# Event Bus

Event Bus 是一个在 C++ 中实现的跨租户发布/订阅系统。它用基于通道的模型替换了点对点 `sendEvent`,支持系统广播、受控的租户间通信、速率限制和持久事件缓冲。

## 设计

**文件:** `native/core/src/EventBus.h`

Event Bus 由 `RillTenantManager` 拥有,并在所有租户之间共享。它提供:

- **基于通道的路由** -- 事件发布到命名通道,只有该通道的订阅者接收它们
- **策略执行** -- 每个通道可以限制谁可以发布、发布速度以及载荷大小
- **传递模式** -- 广播(所有订阅者)、单播(单个租户)、多播(多个租户)
- **持久缓冲** -- 选定的通道缓冲事件以在租户恢复后重放
- **线程安全** -- 所有操作都受 `std::shared_mutex` 保护,使用复制然后分派模式

## 事件结构

```cpp
struct BusEvent {
  uint64_t id;                    // 自动分配的唯一 ID
  std::string channel;            // 通道名称
  std::string name;               // 通道内的事件名称
  std::string payload;            // JSON 序列化的载荷
  size_t payloadBytes;            // 载荷大小,用于配额执行
  EventPriority priority;         // Critical、High、Normal、Low
  double timestamp;               // 事件创建时间
  TenantId sourceTenantId;        // 0 = 系统事件
};
```

## 事件优先级

| 优先级 | 值 | 用例 |
|---|---|---|
| `Critical` | 0 | 系统级警报(OOM、崩溃警告) |
| `High` | 1 | 应用状态变化(前台/后台) |
| `Normal` | 2 | 业务事件 |
| `Low` | 3 | 诊断、日志 |

## 通道策略

每个通道都有一个可配置的策略,控制访问和吞吐量:

```cpp
struct ChannelPolicy {
  std::string name;
  bool systemOnly;           // 只有系统(tenantId=0)可以发布
  bool requirePermission;    // 订阅需要明确权限
  uint32_t maxSubscribers;   // 0 = 无限制
  uint32_t maxEventsPerSecond; // 0 = 无限制
  size_t maxPayloadBytes;    // 默认: 64KB
  bool persistent;           // 为离线租户缓冲事件
};
```

> **注意:** `requirePermission` 虽然在 `ChannelPolicy` 中声明,但**当前并未被执行** —— `subscribe()` 只检查通道是否存在以及是否超过 `maxSubscribers`,`EventBus.cpp` 中没有任何权限检查逻辑。

### 内置通道

> **状态: 规划中 —— 尚未实现。** 下表仅为设计草案。Event Bus 目前启动时**没有任何**预注册通道(`EventBus::EventBus() = default;`),`native/core` 中也没有任何代码创建这些通道。所有通道都必须显式创建 —— C++ 侧调用 `createChannel()`,或 JSI 侧调用 `busCreateChannel(policy)` —— 之后才能发布或订阅。

| 通道(规划中) | systemOnly | persistent | 描述 |
|---|---|---|---|
| `system` | 是 | 是 | 系统生命周期事件(启动、关闭、OOM) |
| `lifecycle` | 是 | 是 | 应用状态转换(前台、后台、内存警告) |
| `network.status` | 是 | 否 | 网络连接变化 |
| `tenant.messages` | 否 | 否 | 租户可写的租户间消息传递(速率限制) |

## 发布操作

### publish(event)

通用发布。执行通道策略:
1. 检查通道是否存在
2. 检查 `systemOnly` 限制
3. 检查载荷大小是否超过 `maxPayloadBytes`
4. 检查速率限制(`maxEventsPerSecond`)
5. 收集匹配的订阅者(持有锁)
6. 释放锁
7. 分派给收集的订阅者

如果被任何策略检查阻止,则返回 `false`。

### broadcast(channel, name, payload)

向通道的所有订阅者进行系统范围的广播。设置 `sourceTenantId = 0`(系统事件)。用于应用生命周期事件和系统通知。

```cpp
bool broadcast(const std::string& channel,
               const std::string& name,
               const std::string& payload,
               EventPriority priority = EventPriority::Normal);
```

### unicast(targetId, channel, name, payload)

将事件传递给属于单个租户的订阅。仅调用该租户在指定通道上的处理程序。

```cpp
bool unicast(TenantId targetId,
             const std::string& channel,
             const std::string& name,
             const std::string& payload);
```

### multicast(targetIds, channel, name, payload)

将事件传递给属于多个指定租户的订阅。

```cpp
bool multicast(const std::vector<TenantId>& targetIds,
               const std::string& channel,
               const std::string& name,
               const std::string& payload);
```

## 订阅管理

### subscribe(tenantId, channel, filter, handler)

为匹配过滤器模式的通道上的事件注册处理程序。

```cpp
uint64_t subscribe(TenantId tenantId,
                   const std::string& channel,
                   const std::string& eventFilter,
                   std::function<void(const BusEvent&)> handler);
```

成功时返回订阅 ID(非零),失败时返回 0。

### 事件过滤器模式

- `"*"` -- 匹配通道上的所有事件
- `"app.*"` -- 前缀匹配(匹配 `app.start`、`app.stop`、`app.config.change`)
- `"user.login"` -- 精确匹配

`matchesFilter` 函数实现模式匹配:
- 如果过滤器是 `"*"`,则匹配所有内容
- 如果过滤器以 `".*"` 结尾,事件名称必须以 `.*` 之前的前缀开始
- 否则,需要精确的字符串相等性

### unsubscribe(subscriptionId)

通过其 ID 取消单个订阅。

### unsubscribeAll(tenantId)

取消租户的所有订阅。在 `destroyTenant` 期间自动调用,以防止悬空处理程序。

## 持久事件重放

`persistent = true` 的通道在环形缓冲区中缓冲事件(`kMaxPersistentEvents = 100`)。当租户在暂停后恢复时,它可以请求重放暂停期间发生的事件:

```cpp
std::vector<BusEvent> getReplayEvents(const std::string& channel,
                                       double sinceTimestamp) const;
```

这将返回所有 `timestamp > sinceTimestamp` 的缓冲事件。

## 实现: 复制然后分派模式

为了避免在处理程序执行期间持有互斥锁(如果处理程序发布事件或修改订阅,这可能会死锁),总线使用两阶段方法:

1. **收集阶段**(持有锁)-- 将匹配的 `Subscription` 对象复制到本地向量中
2. **分派阶段**(无锁)-- 迭代复制的向量并调用每个处理程序

```cpp
// 阶段 1: 收集(持有锁)
auto subs = collectSubscribers(channel, eventName);

// 阶段 2: 分派(释放锁)
dispatchToCollected(subs, event);
```

这种模式用内存(复制订阅数据)换取安全性(分派期间无锁)。

## 速率限制

每个通道的速率限制使用时间戳的滑动窗口:

```cpp
std::unordered_map<std::string, std::deque<double>> channelRateWindows_;
```

在每次发布时,删除超过 1 秒的时间戳。如果剩余计数超过 `maxEventsPerSecond`,则丢弃事件并计入 `totalDropped`。

## 统计信息

```cpp
struct Stats {
  uint64_t totalPublished;        // 成功发布的事件
  uint64_t totalDelivered;        // 单个处理程序调用
  uint64_t totalDropped;          // 丢弃的事件(速率限制、策略)
  size_t activeSubscriptions;     // 当前活动的订阅
  size_t activeChannels;          // 已创建的通道(所有已创建通道,无论是否有订阅者)
};
```

发布/投递/丢弃计数器为 `std::atomic`,更新时无需阻塞;`getStats()` 本身会持有共享锁,以对通道数和订阅数做一致快照。

## JSI 集成

Event Bus 通过 `RillTenantManager` 上的 JSI 方法暴露给 TypeScript:

| JSI 方法 | 描述 |
|---|---|
| `busPublish(opts)` | 使用完整事件选项发布 |
| `busBroadcast(channel, name, payload)` | 系统广播 |
| `busUnicast(targetId, channel, name, payload)` | 单租户传递 |
| `busMulticast(targetIds, channel, name, payload)` | 多租户传递 |
| `busSubscribe(tenantId, channel, filter)` | 订阅(处理程序通过 onEvent 回调路由) |
| `busUnsubscribe(subscriptionId)` | 取消订阅 |
| `busUnsubscribeAll(tenantId)` | 取消租户的所有订阅 |
| `busGetStats()` | 获取统计信息 |
| `busCreateChannel(policy)` | 创建自定义通道 |
