# Guest API Reference

The Guest module provides components, hooks, and platform APIs for building dynamic UI inside the Rill sandbox. Guest code uses standard React patterns (JSX, hooks) and communicates with the host through a well-defined protocol.

Import path: `rill/guest`

---

## Components

All components listed below are available inside the sandbox via `require('rill/guest')` or JSX. They map to host-side React Native component implementations registered through `ComponentRegistry`.

### View

A container component. Maps to React Native's `View`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `style` | `ViewStyle` | `undefined` | Style object for layout and appearance. |
| `testID` | `string` | `undefined` | Test identifier for automation. |
| `onLayout` | `(event: LayoutEvent) => void` | `undefined` | Called when the view's layout changes. |

### Text

A text display component. Maps to React Native's `Text`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `style` | `TextStyle` | `undefined` | Style object for text appearance. |
| `numberOfLines` | `number` | `undefined` | Maximum number of lines before truncation. |
| `ellipsizeMode` | `'head' \| 'middle' \| 'tail' \| 'clip'` | `'tail'` | How text is truncated when it exceeds `numberOfLines`. |
| `selectable` | `boolean` | `false` | Whether the text is selectable by the user. |
| `onPress` | `() => void` | `undefined` | Called when the text is pressed. |

### Image

An image display component. Maps to React Native's `Image`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `source` | `{ uri: string } \| number` | (required) | Image source. A URI object for remote images or a number for bundled assets. |
| `style` | `ImageStyle` | `undefined` | Style object for image appearance. |
| `resizeMode` | `'cover' \| 'contain' \| 'stretch' \| 'repeat' \| 'center'` | `'cover'` | How the image is resized to fit its container. |
| `onLoad` | `() => void` | `undefined` | Called when the image finishes loading. |
| `onError` | `(error: { nativeEvent: { error: string } }) => void` | `undefined` | Called when the image fails to load. |

### TouchableOpacity

A touchable wrapper with opacity feedback. Maps to React Native's `TouchableOpacity`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `onPress` | `() => void` | `undefined` | Called when the component is pressed. |
| `onLongPress` | `() => void` | `undefined` | Called when the component is long-pressed. |
| `activeOpacity` | `number` | `0.2` | Opacity applied when the touch is active. |
| `disabled` | `boolean` | `false` | Whether the touch is disabled. |

### ScrollView

A scrollable container. Maps to React Native's `ScrollView`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `horizontal` | `boolean` | `false` | Whether the scroll view scrolls horizontally. |
| `showsVerticalScrollIndicator` | `boolean` | `true` | Whether the vertical scroll indicator is visible. |
| `showsHorizontalScrollIndicator` | `boolean` | `true` | Whether the horizontal scroll indicator is visible. |
| `onScroll` | `(event: ScrollEvent) => void` | `undefined` | Called when the scroll position changes. |

### FlatList

A performant scrollable list. Maps to React Native's `FlatList`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `data` | `T[]` | (required) | The array of items to render. |
| `renderItem` | `(info: { item: T, index: number }) => ReactElement` | (required) | Function that renders each item. |
| `keyExtractor` | `(item: T, index: number) => string` | `undefined` | Function that extracts a unique key for each item. |
| `horizontal` | `boolean` | `false` | Whether the list scrolls horizontally. |
| `onEndReached` | `() => void` | `undefined` | Called when the end of the list is reached. |
| `onEndReachedThreshold` | `number` | `undefined` | How far from the end (in visible length units) to trigger `onEndReached`. |
| `ListHeaderComponent` | `ReactElement \| (() => ReactElement)` | `undefined` | Rendered at the top of the list. |
| `ListEmptyComponent` | `ReactElement \| (() => ReactElement)` | `undefined` | Rendered when `data` is empty. |

### TextInput

A text input field. Maps to React Native's `TextInput`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `value` | `string` | `undefined` | The current text value (controlled). |
| `onChangeText` | `(text: string) => void` | `undefined` | Called when the text changes. |
| `placeholder` | `string` | `undefined` | Placeholder text displayed when empty. |
| `secureTextEntry` | `boolean` | `false` | Whether to obscure text (password field). |
| `multiline` | `boolean` | `false` | Whether the input supports multiple lines. |
| `maxLength` | `number` | `undefined` | Maximum number of characters allowed. |

### Button

A basic button. Maps to React Native's `Button`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | (required) | The button label text. |
| `onPress` | `() => void` | (required) | Called when the button is pressed. |
| `disabled` | `boolean` | `false` | Whether the button is disabled. |
| `color` | `string` | `undefined` | Button color (platform-specific behavior). |

### Switch

A toggle switch. Maps to React Native's `Switch`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `value` | `boolean` | `false` | The current on/off state. |
| `onValueChange` | `(value: boolean) => void` | `undefined` | Called when the switch is toggled. |
| `disabled` | `boolean` | `false` | Whether the switch is disabled. |

### ActivityIndicator

A loading spinner. Maps to React Native's `ActivityIndicator`.

| Prop | Type | Default | Description |
|---|---|---|---|
| `size` | `'small' \| 'large'` | `'small'` | The size of the indicator. |
| `color` | `string` | `undefined` | The color of the indicator. |
| `animating` | `boolean` | `true` | Whether the indicator is animating. |

---

## Hooks

### useConfig\<T\>()

Returns the current Guest configuration. The configuration is initially set via `loadBundle(source, initialProps)` and can be updated from the host via `engine.updateConfig()`.

```typescript
function useConfig<T = Record<string, unknown>>(): T
```

**Example:**

```tsx
const config = useConfig<{ theme: string; userName: string }>();
return <Text>{config.userName}</Text>;
```

### useHostEvent\<T\>(eventName, callback)

Subscribe to events sent from the host via `engine.sendEvent()`. The callback is invoked whenever the host sends an event with the matching name.

```typescript
function useHostEvent<T = unknown>(
  eventName: string,
  callback: (payload: T) => void
): void
```

**Example:**

```tsx
useHostEvent<{ items: string[] }>('dataUpdate', (payload) => {
  setItems(payload.items);
});
```

### useSendToHost()

Returns a function to send events from the Guest to the host. The host receives these events via `engine.on('message', handler)`.

```typescript
function useSendToHost(): (eventName: string, payload?: unknown) => void
```

**Example:**

```tsx
const sendToHost = useSendToHost();

const handlePress = () => {
  sendToHost('buttonPressed', { id: 'submit' });
};
```

### useRemoteRef\<T\>()

Creates a remote reference to a host-side component instance, allowing the Guest to invoke methods on it (e.g., `focus()`, `scrollTo()`).

```typescript
function useRemoteRef<T>(): [RefCallback, RemoteRef<T> | null]
```

Returns a tuple:
1. A ref callback to attach to the target component.
2. A `RemoteRef` object (or `null` before the ref is attached).

#### RemoteRef Interface

| Property / Method | Type | Description |
|---|---|---|
| `nodeId` | `number` | The node ID of the referenced component. |
| `invoke(method, ...args)` | `(...args: unknown[]) => Promise<unknown>` | Invoke a method on the host component instance. Returns a Promise with the result. |
| `call` | `Proxy` | A proxy object for direct method calls (syntactic sugar). |

#### Predefined Ref Types

**TextInputRef:**

| Method | Signature | Description |
|---|---|---|
| `focus()` | `() => Promise<void>` | Focus the text input. |
| `blur()` | `() => Promise<void>` | Blur the text input. |
| `clear()` | `() => Promise<void>` | Clear the text input value. |

**ScrollViewRef:**

| Method | Signature | Description |
|---|---|---|
| `scrollTo(options)` | `(options: { x?: number, y?: number, animated?: boolean }) => Promise<void>` | Scroll to a specific position. |
| `scrollToEnd(options?)` | `(options?: { animated?: boolean }) => Promise<void>` | Scroll to the end of the content. |

**FlatListRef:**

| Method | Signature | Description |
|---|---|---|
| `scrollToIndex(params)` | `(params: { index: number, animated?: boolean }) => Promise<void>` | Scroll to a specific item index. |
| `scrollToOffset(params)` | `(params: { offset: number, animated?: boolean }) => Promise<void>` | Scroll to a specific pixel offset. |

**Example:**

```tsx
const [ref, remoteRef] = useRemoteRef<TextInputRef>();

const handleFocus = async () => {
  if (remoteRef) {
    await remoteRef.call.focus();
  }
};

return <TextInput ref={ref} placeholder="Enter text" />;
```

---

## RillErrorBoundary

A React error boundary component for catching rendering errors in Guest code. Prevents a single component error from crashing the entire sandbox UI.

```typescript
interface RillErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactElement | ((error: Error) => ReactElement);
  onError?: (error: Error, errorInfo: { componentStack: string }) => void;
}
```

| Prop | Type | Description |
|---|---|---|
| `children` | `ReactNode` | The component tree to wrap. |
| `fallback` | `ReactElement \| (error: Error) => ReactElement` | Rendered when an error is caught. |
| `onError` | `(error: Error, errorInfo: object) => void` | Called when an error is caught. |

---

## Platform APIs

These APIs provide access to platform information and utilities inside the sandbox.

### Platform

Provides information about the current platform.

```typescript
const Platform: {
  OS: 'ios' | 'android' | 'web' | 'macos' | 'windows';
  Version: number | string;
  select: <T>(specifics: { ios?: T; android?: T; default?: T }) => T;
}
```

### Dimensions

Provides screen and window dimensions.

```typescript
const Dimensions: {
  get: (dim: 'window' | 'screen') => { width: number; height: number };
}
```

### StyleSheet

A utility for creating optimized style objects.

```typescript
const StyleSheet: {
  create: <T extends Record<string, ViewStyle | TextStyle | ImageStyle>>(styles: T) => T;
  flatten: (style: StyleProp) => object;
  absoluteFill: ViewStyle;
  hairlineWidth: number;
}
```

### Linking

Provides URL opening capabilities.

```typescript
const Linking: {
  openURL: (url: string) => Promise<void>;
  canOpenURL: (url: string) => Promise<boolean>;
}
```
