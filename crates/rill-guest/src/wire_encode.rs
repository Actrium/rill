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
    /// Only `__fnId` is on the wire in v1 (name/sourceFile are reserved).
    Function {
        fn_id: &'a str,
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
            Value::Function { fn_id } => {
                buf.push(tag::FUNCTION);
                let r = self.intern(fn_id)?;
                put_u16(buf, r);
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
            Json::Obj(entries) => Value::Object(
                entries
                    .iter()
                    .map(|(k, v)| (k.as_str(), json_to_value(v)))
                    .collect(),
            ),
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
}
