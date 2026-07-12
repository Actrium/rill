# Host Integration

This guide covers Engine configuration, component registration, event communication, lifecycle management, and headless rendering on the host side.

## Engine Instance Creation and Configuration

The `Engine` class is the central entry point. Create one instance per logical sandbox:

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

### Configuration Options

| Option | Type | Default | Description |
|---|---|---|---|
| `timeout` | `number` | `10000` | Maximum time (ms) allowed for guest initialization before the engine reports a timeout error. |
| `debug` | `boolean` | `false` | Enables verbose logging and development-time warnings. |
| `logger` | `Logger` | `console` | Custom logger implementation. Must provide `log`, `warn`, and `error` methods. |
| `onMetric` | `(metric) => void` | -- | Callback invoked with performance and health metrics during engine operation. |
| `requireWhitelist` | `string[]` | `[]` | List of module names that guest code is allowed to `require`. All other require calls are blocked. |
| `receiverMaxBatchSize` | `number` | `32` | Maximum number of UI mutations batched together before flushing to the native renderer. |
| `sandbox` | `string` | `'quickjs'` | Sandbox runtime selection. |
| `diagnostics` | `boolean` | `false` | Enables collection of diagnostic data (render counts, timing breakdowns, tree snapshots). |
| `devtools` | `boolean` | `false` | Enables Chrome DevTools Protocol (CDP) connectivity for remote debugging of guest code. |

## Component Registration

By default, Rill maps guest elements to standard React Native primitives (`View`, `Text`, `Image`, etc.). To make custom host components available to guest code, register them on the engine:

```tsx
import { NativeStepList } from './components/NativeStepList';
import { MyButton } from './components/MyButton';

engine.register({
  StepList: NativeStepList,
  CustomButton: MyButton,
});
```

Once registered, guest code can render these components by name:

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

Registered components receive the props set by the guest and render natively on the host.

## EngineView Usage

`EngineView` is the React component that connects an engine instance to your component tree:

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

| Prop | Type | Required | Description |
|---|---|---|---|
| `engine` | `Engine` | Yes | The engine instance to use for this view. |
| `source` | `string` | Yes | URL or file path to the guest bundle. |
| `initialProps` | `object` | No | Props passed to the guest, accessible via `useConfig()`. |
| `onLoad` | `() => void` | No | Called when the guest finishes loading and renders its first frame. |
| `onError` | `(error: Error) => void` | No | Called when a guest error occurs (load failure, runtime error, timeout). |
| `onDestroy` | `() => void` | No | Called when the guest instance is torn down. |
| `fallback` | `ReactNode` | No | Rendered while the guest bundle is loading. |
| `renderError` | `(error: Error) => ReactNode` | No | Custom error UI. If not provided, the engine silently reports via `onError`. |
| `style` | `ViewStyle` | No | Style applied to the container wrapping the guest output. |

## Event Communication

The host and guest communicate through a bidirectional event channel.

### Sending events to the guest

```tsx
engine.sendEvent('THEME_CHANGED', { theme: 'dark' });
engine.sendEvent('DATA_UPDATE', { items: updatedItems });
```

### Listening for events from the guest

```tsx
engine.on('message', (eventName, payload) => {
  if (eventName === 'BUTTON_CLICKED') {
    handleButtonClick(payload);
  }
});
```

Events are serialized across the sandbox boundary. Only JSON-serializable data can be passed as payloads.

## Lifecycle Management

### Destroying the Engine

Always destroy the engine when it is no longer needed to release sandbox resources:

```tsx
useEffect(() => {
  return () => {
    engine.destroy();
  };
}, [engine]);
```

### Health and Diagnostics

```tsx
// Single observability entry point -- always available
const diagnostics = engine.getDiagnostics();

// Health snapshot: loaded/destroyed flags, error count, receiver node count
const health = diagnostics.health;

// Resource usage: active timers, live UI nodes, registered callbacks
const resources = diagnostics.resources;
```

The `diagnostics` option in `EngineOptions` only tunes the activity-stats windows and timeline buckets; `getDiagnostics()` works whether or not it is set.

### Pause and Resume

Pause guest execution when the view is off-screen to save resources, then resume when visible:

```tsx
engine.pause();
// ...later
engine.resume();
```

Pausing suspends timers and event delivery. The guest UI tree is preserved and resumes rendering from where it left off.

## Receiver Headless Mode

For advanced use cases (custom renderers, testing, server-side rendering), you can use the engine without `EngineView` by creating a receiver directly:

```tsx
const receiver = engine.createReceiver((update) => {
  // Called whenever the guest UI tree changes
  console.log('Tree update:', update);
});

// Manually apply a batch of mutations
receiver.applyBatch(batch);

// Render the current tree to a React element
const element = receiver.render();
```

Headless mode gives you full control over how and when guest output is consumed. This is useful for:

- Writing integration tests without mounting native views.
- Building custom renderers that target non-React-Native platforms.
- Server-side rendering of guest components.

---

See also: [Guest Development](./guest-development.md) for the guest-side API surface.
