//! Tests + golden lock for the RBS1 envelope codec. Runs on the HOST target
//! (`cargo test -p rill-guest`); the codec itself is `no_std`, these tests use
//! `std` (libtest brings it in). The Rust encoder is the golden ORACLE:
//! `store-net-bytes.golden.json` is regenerated from the in-code vectors with
//! `RILL_WRITE_STORE_NET_GOLDEN=1` and locked byte-for-byte otherwise.

use super::*;
use std::string::String as StdString;
use std::vec::Vec as StdVec;

// ---- hex helpers ----

fn to_hex(bytes: &[u8]) -> StdString {
    let mut s = StdString::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = std::fmt::Write::write_fmt(&mut s, format_args!("{b:02x}"));
    }
    s
}

fn from_hex(s: &str) -> StdVec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex length");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex digit"))
        .collect()
}

fn magic_le() -> [u8; 4] {
    MAGIC.to_le_bytes()
}

// ============================================================
// framing primitives — byte-exact
// ============================================================

#[test]
fn encode_envelope_layout_is_exact() {
    // {"v":{"$b":0}} with one 4-byte segment.
    let json = "{\"v\":{\"$b\":0}}";
    let seg = [0xde, 0xad, 0xbe, 0xefu8];
    let out = encode_envelope(json, &[&seg]).unwrap();

    let mut expected = StdVec::new();
    expected.extend_from_slice(&magic_le()); // magic
    expected.extend_from_slice(&(json.len() as u32).to_le_bytes()); // jsonLen
    expected.extend_from_slice(json.as_bytes()); // json
    expected.extend_from_slice(&1u32.to_le_bytes()); // segCount
    expected.extend_from_slice(&(seg.len() as u32).to_le_bytes()); // segLen
    expected.extend_from_slice(&seg); // seg bytes
    assert_eq!(out, expected);
    assert_eq!(out.len(), 12 + json.len() + 4 + seg.len());
}

#[test]
fn decode_envelope_round_trips_json_and_segments() {
    let json = "{\"a\":{\"$b\":0},\"b\":{\"$b\":1}}";
    let s0 = [0u8, 0xff, 0x00, 0xff];
    let s1: [u8; 0] = [];
    let frame = encode_envelope(json, &[&s0, &s1]).unwrap();

    let dec = decode_envelope(&frame).unwrap();
    assert_eq!(dec.json, json.as_bytes());
    assert_eq!(dec.segments.len(), 2);
    assert_eq!(dec.segments[0], &s0);
    assert_eq!(dec.segments[1], &s1[..]);
}

#[test]
fn zero_and_ff_bytes_ride_untouched() {
    let payload: StdVec<u8> = (0..=255u8).collect();
    let frame = encode_envelope("{\"v\":{\"$b\":0}}", &[&payload]).unwrap();
    let dec = decode_envelope(&frame).unwrap();
    assert_eq!(dec.segments[0], &payload[..]);
}

// ============================================================
// value walking — hoist / revive, back-compat
// ============================================================

#[test]
fn segment_free_value_is_plain_not_an_envelope() {
    // The load-bearing back-compat invariant: no bytes => raw JSON, no frame.
    let v = Value::Obj(std::vec![
        ("key".into(), Value::Str("greeting".into())),
        ("n".into(), Value::Num(7.0)),
    ]);
    match encode_value(&v).unwrap() {
        Encoded::Plain(bytes) => {
            assert_eq!(bytes, b"{\"key\":\"greeting\",\"n\":7}");
            // MUST NOT begin with the RBS1 magic.
            assert!(bytes.len() < 4 || bytes[0..4] != magic_le());
        }
        Encoded::Envelope(_) => panic!("segment-free value must not be an envelope"),
    }
}

#[test]
fn bytes_value_hoists_to_envelope_and_revives() {
    let v = Value::Obj(std::vec![
        ("key".into(), Value::Str("k".into())),
        ("value".into(), Value::Bytes(std::vec![1, 2, 3, 4, 5])),
    ]);
    let frame = match encode_value(&v).unwrap() {
        Encoded::Envelope(b) => b,
        Encoded::Plain(_) => panic!("a Bytes value must produce an envelope"),
    };
    // Control plane holds the sentinel, never the bytes.
    let dec = decode_envelope(&frame).unwrap();
    assert_eq!(dec.json, b"{\"key\":\"k\",\"value\":{\"$b\":0}}");
    assert_eq!(dec.segments[0], &[1, 2, 3, 4, 5]);
    // Full value round-trip.
    assert_eq!(decode_value(&frame).unwrap(), v);
}

// `$b` is the reserved sentinel key. It is only DANGEROUS when the value also
// carries bytes: then an envelope is framed and the peer's `revive` cannot tell
// an app `{"$b":N}` from a Bytes sentinel. Reject exactly that case. A `$b` key
// in a segment-free value is HARMLESS — it takes the plain-JSON path, is never
// revived, and MUST still encode (byte-for-byte back-compat with today's wire).
#[test]
fn reserved_b_key_is_rejected_only_when_the_value_also_carries_bytes() {
    // Harmless: standalone `$b`, no byte streams -> plain JSON, rides through.
    let plain = Value::Obj(std::vec![("$b".into(), Value::Num(0.0))]);
    match encode_value(&plain).unwrap() {
        Encoded::Plain(bytes) => assert_eq!(bytes, b"{\"$b\":0}"),
        Encoded::Envelope(_) => panic!("a segment-free value must not be an envelope"),
    }

    // Harmless nested inside an array, too (still no bytes).
    let in_arr = Value::Arr(std::vec![Value::Obj(std::vec![(
        "$b".into(),
        Value::Num(1.0)
    )])]);
    assert!(matches!(encode_value(&in_arr).unwrap(), Encoded::Plain(_)));

    // Dangerous: mixed with a real Bytes field (the envelope path). Segment 0
    // exists, so the app `{"$b":0}` would revive to real bytes — reject it.
    let mixed = Value::Obj(std::vec![
        ("payload".into(), Value::Bytes(std::vec![9, 9, 9])),
        (
            "meta".into(),
            Value::Obj(std::vec![("$b".into(), Value::Num(0.0))])
        ),
    ]);
    assert_eq!(encode_value(&mixed).unwrap_err(), Reason::BadSentinel);
}

#[test]
fn nested_sentinels_in_object_and_array() {
    let v = Value::Obj(std::vec![
        ("a".into(), Value::Bytes(std::vec![0xaa])),
        (
            "b".into(),
            Value::Arr(std::vec![
                Value::Bytes(std::vec![0xbb, 0xbb]),
                Value::Bytes(std::vec![]),
            ]),
        ),
    ]);
    let frame = match encode_value(&v).unwrap() {
        Encoded::Envelope(b) => b,
        Encoded::Plain(_) => panic!(),
    };
    let dec = decode_envelope(&frame).unwrap();
    // Walk order: a=0, then b[0]=1, b[1]=2.
    assert_eq!(
        dec.json,
        b"{\"a\":{\"$b\":0},\"b\":[{\"$b\":1},{\"$b\":2}]}"
    );
    assert_eq!(dec.segments.len(), 3);
    assert_eq!(dec.segments[0], &[0xaa]);
    assert_eq!(dec.segments[1], &[0xbb, 0xbb]);
    assert_eq!(dec.segments[2], &[] as &[u8]);
    assert_eq!(decode_value(&frame).unwrap(), v);
}

#[test]
fn both_directions_use_one_symmetric_codec() {
    // The framing is direction-agnostic: the same value encodes to the same
    // bytes whether it is a request arg or a return value, and decodes back
    // identically — this single vector locks BOTH directions.
    let v = Value::Obj(std::vec![(
        "value".into(),
        Value::Bytes(std::vec![9, 8, 7])
    )]);
    let a = encode_value(&v).unwrap();
    let b = encode_value(&v).unwrap();
    assert_eq!(a, b);
    if let Encoded::Envelope(frame) = a {
        assert_eq!(decode_value(&frame).unwrap(), v);
    } else {
        panic!();
    }
}

// ============================================================
// fail-closed cap negatives (every reason token)
// ============================================================

#[test]
fn bad_magic_is_detected() {
    let mut frame = encode_envelope("{}", &[&[1u8][..]]).unwrap();
    frame[0] ^= 0xff; // corrupt the magic
    assert_eq!(decode_envelope(&frame), Err(Reason::BadMagic));
    // A plain-JSON body (no magic) also reports BadMagic — the caller's signal
    // to treat it as raw JSON.
    assert_eq!(decode_envelope(b"{\"x\":1}"), Err(Reason::BadMagic));
    assert_eq!(decode_value(b"{\"x\":1}"), Err(Reason::BadMagic));
}

#[test]
fn truncated_is_detected_at_every_length() {
    let frame = encode_envelope("{\"v\":{\"$b\":0}}", &[&[1, 2, 3, 4u8][..]]).unwrap();
    // Every proper prefix must fail closed (never an OOB read).
    for cut in 0..frame.len() {
        let r = decode_envelope(&frame[..cut]);
        assert!(r.is_err(), "prefix len {cut} must fail");
    }
    // Trailing byte after a complete frame is also truncated (strict trailing).
    let mut extra = frame.clone();
    extra.push(0);
    assert_eq!(decode_envelope(&extra), Err(Reason::Truncated));
}

#[test]
fn json_too_big_rejected() {
    let big = StdString::from_utf8(std::vec![b' '; MAX_JSON_BYTES + 1]).unwrap();
    // Wrap the whitespace in a JSON-ish string so it is "control plane"; length is
    // what the cap checks, not validity.
    assert_eq!(
        encode_envelope(&big, &[&[0u8][..]]),
        Err(Reason::JsonTooBig)
    );
}

#[test]
fn too_many_segments_rejected() {
    let seg = [0u8];
    let refs: StdVec<&[u8]> = (0..=MAX_SEGMENTS).map(|_| &seg[..]).collect();
    assert_eq!(encode_envelope("{}", &refs), Err(Reason::TooManySegments));
    // The value walker enforces the same cap while hoisting.
    let v = Value::Arr(
        (0..=MAX_SEGMENTS)
            .map(|_| Value::Bytes(std::vec![0]))
            .collect(),
    );
    assert_eq!(encode_value(&v), Err(Reason::TooManySegments));
}

#[test]
fn segment_too_big_rejected() {
    let seg = std::vec![0u8; MAX_SEGMENT_BYTES + 1];
    assert_eq!(
        encode_envelope("{\"v\":{\"$b\":0}}", &[&seg]),
        Err(Reason::SegmentTooBig)
    );
    let v = Value::Bytes(seg);
    assert_eq!(encode_value(&v), Err(Reason::SegmentTooBig));
}

#[test]
fn envelope_too_big_rejected() {
    // Several at-cap segments whose aggregate exceeds MAX_ENVELOPE_BYTES even
    // though each respects MAX_SEGMENT_BYTES.
    let seg = std::vec![0u8; MAX_SEGMENT_BYTES];
    let n = MAX_ENVELOPE_BYTES / MAX_SEGMENT_BYTES + 1;
    assert!(n <= MAX_SEGMENTS, "test needs n within the segment cap");
    let refs: StdVec<&[u8]> = (0..n).map(|_| &seg[..]).collect();
    assert_eq!(encode_envelope("{}", &refs), Err(Reason::EnvelopeTooBig));
}

#[test]
fn decode_envelope_too_big_rejected() {
    // A buffer over the aggregate cap but with a valid magic is rejected.
    let mut buf = StdVec::from(magic_le());
    buf.resize(MAX_ENVELOPE_BYTES + 1, 0);
    assert_eq!(decode_envelope(&buf), Err(Reason::EnvelopeTooBig));
}

#[test]
fn decode_json_too_big_rejected() {
    let mut buf = StdVec::from(magic_le());
    buf.extend_from_slice(&((MAX_JSON_BYTES as u32) + 1).to_le_bytes());
    assert_eq!(decode_envelope(&buf), Err(Reason::JsonTooBig));
}

#[test]
fn decode_too_many_segments_rejected() {
    // magic + jsonLen(0) + empty json + segCount(MAX+1)
    let mut buf = StdVec::from(magic_le());
    buf.extend_from_slice(&0u32.to_le_bytes()); // jsonLen 0
    buf.extend_from_slice(&((MAX_SEGMENTS as u32) + 1).to_le_bytes()); // segCount
    assert_eq!(decode_envelope(&buf), Err(Reason::TooManySegments));
}

#[test]
fn decode_segment_too_big_rejected() {
    let mut buf = StdVec::from(magic_le());
    buf.extend_from_slice(&0u32.to_le_bytes()); // jsonLen 0
    buf.extend_from_slice(&1u32.to_le_bytes()); // segCount 1
    buf.extend_from_slice(&((MAX_SEGMENT_BYTES as u32) + 1).to_le_bytes()); // segLen over cap
    assert_eq!(decode_envelope(&buf), Err(Reason::SegmentTooBig));
}

#[test]
fn bad_json_rejected_on_decode_value() {
    // Valid framing, but the control plane is not JSON.
    let frame = encode_envelope("{not json", &[]).unwrap();
    assert_eq!(decode_value(&frame), Err(Reason::BadJson));
}

#[test]
fn bad_segment_ref_rejected() {
    // Sentinel N=5 but only 1 segment present.
    let frame = encode_envelope("{\"v\":{\"$b\":5}}", &[&[1u8][..]]).unwrap();
    assert_eq!(decode_value(&frame), Err(Reason::BadSegmentRef));
}

#[test]
fn bad_sentinel_shapes_rejected() {
    // Extra key alongside $b.
    let f1 = encode_envelope("{\"v\":{\"$b\":0,\"x\":1}}", &[&[1u8][..]]).unwrap();
    assert_eq!(decode_value(&f1), Err(Reason::BadSentinel));
    // Non-integer $b value.
    let f2 = encode_envelope("{\"v\":{\"$b\":\"0\"}}", &[&[1u8][..]]).unwrap();
    assert_eq!(decode_value(&f2), Err(Reason::BadSentinel));
    // Negative $b value.
    let f3 = encode_envelope("{\"v\":{\"$b\":-1}}", &[&[1u8][..]]).unwrap();
    assert_eq!(decode_value(&f3), Err(Reason::BadSentinel));
}

#[test]
fn at_cap_1mib_segment_round_trips() {
    // The at-maxSegmentBytes boundary must succeed (only ONE over-cap byte fails).
    let seg = std::vec![0xabu8; MAX_SEGMENT_BYTES];
    let frame = encode_envelope("{\"v\":{\"$b\":0}}", &[&seg]).unwrap();
    let dec = decode_envelope(&frame).unwrap();
    assert_eq!(dec.segments[0].len(), MAX_SEGMENT_BYTES);
    assert_eq!(dec.segments[0][0], 0xab);
    assert_eq!(dec.segments[0][MAX_SEGMENT_BYTES - 1], 0xab);
}

// ============================================================
// conformance: generated constants match the schema
// ============================================================

fn contract_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts")
        .join(name)
}

#[test]
fn generated_constants_match_the_schema() {
    let src = std::fs::read_to_string(contract_path("store-net-bytes.json")).unwrap();
    let root = crate::mini_json::Json::parse(&src).unwrap();

    let magic_hex = root
        .get("magic")
        .unwrap()
        .get("hex")
        .unwrap()
        .as_str()
        .unwrap();
    let magic = u32::from_str_radix(magic_hex.trim_start_matches("0x"), 16).unwrap();
    assert_eq!(MAGIC, magic, "MAGIC drifted from schema magic.hex");

    let version = root
        .get("protocolVersion")
        .unwrap()
        .get("value")
        .unwrap()
        .as_u64()
        .unwrap();
    assert_eq!(PROTOCOL_VERSION as u64, version);

    let limits = root.get("limits").unwrap();
    let get = |k: &str| {
        limits
            .get(k)
            .unwrap()
            .get("value")
            .unwrap()
            .as_u64()
            .unwrap() as usize
    };
    assert_eq!(MAX_SEGMENTS, get("maxSegments"));
    assert_eq!(MAX_SEGMENT_BYTES, get("maxSegmentBytes"));
    assert_eq!(MAX_ENVELOPE_BYTES, get("maxEnvelopeBytes"));
    assert_eq!(MAX_JSON_BYTES, get("maxJsonBytes"));
}

// ============================================================
// golden lock (Rust encoder is the oracle)
// ============================================================

/// A golden vector spec, mirrored into `store-net-bytes.golden.json`.
struct Vector {
    name: &'static str,
    note: &'static str,
    direction: &'static str,
    control_plane: &'static str,
    // Each segment: either raw bytes, or (fill_byte, len) for the at-cap case.
    segments: StdVec<Seg>,
}
enum Seg {
    Hex(StdVec<u8>),
    Fill(u8, usize),
}
impl Seg {
    fn bytes(&self) -> StdVec<u8> {
        match self {
            Seg::Hex(b) => b.clone(),
            Seg::Fill(byte, len) => std::vec![*byte; *len],
        }
    }
}

fn golden_vectors() -> StdVec<Vector> {
    std::vec![
        Vector {
            name: "back-compat-no-segments",
            note: "segment-free value: raw JSON, NOT an RBS1 frame (back-compat invariant)",
            direction: "both",
            control_plane: "{\"key\":\"greeting\",\"text\":\"hi\"}",
            segments: std::vec![],
        },
        Vector {
            name: "one-segment",
            note: "a single byte-stream field hoisted to segment 0",
            direction: "both",
            control_plane: "{\"key\":\"k\",\"value\":{\"$b\":0}}",
            segments: std::vec![Seg::Hex(std::vec![0xde, 0xad, 0xbe, 0xef])],
        },
        Vector {
            name: "empty-value-segment",
            note: "a zero-length byte stream (segLen 0)",
            direction: "both",
            control_plane: "{\"value\":{\"$b\":0}}",
            segments: std::vec![Seg::Hex(std::vec![])],
        },
        Vector {
            name: "zero-and-ff-bytes",
            note: "raw 0x00 and 0xFF ride untouched in the segment",
            direction: "both",
            control_plane: "{\"value\":{\"$b\":0}}",
            segments: std::vec![Seg::Hex(std::vec![0x00, 0xff, 0x00, 0xff])],
        },
        Vector {
            name: "multi-segment-nested",
            note: "nested sentinels in an object and an array; walk order a=0,b[0]=1,b[1]=2",
            direction: "both",
            control_plane: "{\"a\":{\"$b\":0},\"b\":[{\"$b\":1},{\"$b\":2}]}",
            segments: std::vec![
                Seg::Hex(std::vec![0xaa]),
                Seg::Hex(std::vec![0xbb, 0xbb]),
                Seg::Hex(std::vec![]),
            ],
        },
        Vector {
            name: "at-cap-1mib-segment",
            note: "an at-maxSegmentBytes (1 MiB) byte stream of 0xab; envelope hex omitted for size, length + structure locked",
            direction: "both",
            control_plane: "{\"value\":{\"$b\":0}}",
            segments: std::vec![Seg::Fill(0xab, MAX_SEGMENT_BYTES)],
        },
    ]
}

// Envelope hex is inlined into the golden file only up to this size; larger
// vectors (the 1 MiB at-cap case) lock their length + structure instead.
const GOLDEN_HEX_INLINE_MAX: usize = 4096;

#[test]
fn golden_vectors_are_locked() {
    let path = contract_path("store-net-bytes.golden.json");

    if std::env::var("RILL_WRITE_STORE_NET_GOLDEN").is_ok() {
        write_golden(&path);
    }

    let src =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let root = crate::mini_json::Json::parse(&src).unwrap();
    let vectors = root.get("vectors").unwrap().items().unwrap();

    // The committed file must contain exactly our in-code vectors, by name.
    let expected: StdVec<&str> = golden_vectors().iter().map(|v| v.name).collect();
    let actual: StdVec<&str> = vectors
        .iter()
        .map(|v| v.get("name").unwrap().as_str().unwrap())
        .collect();
    assert_eq!(actual, expected, "golden vector set drifted");

    for (spec, vec_json) in golden_vectors().iter().zip(vectors.iter()) {
        let cp = spec.control_plane;
        assert_eq!(vec_json.get("controlPlane").unwrap().as_str().unwrap(), cp);

        if spec.segments.is_empty() {
            // Plain (back-compat) vector: raw JSON, never a frame.
            assert_eq!(vec_json.get("kind").unwrap().as_str().unwrap(), "plain");
            let raw_hex = vec_json.get("rawJsonHex").unwrap().as_str().unwrap();
            assert_eq!(from_hex(raw_hex), cp.as_bytes());
            assert!(cp.len() < 4 || cp.as_bytes()[0..4] != magic_le());
            // encode_value of the parsed value yields the identical Plain bytes.
            let parsed = super::parse_json(cp).unwrap();
            assert_eq!(
                encode_value(&parsed).unwrap(),
                Encoded::Plain(cp.as_bytes().to_vec())
            );
            continue;
        }

        // Envelope vector: reconstruct via the framing primitive and lock bytes.
        assert_eq!(vec_json.get("kind").unwrap().as_str().unwrap(), "envelope");
        let seg_bytes: StdVec<StdVec<u8>> = spec.segments.iter().map(|s| s.bytes()).collect();
        let seg_refs: StdVec<&[u8]> = seg_bytes.iter().map(|s| s.as_slice()).collect();
        let frame = encode_envelope(cp, &seg_refs).unwrap();

        let expected_len = vec_json.get("envelopeLen").unwrap().as_u64().unwrap() as usize;
        assert_eq!(
            frame.len(),
            expected_len,
            "{}: envelope length drift",
            spec.name
        );

        if let Some(hex) = vec_json.get("envelopeHex").and_then(|h| h.as_str()) {
            assert_eq!(to_hex(&frame), hex, "{}: envelope bytes drift", spec.name);
        }

        // Decode round-trips json + segments.
        let dec = decode_envelope(&frame).unwrap();
        assert_eq!(dec.json, cp.as_bytes());
        assert_eq!(dec.segments.len(), seg_bytes.len());
        for (got, want) in dec.segments.iter().zip(seg_bytes.iter()) {
            assert_eq!(*got, want.as_slice());
        }

        // Value-level idempotence: decode -> Value -> re-encode == same frame.
        let value = decode_value(&frame).unwrap();
        assert_eq!(encode_value(&value).unwrap(), Encoded::Envelope(frame));
    }
}

fn write_golden(path: &std::path::Path) {
    use std::fmt::Write as _;
    let mut out = StdString::new();
    out.push_str(
        "{\n  \"$comment\": \"GENERATED byte-exact RBS1 golden vectors. Oracle: crates/rill-guest/src/store_net_encode.rs (encode_envelope). Regenerate with RILL_WRITE_STORE_NET_GOLDEN=1 cargo test -p rill-guest golden_vectors_are_locked. Each envelope vector pairs a control plane + segments with the exact on-the-wire bytes; the framing is SYMMETRIC (one vector locks request AND return). The at-cap 1 MiB vector omits envelopeHex for size and locks envelopeLen + structure. Segments: {hex} raw bytes, or {fill,len} a repeated byte. The back-compat vector is raw JSON (kind=plain), asserted NOT to be a frame.\",\n  \"vectors\": [\n",
    );
    let vectors = golden_vectors();
    for (i, spec) in vectors.iter().enumerate() {
        let cp = spec.control_plane;
        out.push_str("    {\n");
        let _ = writeln!(out, "      \"name\": {},", json_str(spec.name));
        let _ = writeln!(out, "      \"note\": {},", json_str(spec.note));
        let _ = writeln!(out, "      \"direction\": {},", json_str(spec.direction));
        if spec.segments.is_empty() {
            let _ = writeln!(out, "      \"kind\": \"plain\",");
            let _ = writeln!(out, "      \"controlPlane\": {},", json_str(cp));
            let _ = writeln!(out, "      \"segments\": [],");
            let _ = writeln!(
                out,
                "      \"rawJsonHex\": {}",
                json_str(&to_hex(cp.as_bytes()))
            );
        } else {
            let seg_bytes: StdVec<StdVec<u8>> = spec.segments.iter().map(|s| s.bytes()).collect();
            let seg_refs: StdVec<&[u8]> = seg_bytes.iter().map(|s| s.as_slice()).collect();
            let frame = encode_envelope(cp, &seg_refs).unwrap();
            let _ = writeln!(out, "      \"kind\": \"envelope\",");
            let _ = writeln!(out, "      \"controlPlane\": {},", json_str(cp));
            // segments
            out.push_str("      \"segments\": [");
            for (j, s) in spec.segments.iter().enumerate() {
                if j > 0 {
                    out.push_str(", ");
                }
                match s {
                    Seg::Hex(b) => {
                        let _ = write!(out, "{{\"hex\": {}}}", json_str(&to_hex(b)));
                    }
                    Seg::Fill(byte, len) => {
                        let _ = write!(out, "{{\"fill\": \"{byte:02x}\", \"len\": {len}}}");
                    }
                }
            }
            out.push_str("],\n");
            let _ = writeln!(out, "      \"envelopeLen\": {},", frame.len());
            if frame.len() <= GOLDEN_HEX_INLINE_MAX {
                let _ = writeln!(out, "      \"envelopeHex\": {}", json_str(&to_hex(&frame)));
            } else {
                let _ = writeln!(
                    out,
                    "      \"envelopeHexOmitted\": \"length {} exceeds inline cap; length + structure locked by the Rust suite\"",
                    frame.len()
                );
            }
        }
        if i + 1 < vectors.len() {
            out.push_str("    },\n");
        } else {
            out.push_str("    }\n");
        }
    }
    out.push_str("  ]\n}\n");
    std::fs::write(path, out).unwrap();
}

/// Minimal JSON string literal (the control planes here are ASCII with `"` `\`).
fn json_str(s: &str) -> StdString {
    let mut out = StdString::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
