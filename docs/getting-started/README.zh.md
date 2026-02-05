# 快速入门

本指南将引导你在 React Native 项目中设置 Rill、编写你的第一个 guest 组件，并在 host 端进行渲染。

## 前置要求

- **React** 18.2+ 或 19.x
- **Bun** 运行时（用于构建 guest bundles）
- **React Native** 0.72+（或用于 web 目标的 react-dom）

## 安装

```bash
bun add rill
```

对等依赖项（如果尚未安装，请安装它们）：

```bash
bun add react react-reconciler react-native
```

Rill 支持 React 18.2+ 和 19.x。`react-reconciler` 包是 guest 运行时自定义协调器所必需的。

## 编写 Guest 组件

guest 组件在 Rill 的沙箱环境中运行。它使用 `rill/guest` 模块来访问原语、配置和与 host 的通信。

在 `src/guest.tsx` 创建一个文件：

```tsx
import { View, Text, TouchableOpacity, useConfig, useSendToHost } from 'rill/guest';

interface Config {
  title: string;
  theme: 'light' | 'dark';
}

export default function MyGuest() {
  const config = useConfig<Config>();
  const sendToHost = useSendToHost();

  const handlePress = () => {
    sendToHost('BUTTON_CLICKED', { timestamp: Date.now() });
  };

  return (
    <View style={{ padding: 16 }}>
      <Text style={{ fontSize: 24 }}>{config.title}</Text>
      <TouchableOpacity onPress={handlePress}>
        <Text>Click me</Text>
      </TouchableOpacity>
    </View>
  );
}
```

关键点：

- `useConfig<T>()` 读取 host 提供的初始 props，使用泛型参数进行类型定义。
- `useSendToHost()` 返回一个函数，用于从 guest 向 host 应用程序分发事件。
- 所有 UI 原语（`View`、`Text`、`TouchableOpacity` 等）都从 `rill/guest` 导入，而不是从 `react-native` 导入。

## 构建 Guest Bundle

Rill 包含一个构建命令，可将你的 guest 组件编译为独立的 JavaScript bundle：

```bash
bunx rill build src/guest.tsx -o dist/bundle.js
```

输出的 bundle 可以从 CDN 提供、从文件系统加载或嵌入为静态资源。

## Host 端集成

在 host 端，创建一个 `Engine` 实例并使用 `EngineView` 组件来渲染 guest：

```tsx
import React, { useMemo } from 'react';
import { SafeAreaView, ActivityIndicator } from 'react-native';
import { Engine } from 'rill/host';
import { EngineView } from 'rill/host/preset';

export default function App() {
  const engine = useMemo(() => new Engine({ debug: __DEV__ }), []);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <EngineView
        engine={engine}
        source="https://cdn.example.com/guest.js"
        initialProps={{ title: 'Hello Rill', theme: 'light' }}
        onLoad={() => console.log('Guest loaded')}
        onError={(error) => console.error('Guest error:', error)}
        fallback={<ActivityIndicator />}
      />
    </SafeAreaView>
  );
}
```

- `Engine` 管理沙箱化的 JavaScript 执行环境。
- `EngineView` 从 `source` 获取 guest bundle，在引擎内运行它，并渲染生成的 UI 树。
- `initialProps` 传递给 guest，可通过 `useConfig()` 访问。
- `fallback` 在 guest bundle 加载时显示。

## 下一步

- [Host 集成](./host-integration.zh.md) -- Engine 配置、组件注册、事件通信、生命周期管理和无头模式。
- [Guest 开发](./guest-development.zh.md) -- 可用组件、hooks、样式、通信模式和平台 API。
