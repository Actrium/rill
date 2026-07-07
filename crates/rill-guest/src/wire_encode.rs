//! Guest-side ENCODER for the binary op-batch wire protocol.
//!
//! SINGLE SOURCE OF TRUTH: `contracts/op-batch-wire.json`. The opcode /
//! value-tag / flag numbers, the magic + protocol version, and the fail-closed
//! caps below are all GENERATED from that file by `build.rs` (see the `contract`
//! submodule); this module only lays out the record SHAPES the contract
//! declares and is locked to the byte layout by the golden-vector tests at the
//! bottom (`contracts/op-batch-wire.golden.json`).
//!
//! WORK IN PROGRESS — behind the `wip-binary-protocol` cargo feature (default
//! OFF). It is deliberately NOT wired into the live op-batch emit path; it is
//! new, side-effect-free code that produces an owned `Vec<u8>` and nothing else.
//!
//! `#![no_std]` crate: only `alloc` is used (no `std`).
//!
//! ## Cross-batch string interning
//!
//! An [`Encoder`] owns a persistent intern table. Every string on the wire (DOM
//! type names, prop keys, text, string values, method/callId, error/regexp/
//! promise fields, object keys) is emitted ONCE in the table and referenced
//! elsewhere by a u16 index. Indices are assigned in FIRST-APPEARANCE order as
//! the operations are walked, and — because the same `Encoder` is reused across
//! batches — a given string keeps a STABLE index for the whole session
//! (indices only grow as new strings appear). In v1 the FULL current table is
//! re-serialised in every batch (no delta), so each batch is independently
//! self-decodable. Construct a fresh [`Encoder`] per batch to get the
//! independent, index-from-0 behaviour the golden vectors assume.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

/// Constants generated from `contracts/op-batch-wire.json` by `build.rs`.
/// Private to this module; individual items may be unused until the protocol is
/// wired into the live path, hence the blanket allow.
#[allow(dead_code)]
mod contract {
    include!(concat!(env!("OUT_DIR"), "/op_batch_contract.rs"));
}

/// Fail-closed encode errors. Every variant means the WHOLE batch is aborted
/// and nothing partial is emitted (the caller gets an `Err`, never a truncated
/// buffer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    /// More than `limits.maxOps` operations in one batch (`header.opCount` is u16).
    TooManyOps,
    /// A distinct string past `limits.maxInternStrings` (the intern index is u16).
    InternTableOverflow,
    /// A single string longer than `limits.maxStringBytes` (its `byteLen` is u16).
    StringTooLong,
    /// A collection (props, args, array, object, map, set, removed, children)
    /// larger than `limits.maxCollectionElements` (every count field is u16).
    CollectionTooLarge,
    /// The finished batch would exceed `limits.maxBatchBytes`.
    BatchTooLarge,
    /// A `Float64`/`Date` payload that is NaN or +/-Infinity (not legal on the wire).
    NonFiniteNumber,
    /// A `Date` epochMs outside the ECMAScript Date range (`limits.maxDateMs`,
    /// +/-8.64e15 ms) — a finite but out-of-range value that a TS-host Date would
    /// treat as Invalid. Rejected so the same bytes are valid on every codec.
    DateOutOfRange,
    /// A container value (OBJECT/ARRAY/MAP/SET) nested deeper than
    /// `limits.maxValueDepth`. Depth counts container nesting only, starting at 1
    /// for a top-level value; a conformant decoder rejects the whole batch rather
    /// than recursing further, so the encoder fails closed before emitting it.
    NestingTooDeep,
    /// The batch's running total of DECODED ELEMENTS would exceed
    /// `limits.maxTotalElements`. ONE per-batch count spans every element kind
    /// together: every value node at every level (each scalar AND each
    /// container, a container counted IN ADDITION to all its descendants), PLUS
    /// every REORDER `childId`, PLUS every UPDATE `removed`/`removedProp`
    /// reference, PLUS every intern-table entry re-serialised for the batch —
    /// each counts as exactly 1. The encoder aborts the whole batch the moment
    /// the count would cross the cap, before emitting the offending element.
    TotalElementsExceeded,
}

/// A `SerializedValue` to encode. The NUMBER RULE (an integer in i32 range is
/// [`Value::Int32`], any other finite number is [`Value::Float64`]) is the
/// CALLER's responsibility — this type encodes exactly the variant it is given.
#[derive(Debug, Clone, PartialEq)]
pub enum Value<'a> {
    Null,
    Undefined,
    Bool(bool),
    Int32(i32),
    Float64(f64),
    Str(&'a str),
    /// A function reference plus its OPTIONAL DevTools debug metadata. `fn_id`
    /// is always on the wire; `name` / `source_file` / `source_line` are each
    /// optional and gated by a flags byte (see `values.FUNCTION` in the
    /// contract). Present strings are interned in first-appearance order after
    /// `fn_id`; `source_line` is an inline u32 (a 1-based line, not interned).
    Function {
        fn_id: &'a str,
        name: Option<&'a str>,
        source_file: Option<&'a str>,
        source_line: Option<u32>,
    },
    Object(Vec<(&'a str, Value<'a>)>),
    Array(Vec<Value<'a>>),
    /// Milliseconds since the Unix epoch (`Date.getTime()`).
    Date {
        epoch_ms: f64,
    },
    /// `stack` is the empty string when absent.
    Error {
        name: &'a str,
        message: &'a str,
        stack: &'a str,
    },
    Regexp {
        source: &'a str,
        flags: &'a str,
    },
    Map(Vec<(Value<'a>, Value<'a>)>),
    Set(Vec<Value<'a>>),
    Promise {
        promise_id: &'a str,
    },
}

/// One operation record. `id` is the target node id for every kind (mirrored
/// into `refId` for `RefCall` by the decoder).
#[derive(Debug, Clone, PartialEq)]
pub enum Op<'a> {
    Create {
        id: u32,
        ty: &'a str,
        props: Vec<(&'a str, Value<'a>)>,
    },
    Update {
        id: u32,
        props: Vec<(&'a str, Value<'a>)>,
        removed: Vec<&'a str>,
    },
    Delete {
        id: u32,
    },
    Append {
        id: u32,
        parent_id: u32,
        child_id: u32,
    },
    Insert {
        id: u32,
        parent_id: u32,
        child_id: u32,
        index: u16,
    },
    Remove {
        id: u32,
        parent_id: u32,
        child_id: u32,
    },
    Reorder {
        id: u32,
        parent_id: u32,
        child_ids: Vec<u32>,
    },
    Text {
        id: u32,
        text: &'a str,
    },
    RefCall {
        id: u32,
        method: &'a str,
        call_id: &'a str,
        args: Vec<Value<'a>>,
    },
}

/// A batch of operations to encode. Flags are NONE and no timestamps are
/// emitted (the v1 default the golden vectors assume).
#[derive(Debug, Clone, PartialEq)]
pub struct Batch<'a> {
    /// Monotonic sequence id chosen by the guest; opaque to the wire.
    pub batch_id: u32,
    pub ops: Vec<Op<'a>>,
}

/// A persistent encoder. Reuse one across batches for the cross-batch stable
/// intern indices; construct a fresh one per batch for independent, index-from-0
/// output.
#[derive(Debug, Default)]
pub struct Encoder {
    /// index -> string, in first-appearance (serialisation) order.
    order: Vec<String>,
    /// string -> assigned index, for O(log n) dedup.
    index: BTreeMap<String, u16>,
    /// Running count of DECODED ELEMENTS emitted for the CURRENT batch,
    /// enforcing `limits.maxTotalElements`. Reset to 0 at the start of every
    /// [`encode_batch`](Encoder::encode_batch). ONE shared count charges every
    /// element kind by 1 as it is written: each value node (scalar or
    /// container, so a container plus every descendant is counted), each REORDER
    /// `childId`, each UPDATE `removed` reference, and each intern-table entry
    /// re-serialised for the batch. Unlike the intern table it is NOT persistent
    /// across batches.
    element_count: usize,
}

impl Encoder {
    /// A fresh encoder with an empty intern table (first index will be 0).
    pub fn new() -> Self {
        Self::default()
    }

    /// Charge exactly ONE element against the per-batch total-element cap
    /// (`limits.maxTotalElements`) and fail closed the moment it would cross.
    /// Every element kind — value node, REORDER `childId`, UPDATE `removed`
    /// reference, intern-table entry — funnels through here so a single shared
    /// count bounds the whole batch's decoded footprint. Called BEFORE the
    /// element's bytes are written, so nothing partial crosses the seam.
    fn charge_element(&mut self) -> Result<(), EncodeError> {
        self.element_count += 1;
        if self.element_count > contract::limits::MAX_TOTAL_ELEMENTS {
            return Err(EncodeError::TotalElementsExceeded);
        }
        Ok(())
    }

    /// Intern `s`, returning its stable u16 index. Fails closed on a too-long
    /// string or an overflowing table.
    fn intern(&mut self, s: &str) -> Result<u16, EncodeError> {
        if let Some(&i) = self.index.get(s) {
            return Ok(i);
        }
        if s.len() > contract::limits::MAX_STRING_BYTES {
            return Err(EncodeError::StringTooLong);
        }
        // Assigning this index makes the count `order.len() + 1`; the count is a
        // u16 and every ref is a u16, so the last representable index is
        // MAX_INTERN_STRINGS - 1. Reject once the table is already full.
        if self.order.len() >= contract::limits::MAX_INTERN_STRINGS {
            return Err(EncodeError::InternTableOverflow);
        }
        let idx = self.order.len() as u16;
        self.order.push(String::from(s));
        self.index.insert(String::from(s), idx);
        Ok(idx)
    }

    /// Encode one batch to its exact on-the-wire bytes. On any [`EncodeError`]
    /// nothing is emitted (the returned `Err` carries no partial buffer), but
    /// the intern table may have grown — a persistent encoder that errors
    /// should be discarded rather than reused mid-session.
    pub fn encode_batch(&mut self, batch: &Batch) -> Result<Vec<u8>, EncodeError> {
        if batch.ops.len() > contract::limits::MAX_OPS {
            return Err(EncodeError::TooManyOps);
        }

        // The total-element cap is a PER-BATCH bound: start counting from 0.
        self.element_count = 0;

        // Emit the operations first, into their own buffer. This interns every
        // string lazily in exactly the forward-walk order the schema's intern
        // pre-pass declares, so the table serialised below ends up in
        // first-appearance order without a separate pass.
        let mut ops_buf: Vec<u8> = Vec::new();
        for op in &batch.ops {
            self.emit_op(op, &mut ops_buf)?;
        }

        let mut out: Vec<u8> = Vec::new();
        // ---- 16-byte header ----
        put_u32(&mut out, contract::MAGIC);
        put_u16(&mut out, contract::PROTOCOL_VERSION);
        put_u32(&mut out, batch.batch_id);
        put_u16(&mut out, batch.ops.len() as u16);
        out.push(contract::flags::NONE);
        out.extend_from_slice(&[0, 0, 0]); // reserved[3]

        // ---- intern table (full, in index order) ----
        // The full table is re-serialised every batch, so every entry a decoder
        // will read counts against the shared per-batch element cap: charge one
        // per entry (matching the entry count written below) before emitting any
        // of the table's bytes, failing closed if the batch's running total —
        // value nodes + REORDER childIds + UPDATE removed refs already charged
        // above, now the intern entries — would cross the cap.
        let intern_count = self.order.len();
        for _ in 0..intern_count {
            self.charge_element()?;
        }
        // `order.len()` is bounded by MAX_INTERN_STRINGS (65535), so it fits u16.
        put_u16(&mut out, intern_count as u16);
        for s in &self.order {
            put_u16(&mut out, s.len() as u16);
            out.extend_from_slice(s.as_bytes());
        }

        // ---- operations ----
        out.extend_from_slice(&ops_buf);

        if out.len() > contract::limits::MAX_BATCH_BYTES {
            return Err(EncodeError::BatchTooLarge);
        }
        Ok(out)
    }

    fn emit_op(&mut self, op: &Op, buf: &mut Vec<u8>) -> Result<(), EncodeError> {
        use contract::opcode;
        match op {
            Op::Create { id, ty, props } => {
                buf.push(opcode::CREATE);
                put_u32(buf, *id);
                let ty_ref = self.intern(ty)?;
                put_u16(buf, ty_ref);
                self.emit_props(props, buf)?;
            }
            Op::Update { id, props, removed } => {
                buf.push(opcode::UPDATE);
                put_u32(buf, *id);
                self.emit_props(props, buf)?;
                if removed.len() > contract::limits::MAX_COLLECTION_ELEMENTS {
                    return Err(EncodeError::CollectionTooLarge);
                }
                put_u16(buf, removed.len() as u16);
                for name in removed {
                    // Each removed reference the decoder will read is one
                    // element; charge it before emitting the ref bytes.
                    self.charge_element()?;
                    let r = self.intern(name)?;
                    put_u16(buf, r);
                }
            }
            Op::Delete { id } => {
                buf.push(opcode::DELETE);
                put_u32(buf, *id);
            }
            Op::Append {
                id,
                parent_id,
                child_id,
            } => {
                buf.push(opcode::APPEND);
                put_u32(buf, *id);
                put_u32(buf, *parent_id);
                put_u32(buf, *child_id);
            }
            Op::Insert {
                id,
                parent_id,
                child_id,
                index,
            } => {
                buf.push(opcode::INSERT);
                put_u32(buf, *id);
                put_u32(buf, *parent_id);
                put_u32(buf, *child_id);
                put_u16(buf, *index);
            }
            Op::Remove {
                id,
                parent_id,
                child_id,
            } => {
                buf.push(opcode::REMOVE);
                put_u32(buf, *id);
                put_u32(buf, *parent_id);
                put_u32(buf, *child_id);
            }
            Op::Reorder {
                id,
                parent_id,
                child_ids,
            } => {
                buf.push(opcode::REORDER);
                put_u32(buf, *id);
                put_u32(buf, *parent_id);
                if child_ids.len() > contract::limits::MAX_COLLECTION_ELEMENTS {
                    return Err(EncodeError::CollectionTooLarge);
                }
                put_u16(buf, child_ids.len() as u16);
                for c in child_ids {
                    // Each childId the decoder will read is one element; charge
                    // it before emitting the u32.
                    self.charge_element()?;
                    put_u32(buf, *c);
                }
            }
            Op::Text { id, text } => {
                buf.push(opcode::TEXT);
                put_u32(buf, *id);
                let t = self.intern(text)?;
                put_u16(buf, t);
            }
            Op::RefCall {
                id,
                method,
                call_id,
                args,
            } => {
                buf.push(opcode::REF_CALL);
                put_u32(buf, *id);
                let m = self.intern(method)?;
                put_u16(buf, m);
                let c = self.intern(call_id)?;
                put_u16(buf, c);
                if args.len() > contract::limits::MAX_COLLECTION_ELEMENTS {
                    return Err(EncodeError::CollectionTooLarge);
                }
                put_u16(buf, args.len() as u16);
                for a in args {
                    self.emit_value(a, buf, 1)?;
                }
            }
        }
        Ok(())
    }

    /// A `propsTable`: u16 entry count then (key internRef, value) pairs.
    fn emit_props(
        &mut self,
        props: &[(&str, Value)],
        buf: &mut Vec<u8>,
    ) -> Result<(), EncodeError> {
        if props.len() > contract::limits::MAX_COLLECTION_ELEMENTS {
            return Err(EncodeError::CollectionTooLarge);
        }
        put_u16(buf, props.len() as u16);
        for (key, value) in props {
            let k = self.intern(key)?;
            put_u16(buf, k);
            self.emit_value(value, buf, 1)?;
        }
        Ok(())
    }

    /// Encode one `SerializedValue`. `depth` is the container-nesting level of
    /// THIS value (1 for a top-level prop/arg value); it increments only when
    /// recursing into a container (OBJECT/ARRAY/MAP/SET). A container whose depth
    /// exceeds `limits.maxValueDepth` is rejected fail-closed so the guest never
    /// emits a tree a conformant decoder would refuse to recurse into.
    fn emit_value(
        &mut self,
        value: &Value,
        buf: &mut Vec<u8>,
        depth: usize,
    ) -> Result<(), EncodeError> {
        use contract::tag;

        // Count THIS value node before emitting anything for it. Every value —
        // scalar or container — is exactly 1; a container's descendants are each
        // counted by their own recursive `emit_value` call, so a container is
        // counted IN ADDITION to all of them. It shares the batch's ONE element
        // counter with REORDER childIds, UPDATE removed refs and intern entries.
        // Fail closed the moment the running total would cross the cap, before a
        // single byte of this value is written, so nothing partial crosses.
        self.charge_element()?;

        match value {
            Value::Null => buf.push(tag::NULL),
            Value::Undefined => buf.push(tag::UNDEFINED),
            Value::Bool(false) => buf.push(tag::BOOL_FALSE),
            Value::Bool(true) => buf.push(tag::BOOL_TRUE),
            Value::Int32(n) => {
                buf.push(tag::INT32);
                buf.extend_from_slice(&n.to_le_bytes());
            }
            Value::Float64(n) => {
                if !n.is_finite() {
                    return Err(EncodeError::NonFiniteNumber);
                }
                buf.push(tag::FLOAT64);
                buf.extend_from_slice(&n.to_le_bytes());
            }
            Value::Str(s) => {
                buf.push(tag::STRING);
                let r = self.intern(s)?;
                put_u16(buf, r);
            }
            Value::Function {
                fn_id,
                name,
                source_file,
                source_line,
            } => {
                buf.push(tag::FUNCTION);
                let r = self.intern(fn_id)?;
                put_u16(buf, r);
                // flags: bit0=has_name, bit1=has_sourceFile, bit2=has_sourceLine.
                let mut flags = 0u8;
                if name.is_some() {
                    flags |= 0b001;
                }
                if source_file.is_some() {
                    flags |= 0b010;
                }
                if source_line.is_some() {
                    flags |= 0b100;
                }
                buf.push(flags);
                // Present optional fields only, in fnId->name->sourceFile->
                // sourceLine order (matches the intern first-appearance walk).
                if let Some(n) = name {
                    let nr = self.intern(n)?;
                    put_u16(buf, nr);
                }
                if let Some(sf) = source_file {
                    let sr = self.intern(sf)?;
                    put_u16(buf, sr);
                }
                if let Some(sl) = source_line {
                    put_u32(buf, *sl);
                }
            }
            Value::Object(entries) => {
                if depth > contract::limits::MAX_VALUE_DEPTH {
                    return Err(EncodeError::NestingTooDeep);
                }
                buf.push(tag::OBJECT);
                if entries.len() > contract::limits::MAX_COLLECTION_ELEMENTS {
                    return Err(EncodeError::CollectionTooLarge);
                }
                put_u16(buf, entries.len() as u16);
                for (key, val) in entries {
                    let k = self.intern(key)?;
                    put_u16(buf, k);
                    self.emit_value(val, buf, depth + 1)?;
                }
            }
            Value::Array(items) => {
                if depth > contract::limits::MAX_VALUE_DEPTH {
                    return Err(EncodeError::NestingTooDeep);
                }
                buf.push(tag::ARRAY);
                if items.len() > contract::limits::MAX_COLLECTION_ELEMENTS {
                    return Err(EncodeError::CollectionTooLarge);
                }
                put_u16(buf, items.len() as u16);
                for item in items {
                    self.emit_value(item, buf, depth + 1)?;
                }
            }
            Value::Date { epoch_ms } => {
                if !epoch_ms.is_finite() {
                    return Err(EncodeError::NonFiniteNumber);
                }
                // Finite but beyond the ECMAScript Date range is Invalid on a TS
                // host; reject so every codec shares the same Date domain.
                if epoch_ms.abs() > contract::limits::MAX_DATE_MS as f64 {
                    return Err(EncodeError::DateOutOfRange);
                }
                buf.push(tag::DATE);
                buf.extend_from_slice(&epoch_ms.to_le_bytes());
            }
            Value::Error {
                name,
                message,
                stack,
            } => {
                buf.push(tag::ERROR);
                let n = self.intern(name)?;
                put_u16(buf, n);
                let m = self.intern(message)?;
                put_u16(buf, m);
                let s = self.intern(stack)?;
                put_u16(buf, s);
            }
            Value::Regexp { source, flags } => {
                buf.push(tag::REGEXP);
                let s = self.intern(source)?;
                put_u16(buf, s);
                let f = self.intern(flags)?;
                put_u16(buf, f);
            }
            Value::Map(entries) => {
                if depth > contract::limits::MAX_VALUE_DEPTH {
                    return Err(EncodeError::NestingTooDeep);
                }
                buf.push(tag::MAP);
                if entries.len() > contract::limits::MAX_COLLECTION_ELEMENTS {
                    return Err(EncodeError::CollectionTooLarge);
                }
                put_u16(buf, entries.len() as u16);
                for (k, v) in entries {
                    self.emit_value(k, buf, depth + 1)?;
                    self.emit_value(v, buf, depth + 1)?;
                }
            }
            Value::Set(values) => {
                if depth > contract::limits::MAX_VALUE_DEPTH {
                    return Err(EncodeError::NestingTooDeep);
                }
                buf.push(tag::SET);
                if values.len() > contract::limits::MAX_COLLECTION_ELEMENTS {
                    return Err(EncodeError::CollectionTooLarge);
                }
                put_u16(buf, values.len() as u16);
                for v in values {
                    self.emit_value(v, buf, depth + 1)?;
                }
            }
            Value::Promise { promise_id } => {
                buf.push(tag::PROMISE);
                let r = self.intern(promise_id)?;
                put_u16(buf, r);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mini_json::Json;
    use std::format;
    use std::string::{String, ToString};
    use std::vec::Vec;

    /// Lowercase-hex a byte buffer for comparison against the golden `hex`.
    fn to_hex(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    /// Map a golden JSON prop/arg value to an encoder [`Value`], applying the
    /// contract's NUMBER RULE (integer in i32 range -> Int32, else Float64).
    /// Only the JSON kinds the golden vectors use are needed, but objects and
    /// arrays are handled generically so richer vectors would work too.
    fn json_to_value(j: &Json) -> Value<'_> {
        match j {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Str(s) => Value::Str(s.as_str()),
            Json::Num(n) => {
                if n.fract() == 0.0 && *n >= i32::MIN as f64 && *n <= i32::MAX as f64 {
                    Value::Int32(*n as i32)
                } else {
                    Value::Float64(*n)
                }
            }
            Json::Arr(items) => Value::Array(items.iter().map(json_to_value).collect()),
            Json::Obj(entries) => {
                // A JSON object is a plain OBJECT value UNLESS it carries one of
                // the matrix fixture's two fixture-only discriminators: an "__mv"
                // sentinel (for a value JSON cannot express, e.g. undefined) or a
                // "__type" tag (function/date/error/regexp/map/set/promise, the
                // guest SerializedValue special kinds). The golden vectors use
                // neither, so their plain objects/props fall straight through.
                if let Some(mv) = j.get("__mv").and_then(Json::as_str) {
                    match mv {
                        "undefined" => Value::Undefined,
                        other => panic!("unknown __mv sentinel {other:?}"),
                    }
                } else if let Some(ty) = j.get("__type").and_then(Json::as_str) {
                    match ty {
                        "function" => Value::Function {
                            fn_id: req_str(j, "__fnId"),
                            name: j.get("__name").and_then(Json::as_str),
                            source_file: j.get("__sourceFile").and_then(Json::as_str),
                            source_line: j
                                .get("__sourceLine")
                                .and_then(Json::as_u64)
                                .map(|n| n as u32),
                        },
                        "date" => Value::Date {
                            epoch_ms: req_f64(j, "__epochMs"),
                        },
                        "error" => Value::Error {
                            name: req_str(j, "__name"),
                            message: req_str(j, "__message"),
                            // Empty/absent stack interns as "" (decoders map that
                            // back to an absent stack).
                            stack: j.get("__stack").and_then(Json::as_str).unwrap_or(""),
                        },
                        "regexp" => Value::Regexp {
                            source: req_str(j, "__source"),
                            flags: req_str(j, "__flags"),
                        },
                        "promise" => Value::Promise {
                            promise_id: req_str(j, "__promiseId"),
                        },
                        "map" => Value::Map(
                            j.get("__entries")
                                .and_then(Json::items)
                                .expect("map __entries[]")
                                .iter()
                                .map(|pair| {
                                    let kv = pair.items().expect("map entry is [key, value]");
                                    (json_to_value(&kv[0]), json_to_value(&kv[1]))
                                })
                                .collect(),
                        ),
                        "set" => Value::Set(
                            j.get("__values")
                                .and_then(Json::items)
                                .expect("set __values[]")
                                .iter()
                                .map(json_to_value)
                                .collect(),
                        ),
                        other => panic!("unknown __type discriminator {other:?}"),
                    }
                } else {
                    Value::Object(
                        entries
                            .iter()
                            .map(|(k, v)| (k.as_str(), json_to_value(v)))
                            .collect(),
                    )
                }
            }
        }
    }

    /// A required interned-string field of a `__type`-tagged matrix value.
    fn req_str<'a>(j: &'a Json, key: &str) -> &'a str {
        j.get(key)
            .and_then(Json::as_str)
            .unwrap_or_else(|| panic!("matrix value missing string field {key}"))
    }

    /// A required numeric field (used for `Date.__epochMs`, which may be
    /// negative, so `as_u64` is not enough).
    fn req_f64(j: &Json, key: &str) -> f64 {
        match j.get(key) {
            Some(Json::Num(n)) => *n,
            _ => panic!("matrix value missing number field {key}"),
        }
    }

    fn json_props(j: &Json) -> Vec<(&str, Value<'_>)> {
        match j {
            Json::Obj(entries) => entries
                .iter()
                .map(|(k, v)| (k.as_str(), json_to_value(v)))
                .collect(),
            _ => Vec::new(),
        }
    }

    fn u32_field(op: &Json, key: &str) -> u32 {
        op.get(key)
            .and_then(Json::as_u64)
            .unwrap_or_else(|| panic!("golden op missing u32 field {key}")) as u32
    }

    /// Build an [`Op`] from one golden batch operation object.
    fn json_to_op(op: &Json) -> Op<'_> {
        let kind = op.get("op").and_then(Json::as_str).expect("op.op");
        let id = u32_field(op, "id");
        match kind {
            "CREATE" => Op::Create {
                id,
                ty: op.get("type").and_then(Json::as_str).expect("CREATE.type"),
                props: op.get("props").map(json_props).unwrap_or_default(),
            },
            "UPDATE" => Op::Update {
                id,
                props: op.get("props").map(json_props).unwrap_or_default(),
                removed: op
                    .get("removedProps")
                    .and_then(Json::items)
                    .map(|items| {
                        items
                            .iter()
                            .map(|s| s.as_str().expect("removedProps entry"))
                            .collect()
                    })
                    .unwrap_or_default(),
            },
            "DELETE" => Op::Delete { id },
            "APPEND" => Op::Append {
                id,
                parent_id: u32_field(op, "parentId"),
                child_id: u32_field(op, "childId"),
            },
            "INSERT" => Op::Insert {
                id,
                parent_id: u32_field(op, "parentId"),
                child_id: u32_field(op, "childId"),
                index: u32_field(op, "index") as u16,
            },
            "REMOVE" => Op::Remove {
                id,
                parent_id: u32_field(op, "parentId"),
                child_id: u32_field(op, "childId"),
            },
            "REORDER" => Op::Reorder {
                id,
                parent_id: u32_field(op, "parentId"),
                child_ids: op
                    .get("childIds")
                    .and_then(Json::items)
                    .map(|items| items.iter().map(|c| c.as_u64().unwrap() as u32).collect())
                    .unwrap_or_default(),
            },
            "TEXT" => Op::Text {
                id,
                text: op.get("text").and_then(Json::as_str).expect("TEXT.text"),
            },
            "REF_CALL" => Op::RefCall {
                id,
                method: op.get("method").and_then(Json::as_str).expect("method"),
                call_id: op.get("callId").and_then(Json::as_str).expect("callId"),
                args: op
                    .get("args")
                    .and_then(Json::items)
                    .map(|items| items.iter().map(json_to_value).collect())
                    .unwrap_or_default(),
            },
            other => panic!("unknown golden op kind {other}"),
        }
    }

    /// Every golden vector encodes byte-for-byte to its `hex`, using a FRESH
    /// encoder per batch (index-from-0), header.flags = NONE. This is the
    /// cross-language oracle: if the encoder and the golden disagree, one of
    /// them is wrong.
    #[test]
    fn golden_vectors_encode_byte_exact() {
        let src = include_str!("../../../contracts/op-batch-wire.golden.json");
        let root = Json::parse(src).expect("parse golden json");
        let vectors = root
            .get("vectors")
            .and_then(Json::items)
            .expect("vectors[]");
        assert!(!vectors.is_empty(), "golden has no vectors");

        for vec_entry in vectors {
            let name = vec_entry.get("name").and_then(Json::as_str).unwrap_or("?");
            let batch_json = vec_entry.get("batch").expect("vector.batch");
            let expected_hex = vec_entry
                .get("hex")
                .and_then(Json::as_str)
                .expect("vector.hex")
                .to_string();

            let batch_id = batch_json
                .get("batchId")
                .and_then(Json::as_u64)
                .expect("batch.batchId") as u32;
            let ops: Vec<Op> = batch_json
                .get("operations")
                .and_then(Json::items)
                .expect("batch.operations")
                .iter()
                .map(json_to_op)
                .collect();

            let batch = Batch { batch_id, ops };
            let mut encoder = Encoder::new();
            let bytes = encoder
                .encode_batch(&batch)
                .unwrap_or_else(|e| panic!("vector {name}: encode failed: {e:?}"));

            let got_hex = to_hex(&bytes);
            assert_eq!(
                got_hex, expected_hex,
                "vector {name}: encoded bytes disagree with golden hex\n  got: {got_hex}\n  exp: {expected_hex}"
            );

            // Sanity: the vector's declared byteLength matches too.
            if let Some(bl) = vec_entry.get("byteLength").and_then(Json::as_u64) {
                assert_eq!(bytes.len() as u64, bl, "vector {name}: byteLength mismatch");
            }
        }
    }

    /// A persistent encoder keeps a stable index across batches: 'View'
    /// interned in batch 1 (index 0) is still index 0 in batch 2, and the full
    /// table is re-serialised each time.
    #[test]
    fn cross_batch_intern_is_stable() {
        let mut enc = Encoder::new();

        let b1 = Batch {
            batch_id: 1,
            ops: std::vec![Op::Create {
                id: 1,
                ty: "View",
                props: std::vec![],
            }],
        };
        let bytes1 = enc.encode_batch(&b1).unwrap();
        // Same as the `one-create` golden with batchId 1.
        assert_eq!(
            to_hex(&bytes1),
            "52494c4c0100010000000100000000000100040056696577010100000000000000"
        );

        // Second batch reuses 'View' (still index 0) and adds 'Text' (index 1).
        let b2 = Batch {
            batch_id: 2,
            ops: std::vec![
                Op::Create {
                    id: 2,
                    ty: "Text",
                    props: std::vec![],
                },
                Op::Create {
                    id: 3,
                    ty: "View",
                    props: std::vec![],
                },
            ],
        };
        let bytes2 = enc.encode_batch(&b2).unwrap();
        let hex2 = to_hex(&bytes2);
        // Full table re-serialised: count = 2, [0]='View', [1]='Text'.
        // header: magic/version/batchId=2/opCount=2/flags/reserved
        // then intern: 0200 | 0400 56696577 | 0400 54657874
        // then op CREATE id2 type=intern1(Text) props0 ; CREATE id3 type=intern0(View) props0
        assert_eq!(
            hex2,
            "52494c4c0100020000000200000000000200040056696577040054657874\
010200000001000000010300000000000000"
        );
    }

    /// A string longer than the u16 byte cap is rejected fail-closed.
    #[test]
    fn oversized_string_is_rejected() {
        let big = "x".repeat(contract::limits::MAX_STRING_BYTES + 1);
        let batch = Batch {
            batch_id: 0,
            ops: std::vec![Op::Text { id: 1, text: &big }],
        };
        let mut enc = Encoder::new();
        assert_eq!(enc.encode_batch(&batch), Err(EncodeError::StringTooLong));
    }

    /// Build a value that is `container_depth` nested arrays deep: the outermost
    /// array sits at depth 1, the innermost (empty) array at depth
    /// `container_depth`.
    fn nested_array(container_depth: usize) -> Value<'static> {
        let mut v = Value::Array(Vec::new());
        for _ in 1..container_depth {
            v = Value::Array(std::vec![v]);
        }
        v
    }

    /// A value nested exactly AT `maxValueDepth` still encodes; one level past
    /// the cap is rejected fail-closed. Depth counts container nesting starting
    /// at 1 for the top-level prop value.
    #[test]
    fn value_nesting_depth_is_enforced() {
        let cap = contract::limits::MAX_VALUE_DEPTH;

        // AT the cap: encodes fine.
        let at_cap = Batch {
            batch_id: 0,
            ops: std::vec![Op::Create {
                id: 1,
                ty: "View",
                props: std::vec![("v", nested_array(cap))],
            }],
        };
        let mut enc = Encoder::new();
        assert!(
            enc.encode_batch(&at_cap).is_ok(),
            "a value nested at exactly maxValueDepth ({cap}) must encode"
        );

        // One past the cap: rejected, nothing emitted.
        let past_cap = Batch {
            batch_id: 0,
            ops: std::vec![Op::Create {
                id: 1,
                ty: "View",
                props: std::vec![("v", nested_array(cap + 1))],
            }],
        };
        let mut enc = Encoder::new();
        assert_eq!(
            enc.encode_batch(&past_cap),
            Err(EncodeError::NestingTooDeep),
            "a value nested past maxValueDepth ({cap}) must be rejected"
        );
    }

    /// Build an Array-of-Arrays value whose total value-node count is exactly
    /// `1 + groups * (1 + per)`: the outer array (1) + `groups` inner arrays
    /// (`groups`) + `groups * per` scalars. Each level stays within
    /// `maxCollectionElements` (u16) and `maxValueDepth`.
    fn array_of_arrays(groups: usize, per: usize) -> Value<'static> {
        let inner: Vec<Value> = std::iter::repeat_with(|| Value::Int32(0))
            .take(per)
            .collect();
        let outer: Vec<Value> = std::iter::repeat_with(|| Value::Array(inner.clone()))
            .take(groups)
            .collect();
        Value::Array(outer)
    }

    /// A value tree containing EXACTLY `n` value nodes (`n >= 1`), built as an
    /// outer ARRAY of inner ARRAYs of `Int32` scalars. Every collection stays
    /// within `maxCollectionElements` and the tree is only two levels deep (well
    /// within `maxValueDepth`), so the node COUNT is the only property under
    /// test. The outer array is 1 node; the remaining `n - 1` are inner arrays
    /// (1 each) plus their scalar children.
    fn value_with_exact_nodes(n: usize) -> Value<'static> {
        assert!(n >= 1, "need at least the outer array node");
        let per_cap = contract::limits::MAX_COLLECTION_ELEMENTS;
        let mut remaining = n - 1;
        let mut inners: Vec<Value> = Vec::new();
        while remaining > 0 {
            let scalars = std::cmp::min(per_cap, remaining - 1);
            let inner: Vec<Value> = std::iter::repeat_with(|| Value::Int32(0))
                .take(scalars)
                .collect();
            inners.push(Value::Array(inner));
            remaining -= 1 + scalars;
        }
        Value::Array(inners)
    }

    /// The total-element cap (`maxTotalElements`) is enforced across the whole
    /// batch: a tree whose value nodes PLUS the CREATE's intern entries total
    /// EXACTLY the cap encodes, and one node past it is rejected fail-closed
    /// with `TotalElementsExceeded`. A value node is every scalar AND every
    /// container, each counted once (a container in addition to its
    /// descendants); the CREATE also interns its type `"View"` and prop key
    /// `"v"` — 2 more elements on the same shared counter — so the value tree
    /// carries `cap - 2` nodes to land the batch total on the cap.
    #[test]
    fn total_value_nodes_cap_is_enforced() {
        let cap = contract::limits::MAX_TOTAL_ELEMENTS;

        // Exactly AT the cap: (cap - 2) value nodes + 2 intern entries = cap.
        let at_cap = Batch {
            batch_id: 0,
            ops: std::vec![Op::Create {
                id: 1,
                ty: "View",
                props: std::vec![("v", value_with_exact_nodes(cap - 2))],
            }],
        };
        let mut enc = Encoder::new();
        assert!(
            enc.encode_batch(&at_cap).is_ok(),
            "a batch totalling exactly maxTotalElements ({cap}) elements must encode"
        );

        // One element PAST the cap: (cap - 1) value nodes + 2 intern = cap + 1.
        let past_cap = Batch {
            batch_id: 0,
            ops: std::vec![Op::Create {
                id: 1,
                ty: "View",
                props: std::vec![("v", value_with_exact_nodes(cap - 1))],
            }],
        };
        let mut enc = Encoder::new();
        assert_eq!(
            enc.encode_batch(&past_cap),
            Err(EncodeError::TotalElementsExceeded),
            "a batch exceeding maxTotalElements ({cap}) must be rejected fail-closed"
        );
    }

    /// The value-node counter is per-batch: a first batch that reaches the cap
    /// does not poison a second batch reusing the same persistent encoder.
    #[test]
    fn total_value_nodes_cap_resets_between_batches() {
        let mut enc = Encoder::new();
        // A modest batch (well under the cap) on a fresh encoder.
        let small = Batch {
            batch_id: 0,
            ops: std::vec![Op::Create {
                id: 1,
                ty: "View",
                props: std::vec![("v", array_of_arrays(2, 3))],
            }],
        };
        assert!(enc.encode_batch(&small).is_ok());
        // Reusing the SAME encoder, a second identical batch must still encode:
        // the counter reset to 0, it did not carry the first batch's total.
        assert!(enc.encode_batch(&small).is_ok());
    }

    /// Build a batch of REORDER ops whose childIds sum to exactly `total`,
    /// split into u16-legal chunks (each `<= maxCollectionElements`). REORDER
    /// carries no strings, so the intern table stays empty and the batch's total
    /// decoded-element count equals `total` exactly (childIds only).
    fn reorder_batch(total: usize) -> Batch<'static> {
        let chunk = contract::limits::MAX_COLLECTION_ELEMENTS;
        let mut ops: Vec<Op> = Vec::new();
        let mut remaining = total;
        let mut id = 1u32;
        while remaining > 0 {
            let n = std::cmp::min(chunk, remaining);
            ops.push(Op::Reorder {
                id,
                parent_id: 0,
                child_ids: std::vec![0u32; n],
            });
            remaining -= n;
            id += 1;
        }
        Batch { batch_id: 0, ops }
    }

    /// Build a batch of UPDATE ops carrying exactly `total_refs` removed-prop
    /// references, split into u16-legal chunks. Every reference is the SAME
    /// name `"x"`, so the intern table holds a single entry: the batch's total
    /// decoded-element count is `total_refs` removed refs + 1 intern entry (the
    /// props tables are empty, contributing no value nodes).
    fn removed_refs_batch(total_refs: usize) -> Batch<'static> {
        let chunk = contract::limits::MAX_COLLECTION_ELEMENTS;
        let mut ops: Vec<Op> = Vec::new();
        let mut remaining = total_refs;
        let mut id = 1u32;
        while remaining > 0 {
            let n = std::cmp::min(chunk, remaining);
            ops.push(Op::Update {
                id,
                props: Vec::new(),
                removed: std::vec!["x"; n],
            });
            remaining -= n;
            id += 1;
        }
        Batch { batch_id: 0, ops }
    }

    /// REORDER childIds are charged to the SAME per-batch element counter as
    /// value nodes: a batch whose childIds total exactly `maxTotalElements`
    /// encodes, and one childId past it is rejected fail-closed. This is the
    /// non-value collection path the cap previously left uncharged.
    #[test]
    fn reorder_childids_count_toward_total_elements_cap() {
        let cap = contract::limits::MAX_TOTAL_ELEMENTS;

        // Exactly AT the cap (childIds only, empty intern table): encodes.
        let mut enc = Encoder::new();
        assert!(
            enc.encode_batch(&reorder_batch(cap)).is_ok(),
            "a batch of exactly maxTotalElements ({cap}) REORDER childIds must encode"
        );

        // One childId PAST the cap: rejected, nothing emitted.
        let mut enc2 = Encoder::new();
        assert_eq!(
            enc2.encode_batch(&reorder_batch(cap + 1)),
            Err(EncodeError::TotalElementsExceeded),
            "a batch exceeding maxTotalElements ({cap}) via REORDER childIds must be rejected"
        );
    }

    /// UPDATE removed refs AND the intern-table entries share the one per-batch
    /// element counter with value nodes. `cap - 1` removed refs plus the single
    /// `"x"` intern entry is exactly `maxTotalElements` and encodes; `cap`
    /// removed refs plus that entry is one past the cap and is rejected — which
    /// also proves the intern entry itself is charged (refs alone equal the cap
    /// and only the extra entry tips it over).
    #[test]
    fn removed_props_and_intern_entries_count_toward_total_elements_cap() {
        let cap = contract::limits::MAX_TOTAL_ELEMENTS;

        // (cap - 1) removed refs + 1 intern entry = cap: encodes.
        let mut enc = Encoder::new();
        assert!(
            enc.encode_batch(&removed_refs_batch(cap - 1)).is_ok(),
            "(maxTotalElements - 1) removed refs plus the 1 intern entry must encode"
        );

        // cap removed refs + 1 intern entry = cap + 1: rejected fail-closed.
        let mut enc2 = Encoder::new();
        assert_eq!(
            enc2.encode_batch(&removed_refs_batch(cap)),
            Err(EncodeError::TotalElementsExceeded),
            "maxTotalElements removed refs plus the intern entry must be rejected"
        );
    }

    /// NaN/Infinity are not legal on the wire.
    #[test]
    fn non_finite_float_is_rejected() {
        let batch = Batch {
            batch_id: 0,
            ops: std::vec![Op::Create {
                id: 1,
                ty: "View",
                props: std::vec![("w", Value::Float64(f64::INFINITY))],
            }],
        };
        let mut enc = Encoder::new();
        assert_eq!(enc.encode_batch(&batch), Err(EncodeError::NonFiniteNumber));
    }

    #[test]
    fn non_finite_date_is_rejected() {
        let mut enc = Encoder::new();
        let batch = Batch {
            batch_id: 0,
            ops: std::vec![Op::Create {
                id: 1,
                ty: "View",
                props: std::vec![("d", Value::Date { epoch_ms: f64::NAN })],
            }],
        };
        assert_eq!(enc.encode_batch(&batch), Err(EncodeError::NonFiniteNumber));
    }

    #[test]
    fn out_of_range_date_is_rejected_at_cap_ok() {
        // Finite but beyond the ECMAScript Date range (limits.maxDateMs) is
        // Invalid on a TS host, so every codec rejects it (parity, no drift);
        // a Date exactly at the cap still encodes.
        let mut enc = Encoder::new();
        let over = Batch {
            batch_id: 0,
            ops: std::vec![Op::Create {
                id: 1,
                ty: "View",
                props: std::vec![("d", Value::Date { epoch_ms: 1e300 })],
            }],
        };
        assert_eq!(enc.encode_batch(&over), Err(EncodeError::DateOutOfRange));

        let mut enc2 = Encoder::new();
        let at_cap = Batch {
            batch_id: 0,
            ops: std::vec![Op::Create {
                id: 2,
                ty: "View",
                props: std::vec![("d", Value::Date { epoch_ms: 8.64e15 })],
            }],
        };
        assert!(enc2.encode_batch(&at_cap).is_ok());
    }

    // ========================================================================
    // Comprehensive op x value CONFORMANCE matrix
    //
    // The 4 hand golden vectors pin the format byte-exact; this generates a
    // BROAD corpus (every op kind x every value type, plus nested/mixed combos
    // and boundary sizes) from THIS encoder — the pinned oracle — into the
    // checked-in fixture contracts/op-batch-wire.matrix.json. The TS and C++
    // decoder suites load the SAME file and decode each vector back to its
    // batch, so all three codecs lock to one artifact. Regenerate the fixture
    // with `RILL_REGEN_MATRIX=1 cargo test -p rill-guest \
    //   --features wip-binary-protocol matrix_fixture_in_sync`.
    // ========================================================================

    /// Build and encode one batch from its `batch` JSON (fresh encoder,
    /// index-from-0). Shared by the matrix generator and the re-encode test.
    fn encode_batch_json(batch_json: &Json) -> Vec<u8> {
        let batch_id = batch_json
            .get("batchId")
            .and_then(Json::as_u64)
            .expect("batch.batchId") as u32;
        let ops: Vec<Op> = batch_json
            .get("operations")
            .and_then(Json::items)
            .expect("batch.operations")
            .iter()
            .map(json_to_op)
            .collect();
        Encoder::new()
            .encode_batch(&Batch { batch_id, ops })
            .expect("matrix vector must encode")
    }

    // ---- JSON text builders (values) ---------------------------------------
    //
    // Each returns a fragment of JSON text in the guest SerializedValue shape,
    // with two fixture-only encodings JSON cannot express directly: undefined is
    // {"__mv":"undefined"} and a Date is {"__type":"date","__epochMs":N} (the
    // decoders rebuild the ISO string from the ms).

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

    fn mv_null() -> String {
        "null".to_string()
    }
    fn mv_undefined() -> String {
        "{\"__mv\":\"undefined\"}".to_string()
    }
    fn mv_bool(b: bool) -> String {
        if b { "true" } else { "false" }.to_string()
    }
    fn mv_int(n: i32) -> String {
        n.to_string()
    }
    /// A raw JSON numeric literal chosen to land on FLOAT64 (fractional, or a
    /// whole number outside i32 range).
    fn mv_float(lit: &str) -> String {
        lit.to_string()
    }
    fn mv_string(s: &str) -> String {
        jstr(s)
    }
    fn mv_function(fn_id: &str) -> String {
        format!("{{\"__type\":\"function\",\"__fnId\":{}}}", jstr(fn_id))
    }
    /// A function value carrying the full DevTools debug metadata
    /// (name + sourceFile + sourceLine present, so its flags byte is 0x07).
    fn mv_function_full(fn_id: &str, name: &str, source_file: &str, source_line: u32) -> String {
        format!(
            "{{\"__type\":\"function\",\"__fnId\":{},\"__name\":{},\"__sourceFile\":{},\"__sourceLine\":{}}}",
            jstr(fn_id),
            jstr(name),
            jstr(source_file),
            source_line
        )
    }
    fn mv_date(ms: i64) -> String {
        format!("{{\"__type\":\"date\",\"__epochMs\":{ms}}}")
    }
    fn mv_error(name: &str, message: &str, stack: Option<&str>) -> String {
        match stack {
            Some(s) => format!(
                "{{\"__type\":\"error\",\"__name\":{},\"__message\":{},\"__stack\":{}}}",
                jstr(name),
                jstr(message),
                jstr(s)
            ),
            None => format!(
                "{{\"__type\":\"error\",\"__name\":{},\"__message\":{}}}",
                jstr(name),
                jstr(message)
            ),
        }
    }
    fn mv_regexp(source: &str, flags: &str) -> String {
        format!(
            "{{\"__type\":\"regexp\",\"__source\":{},\"__flags\":{}}}",
            jstr(source),
            jstr(flags)
        )
    }
    fn mv_promise(id: &str) -> String {
        format!("{{\"__type\":\"promise\",\"__promiseId\":{}}}", jstr(id))
    }
    fn mv_object(pairs: &[(&str, String)]) -> String {
        let body: Vec<String> = pairs
            .iter()
            .map(|(k, v)| format!("{}:{}", jstr(k), v))
            .collect();
        format!("{{{}}}", body.join(","))
    }
    fn mv_array(items: &[String]) -> String {
        format!("[{}]", items.join(","))
    }
    fn mv_map(entries: &[(String, String)]) -> String {
        let body: Vec<String> = entries.iter().map(|(k, v)| format!("[{k},{v}]")).collect();
        format!("{{\"__type\":\"map\",\"__entries\":[{}]}}", body.join(","))
    }
    fn mv_set(items: &[String]) -> String {
        format!("{{\"__type\":\"set\",\"__values\":[{}]}}", items.join(","))
    }

    // ---- JSON text builders (operations) -----------------------------------

    fn props_json(props: &[(&str, String)]) -> String {
        let body: Vec<String> = props
            .iter()
            .map(|(k, v)| format!("{}:{}", jstr(k), v))
            .collect();
        format!("{{{}}}", body.join(","))
    }
    fn op_create(id: u32, ty: &str, props: &[(&str, String)]) -> String {
        format!(
            "{{\"op\":\"CREATE\",\"id\":{},\"type\":{},\"props\":{}}}",
            id,
            jstr(ty),
            props_json(props)
        )
    }
    fn op_update(id: u32, props: &[(&str, String)], removed: &[&str]) -> String {
        if removed.is_empty() {
            format!(
                "{{\"op\":\"UPDATE\",\"id\":{},\"props\":{}}}",
                id,
                props_json(props)
            )
        } else {
            let r: Vec<String> = removed.iter().map(|s| jstr(s)).collect();
            format!(
                "{{\"op\":\"UPDATE\",\"id\":{},\"props\":{},\"removedProps\":[{}]}}",
                id,
                props_json(props),
                r.join(",")
            )
        }
    }
    fn op_delete(id: u32) -> String {
        format!("{{\"op\":\"DELETE\",\"id\":{id}}}")
    }
    fn op_append(id: u32, parent: u32, child: u32) -> String {
        format!("{{\"op\":\"APPEND\",\"id\":{id},\"parentId\":{parent},\"childId\":{child}}}")
    }
    fn op_insert(id: u32, parent: u32, child: u32, index: u16) -> String {
        format!(
            "{{\"op\":\"INSERT\",\"id\":{id},\"parentId\":{parent},\"childId\":{child},\"index\":{index}}}"
        )
    }
    fn op_remove(id: u32, parent: u32, child: u32) -> String {
        format!("{{\"op\":\"REMOVE\",\"id\":{id},\"parentId\":{parent},\"childId\":{child}}}")
    }
    fn op_reorder(id: u32, parent: u32, child_ids: &[u32]) -> String {
        let c: Vec<String> = child_ids.iter().map(|x| x.to_string()).collect();
        format!(
            "{{\"op\":\"REORDER\",\"id\":{id},\"parentId\":{parent},\"childIds\":[{}]}}",
            c.join(",")
        )
    }
    fn op_text(id: u32, text: &str) -> String {
        format!("{{\"op\":\"TEXT\",\"id\":{},\"text\":{}}}", id, jstr(text))
    }
    fn op_refcall(id: u32, method: &str, call_id: &str, args: &[String]) -> String {
        // refId is NOT on the wire (decoder mirrors id); include it so the
        // decoded op compares equal to the batch JSON.
        format!(
            "{{\"op\":\"REF_CALL\",\"id\":{},\"refId\":{},\"method\":{},\"callId\":{},\"args\":[{}]}}",
            id,
            id,
            jstr(method),
            jstr(call_id),
            args.join(",")
        )
    }
    fn make_batch(batch_id: u32, ops: &[String]) -> String {
        format!(
            "{{\"version\":1,\"batchId\":{},\"operations\":[{}]}}",
            batch_id,
            ops.join(",")
        )
    }

    /// The 16 value variants, each labelled, used to build the op x value cells.
    fn value_catalog() -> Vec<(&'static str, String)> {
        std::vec![
            ("null", mv_null()),
            ("undefined", mv_undefined()),
            ("bool-false", mv_bool(false)),
            ("bool-true", mv_bool(true)),
            ("int32", mv_int(42)),
            ("float64", mv_float("3.5")),
            ("string", mv_string("hello")),
            ("function", mv_function("fn_7")),
            (
                "object",
                mv_object(&[("a", mv_int(1)), ("b", mv_string("x"))])
            ),
            (
                "array",
                mv_array(&[mv_int(1), mv_bool(true), mv_null(), mv_string("x")])
            ),
            ("date", mv_date(1_700_000_000_000)),
            (
                "error",
                mv_error("TypeError", "boom", Some("at f (a.js:1:2)"))
            ),
            ("regexp", mv_regexp("ab+c", "gi")),
            (
                "map",
                mv_map(&[(mv_string("a"), mv_int(1)), (mv_string("b"), mv_date(0)),])
            ),
            ("set", mv_set(&[mv_int(1), mv_int(2), mv_string("x")])),
            ("promise", mv_promise("p_3")),
        ]
    }

    /// (name, batch JSON) for every matrix vector. Deterministic order.
    fn matrix_specs() -> Vec<(String, String)> {
        let mut specs: Vec<(String, String)> = Vec::new();
        let mut batch_id = 1000u32;
        let mut push = |specs: &mut Vec<(String, String)>, name: &str, ops: &[String]| {
            specs.push((name.to_string(), make_batch(batch_id, ops)));
            batch_id += 1;
        };

        // op x value: the value-carrying ops are CREATE props, UPDATE props and
        // REF_CALL args. Each carries all 16 value variants.
        for (label, v) in value_catalog() {
            let ops = std::vec![op_create(1, "View", &[("v", v)])];
            push(&mut specs, &format!("create-value-{label}"), &ops);
        }
        for (label, v) in value_catalog() {
            let ops = std::vec![op_update(1, &[("v", v)], &[])];
            push(&mut specs, &format!("update-value-{label}"), &ops);
        }
        for (label, v) in value_catalog() {
            let ops = std::vec![op_refcall(1, "measure", "call_1", &[v])];
            push(&mut specs, &format!("refcall-arg-{label}"), &ops);
        }

        // Structural ops (no SerializedValue payload).
        push(&mut specs, "op-delete", &std::vec![op_delete(5)]);
        push(&mut specs, "op-append", &std::vec![op_append(0, 1, 2)]);
        push(&mut specs, "op-insert", &std::vec![op_insert(0, 1, 2, 3)]);
        push(&mut specs, "op-remove", &std::vec![op_remove(0, 1, 2)]);
        push(
            &mut specs,
            "op-reorder",
            &std::vec![op_reorder(1, 0, &[5, 4, 3, 2, 1])],
        );
        push(
            &mut specs,
            "op-text",
            &std::vec![op_text(9, "Hello, world")],
        );
        push(
            &mut specs,
            "op-update-removed-props",
            &std::vec![op_update(1, &[("k", mv_int(1))], &["old1", "old2"])],
        );

        // Boundary sizes / edge scalars.
        push(
            &mut specs,
            "boundary-int32-min",
            &std::vec![op_create(1, "View", &[("v", mv_int(i32::MIN))])],
        );
        push(
            &mut specs,
            "boundary-int32-max",
            &std::vec![op_create(1, "View", &[("v", mv_int(i32::MAX))])],
        );
        push(
            &mut specs,
            "boundary-float64-large",
            &std::vec![op_create(1, "View", &[("v", mv_float("3000000000"))])],
        );
        push(
            &mut specs,
            "boundary-float64-negative",
            &std::vec![op_create(1, "View", &[("v", mv_float("-2.5"))])],
        );
        push(
            &mut specs,
            "boundary-date-min",
            &std::vec![op_create(
                1,
                "View",
                &[("v", mv_date(-8_640_000_000_000_000))]
            )],
        );
        push(
            &mut specs,
            "boundary-date-max",
            &std::vec![op_create(
                1,
                "View",
                &[("v", mv_date(8_640_000_000_000_000))]
            )],
        );
        push(
            &mut specs,
            "boundary-empty-string",
            &std::vec![op_create(1, "View", &[("v", mv_string(""))])],
        );
        push(
            &mut specs,
            "boundary-empty-object",
            &std::vec![op_create(1, "View", &[("v", mv_object(&[]))])],
        );
        push(
            &mut specs,
            "boundary-empty-array",
            &std::vec![op_create(1, "View", &[("v", mv_array(&[]))])],
        );
        push(
            &mut specs,
            "boundary-empty-map",
            &std::vec![op_create(1, "View", &[("v", mv_map(&[]))])],
        );
        push(
            &mut specs,
            "boundary-empty-set",
            &std::vec![op_create(1, "View", &[("v", mv_set(&[]))])],
        );
        let hundred: Vec<String> = (0..100).map(mv_int).collect();
        push(
            &mut specs,
            "boundary-array-100-ints",
            &std::vec![op_create(1, "View", &[("v", mv_array(&hundred))])],
        );
        let long = "x".repeat(1000);
        push(
            &mut specs,
            "boundary-long-string",
            &std::vec![op_text(1, &long)],
        );

        // Nested / mixed combos.
        let nested_obj = mv_object(&[
            (
                "arr",
                mv_array(&[
                    mv_int(1),
                    mv_map(&[(mv_string("k"), mv_bool(true))]),
                    mv_set(&[mv_string("s")]),
                ]),
            ),
            ("when", mv_date(0)),
            ("re", mv_regexp("^a$", "i")),
        ]);
        push(
            &mut specs,
            "nested-object-mixed",
            &std::vec![op_create(1, "View", &[("data", nested_obj)])],
        );
        let deep = mv_array(&[mv_array(&[mv_array(&[mv_array(&[mv_array(&[mv_int(
            7,
        )])])])])]);
        push(
            &mut specs,
            "nested-array-depth-5",
            &std::vec![op_create(1, "View", &[("v", deep)])],
        );
        let special_map = mv_map(&[
            (mv_date(0), mv_function("f1")),
            (mv_int(1), mv_error("E", "m", None)),
            (mv_array(&[mv_int(1)]), mv_promise("p")),
        ]);
        push(
            &mut specs,
            "nested-map-special-kv",
            &std::vec![op_create(1, "View", &[("m", special_map)])],
        );
        let mixed_props: Vec<(&str, String)> = std::vec![
            ("s", mv_string("txt")),
            ("n", mv_int(-3)),
            ("f", mv_float("1.25")),
            ("b", mv_bool(false)),
            ("nil", mv_null()),
            ("u", mv_undefined()),
            ("d", mv_date(123_456_789)),
            ("fn", mv_function("cb")),
        ];
        push(
            &mut specs,
            "mixed-props-create",
            &std::vec![op_create(1, "View", &mixed_props)],
        );
        let mixed_args = std::vec![
            mv_int(1),
            mv_string("a"),
            mv_bool(true),
            mv_null(),
            mv_undefined(),
            mv_array(&[mv_int(9)]),
            mv_object(&[("k", mv_int(2))]),
        ];
        push(
            &mut specs,
            "mixed-args-refcall",
            &std::vec![op_refcall(3, "scrollTo", "c9", &mixed_args)],
        );
        let multi = std::vec![
            op_create(
                1,
                "View",
                &[
                    ("id", mv_string("root")),
                    ("style", mv_object(&[("flex", mv_int(1))])),
                ],
            ),
            op_create(2, "Text", &[]),
            op_append(0, 1, 2),
            op_text(2, "Hi"),
            op_update(1, &[("id", mv_string("main"))], &["style"]),
            op_reorder(1, 0, &[2]),
            op_refcall(2, "focus", "c1", &[]),
            op_delete(2),
        ];
        push(&mut specs, "multi-op-mixed", &multi);

        // FUNCTION debug metadata: name + sourceFile + sourceLine all present
        // (flags byte 0x07), exercised in all three value-carrying op contexts.
        // The bare-function case (flags=0) is already covered by the
        // create/update/refcall "function" cells above.
        push(
            &mut specs,
            "create-value-function-debug",
            &std::vec![op_create(
                1,
                "View",
                &[("v", mv_function_full("fn_9", "onPress", "App.tsx", 42))],
            )],
        );
        push(
            &mut specs,
            "update-value-function-debug",
            &std::vec![op_update(
                1,
                &[("v", mv_function_full("fn_9", "onPress", "App.tsx", 42))],
                &[],
            )],
        );
        push(
            &mut specs,
            "refcall-arg-function-debug",
            &std::vec![op_refcall(
                1,
                "measure",
                "call_1",
                &[mv_function_full("fn_9", "onPress", "App.tsx", 42)],
            )],
        );

        specs
    }

    fn matrix_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../contracts/op-batch-wire.matrix.json")
    }

    /// Render the whole fixture as pretty-ish JSON text (one vector per line).
    fn build_matrix_json() -> (String, usize) {
        let specs = matrix_specs();
        let comment = jstr(
            "GENERATED by the rill-guest wire_encode matrix generator \
             (RILL_REGEN_MATRIX=1 cargo test -p rill-guest --features \
             wip-binary-protocol matrix_fixture_in_sync). DO NOT EDIT BY HAND. \
             Comprehensive op x value conformance corpus for the op-batch binary \
             wire protocol (contracts/op-batch-wire.json), produced by the pinned \
             Rust encoder (the oracle). All three codecs lock to this file: Rust \
             re-encodes each vector byte-exact, the TS and C++ decoders decode it \
             back to `batch`. Two fixture-only value encodings JSON cannot express \
             directly: undefined is {\"__mv\":\"undefined\"}, and a Date is \
             {\"__type\":\"date\",\"__epochMs\":N} (decoders rebuild the ISO string \
             from the ms). Everything else is the exact decoded SerializedValue \
             shape.",
        );
        let mut out = String::new();
        out.push_str("{\n");
        out.push_str("  \"$comment\": ");
        out.push_str(&comment);
        out.push_str(",\n");
        out.push_str("  \"version\": 1,\n");
        out.push_str("  \"vectors\": [\n");
        for (i, (name, batch)) in specs.iter().enumerate() {
            let batch_j = Json::parse(batch)
                .unwrap_or_else(|e| panic!("vector {name}: built invalid batch json: {e}"));
            let bytes = encode_batch_json(&batch_j);
            let hex = to_hex(&bytes);
            out.push_str("    { \"name\": ");
            out.push_str(&jstr(name));
            out.push_str(", \"batch\": ");
            out.push_str(batch);
            out.push_str(", \"hex\": ");
            out.push_str(&jstr(&hex));
            out.push_str(&format!(", \"byteLength\": {} }}", bytes.len()));
            if i + 1 < specs.len() {
                out.push(',');
            }
            out.push('\n');
        }
        out.push_str("  ]\n");
        out.push_str("}\n");
        (out, specs.len())
    }

    /// The generator + drift guard. With `RILL_REGEN_MATRIX=1` set it (re)writes
    /// the checked-in fixture; otherwise it asserts the committed file matches
    /// what the specs would generate, so the fixture can never silently drift
    /// from the encoder. Read-only in CI (no write, no race with the loader).
    #[test]
    fn matrix_fixture_in_sync() {
        let (generated, count) = build_matrix_json();
        assert!(
            count >= 60,
            "matrix should be a comprehensive corpus, only built {count} vectors"
        );
        let path = matrix_path();
        if std::env::var("RILL_REGEN_MATRIX").is_ok() {
            std::fs::write(&path, generated.as_bytes()).expect("write matrix fixture");
            return;
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "read {}: {e}\nrun `RILL_REGEN_MATRIX=1 cargo test -p rill-guest \
                 --features wip-binary-protocol matrix_fixture_in_sync` to create it",
                path.display()
            )
        });
        assert_eq!(
            committed, generated,
            "op-batch-wire.matrix.json is stale; regenerate with RILL_REGEN_MATRIX=1"
        );
    }

    /// Rust re-encodes every matrix vector byte-exact — the encoder half of the
    /// three-codec conformance loop (the mirror of the golden re-encode test,
    /// reading the checked-in fixture independently of the generator).
    #[test]
    fn matrix_vectors_encode_byte_exact() {
        let src = std::fs::read_to_string(matrix_path()).expect("read matrix fixture");
        let root = Json::parse(&src).expect("parse matrix json");
        let vectors = root
            .get("vectors")
            .and_then(Json::items)
            .expect("vectors[]");
        assert!(!vectors.is_empty(), "matrix has no vectors");
        for vec_entry in vectors {
            let name = vec_entry.get("name").and_then(Json::as_str).unwrap_or("?");
            let batch_json = vec_entry.get("batch").expect("vector.batch");
            let expected_hex = vec_entry
                .get("hex")
                .and_then(Json::as_str)
                .expect("vector.hex");
            let bytes = encode_batch_json(batch_json);
            let got = to_hex(&bytes);
            assert_eq!(
                got, expected_hex,
                "vector {name}: re-encode disagrees with the matrix hex"
            );
            if let Some(bl) = vec_entry.get("byteLength").and_then(Json::as_u64) {
                assert_eq!(bytes.len() as u64, bl, "vector {name}: byteLength mismatch");
            }
        }
    }
}
