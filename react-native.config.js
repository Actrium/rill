// React Native autolinking configuration for RillSandboxNative.
//
// We explicitly set `podspecPath` to keep autolinking working across:
//   - RN versions that don't auto-discover arbitrary *.podspec names
//   - react-native-macos projects (which reuse the "ios" autolinking config)
//
// Usage:
//   npm install rill
//   cd ios && pod install        # auto-links RillSandboxNative
//
// Optional engine selection (default: jsc):
//   RILL_SANDBOX_ENGINE=hermes pod install
//   RILL_SANDBOX_ENGINE=quickjs pod install
module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: 'RillSandboxNative.podspec',
      },
      android: {
        packageImportPath: 'import com.rill.sandbox.RillSandboxNativePackage;',
        packageInstance: 'new RillSandboxNativePackage()',
      },
    },
  },
};
