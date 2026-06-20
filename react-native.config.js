// React Native autolinking configuration for RillSandboxNative.
//
// Keep only Android explicit fields. iOS autolinking uses the podspec
// discovered from package root.
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: 'import com.rill.sandbox.RillSandboxNativePackage;',
        packageInstance: 'new RillSandboxNativePackage()',
      },
    },
  },
};
