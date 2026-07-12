//! Tests for the RBS1 byte-value SDK wrappers (`store::put_bytes`/`get_bytes`
//! and `net::fetch_bytes`). Runs on the HOST target (`cargo test -p rill-guest`):
//! each test drives the REAL host-call future against the recording `rill_host_call`
//! shim, WIRETAPS the exact request bytes, then feeds a crafted response back
//! through the real `rill_resolve` path (a mock host that echoes segments).
//!
//! The load-bearing assertions: the request/response are RBS1 ENVELOPES, the value
//! rides a binary SEGMENT, and NO array-of-numbers ever appears in the JSON control
//! plane — plus a back-compat check that a text-only store call is byte-identical
//! to before.

use crate::store_net_encode::limits::MAX_SEGMENT_BYTES;
use crate::store_net_encode::{decode_envelope, encode_envelope, MAGIC};
use crate::test_shims::CALLS;
use core::fmt::Write as _;
use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll, Waker};
use std::boxed::Box;
use std::string::{String, ToString};
use std::vec;
use std::vec::Vec;

// ---- driving a real host-call future against the recording shim ----

fn poll_once<F: Future>(fut: Pin<&mut F>) -> Poll<F::Output> {
    let mut cx = Context::from_waker(Waker::noop());
    fut.poll(&mut cx)
}

/// A host call captured in-flight: the raw request bytes (for wiretapping) plus
/// the cb id, ready for `resolve` to feed a mock response back.
struct Wiretap<F: Future> {
    fut: Pin<Box<F>>,
    module: String,
    method: String,
    request: Vec<u8>,
    cb: u32,
}

fn issue<F: Future>(f: F) -> Wiretap<F> {
    CALLS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let mut fut = Box::pin(f);
    assert!(
        poll_once(fut.as_mut()).is_pending(),
        "host-call future must park on first poll"
    );
    let mut calls = CALLS.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(calls.len(), 1, "expected exactly one rill_host_call");
    let (module, method, request, cb) = calls.pop().expect("len checked");
    drop(calls);
    Wiretap {
        fut,
        module,
        method,
        request,
        cb,
    }
}

impl<F: Future> Wiretap<F> {
    /// Feed the mock host's response back through the real `rill_resolve` path
    /// and return the completed future's output.
    fn resolve(mut self, ok: u32, response: &[u8]) -> F::Output {
        // Safety: `response` is a live slice we own for the duration of the call;
        // resolve copies it out immediately (to_vec).
        unsafe { crate::rt::resolve(self.cb, ok, response.as_ptr(), response.len()) };
        match poll_once(self.fut.as_mut()) {
            Poll::Ready(out) => out,
            Poll::Pending => panic!("future did not complete after resolve"),
        }
    }
}

fn is_rbs1(buf: &[u8]) -> bool {
    buf.len() >= 4 && buf[0..4] == MAGIC.to_le_bytes()
}

/// The decimal comma-separated form the OLD number-array wire would have used
/// for `bytes` (e.g. `[0,255,16]` -> `"0,255,16"`). Its ABSENCE on the wire is
/// the proof that bytes ride the binary segment, never a JSON number-array.
fn number_csv(bytes: &[u8]) -> String {
    let mut s = String::new();
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let _ = write!(s, "{b}");
    }
    s
}

fn contains_subslice(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

/// The value vectors every round-trip exercises: empty, single byte, the
/// `0x00`/`0xFF` pair, the full byte range, and an at-cap (1 MiB) blob.
fn sample_values() -> Vec<Vec<u8>> {
    vec![
        vec![],
        vec![0x42],
        vec![0x00, 0xff, 0x00, 0xff],
        (0..=255u8).collect(),
        vec![0xabu8; MAX_SEGMENT_BYTES],
    ]
}

// ============================================================
// store::put_bytes — request wiretap (segment present, no number array)
// ============================================================

#[test]
fn put_bytes_request_is_an_rbs1_frame_with_no_number_array() {
    let _guard = crate::wire_lock();
    for value in sample_values() {
        let tap = issue(crate::store::put_bytes("k", &value));
        assert_eq!(tap.module, "host:store");
        assert_eq!(tap.method, "putBytes");
        assert!(is_rbs1(&tap.request), "request must be an RBS1 envelope");

        let dec = decode_envelope(&tap.request).expect("valid envelope");
        // The control plane is byte-EXACT regardless of the value: the value
        // bytes NEVER touch the JSON — only the {"$b":0} sentinel does.
        assert_eq!(dec.json, b"{\"key\":\"k\",\"value\":{\"$b\":0}}");
        // Exactly one segment, byte-identical to the value (incl. 0x00/0xFF).
        assert_eq!(dec.segments.len(), 1);
        assert_eq!(dec.segments[0], &value[..]);
        // No JSON number-array in the control plane: it holds no '[' and the
        // ONLY digit is the sentinel index '0'.
        assert!(
            !dec.json.contains(&b'['),
            "control plane must contain no array"
        );
        let digits = dec.json.iter().filter(|b| b.is_ascii_digit()).count();
        assert_eq!(digits, 1, "only the sentinel index '0' may be a digit");

        // Mock host acks with a plain-JSON body; the wrapper surfaces it.
        let out = tap.resolve(1, b"{\"version\":1}");
        assert_eq!(out.expect("put ok"), b"{\"version\":1}");
    }
}

#[test]
fn put_bytes_over_cap_fails_closed_with_no_host_call() {
    let _guard = crate::wire_lock();
    CALLS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let value = vec![0u8; MAX_SEGMENT_BYTES + 1];
    let mut fut = Box::pin(crate::store::put_bytes("k", &value));
    match poll_once(fut.as_mut()) {
        Poll::Ready(Err(body)) => {
            // Fail-closed with the schema's stable reason token, no partial write.
            assert_eq!(body, b"{\"error\":\"segment-too-big\"}");
        }
        Poll::Ready(Ok(_)) => panic!("over-cap value must not succeed"),
        Poll::Pending => panic!("over-cap value must fail before any host call"),
    }
    assert!(
        CALLS.lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
        "no host call may be issued for an over-cap value"
    );
}

// ============================================================
// store round-trip through a mock host that echoes the segment
// ============================================================

#[test]
fn store_put_then_get_bytes_round_trips_exactly() {
    let _guard = crate::wire_lock();
    for value in sample_values() {
        // put: request carries the value segment; host acks plain JSON.
        let put = issue(crate::store::put_bytes("k", &value));
        let dec = decode_envelope(&put.request).unwrap();
        assert_eq!(dec.segments[0], &value[..]);
        assert_eq!(
            put.resolve(1, b"{\"version\":3}").unwrap(),
            b"{\"version\":3}"
        );

        // get: request is PLAIN JSON (no bytes out), response is an RBS1 envelope
        // whose segment 0 is the stored value — the mock host echoes it back.
        let get = issue(crate::store::get_bytes("k"));
        assert_eq!(get.method, "getBytes");
        assert!(
            !is_rbs1(&get.request),
            "getBytes request has no bytes => plain JSON"
        );
        assert_eq!(get.request, b"{\"key\":\"k\"}");

        let reply = encode_envelope("{\"value\":{\"$b\":0},\"version\":3}", &[&value]).unwrap();
        let got = get.resolve(1, &reply).expect("get ok");
        assert_eq!(got, Some(value.clone()), "byte-exact round trip");
    }
}

#[test]
fn get_bytes_absent_key_is_none() {
    let _guard = crate::wire_lock();
    let get = issue(crate::store::get_bytes("missing"));
    // Absent key => the host replies with a bare plain-JSON `null`.
    let got = get.resolve(1, b"null").expect("get ok");
    assert_eq!(got, None);
}

// ============================================================
// net::fetch_bytes — binary request + response body via the envelope
// ============================================================

#[test]
fn fetch_bytes_carries_binary_body_both_ways_no_number_array() {
    let _guard = crate::wire_lock();
    let body: Vec<u8> = vec![0x00, 0xff, 0x10, 0x20, 0xff, 0x00, 0x7b, 0x5d];
    let tap = issue(crate::net::fetch_bytes(
        "https://example.test/upload",
        "POST",
        &[("content-type", "application/octet-stream")],
        Some(&body),
    ));
    assert_eq!(tap.module, "host:net");
    assert_eq!(tap.method, "fetchBytes");
    assert!(
        is_rbs1(&tap.request),
        "request with a body must be an RBS1 envelope"
    );

    let dec = decode_envelope(&tap.request).unwrap();
    // Body rides segment 0, byte-exact; the control plane carries only the
    // sentinel for it (never the bytes).
    assert_eq!(dec.segments.len(), 1);
    assert_eq!(dec.segments[0], &body[..]);
    assert!(
        contains_subslice(dec.json, b"\"body\":{\"$b\":0}"),
        "control plane must reference the body via the sentinel"
    );
    // No number-array ANYWHERE on the request wire: the body's decimal CSV is
    // absent (the raw bytes ride the segment, not the JSON).
    assert!(
        !contains_subslice(&tap.request, number_csv(&body).as_bytes()),
        "request must carry no array-of-numbers"
    );

    // Mock host:net echoes the body back as the response body segment.
    let reply = encode_envelope(
        "{\"status\":200,\"headers\":[[\"content-type\",\"application/octet-stream\"]],\"body\":{\"$b\":0}}",
        &[&body],
    )
    .unwrap();
    let resp = tap.resolve(1, &reply).expect("fetch ok");
    assert_eq!(resp.status, 200);
    assert_eq!(
        resp.headers,
        vec![(
            "content-type".to_string(),
            "application/octet-stream".to_string()
        )]
    );
    assert_eq!(resp.body, body, "response body decoded byte-exact");
}

#[test]
fn fetch_bytes_bodyless_request_is_plain_json() {
    let _guard = crate::wire_lock();
    let tap = issue(crate::net::fetch_bytes(
        "https://example.test/ping",
        "GET",
        &[("accept", "*/*")],
        None,
    ));
    // No body => no segment => a plain-JSON control plane (back-compat shape).
    assert!(
        !is_rbs1(&tap.request),
        "bodyless request must be plain JSON"
    );
    assert_eq!(
        tap.request,
        b"{\"url\":\"https://example.test/ping\",\"method\":\"GET\",\"headers\":[[\"accept\",\"*/*\"]]}"
    );
    // A response without a body comes back as plain JSON; body decodes empty.
    let resp = tap
        .resolve(1, b"{\"status\":204,\"headers\":[]}")
        .expect("fetch ok");
    assert_eq!(resp.status, 204);
    assert!(resp.body.is_empty());
    assert!(resp.headers.is_empty());
}

// ============================================================
// back-compat: a text-only store call is byte-identical to before
// ============================================================

#[test]
fn text_store_put_is_unchanged_plain_json() {
    let _guard = crate::wire_lock();
    let tap = issue(crate::store::put("k", "hi"));
    assert_eq!(tap.module, "host:store");
    assert_eq!(tap.method, "putText");
    // The RBS1 fork is NEVER taken for a non-binary call: same plain-JSON body
    // as before this change, not magic-prefixed.
    assert!(!is_rbs1(&tap.request), "text put must not be an RBS1 frame");
    assert_eq!(tap.request, b"{\"key\":\"k\",\"text\":\"hi\"}");
    let _ = tap.resolve(1, b"{\"version\":1}");
}
