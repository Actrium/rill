# Guest 开发

本指南涵盖在 Rill 沙箱环境中运行的 guest 代码可用的组件、hooks、样式、通信模式和平台 API。

## SDK 导入

所有 guest API 都从 `rill/guest` 模块导入：

```tsx
import { View, Text, useConfig, useSendToHost } from 'rill/guest';
```

guest 代码不直接从 `react-native` 导入。SDK 提供了一组精选的原语，引擎将其映射到 host 端的原生组件。

## 组件概览

Rill 附带以下内置组件：

| 组件 | 描述 |
|---|---|
| `View` | 容器布局原语。支持 flexbox 样式。 |
| `Text` | 文本渲染。支持嵌套和内联样式。 |
| `Image` | 从 URI 源显示图像。 |
| `ScrollView` | 可滚动容器，用于可能超过可见区域的内容。 |
| `TouchableOpacity` | 可按压的包装器，触摸时降低不透明度。 |
| `TextInput` | 单行或多行文本输入字段。 |
| `FlatList` | 用于渲染大型数据集的高性能可滚动列表。 |
| `Button` | 带有标题和 onPress 处理程序的简单按钮。 |
| `Switch` | 布尔值的切换开关。 |
| `ActivityIndicator` | 加载旋转器。 |

所有组件接受与其 React Native 对应物相同的 props，但不包括无法安全地跨沙箱边界暴露的功能（例如，直接原生模块访问）。

### 示例

```tsx
import { View, Text, Image, ScrollView } from 'rill/guest';

export default function ProductCard() {
  return (
    <ScrollView>
      <View style={{ padding: 16 }}>
        <Image
          source={{ uri: 'https://example.com/product.png' }}
          style={{ width: 200, height: 200 }}
        />
        <Text style={{ fontSize: 18, fontWeight: 'bold' }}>Product Name</Text>
        <Text style={{ color: '#666' }}>Description goes here.</Text>
      </View>
    </ScrollView>
  );
}
```

## Hooks

### useConfig

返回 host 通过 `EngineView` 的 `initialProps` prop 提供的初始 props。接受泛型类型参数以实现类型安全：

```tsx
interface Config {
  userId: number;
  locale: string;
}

const config = useConfig<Config>();
// config.userId, config.locale
```

### useHostEvent

订阅从 host 发送的事件。每当 host 使用匹配的事件名称调用 `engine.sendEvent()` 时，回调就会触发：

```tsx
import { useHostEvent } from 'rill/guest';

useHostEvent('THEME_CHANGED', (payload) => {
  console.log('New theme:', payload.theme);
});

useHostEvent('DATA_UPDATE', (payload) => {
  setItems(payload.items);
});
```

### useSendToHost

返回一个从 guest 向 host 发送事件的函数。host 通过 `engine.on('message', ...)` 接收这些事件：

```tsx
import { useSendToHost } from 'rill/guest';

const sendToHost = useSendToHost();

const handleSubmit = (data) => {
  sendToHost('FORM_SUBMITTED', { data });
};
```

### useRemoteRef

创建对 host 端组件实例的引用，允许 guest 在其上调用方法。这对于聚焦输入或滚动到某个位置等命令式操作很有用：

```tsx
import { TextInput, useRemoteRef } from 'rill/guest';
import type { TextInputRef } from 'rill/guest';

export default function SearchBar() {
  const inputRef = useRemoteRef<TextInputRef>();

  const handleClear = () => {
    inputRef.current?.focus();
  };

  return (
    <TextInput
      ref={inputRef}
      placeholder="Search..."
    />
  );
}
```

可用的 ref 类型：

| Ref 类型 | 方法 | 使用对象 |
|---|---|---|
| `TextInputRef` | `focus()`, `blur()`, `clear()`, `setNativeProps()` | `TextInput` |
| `ScrollViewRef` | `scrollTo()`, `scrollToEnd()`, `flashScrollIndicators()` | `ScrollView` |
| `FlatListRef` | `scrollToIndex()`, `scrollToOffset()`, `scrollToEnd()` | `FlatList` |

远程 ref 调用被序列化并在 host 上异步执行。它们不返回值。

## 样式

guest 组件接受 React Native 样式对象。支持内联样式和提取的样式对象：

```tsx
import { View, Text } from 'rill/guest';

const styles = {
  container: {
    flex: 1,
    padding: 16,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold' as const,
    color: '#333',
  },
};

export default function StyledExample() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Styled Content</Text>
    </View>
  );
}
```

样式属性遵循 React Native 规范：flexbox 布局、绝对/相对定位和平台一致的单位（与密度无关的像素）。

## 通信模式

### Guest 到 Host

使用 `useSendToHost` 通知 host 用户交互、状态更改或数据请求：

```tsx
const sendToHost = useSendToHost();

// 用户操作
sendToHost('ITEM_SELECTED', { itemId: 42 });

// 数据请求
sendToHost('REQUEST_REFRESH', {});

// 导航意图
sendToHost('NAVIGATE', { screen: 'Details', params: { id: 7 } });
```

### Host 到 Guest

使用 `useHostEvent` 响应从 host 推送的数据：

```tsx
const [items, setItems] = useState([]);

useHostEvent('ITEMS_LOADED', (payload) => {
  setItems(payload.items);
});

useHostEvent('FORCE_LOGOUT', () => {
  setItems([]);
  sendToHost('ACKNOWLEDGED_LOGOUT', {});
});
```

所有事件 payload 必须是 JSON 可序列化的。函数、类实例和循环引用无法跨越沙箱边界。

## Error Boundary

使用 `RillErrorBoundary` 包装 guest 组件以捕获渲染错误并显示回退 UI，而不是使 guest 崩溃：

```tsx
import { View, Text, RillErrorBoundary } from 'rill/guest';

export default function SafeGuest() {
  return (
    <RillErrorBoundary
      fallback={
        <View style={{ padding: 16 }}>
          <Text>Something went wrong.</Text>
        </View>
      }
    >
      <RiskyComponent />
    </RillErrorBoundary>
  );
}
```

当捕获到错误时，边界会渲染回退并通过引擎的错误通道向 host 报告错误。

## 平台 API

Rill 在沙箱内暴露了 React Native 平台 API 的子集：

### Platform

```tsx
import { Platform } from 'rill/guest';

if (Platform.OS === 'ios') {
  // iOS-specific logic
}

console.log(Platform.Version); // e.g., '17.0'
```

### Dimensions

```tsx
import { Dimensions } from 'rill/guest';

const { width, height } = Dimensions.get('window');
```

### StyleSheet

```tsx
import { StyleSheet } from 'rill/guest';

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  text: { fontSize: 14, color: '#000' },
});
```

`StyleSheet.create` 在创建时验证样式并返回优化的样式引用。

### Linking

```tsx
import { Linking } from 'rill/guest';

const openURL = async (url: string) => {
  const supported = await Linking.canOpenURL(url);
  if (supported) {
    await Linking.openURL(url);
  }
};
```

Linking 调用被转发到 host 并受引擎安全策略的约束。host 可以限制允许哪些 URL 方案。

---

另请参阅：[快速入门](./README.zh.md) 了解初始设置，以及 [Host 集成](./host-integration.zh.md) 了解 host 端 API。
