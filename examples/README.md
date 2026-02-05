# Rill Examples

Example applications demonstrating the rill SDK across different platforms.

## Examples

| Example | Platform | Status | Description |
|---------|----------|--------|-------------|
| [ios-demo](./ios-demo/) | iOS | Ready | Full iOS app with performance dashboard, 3 sandbox engines (JSC/Hermes/QuickJS), Bridgeless only |
| [android-demo](./android-demo/) | Android | Placeholder | Android app with Hermes and QuickJS sandboxes |
| [macos-demo](./macos-demo/) | macOS | Placeholder | macOS app via `react-native-macos` |
| [windows-demo](./windows-demo/) | Windows | Placeholder | Windows app via `react-native-windows` |

## Dependency Resolution

Examples reference `rill` via relative `file:` paths, not npm registry:

| Example | rill dependency |
|---------|----------------|
| `ios-demo/RCTNApps` | `"rill": "file:../../../"` |

This ensures examples always use the local checkout of rill.

## Package Exports Reference

Guest bundles import from `rill/guest`:

```tsx
import { View, Text, useHostEvent, useSendToHost, useConfig } from 'rill/guest';
```

Host apps import from `rill/host` and `rill/host/preset`:

```tsx
import { Engine } from 'rill/host';
import { DefaultComponents, EngineView } from 'rill/host/preset';
```
