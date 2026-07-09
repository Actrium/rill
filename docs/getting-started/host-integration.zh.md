# Host 集成

本指南涵盖 host 端的 Engine 配置、组件注册、事件通信、生命周期管理和无头渲染。

## Engine 实例创建和配置

`Engine` 类是中心入口点。为每个逻辑沙箱创建一个实例：

```tsx
import { Engine } from 'rill/host';

const engine = new Engine({
  timeout: 5000,
  debug: __DEV__,
  logger: console,
  onMetric: (metric) => analytics.track(metric),
  requireWhitelist: ['lodash', 'dayjs'],
  receiverMaxBatchSize: 64,
  sandbox: 'quickjs',
  diagnostics: true,
  devtools: __DEV__,
});
```

### 配置选项

| 选项 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `timeout` | `number` | `10000` | 在引擎报告超时错误之前，允许 guest 初始化的最大时间（毫秒）。 |
| `debug` | `boolean` | `false` | 启用详细日志记录和开发时警告。 |
| `logger` | `Logger` | `console` | 自定义日志记录器实现。必须提供 `log`、`warn` 和 `error` 方法。 |
| `onMetric` | `(metric) => void` | -- | 在引擎操作期间使用性能和健康指标调用的回调。 |
| `requireWhitelist` | `string[]` | `[]` | guest 代码允许 `require` 的模块名称列表。所有其他 require 调用都将被阻止。 |
| `receiverMaxBatchSize` | `number` | `32` | 在刷新到原生渲染器之前批处理在一起的 UI 变更的最大数量。 |
| `sandbox` | `string` | `'quickjs'` | 沙箱运行时选择。 |
| `diagnostics` | `boolean` | `false` | 启用诊断数据收集（渲染次数、时间分解、树快照）。 |
| `devtools` | `boolean` | `false` | 启用 Chrome DevTools Protocol (CDP) 连接，用于远程调试 guest 代码。 |

## 组件注册

默认情况下，Rill 将 guest 元素映射到标准的 React Native 原语（`View`、`Text`、`Image` 等）。要使自定义 host 组件可供 guest 代码使用，请在引擎上注册它们：

```tsx
import { NativeStepList } from './components/NativeStepList';
import { MyButton } from './components/MyButton';

engine.register({
  StepList: NativeStepList,
  CustomButton: MyButton,
});
```

注册后，guest 代码可以按名称渲染这些组件：

```tsx
// Inside guest code
import { View } from 'rill/guest';

export default function Guest() {
  return (
    <View>
      <StepList steps={['Step 1', 'Step 2']} />
      <CustomButton label="Continue" />
    </View>
  );
}
```

已注册的组件接收 guest 设置的 props，并在 host 上进行原生渲染。

## EngineView 使用

`EngineView` 是将 engine 实例连接到你的组件树的 React 组件：

```tsx
<EngineView
  engine={engine}
  source="https://cdn.example.com/guest.js"
  initialProps={{ title: 'Dashboard', userId: 42 }}
  onLoad={() => console.log('Guest loaded')}
  onError={(error) => console.error(error)}
  onDestroy={() => console.log('Guest destroyed')}
  fallback={<ActivityIndicator />}
  renderError={(error) => <Text>Failed: {error.message}</Text>}
  style={{ flex: 1 }}
/>
```

### Props

| Prop | 类型 | 必需 | 描述 |
|---|---|---|---|
| `engine` | `Engine` | 是 | 用于此视图的引擎实例。 |
| `source` | `string` | 是 | guest bundle 的 URL 或文件路径。 |
| `initialProps` | `object` | 否 | 传递给 guest 的 props，可通过 `useConfig()` 访问。 |
| `onLoad` | `() => void` | 否 | 当 guest 完成加载并渲染其第一帧时调用。 |
| `onError` | `(error: Error) => void` | 否 | 当发生 guest 错误时调用（加载失败、运行时错误、超时）。 |
| `onDestroy` | `() => void` | 否 | 当 guest 实例被销毁时调用。 |
| `fallback` | `ReactNode` | 否 | 在 guest bundle 加载时渲染。 |
| `renderError` | `(error: Error) => ReactNode` | 否 | 自定义错误 UI。如果未提供，引擎将通过 `onError` 静默报告。 |
| `style` | `ViewStyle` | 否 | 应用于包装 guest 输出的容器的样式。 |

## 事件通信

host 和 guest 通过双向事件通道进行通信。

### 向 guest 发送事件

```tsx
engine.sendEvent('THEME_CHANGED', { theme: 'dark' });
engine.sendEvent('DATA_UPDATE', { items: updatedItems });
```

### 监听来自 guest 的事件

```tsx
engine.on('message', (eventName, payload) => {
  if (eventName === 'BUTTON_CLICKED') {
    handleButtonClick(payload);
  }
});
```

事件在沙箱边界之间序列化。只有 JSON 可序列化的数据才能作为 payload 传递。

## 生命周期管理

### 销毁 Engine

当不再需要引擎时，始终销毁它以释放沙箱资源：

```tsx
useEffect(() => {
  return () => {
    engine.destroy();
  };
}, [engine]);
```

### 健康和诊断

```tsx
// 唯一的可观测性入口 -- 始终可用
const diagnostics = engine.getDiagnostics();

// 健康快照：加载/销毁标志、错误计数、receiver 节点数
const health = diagnostics.health;

// 资源使用情况：活动计时器、存活 UI 节点、已注册回调
const resources = diagnostics.resources;
```

`EngineOptions` 中的 `diagnostics` 选项只用于调整活动统计窗口与时间线分桶参数；无论是否设置，`getDiagnostics()` 都可用。

### 暂停和恢复

当视图在屏幕外时暂停 guest 执行以节省资源，然后在可见时恢复：

```tsx
engine.pause();
// ...later
engine.resume();
```

暂停会挂起计时器和事件传递。guest UI 树被保留，并从中断处恢复渲染。

## Receiver 无头模式

对于高级用例（自定义渲染器、测试、服务器端渲染），你可以在不使用 `EngineView` 的情况下通过直接创建 receiver 来使用引擎：

```tsx
const receiver = engine.createReceiver((update) => {
  // 每当 guest UI 树发生变化时调用
  console.log('Tree update:', update);
});

// 手动应用一批变更
receiver.applyBatch(batch);

// 将当前树渲染为 React 元素
const element = receiver.render();
```

无头模式使你可以完全控制如何以及何时消费 guest 输出。这对以下情况很有用：

- 在不挂载原生视图的情况下编写集成测试。
- 构建面向非 React-Native 平台的自定义渲染器。
- guest 组件的服务器端渲染。

---

另请参阅：[Guest 开发](./guest-development.zh.md) 了解 guest 端 API 表面。
