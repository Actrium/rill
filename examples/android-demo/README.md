# android-demo

Android example app demonstrating rill sandbox execution with React Native Bridgeless / New Architecture.

## Target

- Platform: Android
- Host engine: React Native Hermes
- Sandbox engines: QuickJS, Hermes
- APK flavors: `quickjs`, `hermes`
- E2E target: Android emulator or adb-connected device

## Install

```bash
cd examples/android-demo
./install.sh                  # Build and install quickjs + hermes release APKs
./install.sh quickjs          # Build and install QuickJS only
./install.sh hermes --debug   # Build and install Hermes debug APK
```

## Emulator E2E

```bash
cd examples/android-demo
./run-e2e.sh                  # Run quickjs + hermes
./run-e2e.sh quickjs          # Run QuickJS only
./run-e2e.sh hermes           # Run Hermes only
```

The runner builds and installs the selected flavor, launches
`com.rill.demo.<flavor>/com.rill.demo.MainActivity` with e2e launch props, then waits for
`RILL_ANDROID_E2E` markers in `adb logcat`.

Useful environment variables:

```bash
RILL_ANDROID_E2E_DEVICE=emulator-5554 ./run-e2e.sh
RILL_ANDROID_E2E_AVD=Pixel_API_35 ./run-e2e.sh
RILL_ANDROID_E2E_HEADLESS=0 ./run-e2e.sh
RILL_ANDROID_GRADLE_INIT=/tmp/rill-android-mirrors.gradle ./run-e2e.sh
```

The Android E2E checks cover sandbox detection, guest eval, host function injection, guest function
extraction, complex value round-trip, error propagation, context isolation, disposed-context behavior,
and the native performance bridge reaching the sandbox.
