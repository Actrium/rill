# Rill

轻量级、无头、沙箱化的 React Native 动态 UI 渲染引擎。

> **rill** /rɪl/ n. 小溪 - 象征轻量、流畅的数据流动

## 特性

- **React 开发体验**：使用 JSX 和 Hooks 编写 Guest
- **完整沙箱隔离**：多种沙箱后端（VM/JSC/Hermes/QuickJS/WASM）自动选择；Guest 崩溃不影响 Host
- **轻量高效**：无 WebView 开销，原生渲染性能
- **统一桥接层**：类型安全的序列化，自动回调生命周期管理
- **灵活扩展**：支持注册自定义业务组件

## 包导出

```
rill/
├── /host            # Host 运行时（Engine, useEngineView）
├── /host/preset     # Host UI 工具（EngineView, DefaultComponents）
├── /guest           # Guest SDK（组件、Hooks、平台 API）
├── /devtools        # 开发工具
└── /cli             # CLI 构建工具
```

> `import ... from 'rill'` 被刻意禁用，请使用以上明确入口。


## 快速开始

### 安装

```bash
# 使用 bun
bun add rill

# 使用 npm
npm install rill
```

**Peer 依赖：**
- React 18.2+ 或 19.x
- react-reconciler（匹配你的 React 版本）
- react-native（RN 应用）或 react-dom（Web 应用）

### Host 集成

```tsx
import React, { useMemo, useEffect } from 'react';
import { Engine } from 'rill/host';
import { EngineView } from 'rill/host/preset';
import { NativeStepList } from './components/NativeStepList';

function App() {
  // 1. 创建引擎实例
  const engine = useMemo(() => new Engine({
    debug: __DEV__,
    timeout: 5000,
  }), []);

  // 2. 注册自定义组件
  useEffect(() => {
    engine.register({
      StepList: NativeStepList,
    });
  }, [engine]);

  // 3. 渲染 Guest
  return (
    <EngineView
      engine={engine}
      source="https://cdn.example.com/guest.js"
      initialProps={{ theme: 'dark' }}
      onLoad={() => console.log('Guest 已加载')}
      onError={(err) => console.error('Guest 错误:', err)}
      renderError={(error) => <Text>错误: {error.message}</Text>}
    />
  );
}
```

> React Native 原生 JSI 沙箱集成（JSC/Hermes/QuickJS）见：`docs/guides/native-integration.zh.md`。

### Guest 开发

```tsx
import { View, Text, TouchableOpacity, useHostEvent, useConfig } from 'rill/guest';

export default function MyGuest() {
  const config = useConfig<{ theme: string }>();

  useHostEvent('REFRESH', () => {
    console.log('Host 请求刷新');
  });

  return (
    <View style={{ flex: 1, padding: 20 }}>
      <Text style={{ fontSize: 24 }}>来自 Guest 的问候！</Text>
      <Text>主题: {config.theme}</Text>
      <TouchableOpacity onPress={() => console.log('已点击!')}>
        <Text>点击我</Text>
      </TouchableOpacity>
    </View>
  );
}
```

### 构建 Guest

```bash
# 构建 bundle
bunx rill build src/guest.tsx -o dist/bundle.js

# 开发模式
bunx rill build src/guest.tsx --watch --no-minify --sourcemap

# 分析 bundle
bunx rill analyze dist/bundle.js
```

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                       Host App (React Native)                    │
├─────────────────────────────────────────────────────────────────┤
│  EngineView → Engine → 沙箱后端                                  │
│                            │                                     │
│                            ▼                                     │
│                    ┌───────────────────┐                        │
│                    │  Guest Bundle.js  │                        │
│                    │  (React + SDK)    │                        │
│                    └───────────────────┘                        │
│                            │                                     │
│                            ▼                                     │
│                    Reconciler (VNode Ops)                       │
│                            │                                     │
│                    ┌───────┴───────┐                            │
│                    │    Bridge     │  ← 统一序列化层            │
│                    └───────┬───────┘                            │
│                            ▼                                     │
│                    Receiver → Registry → 原生组件树             │
└─────────────────────────────────────────────────────────────────┘
```

## 模块概览

| 模块 | 导入路径 | 描述 |
|------|----------|------|
| Host | `rill/host` | Host 运行时：Engine、useEngineView |
| Host Preset | `rill/host/preset` | Host UI 工具：EngineView、DefaultComponents |
| Guest | `rill/guest` | Guest 模块：组件、Hooks |
| DevTools | `rill/devtools` | 调试工具：操作日志、树形检查 |
| CLI | `rill` (bin) / `rill/cli` | Guest 打包器（基于 Bun） |

## API

### Engine

```typescript
import { Engine } from 'rill/host';

const engine = new Engine({
  timeout: 5000,        // 执行超时（毫秒）
  debug: false,         // 调试模式
});

// 注册组件
engine.register({ ComponentName: ReactComponent });

// 加载 Guest
await engine.loadBundle(bundleUrl, initialProps);

// 发送事件给 Guest
engine.sendEvent('EVENT_NAME', payload);

// 监听 Guest 消息
engine.on('message', (msg) => console.log(msg.event, msg.payload));

// 健康检查
const health = engine.getHealth();

// 销毁
engine.destroy();
```

### SDK Hooks

```typescript
import { useHostEvent, useConfig, useSendToHost, useRemoteRef, TextInputRef } from 'rill/guest';

// 订阅 Host 事件
useHostEvent('EVENT_NAME', (payload) => { /* 处理 */ });

// 获取初始配置
const config = useConfig<ConfigType>();

// 发送消息给 Host
const send = useSendToHost();
send('EVENT_NAME', payload);

// 调用 Host 组件方法 (Remote Ref)
const [inputRef, remoteInput] = useRemoteRef<TextInputRef>();
await remoteInput?.invoke('focus');
```

### 默认组件

- `View` - 容器组件
- `Text` - 文本组件
- `Image` - 图片组件
- `ScrollView` - 滚动容器
- `TouchableOpacity` - 可触摸组件
- `TextInput` - 文本输入
- `FlatList` - 虚拟化列表
- `Button` - 按钮组件
- `Switch` - 开关组件
- `ActivityIndicator` - 加载指示器

## Host ↔ Guest 通信

Guest 使用 SDK hook `useHostEvent(event, callback)` 订阅，Host 通过 `engine.sendEvent(eventName, payload)` 发送。

**Guest 示例：**
```tsx
import { View, Text, useHostEvent, useSendToHost } from 'rill/guest';

export default function Guest() {
  const send = useSendToHost();

  useHostEvent('PING', (payload) => {
    send('PONG', { received: payload });
  });

  return <View><Text>就绪</Text></View>;
}
```

**Host 示例：**
```tsx
import { Engine } from 'rill/host';

const engine = new Engine();
engine.on('message', (m) => console.log(m.event, m.payload));
engine.sendEvent('PING', { timestamp: Date.now() });
```

## 文档

- [API 参考](./docs/API.zh.md) - 完整 API 文档
- [用户指南](./docs/GUIDE.zh.md) - 入门教程和最佳实践
- [架构设计](./docs/ARCHITECTURE.zh.md) - 系统架构详解
- [生产指南](./docs/PRODUCTION_GUIDE.zh.md) - 生产部署清单
- [内部文档](./docs/internals/) - 桥接层、序列化细节

## 开发

```bash
# 安装依赖
bun install

# 运行测试
bun test

# 类型检查
bun run typecheck

# 代码检查
bun run lint
```

## 测试

```bash
npm run test:all      # 运行所有测试 (单元 + Native + E2E)
npm test              # 仅单元测试
npm run test:native   # Native C++/ObjC++ 测试 (QuickJS/JSC)
npm run test:e2e      # Web Worker E2E 测试
npm run test:e2e:wasm # WASM 沙箱 E2E 测试
npm run test:e2e:rn   # React Native macOS E2E 测试
```

## 许可证

Apache-2.0
