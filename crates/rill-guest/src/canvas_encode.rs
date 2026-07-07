//! Guest-side ENCODER for the binary CANVAS wire protocol (a per-frame flat 2D
//! display list — the `host:canvas.draw` path).
//!
//! SINGLE SOURCE OF TRUTH: `contracts/canvas-wire.json`. The magic, protocol
//! version, the 21 opcode numbers, the frame flags and the fail-closed caps
//! below are all GENERATED from that file by `build.rs` (see the `contract`
//! submodule); this module only lays out the record SHAPES the contract declares
//! and is locked to the byte layout by the golden-vector tests at the bottom
//! (`contracts/canvas-wire.golden.json`).
//!
//! SISTER contract to `op-batch-wire.json` / `wire_encode.rs`, deliberately
//! SEPARATE: op-batch carries UI-tree DIFFS over a retained node graph
//! (recursive `SerializedValue` trees), whereas canvas is a FLAT, per-frame
//! sequence of drawing ops with no nesting and no retained wire state. The two
//! share the ENVELOPE SHAPE (magic + version + header + a per-frame u16 intern
//! table + ops) and the SAME single-source + golden-lock discipline, but use
//! DISTINCT magic (`RCNV` = 0x564e4352 vs `RILL` = 0x4c4c4952) so a buffer meant
//! for one decoder fails the other's `u32` magic compare immediately.
//!
//! WORK IN PROGRESS — behind the `wip-binary-protocol` cargo feature (default
//! OFF). It is deliberately NOT wired into the live canvas emit path
//! (`canvas::draw` still ships JSON); it is new, side-effect-free code that
//! produces an owned `Vec<u8>` and nothing else.
//!
//! `#![no_std]` crate: only `alloc` is used (no `std`).
//!
//! ## Per-frame color interning
//!
//! Unlike op-batch's cross-batch persistent table, a canvas frame is fully
//! self-contained: the intern table starts EMPTY every frame and every
//! `internRef` resolves within the same frame. Only `setFillStyle` /
//! `setStrokeStyle` COLOR strings are interned (they repeat heavily within a
//! frame); `fillText` text is INLINE (high cardinality). Indices are assigned in
//! FIRST-APPEARANCE order as the ops are walked. Coordinates/dimensions are all
//! `f64` little-endian and MUST be finite (NaN/Inf fail closed), mirroring the
//! guest `DrawList::finite` latch on the JSON path.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

/// Constants generated from `contracts/canvas-wire.json` by `build.rs`. Private
/// to this module; individual items may be unused until the protocol is wired
/// into the live path, hence the blanket allow.
#[allow(dead_code)]
mod contract {
    include!(concat!(env!("OUT_DIR"), "/canvas_contract.rs"));
}

/// The canvas wire `protocolVersion` this encoder produces (generated from
/// `contracts/canvas-wire.json`). Exposed so the guest's `canvas::draw`
/// capability handshake can compare it against the host-advertised
/// `wireVersion` and only send binary when the host decodes the SAME version.
pub const WIRE_VERSION: u16 = contract::PROTOCOL_VERSION;

/// Fail-closed encode errors. Every variant means the WHOLE frame is aborted and
/// nothing partial is emitted (the caller gets an `Err`, never a truncated
/// buffer). Each maps to a `reasons` token in the contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    /// More than `limits.maxOps` draw ops in one frame (contract reason
    /// `op-budget`). `header.opCount` is a u32 field but its VALUE is capped.
    TooManyOps,
    /// A distinct color past `limits.maxInternStrings` (reason `intern-overflow`).
    InternTableOverflow,
    /// A `canvasId` or intern color string longer than `limits.maxStringBytes`
    /// (reason `string-too-big`); its `byteLen` is a u16 that MUST NOT wrap.
    StringTooLong,
    /// A `fillText` text run longer than `limits.maxTextBytes` (reason
    /// `text-too-big`); its `textLen` is a u32 but the CAP is the bound.
    TextTooLong,
    /// The finished frame would exceed `limits.maxBatchBytes` (reason
    /// `frame-too-big`).
    FrameTooLarge,
    /// An `f64` coordinate/dimension/style scalar that is NaN or +/-Infinity
    /// (reason `non-finite`) — canvas requires finite numbers, mirroring the
    /// guest `DrawList::finite` latch on the JSON path.
    NonFiniteNumber,
}

/// One canvas draw op to encode, OWNED so a `DrawList` can record a frame's ops
/// alongside its JSON. Field order within each variant matches the contract's
/// `ops` record layout (and the guest `DrawList` JSON emission).
#[derive(Debug, Clone, PartialEq)]
pub enum CanvasOp {
    BeginPath,
    ClosePath,
    MoveTo {
        x: f64,
        y: f64,
    },
    LineTo {
        x: f64,
        y: f64,
    },
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
    Arc {
        x: f64,
        y: f64,
        r: f64,
        start: f64,
        end: f64,
        ccw: bool,
    },
    Fill,
    Stroke,
    FillRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
    StrokeRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
    ClearRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
    /// Color is INTERNED (u16 `internRef`).
    SetFillStyle {
        color: String,
    },
    /// Color is INTERNED (u16 `internRef`).
    SetStrokeStyle {
        color: String,
    },
    SetLineWidth {
        w: f64,
    },
    /// Text is INLINE (u32 len + UTF-8, not interned). Field order is x, y, text.
    FillText {
        x: f64,
        y: f64,
        text: String,
    },
    Save,
    Restore,
    Translate {
        x: f64,
        y: f64,
    },
    Scale {
        x: f64,
        y: f64,
    },
    Rotate {
        angle: f64,
    },
    SetTransform {
        a: f64,
        b: f64,
        c: f64,
        d: f64,
        e: f64,
        f: f64,
    },
}

/// A per-frame encoder. Canvas frames are independent, so the intern table is
/// cleared at the start of every [`encode_frame`](Encoder::encode_frame) — a
/// `Encoder` may be reused across frames purely to recycle its allocations; it
/// carries NO cross-frame state (unlike op-batch's persistent [`Encoder`]).
#[derive(Debug, Default)]
pub struct Encoder {
    /// index -> color string, in first-appearance (serialisation) order.
    order: Vec<String>,
    /// color string -> assigned index, for O(log n) dedup.
    index: BTreeMap<String, u16>,
}

impl Encoder {
    /// A fresh encoder with an empty intern table (first index will be 0).
    pub fn new() -> Self {
        Self::default()
    }

    /// Intern a color string, returning its per-frame u16 index. Fails closed on
    /// a too-long string or an overflowing table.
    fn intern(&mut self, s: &str) -> Result<u16, EncodeError> {
        if let Some(&i) = self.index.get(s) {
            return Ok(i);
        }
        if s.len() > contract::limits::MAX_STRING_BYTES {
            return Err(EncodeError::StringTooLong);
        }
        // Assigning this index makes the count `order.len() + 1`; the count is a
        // u16 and every ref is a u16. maxInternStrings (4096) is far below the
        // u16 ceiling, so reject once the table is already at the cap.
        if self.order.len() >= contract::limits::MAX_INTERN_STRINGS {
            return Err(EncodeError::InternTableOverflow);
        }
        let idx = self.order.len() as u16;
        self.order.push(String::from(s));
        self.index.insert(String::from(s), idx);
        Ok(idx)
    }

    /// Encode one frame to its exact on-the-wire bytes. On any [`EncodeError`]
    /// nothing partial is emitted (the returned `Err` carries no buffer). The
    /// intern table is reset at entry, so the output is always index-from-0 and
    /// self-contained.
    pub fn encode_frame(
        &mut self,
        canvas_id: &str,
        frame_id: u32,
        ops: &[CanvasOp],
    ) -> Result<Vec<u8>, EncodeError> {
        // Decode-amplification guard: validate the op budget BEFORE doing any
        // work, exactly as the host pre-checks header.opCount against maxOps.
        if ops.len() > contract::limits::MAX_OPS {
            return Err(EncodeError::TooManyOps);
        }
        if canvas_id.len() > contract::limits::MAX_STRING_BYTES {
            return Err(EncodeError::StringTooLong);
        }

        // Per-frame semantics: the intern table starts empty every frame.
        self.order.clear();
        self.index.clear();

        // Emit the ops first, into their own buffer. This interns every color
        // lazily in exactly the forward-walk order the schema's pre-pass
        // declares, so the table serialised below ends up in first-appearance
        // order without a separate pass.
        let mut ops_buf: Vec<u8> = Vec::new();
        for op in ops {
            self.emit_op(op, &mut ops_buf)?;
        }

        let mut out: Vec<u8> = Vec::new();
        // ---- 16-byte header ----
        put_u32(&mut out, contract::MAGIC);
        put_u16(&mut out, contract::PROTOCOL_VERSION);
        put_u32(&mut out, frame_id);
        // opCount is a u32 (ample width for the 20000-op budget); the value is
        // capped above.
        put_u32(&mut out, ops.len() as u32);
        out.push(contract::flags::NONE);
        out.push(0); // reserved[1]

        // ---- canvasId (inline, u16 len + UTF-8; NOT interned) ----
        // length bounded by maxStringBytes above, so it fits u16 without wrap.
        put_u16(&mut out, canvas_id.len() as u16);
        out.extend_from_slice(canvas_id.as_bytes());

        // ---- intern table (colors, in first-appearance order) ----
        // order.len() is bounded by maxInternStrings (< u16 ceiling), fits u16.
        put_u16(&mut out, self.order.len() as u16);
        for s in &self.order {
            put_u16(&mut out, s.len() as u16);
            out.extend_from_slice(s.as_bytes());
        }

        // ---- ops ----
        out.extend_from_slice(&ops_buf);

        if out.len() > contract::limits::MAX_BATCH_BYTES {
            return Err(EncodeError::FrameTooLarge);
        }
        Ok(out)
    }

    fn emit_op(&mut self, op: &CanvasOp, buf: &mut Vec<u8>) -> Result<(), EncodeError> {
        use contract::opcode;
        match op {
            CanvasOp::BeginPath => buf.push(opcode::BEGIN_PATH),
            CanvasOp::ClosePath => buf.push(opcode::CLOSE_PATH),
            CanvasOp::MoveTo { x, y } => {
                buf.push(opcode::MOVE_TO);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
            }
            CanvasOp::LineTo { x, y } => {
                buf.push(opcode::LINE_TO);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
            }
            CanvasOp::Rect { x, y, w, h } => {
                buf.push(opcode::RECT);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
                put_f64(buf, *w)?;
                put_f64(buf, *h)?;
            }
            CanvasOp::Arc {
                x,
                y,
                r,
                start,
                end,
                ccw,
            } => {
                buf.push(opcode::ARC);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
                put_f64(buf, *r)?;
                put_f64(buf, *start)?;
                put_f64(buf, *end)?;
                buf.push(if *ccw { 1 } else { 0 });
            }
            CanvasOp::Fill => buf.push(opcode::FILL),
            CanvasOp::Stroke => buf.push(opcode::STROKE),
            CanvasOp::FillRect { x, y, w, h } => {
                buf.push(opcode::FILL_RECT);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
                put_f64(buf, *w)?;
                put_f64(buf, *h)?;
            }
            CanvasOp::StrokeRect { x, y, w, h } => {
                buf.push(opcode::STROKE_RECT);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
                put_f64(buf, *w)?;
                put_f64(buf, *h)?;
            }
            CanvasOp::ClearRect { x, y, w, h } => {
                buf.push(opcode::CLEAR_RECT);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
                put_f64(buf, *w)?;
                put_f64(buf, *h)?;
            }
            CanvasOp::SetFillStyle { color } => {
                buf.push(opcode::SET_FILL_STYLE);
                let r = self.intern(color)?;
                put_u16(buf, r);
            }
            CanvasOp::SetStrokeStyle { color } => {
                buf.push(opcode::SET_STROKE_STYLE);
                let r = self.intern(color)?;
                put_u16(buf, r);
            }
            CanvasOp::SetLineWidth { w } => {
                buf.push(opcode::SET_LINE_WIDTH);
                put_f64(buf, *w)?;
            }
            CanvasOp::FillText { x, y, text } => {
                buf.push(opcode::FILL_TEXT);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
                if text.len() > contract::limits::MAX_TEXT_BYTES {
                    return Err(EncodeError::TextTooLong);
                }
                // textLen is a u32 (the cap, not the field width, is the bound).
                put_u32(buf, text.len() as u32);
                buf.extend_from_slice(text.as_bytes());
            }
            CanvasOp::Save => buf.push(opcode::SAVE),
            CanvasOp::Restore => buf.push(opcode::RESTORE),
            CanvasOp::Translate { x, y } => {
                buf.push(opcode::TRANSLATE);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
            }
            CanvasOp::Scale { x, y } => {
                buf.push(opcode::SCALE);
                put_f64(buf, *x)?;
                put_f64(buf, *y)?;
            }
            CanvasOp::Rotate { angle } => {
                buf.push(opcode::ROTATE);
                put_f64(buf, *angle)?;
            }
            CanvasOp::SetTransform { a, b, c, d, e, f } => {
                buf.push(opcode::SET_TRANSFORM);
                put_f64(buf, *a)?;
                put_f64(buf, *b)?;
                put_f64(buf, *c)?;
                put_f64(buf, *d)?;
                put_f64(buf, *e)?;
                put_f64(buf, *f)?;
            }
        }
        Ok(())
    }
}

#[inline]
fn put_u16(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

#[inline]
fn put_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

/// Write one `f64` little-endian, failing closed on a non-finite value (the
/// wire requires finite numbers; mirrors the guest `DrawList::finite` latch).
#[inline]
fn put_f64(buf: &mut Vec<u8>, v: f64) -> Result<(), EncodeError> {
    if !v.is_finite() {
        return Err(EncodeError::NonFiniteNumber);
    }
    buf.extend_from_slice(&v.to_le_bytes());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mini_json::Json;
    use core::fmt::Write as _;
    use std::format;
    use std::path::PathBuf;
    use std::string::{String, ToString};
    use std::vec::Vec;
    use std::{vec, write};

    /// Lowercase-hex a byte buffer for comparison against the golden `hex`.
    fn to_hex(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    fn encode(canvas_id: &str, frame_id: u32, ops: &[CanvasOp]) -> Vec<u8> {
        Encoder::new()
            .encode_frame(canvas_id, frame_id, ops)
            .expect("frame must encode")
    }

    // ---- golden vector plumbing --------------------------------------------

    fn golden_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contracts/canvas-wire.golden.json")
    }

    /// A required f64 field of a golden op object (mini_json exposes numbers as
    /// `Json::Num`, which round-trips f64 via Rust's shortest formatting).
    fn f(op: &Json, key: &str) -> f64 {
        match op.get(key) {
            Some(Json::Num(n)) => *n,
            _ => panic!("golden op missing number field {key}"),
        }
    }

    fn s<'a>(op: &'a Json, key: &str) -> &'a str {
        op.get(key)
            .and_then(Json::as_str)
            .unwrap_or_else(|| panic!("golden op missing string field {key}"))
    }

    /// Parse one golden op JSON object (`{"op":"moveTo","x":..,"y":..}` — the
    /// SAME shape the guest `DrawList` emits on the JSON path) into a
    /// [`CanvasOp`]. This makes the checked-in file the true SOURCE the encoder
    /// re-encodes byte-exact, so encoder and golden cannot silently drift.
    fn json_to_op(op: &Json) -> CanvasOp {
        match s(op, "op") {
            "beginPath" => CanvasOp::BeginPath,
            "closePath" => CanvasOp::ClosePath,
            "moveTo" => CanvasOp::MoveTo {
                x: f(op, "x"),
                y: f(op, "y"),
            },
            "lineTo" => CanvasOp::LineTo {
                x: f(op, "x"),
                y: f(op, "y"),
            },
            "rect" => CanvasOp::Rect {
                x: f(op, "x"),
                y: f(op, "y"),
                w: f(op, "w"),
                h: f(op, "h"),
            },
            "arc" => CanvasOp::Arc {
                x: f(op, "x"),
                y: f(op, "y"),
                r: f(op, "r"),
                start: f(op, "start"),
                end: f(op, "end"),
                ccw: matches!(op.get("ccw"), Some(Json::Bool(true))),
            },
            "fill" => CanvasOp::Fill,
            "stroke" => CanvasOp::Stroke,
            "fillRect" => CanvasOp::FillRect {
                x: f(op, "x"),
                y: f(op, "y"),
                w: f(op, "w"),
                h: f(op, "h"),
            },
            "strokeRect" => CanvasOp::StrokeRect {
                x: f(op, "x"),
                y: f(op, "y"),
                w: f(op, "w"),
                h: f(op, "h"),
            },
            "clearRect" => CanvasOp::ClearRect {
                x: f(op, "x"),
                y: f(op, "y"),
                w: f(op, "w"),
                h: f(op, "h"),
            },
            "setFillStyle" => CanvasOp::SetFillStyle {
                color: s(op, "color").to_string(),
            },
            "setStrokeStyle" => CanvasOp::SetStrokeStyle {
                color: s(op, "color").to_string(),
            },
            "setLineWidth" => CanvasOp::SetLineWidth { w: f(op, "w") },
            "fillText" => CanvasOp::FillText {
                x: f(op, "x"),
                y: f(op, "y"),
                text: s(op, "text").to_string(),
            },
            "save" => CanvasOp::Save,
            "restore" => CanvasOp::Restore,
            "translate" => CanvasOp::Translate {
                x: f(op, "x"),
                y: f(op, "y"),
            },
            "scale" => CanvasOp::Scale {
                x: f(op, "x"),
                y: f(op, "y"),
            },
            "rotate" => CanvasOp::Rotate {
                angle: f(op, "angle"),
            },
            "setTransform" => CanvasOp::SetTransform {
                a: f(op, "a"),
                b: f(op, "b"),
                c: f(op, "c"),
                d: f(op, "d"),
                e: f(op, "e"),
                f: f(op, "f"),
            },
            other => panic!("unknown golden op {other}"),
        }
    }

    /// A source vector: name, description, target canvasId/frameId and the ops
    /// the guest `DrawList` would build. The encoder turns each into its hex.
    struct Vector {
        name: &'static str,
        description: String,
        canvas_id: String,
        frame_id: u32,
        ops: Vec<CanvasOp>,
    }

    fn v(
        name: &'static str,
        description: &str,
        canvas_id: &str,
        frame_id: u32,
        ops: Vec<CanvasOp>,
    ) -> Vector {
        Vector {
            name,
            description: description.to_string(),
            canvas_id: canvas_id.to_string(),
            frame_id,
            ops,
        }
    }

    fn fs(color: &str) -> CanvasOp {
        CanvasOp::SetFillStyle {
            color: color.to_string(),
        }
    }
    fn ss(color: &str) -> CanvasOp {
        CanvasOp::SetStrokeStyle {
            color: color.to_string(),
        }
    }
    fn text(x: f64, y: f64, t: &str) -> CanvasOp {
        CanvasOp::FillText {
            x,
            y,
            text: t.to_string(),
        }
    }

    /// The full corpus of golden vectors, defined ONCE and shared by the
    /// generator and the byte-exact re-encode test. Covers every one of the 21
    /// ops, an empty frame, intern dedup on repeated colors, a multibyte
    /// `fillText`, an at-limit op count near `maxOps`, and a mixed realistic
    /// frame.
    fn vectors() -> Vec<Vector> {
        use CanvasOp::*;
        let mut out = vec![
            v(
                "empty",
                "Zero ops: header + inline canvasId + empty intern table. The irreducible floor of a frame.",
                "c",
                0,
                vec![],
            ),
            v("begin-path", "The single op beginPath.", "c", 1, vec![BeginPath]),
            v("close-path", "The single op closePath.", "c", 1, vec![ClosePath]),
            v(
                "move-to",
                "moveTo with two f64 coordinates.",
                "c",
                1,
                vec![MoveTo { x: 10.0, y: 20.5 }],
            ),
            v(
                "line-to",
                "lineTo with two f64 coordinates.",
                "c",
                1,
                vec![LineTo { x: -3.5, y: 4.25 }],
            ),
            v(
                "rect",
                "rect adds a rectangle sub-path (x,y,w,h).",
                "c",
                1,
                vec![Rect { x: 1.0, y: 2.0, w: 30.0, h: 40.0 }],
            ),
            v(
                "arc-cw",
                "arc clockwise (ccw = 0): x,y,r,start,end + a u8 bool.",
                "c",
                1,
                vec![Arc { x: 50.0, y: 50.0, r: 25.0, start: 0.0, end: 6.0, ccw: false }],
            ),
            v(
                "arc-ccw",
                "arc counter-clockwise (ccw = 1) — exercises the u8 bool = 1 path.",
                "c",
                1,
                vec![Arc { x: 50.0, y: 50.0, r: 25.0, start: 0.0, end: 3.0, ccw: true }],
            ),
            v("fill", "The single op fill.", "c", 1, vec![Fill]),
            v("stroke", "The single op stroke.", "c", 1, vec![Stroke]),
            v(
                "fill-rect",
                "fillRect (x,y,w,h).",
                "c",
                1,
                vec![FillRect { x: 0.0, y: 0.0, w: 100.0, h: 50.0 }],
            ),
            v(
                "stroke-rect",
                "strokeRect (x,y,w,h).",
                "c",
                1,
                vec![StrokeRect { x: 5.0, y: 5.0, w: 90.0, h: 40.0 }],
            ),
            v(
                "clear-rect",
                "clearRect (x,y,w,h).",
                "c",
                1,
                vec![ClearRect { x: 0.0, y: 0.0, w: 640.0, h: 480.0 }],
            ),
            v(
                "set-fill-style",
                "setFillStyle interns one color (index 0) and references it.",
                "c",
                1,
                vec![fs("#ff0000")],
            ),
            v(
                "set-stroke-style",
                "setStrokeStyle interns one color (index 0) and references it.",
                "c",
                1,
                vec![ss("rgba(0,0,0,0.5)")],
            ),
            v(
                "set-line-width",
                "setLineWidth (one f64).",
                "c",
                1,
                vec![SetLineWidth { w: 2.0 }],
            ),
            v(
                "fill-text",
                "fillText with x, y then INLINE ASCII text (u32 len + UTF-8).",
                "c",
                1,
                vec![text(10.0, 20.0, "Hello")],
            ),
            v("save", "The single op save.", "c", 1, vec![Save]),
            v("restore", "The single op restore.", "c", 1, vec![Restore]),
            v(
                "translate",
                "translate (x,y).",
                "c",
                1,
                vec![Translate { x: 12.0, y: -8.0 }],
            ),
            v("scale", "scale (x,y).", "c", 1, vec![Scale { x: 2.0, y: 0.5 }]),
            v("rotate", "rotate (angle radians).", "c", 1, vec![Rotate { angle: 0.75 }]),
            v(
                "set-transform",
                "setTransform with the full 6-element affine matrix (a,b,c,d,e,f).",
                "c",
                1,
                vec![SetTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 100.0, f: 200.0 }],
            ),
            v(
                "repeated-colors",
                "Intern dedup: '#f00' appears in THREE ops but is stored ONCE (index 0); '#00f' is index 1. The table holds two entries, not four.",
                "chart",
                7,
                vec![
                    fs("#f00"),
                    FillRect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 },
                    ss("#00f"),
                    fs("#f00"),
                    FillRect { x: 20.0, y: 0.0, w: 10.0, h: 10.0 },
                    fs("#f00"),
                ],
            ),
            v(
                "fill-text-multibyte",
                "fillText whose text is multibyte UTF-8 ('caf\u{e9} \u{2615} \u{65e5}\u{672c}\u{8a9e}'): textLen is the BYTE length, greater than the char count.",
                "c",
                2,
                vec![text(4.0, 16.0, "caf\u{e9} \u{2615} \u{65e5}\u{672c}\u{8a9e}")],
            ),
            v(
                "mixed-frame",
                "A realistic frame: save, style, filled backdrop, a stroked poly-line path, a text label, restore. Exercises intern reuse, inline text, path ops and the transform stack together.",
                "sparkline",
                42,
                vec![
                    Save,
                    fs("#1e293b"),
                    FillRect { x: 0.0, y: 0.0, w: 200.0, h: 60.0 },
                    ss("#38bdf8"),
                    SetLineWidth { w: 2.0 },
                    BeginPath,
                    MoveTo { x: 0.0, y: 50.0 },
                    LineTo { x: 40.0, y: 30.0 },
                    LineTo { x: 80.0, y: 42.0 },
                    LineTo { x: 120.0, y: 12.0 },
                    LineTo { x: 160.0, y: 24.0 },
                    LineTo { x: 200.0, y: 8.0 },
                    Stroke,
                    fs("#e2e8f0"),
                    text(4.0, 14.0, "CPU 82%"),
                    Restore,
                ],
            ),
        ];
        // At-limit op count near maxOps: exactly maxOps beginPath ops. The header
        // opCount field must equal maxOps and the frame must still encode (the
        // boundary the host pre-checks against limits.maxOps before its loop).
        out.push(v(
            "at-limit-ops",
            "An at-limit frame of exactly limits.maxOps beginPath ops — the decode-amplification boundary the host validates opCount against before its loop.",
            "c",
            9,
            vec![CanvasOp::BeginPath; contract::limits::MAX_OPS],
        ));
        out
    }

    /// Serialize one op back to the guest JSON shape (matches the DrawList JSON
    /// emission) for the golden file's `ops` array.
    fn op_to_json(op: &CanvasOp) -> String {
        // Numbers are formatted with Rust's shortest round-trip form, the same as
        // the DrawList JSON path; parsing them back yields the identical f64.
        match op {
            CanvasOp::BeginPath => "{\"op\":\"beginPath\"}".to_string(),
            CanvasOp::ClosePath => "{\"op\":\"closePath\"}".to_string(),
            CanvasOp::MoveTo { x, y } => format!("{{\"op\":\"moveTo\",\"x\":{x},\"y\":{y}}}"),
            CanvasOp::LineTo { x, y } => format!("{{\"op\":\"lineTo\",\"x\":{x},\"y\":{y}}}"),
            CanvasOp::Rect { x, y, w, h } => {
                format!("{{\"op\":\"rect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}")
            }
            CanvasOp::Arc { x, y, r, start, end, ccw } => format!(
                "{{\"op\":\"arc\",\"x\":{x},\"y\":{y},\"r\":{r},\"start\":{start},\"end\":{end},\"ccw\":{ccw}}}"
            ),
            CanvasOp::Fill => "{\"op\":\"fill\"}".to_string(),
            CanvasOp::Stroke => "{\"op\":\"stroke\"}".to_string(),
            CanvasOp::FillRect { x, y, w, h } => {
                format!("{{\"op\":\"fillRect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}")
            }
            CanvasOp::StrokeRect { x, y, w, h } => {
                format!("{{\"op\":\"strokeRect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}")
            }
            CanvasOp::ClearRect { x, y, w, h } => {
                format!("{{\"op\":\"clearRect\",\"x\":{x},\"y\":{y},\"w\":{w},\"h\":{h}}}")
            }
            CanvasOp::SetFillStyle { color } => {
                format!("{{\"op\":\"setFillStyle\",\"color\":{}}}", jstr(color))
            }
            CanvasOp::SetStrokeStyle { color } => {
                format!("{{\"op\":\"setStrokeStyle\",\"color\":{}}}", jstr(color))
            }
            CanvasOp::SetLineWidth { w } => format!("{{\"op\":\"setLineWidth\",\"w\":{w}}}"),
            CanvasOp::FillText { x, y, text } => format!(
                "{{\"op\":\"fillText\",\"x\":{x},\"y\":{y},\"text\":{}}}",
                jstr(text)
            ),
            CanvasOp::Save => "{\"op\":\"save\"}".to_string(),
            CanvasOp::Restore => "{\"op\":\"restore\"}".to_string(),
            CanvasOp::Translate { x, y } => format!("{{\"op\":\"translate\",\"x\":{x},\"y\":{y}}}"),
            CanvasOp::Scale { x, y } => format!("{{\"op\":\"scale\",\"x\":{x},\"y\":{y}}}"),
            CanvasOp::Rotate { angle } => format!("{{\"op\":\"rotate\",\"angle\":{angle}}}"),
            CanvasOp::SetTransform { a, b, c, d, e, f } => format!(
                "{{\"op\":\"setTransform\",\"a\":{a},\"b\":{b},\"c\":{c},\"d\":{d},\"e\":{e},\"f\":{f}}}"
            ),
        }
    }

    /// Minimal JSON string escaper (the color/text corpus stays within the
    /// characters this handles; multibyte UTF-8 passes through verbatim).
    fn jstr(s: &str) -> String {
        let mut out = String::from("\"");
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                _ => out.push(c),
            }
        }
        out.push('"');
        out
    }

    /// Build the full golden JSON document from the vector corpus, each vector's
    /// hex produced by the encoder oracle. Compact one-line-per-vector layout
    /// (the `ops` array inline) so the at-limit vector stays to a single line.
    fn build_golden_json() -> (String, usize) {
        let vecs = vectors();
        let mut out = String::new();
        out.push_str(
            "{\n  \"$comment\": \"GOLDEN VECTORS for the canvas binary wire protocol \
             (contracts/canvas-wire.json). Each entry pairs a source frame (canvasId, frameId \
             and the guest DrawList ops, in the SAME JSON shape the JSON path emits) with its \
             EXACT on-the-wire encoding as a lowercase hex string. The Rust encoder \
             (crates/rill-guest/src/canvas_encode.rs) is the ORACLE that produces 'hex' \
             byte-for-byte; the future TS decoder must reconstruct the frame from 'hex' — so \
             encoder and decoder cannot silently drift together. Vectors assume a FRESH encoder \
             per frame (intern table starts empty, indices from 0), header.flags = NONE, all \
             scalars little-endian, all numbers f64. GENERATED by the canvas_encode.rs test \
             (RILL_REGEN_CANVAS_GOLDEN=1 cargo test -p rill-guest --features wip-binary-protocol \
             canvas_golden_in_sync). DO NOT EDIT BY HAND.\",\n",
        );
        out.push_str("  \"version\": 1,\n");
        out.push_str("  \"vectors\": [\n");
        for (i, vec) in vecs.iter().enumerate() {
            let bytes = encode(&vec.canvas_id, vec.frame_id, &vec.ops);
            let ops_json: Vec<String> = vec.ops.iter().map(op_to_json).collect();
            let mut line = String::new();
            write!(
                line,
                "    {{ \"name\": {}, \"description\": {}, \"frame\": {{ \"canvasId\": {}, \
                 \"frameId\": {}, \"ops\": [{}] }}, \"hex\": {}, \"byteLength\": {} }}",
                jstr(vec.name),
                jstr(&vec.description),
                jstr(&vec.canvas_id),
                vec.frame_id,
                ops_json.join(","),
                jstr(&to_hex(&bytes)),
                bytes.len()
            )
            .unwrap();
            out.push_str(&line);
            if i + 1 < vecs.len() {
                out.push(',');
            }
            out.push('\n');
        }
        out.push_str("  ]\n}\n");
        (out, vecs.len())
    }

    /// Generator + drift guard. With `RILL_REGEN_CANVAS_GOLDEN=1` it (re)writes
    /// the checked-in golden; otherwise it asserts the committed file matches
    /// what the corpus would generate, so the golden can never silently drift
    /// from the encoder.
    #[test]
    fn canvas_golden_in_sync() {
        let (generated, count) = build_golden_json();
        assert!(count >= 26, "golden corpus too small: only {count} vectors");
        let path = golden_path();
        if std::env::var("RILL_REGEN_CANVAS_GOLDEN").is_ok() {
            std::fs::write(&path, generated.as_bytes()).expect("write golden");
            return;
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "read {}: {e}\nrun `RILL_REGEN_CANVAS_GOLDEN=1 cargo test -p rill-guest \
                 --features wip-binary-protocol canvas_golden_in_sync` to create it",
                path.display()
            )
        });
        assert_eq!(
            committed, generated,
            "canvas-wire.golden.json is stale; regenerate with RILL_REGEN_CANVAS_GOLDEN=1"
        );
    }

    /// The byte-exact oracle test: every committed golden vector's `frame.ops`
    /// (parsed independently from the file) re-encodes to EXACTLY its `hex`. If
    /// the encoder and the golden disagree, one of them is wrong.
    #[test]
    fn golden_vectors_encode_byte_exact() {
        let src = std::fs::read_to_string(golden_path()).expect("read golden");
        let root = Json::parse(&src).expect("parse golden json");
        let vectors = root
            .get("vectors")
            .and_then(Json::items)
            .expect("vectors[]");
        assert!(!vectors.is_empty(), "golden has no vectors");

        for entry in vectors {
            let name = entry.get("name").and_then(Json::as_str).unwrap_or("?");
            let frame = entry.get("frame").expect("vector.frame");
            let canvas_id = frame
                .get("canvasId")
                .and_then(Json::as_str)
                .expect("frame.canvasId");
            let frame_id = frame
                .get("frameId")
                .and_then(Json::as_u64)
                .expect("frame.frameId") as u32;
            let ops: Vec<CanvasOp> = frame
                .get("ops")
                .and_then(Json::items)
                .expect("frame.ops")
                .iter()
                .map(json_to_op)
                .collect();
            let expected_hex = entry.get("hex").and_then(Json::as_str).expect("vector.hex");

            let bytes = encode(canvas_id, frame_id, &ops);
            assert_eq!(
                to_hex(&bytes),
                expected_hex,
                "vector {name}: encoded bytes disagree with golden hex"
            );
            if let Some(bl) = entry.get("byteLength").and_then(Json::as_u64) {
                assert_eq!(bytes.len() as u64, bl, "vector {name}: byteLength mismatch");
            }
        }
    }

    // ---- structural / header checks ----------------------------------------

    /// The magic is 'RCNV' (0x564e4352), DISTINCT from op-batch's 'RILL', and
    /// the empty frame lays out the fixed header exactly.
    #[test]
    fn empty_frame_header_layout() {
        let bytes = encode("c", 0, &[]);
        // magic 'RCNV'
        assert_eq!(&bytes[0..4], &[0x52, 0x43, 0x4e, 0x56]);
        // version u16 = 1
        assert_eq!(&bytes[4..6], &1u16.to_le_bytes());
        // frameId u32 = 0
        assert_eq!(&bytes[6..10], &0u32.to_le_bytes());
        // opCount u32 = 0
        assert_eq!(&bytes[10..14], &0u32.to_le_bytes());
        // flags NONE + reserved 0
        assert_eq!(bytes[14], 0);
        assert_eq!(bytes[15], 0);
        // canvasId: len 1 + 'c'
        assert_eq!(&bytes[16..18], &1u16.to_le_bytes());
        assert_eq!(bytes[18], b'c');
        // intern count 0
        assert_eq!(&bytes[19..21], &0u16.to_le_bytes());
        assert_eq!(bytes.len(), 21);
    }

    /// opCount lands in the header as a u32 the host can pre-check.
    fn header_op_count(bytes: &[u8]) -> u32 {
        u32::from_le_bytes([bytes[10], bytes[11], bytes[12], bytes[13]])
    }

    // ---- cap / negative tests ----------------------------------------------

    /// At exactly maxOps the frame encodes and the header opCount equals maxOps;
    /// one op past the cap is rejected fail-closed (the decode-amplification
    /// boundary).
    #[test]
    fn op_budget_cap_is_enforced() {
        let cap = contract::limits::MAX_OPS;
        let at_cap = vec![CanvasOp::BeginPath; cap];
        let bytes = encode("c", 0, &at_cap);
        assert_eq!(header_op_count(&bytes) as usize, cap);

        let past = vec![CanvasOp::BeginPath; cap + 1];
        assert_eq!(
            Encoder::new().encode_frame("c", 0, &past),
            Err(EncodeError::TooManyOps)
        );
    }

    /// A color string past maxStringBytes is rejected (its u16 byteLen must not
    /// wrap).
    #[test]
    fn oversized_color_is_rejected() {
        let big = "#".to_string() + &"a".repeat(contract::limits::MAX_STRING_BYTES);
        assert_eq!(
            Encoder::new().encode_frame("c", 0, &[fs(&big)]),
            Err(EncodeError::StringTooLong)
        );
    }

    /// A canvasId past maxStringBytes is rejected.
    #[test]
    fn oversized_canvas_id_is_rejected() {
        let big = "x".repeat(contract::limits::MAX_STRING_BYTES + 1);
        assert_eq!(
            Encoder::new().encode_frame(&big, 0, &[]),
            Err(EncodeError::StringTooLong)
        );
    }

    /// A fillText text run past maxTextBytes is rejected fail-closed (never
    /// truncated).
    #[test]
    fn oversized_text_is_rejected() {
        let big = "a".repeat(contract::limits::MAX_TEXT_BYTES + 1);
        assert_eq!(
            Encoder::new().encode_frame("c", 0, &[text(0.0, 0.0, &big)]),
            Err(EncodeError::TextTooLong)
        );
    }

    /// More distinct colors than maxInternStrings overflows the table.
    #[test]
    fn intern_table_overflow_is_rejected() {
        let cap = contract::limits::MAX_INTERN_STRINGS;
        // cap distinct colors fit; the (cap+1)-th distinct color overflows.
        let ok: Vec<CanvasOp> = (0..cap).map(|i| fs(&format!("#{i:06x}"))).collect();
        assert!(Encoder::new().encode_frame("c", 0, &ok).is_ok());

        let over: Vec<CanvasOp> = (0..=cap).map(|i| fs(&format!("#{i:06x}"))).collect();
        assert_eq!(
            Encoder::new().encode_frame("c", 0, &over),
            Err(EncodeError::InternTableOverflow)
        );
    }

    /// A frame whose assembled bytes exceed maxBatchBytes is rejected. Built
    /// from many max-size fillText runs (each within maxTextBytes and the op
    /// budget) whose total tops the 8 MiB ceiling.
    #[test]
    fn oversized_frame_is_rejected() {
        let run = "a".repeat(contract::limits::MAX_TEXT_BYTES);
        // Each fillText ~ 1 + 8 + 8 + 4 + maxTextBytes bytes; enough runs to
        // cross maxBatchBytes while staying under maxOps.
        let per = contract::limits::MAX_TEXT_BYTES + 21;
        let n = contract::limits::MAX_BATCH_BYTES / per + 2;
        assert!(
            n <= contract::limits::MAX_OPS,
            "test would breach op budget"
        );
        let ops: Vec<CanvasOp> = (0..n).map(|_| text(0.0, 0.0, &run)).collect();
        assert_eq!(
            Encoder::new().encode_frame("c", 0, &ops),
            Err(EncodeError::FrameTooLarge)
        );
    }

    /// Non-finite f64s are rejected everywhere a coordinate/dimension/style
    /// scalar appears — parity with the JSON path's DrawList::finite latch.
    #[test]
    fn non_finite_numbers_are_rejected() {
        let cases = vec![
            CanvasOp::MoveTo {
                x: f64::NAN,
                y: 0.0,
            },
            CanvasOp::LineTo {
                x: 0.0,
                y: f64::INFINITY,
            },
            CanvasOp::Rect {
                x: 0.0,
                y: 0.0,
                w: f64::NEG_INFINITY,
                h: 1.0,
            },
            CanvasOp::Arc {
                x: 0.0,
                y: 0.0,
                r: f64::NAN,
                start: 0.0,
                end: 0.0,
                ccw: false,
            },
            CanvasOp::SetLineWidth { w: f64::INFINITY },
            CanvasOp::FillText {
                x: f64::NAN,
                y: 0.0,
                text: "x".to_string(),
            },
            CanvasOp::Rotate { angle: f64::NAN },
            CanvasOp::SetTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: f64::NAN,
                f: 0.0,
            },
        ];
        for op in cases {
            assert_eq!(
                Encoder::new().encode_frame("c", 0, std::slice::from_ref(&op)),
                Err(EncodeError::NonFiniteNumber),
                "op {op:?} with a non-finite field must be rejected"
            );
        }
    }

    /// Interning is per-frame: a color interned in one frame does NOT persist
    /// into the next (the table restarts empty, indices from 0), so two frames
    /// with the same first color produce identical intern-table bytes.
    #[test]
    fn intern_table_is_per_frame() {
        let mut enc = Encoder::new();
        let a = enc.encode_frame("c", 0, &[fs("#abc")]).unwrap();
        let b = enc.encode_frame("c", 0, &[fs("#abc")]).unwrap();
        assert_eq!(
            a, b,
            "reused encoder must not carry intern state across frames"
        );
    }
}
