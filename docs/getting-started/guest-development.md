# Guest Development

This guide covers the components, hooks, styling, communication patterns, and platform APIs available to guest code running inside Rill's sandboxed environment.

## SDK Import

All guest APIs are imported from the `rill/guest` module:

```tsx
import { View, Text, useConfig, useSendToHost } from 'rill/guest';
```

Guest code does not import from `react-native` directly. The SDK provides a curated set of primitives that the engine maps to native components on the host side.

## Components Overview

Rill ships with the following built-in components:

| Component | Description |
|---|---|
| `View` | Container layout primitive. Supports flexbox styling. |
| `Text` | Text rendering. Supports nesting and inline styles. |
| `Image` | Displays images from a URI source. |
| `ScrollView` | Scrollable container for content that may exceed the visible area. |
| `TouchableOpacity` | Pressable wrapper that reduces opacity on touch. |
| `TextInput` | Single-line or multi-line text input field. |
| `FlatList` | Performant scrollable list for rendering large data sets. |
| `Button` | Simple button with a title and onPress handler. |
| `Switch` | Toggle switch for boolean values. |
| `ActivityIndicator` | Loading spinner. |

All components accept the same props as their React Native counterparts, with the exception of features that cannot be safely exposed across the sandbox boundary (e.g., direct native module access).

### Example

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

Returns the initial props provided by the host via `EngineView`'s `initialProps` prop. Accepts a generic type parameter for type safety:

```tsx
interface Config {
  userId: number;
  locale: string;
}

const config = useConfig<Config>();
// config.userId, config.locale
```

### useHostEvent

Subscribes to events sent from the host. The callback fires whenever the host calls `engine.sendEvent()` with a matching event name:

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

Returns a function that sends events from the guest to the host. The host receives these via `engine.on('message', ...)`:

```tsx
import { useSendToHost } from 'rill/guest';

const sendToHost = useSendToHost();

const handleSubmit = (data) => {
  sendToHost('FORM_SUBMITTED', { data });
};
```

### useRemoteRef

Creates a reference to a host-side component instance, allowing the guest to invoke methods on it. This is useful for imperative operations like focusing an input or scrolling to a position:

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

Available ref types:

| Ref Type | Methods | Used With |
|---|---|---|
| `TextInputRef` | `focus()`, `blur()`, `clear()`, `setNativeProps()` | `TextInput` |
| `ScrollViewRef` | `scrollTo()`, `scrollToEnd()`, `flashScrollIndicators()` | `ScrollView` |
| `FlatListRef` | `scrollToIndex()`, `scrollToOffset()`, `scrollToEnd()` | `FlatList` |

Remote ref calls are serialized and executed asynchronously on the host. They do not return values.

## Styling

Guest components accept React Native style objects. Both inline styles and extracted style objects are supported:

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

Style properties follow the React Native specification: flexbox layout, absolute/relative positioning, and platform-consistent units (density-independent pixels).

## Communication Patterns

### Guest to Host

Use `useSendToHost` to notify the host of user interactions, state changes, or data requests:

```tsx
const sendToHost = useSendToHost();

// User action
sendToHost('ITEM_SELECTED', { itemId: 42 });

// Data request
sendToHost('REQUEST_REFRESH', {});

// Navigation intent
sendToHost('NAVIGATE', { screen: 'Details', params: { id: 7 } });
```

### Host to Guest

Use `useHostEvent` to react to data pushed from the host:

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

All event payloads must be JSON-serializable. Functions, class instances, and circular references cannot cross the sandbox boundary.

## Error Boundary

Wrap guest components with `RillErrorBoundary` to catch rendering errors and display a fallback UI instead of crashing the guest:

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

When an error is caught, the boundary renders the fallback and reports the error to the host via the engine's error channel.

## Platform APIs

Rill exposes a subset of React Native platform APIs inside the sandbox:

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

`StyleSheet.create` validates styles at creation time and returns an optimized style reference.

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

Linking calls are forwarded to the host and subject to the engine's security policy. The host can restrict which URL schemes are allowed.

---

See also: [Quick Start](./README.md) for initial setup and [Host Integration](./host-integration.md) for the host-side API.
