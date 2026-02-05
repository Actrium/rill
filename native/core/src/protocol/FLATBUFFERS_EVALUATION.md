# FlatBuffers vs 自定义协议评估

## 评估目的

在 P3 正式实施前，验证是否应该采用 FlatBuffers 替代自定义二进制协议。

## KPI 目标

| 指标 | Baseline (JSON) | Target |
|------|-----------------|--------|
| 编码 100 CREATE | ~2ms | < 0.4ms |
| 传输体积 100 CREATE | ~15KB | < 6KB |
| 解码延迟 (header) | ~1ms | < 0.1ms |
| 解码延迟 (full) | ~2ms | < 0.6ms |

## 关键对比维度

### 1. String Interning

**自定义协议**：
- 支持跨 batch 持久化 intern table
- 高频字符串（"View", "style", "onPress"）只传输一次
- 后续 batch 仅传 u16 索引

**FlatBuffers**：
- 仅 buffer 内 `CreateSharedString` 去重
- 每个 batch 重新传输所有字符串
- 无跨 batch 复用机制

### 2. 编码体积

**自定义协议（REMOVE 操作）**：
```
opType(1) + nodeId(4) + parentId(4) + childId(4) = 13 bytes
```

**FlatBuffers（REMOVE 操作）**：
```
vtable_offset(4) + vtable(~8) + fields(12) = ~24 bytes
```

### 3. 零拷贝解码

**自定义协议**：
- 手写 iterator + lazy decode
- string_view 指向原始 buffer
- 需要手动维护

**FlatBuffers**：
- 原生支持，自动生成代码
- 类型安全的访问器
- 无需手动维护

### 4. 代码维护

**自定义协议**：
- 需手写 C++ encoder/decoder (~600 行)
- 需手写 TS encoder (~400 行)
- 格式变更需同步修改两端

**FlatBuffers**：
- Schema 定义 (~50 行)
- 自动生成 C++/TS 代码
- Schema 演进有内建支持

## 评估方案

### Phase 1: FlatBuffers 原型 (1-2 天)

1. 定义 FlatBuffers schema
2. 生成 C++/TS binding
3. 实现基础 encoder/decoder

### Phase 2: 基准对比

```bash
# 运行基准测试
bun test native/core/test/benchmark_protocol.cpp

# 对比指标：
# - 编码时间 (100/500/1000 CREATE)
# - 输出体积
# - 解码时间 (header-only / full)
# - 内存分配次数
```

### Phase 3: 决策

| 场景 | 选择 |
|------|------|
| FlatBuffers 满足所有 KPI | 采用 FlatBuffers |
| FlatBuffers 体积超标 >20% | 自定义协议 |
| 性能接近，FlatBuffers 体积稍大 | 混合方案 |

## 混合方案设计

如果 FlatBuffers 性能可接受但体积偏大，可考虑：

```
FlatBuffers (基础结构)
    + String Intern Pool (跨 batch 复用)
```

实现方式：
1. FlatBuffers schema 中字符串使用 `uint16` 索引
2. 外置 intern table 随首个 batch 发送
3. 后续 batch 仅引用索引

## 当前进度

- [x] 自定义协议 InstructionFormat.h 定义完成
- [x] 自定义协议 C++ Decoder/Encoder 实现完成
- [x] 自定义协议 TS Encoder 实现完成
- [ ] FlatBuffers schema 定义
- [ ] FlatBuffers binding 生成
- [ ] 基准测试实现
- [ ] 对比报告

## 预期结论

基于设计分析，**自定义协议在 Rill 场景下预计优势明显**：

1. **String Intern 跨 batch 持久化** 是核心优化点
   - DOM 操作中组件名和 prop 名高频重复
   - 单个应用生命周期内，去重率可达 80%+

2. **体积优势**：预计比 FlatBuffers 小 30-50%

3. **性能相当**：编码/解码速度两者接近

4. **代价**：需要维护手写编解码器 (~1000 行 C++ + ~400 行 TS)

**建议**：如果时间紧张，直接使用自定义协议；如果有余裕，先做 FlatBuffers 原型验证。
