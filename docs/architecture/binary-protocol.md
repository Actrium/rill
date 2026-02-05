# Binary Instruction Protocol

The binary instruction protocol (P3) replaces JSON serialization for Guest-to-Host operation batches. It provides significant size reduction and encoding speed improvements for the high-frequency rendering pipeline.

## Design Motivation

JSON serialization is the default encoding for operation batches, but it has measurable overhead:
- String formatting and escaping for every property name and value
- Redundant repetition of property names across operations (e.g., "style", "children", "onPress")
- Base-10 numeric encoding instead of native binary representation
- No structural sharing between batches

The binary protocol addresses these with:
- **String interning** -- Property names and repeated values are stored once in a lookup table and referenced by 16-bit index
- **Native numeric encoding** -- int32 as 4 bytes, float64 as 8 bytes
- **Fixed-size headers** -- No parsing ambiguity, predictable memory layout
- **Zero-copy decoding** -- Decoder can iterate operations without allocating new strings

### Target KPIs

| Metric | JSON Baseline | Binary Target |
|---|---|---|
| Encoding 100 CREATEs | ~2ms | <0.4ms |
| Transfer size (100 CREATEs) | ~15KB | <6KB |
| Decoding | Full parse | Zero-copy iterator |
| String intern hit rate | N/A | >85% |

## Wire Format

```
+---------------------------------------------+
|  Header (16 bytes)                          |
+---------------------------------------------+
|  String Intern Table                         |
+---------------------------------------------+
|  Operations [opCount]                        |
+---------------------------------------------+
```

### Header (16 bytes, fixed)

```
Offset  Size  Field        Description
0       4     magic        0x4C4C4952 ("RILL" in little-endian)
4       2     version      Protocol version (currently 1)
6       4     batchId      Batch sequence number
10      2     opCount      Number of operations in this batch
12      1     flags        Batch flags
13      3     reserved     Must be zero
```

**Batch Flags:**
- `0x01` DELTA_INTERN -- String intern table uses delta encoding from previous batch
- `0x02` STRUCTURAL_ONLY -- Batch contains only structural ops (no props)
- `0x04` HAS_TIMESTAMPS -- Operations include optional timestamp fields

### String Intern Table

```
u16   count              Number of strings
[StringEntry] entries    Repeated `count` times

StringEntry:
  u16   length           UTF-8 byte length
  u8[]  utf8             UTF-8 bytes (NOT null-terminated)
```

Maximum 65535 strings, maximum 65535 bytes per string. Strings are referenced by their zero-based index throughout the rest of the batch.

Common strings like component type names (`"View"`, `"Text"`), property names (`"style"`, `"onPress"`), and function IDs appear once in the table and are reused across all operations.

### Operation Encoding

Each operation starts with a `u8` opType followed by type-specific fields.

#### OpType Values

| Value | Operation | Payload |
|---|---|---|
| `0x01` | CREATE | `u32 nodeId, u16 typeRef, PropTable props` |
| `0x02` | UPDATE | `u32 nodeId, PropTable props, u16 removedCount, u16[] removedProps` |
| `0x03` | DELETE | `u32 nodeId` |
| `0x04` | APPEND | `u32 nodeId, u32 parentId, u32 childId` |
| `0x05` | INSERT | `u32 nodeId, u32 parentId, u32 childId, u16 index` |
| `0x06` | REMOVE | `u32 nodeId, u32 parentId, u32 childId` |
| `0x07` | REORDER | `u32 nodeId, u32 parentId, u16 childCount, u32[] childIds` |
| `0x08` | TEXT | `u32 nodeId, u16 textRef` |
| `0x09` | REF_CALL | `u32 nodeId, u16 methodRef, u16 callIdRef, ValueArray args` |

If `HAS_TIMESTAMPS` flag is set, each operation is followed by a `u64 timestamp` field.

### PropTable Layout

```
u16   count              Number of properties
[PropEntry] entries      Repeated `count` times

PropEntry:
  u16   keyRef           Intern table index for property name
  u8    valueType        ValueType enum
  [payload]              Type-dependent payload
```

### ValueType Encoding

| Value | Type | Payload |
|---|---|---|
| `0x00` | null | (none) |
| `0x01` | undefined | (none) |
| `0x02` | false | (none) |
| `0x03` | true | (none) |
| `0x04` | int32 | 4 bytes, signed little-endian |
| `0x05` | float64 | 8 bytes, IEEE 754 little-endian |
| `0x06` | string | `u16` intern index |
| `0x07` | function | `u16` fnId intern index (+ optional metadata) |
| `0x08` | object | Nested PropTable |
| `0x09` | array | ValueArray (`u16 count` + entries) |
| `0x0A` | date | `float64` timestamp (ms since epoch) |
| `0x0B` | error | `u16 name + u16 message + u16 stack` (intern indexes) |
| `0x0C` | regexp | `u16 source + u16 flags` (intern indexes) |
| `0x0D` | map | `u16 count` + `[key, value]` pairs |
| `0x0E` | set | `u16 count` + values |
| `0x0F` | promise | `u16` promiseId intern index |

Optimized numeric types (`0x10`-`0x14`: int8, int16, uint8, uint16, float32) are reserved for future use.

### Function Metadata

Minimal function encoding is just a `u16` intern index for the fnId string. When DevTools is enabled, extended metadata follows:

```
u16   fnIdRef
u8    hasMetadata (0 or 1)
[if hasMetadata]:
  u16   nameRef          Intern index for function name
  u16   sourceFileRef    Intern index for source file path
  u32   sourceLine       Source line number
```

## Implementation

### InstructionEncoder (C++) -- `native/core/src/InstructionEncoder.h`

Encodes JSI values from the sandbox runtime into the binary format:
- Maintains an intern table that grows across the encoding session
- Writes to a pre-allocated `std::vector<uint8_t>` buffer
- Tracks encoding statistics (output bytes, intern hit rate, encoding time)

### InstructionDecoder (C++) -- `native/core/src/InstructionDecoder.h`

Decodes binary data on the host side:
- Zero-copy: reads string data directly from the input buffer via `string_view`
- Lazy props: can skip PropTable data without fully parsing it
- Provides an operation iterator interface for streaming decode
- Reports decoding statistics (input bytes, ops decoded, props skipped)

### BinaryEncoder (TypeScript) -- `src/guest/runtime/reconciler/binary-encoder.ts`

Guest-side encoder that produces `ArrayBuffer` from operation batches. Used when the guest reconciler is configured for binary output. The `ArrayBuffer` is passed directly through `__rill_sendBatch` and detected by Bridge for binary-mode processing.

### BinaryProtocol (TypeScript) -- `src/shared/bridge/binary-protocol.ts`

TypeScript-side binary protocol support utilities shared between guest and host.

## Error Handling

The decoder reports structured errors via `DecodeError` enum:

| Error | Description |
|---|---|
| `INVALID_MAGIC` | First 4 bytes do not match `0x4C4C4952` |
| `VERSION_MISMATCH` | Protocol version not supported |
| `TRUNCATED_HEADER` | Buffer too small for 16-byte header |
| `TRUNCATED_DATA` | Buffer ends mid-operation |
| `INVALID_OP_TYPE` | Unknown operation type byte |
| `INVALID_VALUE_TYPE` | Unknown value type byte |
| `INTERN_INDEX_OUT_OF_BOUNDS` | String reference exceeds table size |
| `MALFORMED_PROP_TABLE` | PropTable structure inconsistency |
| `MALFORMED_VALUE_ARRAY` | ValueArray structure inconsistency |
| `BUFFER_OVERFLOW` | Write exceeds buffer capacity |

## Performance Data

From implementation benchmarks (100 CREATE operations with typical props):

| Metric | Result |
|---|---|
| Encoding time | ~0.394ms (vs ~2ms JSON) |
| Transfer size | ~5,260 bytes (vs ~15,000 bytes JSON) |
| Size reduction | ~65% |
| String intern hit rate | 88.5% |
| Encoding speedup | ~5x |
