# 二进制指令协议

二进制指令协议(P3)替换了 Guest 到 Host 操作批次的 JSON 序列化。它为高频渲染管道提供了显著的大小减少和编码速度改进。

## 设计动机

JSON 序列化是操作批次的默认编码,但它有可测量的开销:
- 每个属性名称和值的字符串格式化和转义
- 跨操作的属性名称冗余重复(例如 "style"、"children"、"onPress")
- 十进制数字编码而不是原生二进制表示
- 批次之间没有结构共享

二进制协议通过以下方式解决这些问题:
- **字符串驻留** -- 属性名称和重复值在查找表中存储一次,并通过 16 位索引引用
- **原生数字编码** -- int32 为 4 字节,float64 为 8 字节
- **固定大小的头部** -- 无解析歧义,可预测的内存布局
- **零拷贝解码** -- 解码器可以迭代操作而无需分配新字符串

### 目标 KPI

| 指标 | JSON 基准 | 二进制目标 |
|---|---|---|
| 编码 100 个 CREATE | ~2ms | <0.4ms |
| 传输大小(100 个 CREATE) | ~15KB | <6KB |
| 解码 | 完整解析 | 零拷贝迭代器 |
| 字符串驻留命中率 | N/A | >85% |

## 线路格式

```
+---------------------------------------------+
|  Header (16 字节)                           |
+---------------------------------------------+
|  String Intern Table                         |
+---------------------------------------------+
|  Operations [opCount]                        |
+---------------------------------------------+
```

### Header (16 字节,固定)

```
Offset  Size  Field        描述
0       4     magic        0x4C4C4952(小端序的 "RILL")
4       2     version      协议版本(当前为 1)
6       4     batchId      批次序列号
10      2     opCount      此批次中的操作数
12      1     flags        批次标志
13      3     reserved     必须为零
```

**批次标志:**
- `0x01` DELTA_INTERN -- 字符串驻留表使用来自先前批次的增量编码
- `0x02` STRUCTURAL_ONLY -- 批次仅包含结构操作(无属性)
- `0x04` HAS_TIMESTAMPS -- 操作包括可选的时间戳字段

### String Intern Table

```
u16   count              字符串数量
[StringEntry] entries    重复 `count` 次

StringEntry:
  u16   length           UTF-8 字节长度
  u8[]  utf8             UTF-8 字节(非空终止)
```

最多 65535 个字符串,每个字符串最多 65535 字节。字符串在批次的其余部分通过其从零开始的索引引用。

常见字符串如组件类型名称(`"View"`、`"Text"`)、属性名称(`"style"`、`"onPress"`)和函数 ID 在表中出现一次,并在所有操作中重用。

### 操作编码

每个操作以 `u8` opType 开始,后跟特定于类型的字段。

#### OpType 值

| 值 | 操作 | 载荷 |
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

如果设置了 `HAS_TIMESTAMPS` 标志,每个操作后跟一个 `u64 timestamp` 字段。

### PropTable 布局

```
u16   count              属性数量
[PropEntry] entries      重复 `count` 次

PropEntry:
  u16   keyRef           属性名称的驻留表索引
  u8    valueType        ValueType 枚举
  [payload]              依赖于类型的载荷
```

### ValueType 编码

| 值 | 类型 | 载荷 |
|---|---|---|
| `0x00` | null | (无) |
| `0x01` | undefined | (无) |
| `0x02` | false | (无) |
| `0x03` | true | (无) |
| `0x04` | int32 | 4 字节,有符号小端序 |
| `0x05` | float64 | 8 字节,IEEE 754 小端序 |
| `0x06` | string | `u16` 驻留索引 |
| `0x07` | function | `u16` fnId 驻留索引(+ 可选元数据) |
| `0x08` | object | 嵌套 PropTable |
| `0x09` | array | ValueArray(`u16 count` + 条目) |
| `0x0A` | date | `float64` 时间戳(自纪元以来的毫秒) |
| `0x0B` | error | `u16 name + u16 message + u16 stack`(驻留索引) |
| `0x0C` | regexp | `u16 source + u16 flags`(驻留索引) |
| `0x0D` | map | `u16 count` + `[key, value]` 对 |
| `0x0E` | set | `u16 count` + 值 |
| `0x0F` | promise | `u16` promiseId 驻留索引 |

优化的数字类型(`0x10`-`0x14`: int8、int16、uint8、uint16、float32)保留供将来使用。

### 函数元数据

最小函数编码只是 fnId 字符串的 `u16` 驻留索引。当启用 DevTools 时,扩展元数据如下:

```
u16   fnIdRef
u8    hasMetadata(0 或 1)
[如果 hasMetadata]:
  u16   nameRef          函数名称的驻留索引
  u16   sourceFileRef    源文件路径的驻留索引
  u32   sourceLine       源代码行号
```

## 实现

### InstructionEncoder (C++) -- `native/core/src/InstructionEncoder.h`

将沙箱运行时的 JSI 值编码为二进制格式:
- 维护一个在编码会话中增长的驻留表
- 写入预分配的 `std::vector<uint8_t>` 缓冲区
- 跟踪编码统计信息(输出字节、驻留命中率、编码时间)

### InstructionDecoder (C++) -- `native/core/src/InstructionDecoder.h`

在 host 端解码二进制数据:
- 零拷贝: 通过 `string_view` 直接从输入缓冲区读取字符串数据
- 延迟属性: 可以跳过 PropTable 数据而无需完全解析
- 为流式解码提供操作迭代器接口
- 报告解码统计信息(输入字节、解码的操作、跳过的属性)

### BinaryEncoder (TypeScript) -- `src/guest/runtime/reconciler/binary-encoder.ts`

Guest 端编码器,从操作批次生成 `ArrayBuffer`。当 guest reconciler 配置为二进制输出时使用。`ArrayBuffer` 直接通过 `__rill_sendBatch` 传递,并由 Bridge 检测以进行二进制模式处理。

### BinaryProtocol (TypeScript) -- `src/shared/bridge/binary-protocol.ts`

Guest 和 host 之间共享的 TypeScript 端二进制协议支持工具。

## 错误处理

解码器通过 `DecodeError` 枚举报告结构化错误:

| 错误 | 描述 |
|---|---|
| `INVALID_MAGIC` | 前 4 字节不匹配 `0x4C4C4952` |
| `VERSION_MISMATCH` | 不支持的协议版本 |
| `TRUNCATED_HEADER` | 缓冲区太小,无法容纳 16 字节头部 |
| `TRUNCATED_DATA` | 缓冲区在操作中间结束 |
| `INVALID_OP_TYPE` | 未知操作类型字节 |
| `INVALID_VALUE_TYPE` | 未知值类型字节 |
| `INTERN_INDEX_OUT_OF_BOUNDS` | 字符串引用超出表大小 |
| `MALFORMED_PROP_TABLE` | PropTable 结构不一致 |
| `MALFORMED_VALUE_ARRAY` | ValueArray 结构不一致 |
| `BUFFER_OVERFLOW` | 写入超出缓冲区容量 |

## 性能数据

来自实现基准测试(100 个具有典型属性的 CREATE 操作):

| 指标 | 结果 |
|---|---|
| 编码时间 | ~0.394ms(对比 ~2ms JSON) |
| 传输大小 | ~5,260 字节(对比 ~15,000 字节 JSON) |
| 大小减少 | ~65% |
| 字符串驻留命中率 | 88.5% |
| 编码加速 | ~5x |
