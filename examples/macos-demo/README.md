# macos-demo

> **Status: Placeholder** — not yet implemented.

macOS example app demonstrating **rill sandbox** with `react-native-macos`.

## Target

- Platform: macOS (`react-native-macos`)
- Sandbox engines: JSC, QuickJS

## Notes

- `tests/rn-macos-bridgeless/` already contains a functional macOS test application
  used for end-to-end testing of the rill sandbox (Bridgeless / New Architecture).
  This demo will provide a standalone example with a performance dashboard similar to `ios-demo`.

## Planned Structure

```
macos-demo/
├── macos-demo.xcodeproj/
├── macos-demo/        # Swift/ObjC source
├── RCTNApps/          # Shared React Native JS layer
├── Podfile
└── TestCode/
```
