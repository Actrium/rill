const fs = require('fs');
const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { resolve } = require('metro-resolver');

const rootDir = __dirname;

// Resolve rill from symlink in node_modules
const rillPath = fs.realpathSync(path.resolve(rootDir, 'node_modules/rill'));

// react-native-windows path (full RN fork with .windows.js overlays)
const rnwPath = fs.realpathSync(
  path.resolve(require.resolve('react-native-windows/package.json'), '..')
);

const defaultConfig = getDefaultConfig(rootDir);

// Block duplicate React instances from symlinked packages + RNW build artifacts
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
defaultConfig.resolver.blockList = [
  /.*node_modules\/react\/cjs\/react\.development\.js.*inline-requires-plugin.*/,
  new RegExp(`${escapeRegExp(rillPath)}/node_modules/react/.*`),
  new RegExp(`${escapeRegExp(rillPath)}/node_modules/react-reconciler/.*`),
  // RNW: prevent metro crash from windows/ build artifacts
  new RegExp(`${path.resolve(__dirname, 'windows').replace(/[/\\]/g, '/')}.*`),
  new RegExp(`${rnwPath}/build/.*`),
  new RegExp(`${rnwPath}/target/.*`),
  /.*\.ProjectImports\.zip/,
];

/** @type {import('metro-config').MetroConfig} */
const customConfig = {
  watcher: {
    watchman: { deferStates: [] },
    healthCheck: { enabled: false },
  },
  watchFolders: [rillPath],
  resolver: {
    platforms: ['windows', 'android', 'ios'],
    unstable_enableSymlinks: true,
    nodeModulesPaths: [path.resolve(rootDir, 'node_modules')],
    resolveRequest: (context, moduleName, platform) => {
      // rill monorepo resolution
      if (moduleName === 'rill' || moduleName === 'rill/host') {
        return {
          type: 'sourceFile',
          filePath: path.resolve(rillPath, 'src', 'host', 'index.ts'),
        };
      }
      // Test stubs for isolating crash
      if (moduleName === 'rill-test-a') {
        return { type: 'sourceFile', filePath: path.resolve(rootDir, 'stubs', 'rill-test-a.ts') };
      }
      if (moduleName === 'rill-test-b') {
        return { type: 'sourceFile', filePath: path.resolve(rootDir, 'stubs', 'rill-test-b.ts') };
      }
      if (moduleName === 'rill-test-c') {
        return { type: 'sourceFile', filePath: path.resolve(rootDir, 'stubs', 'rill-test-c.ts') };
      }
      if (moduleName === 'rill-test-d') {
        return { type: 'sourceFile', filePath: path.resolve(rootDir, 'stubs', 'rill-test-d.ts') };
      }
      if (moduleName === 'rill-test-eval-guest') {
        return {
          type: 'sourceFile',
          filePath: path.resolve(rootDir, 'stubs', 'rill-test-eval-guest.ts'),
        };
      }
      if (moduleName === 'rill-test-all') {
        return { type: 'sourceFile', filePath: path.resolve(rootDir, 'stubs', 'rill-test-all.ts') };
      }
      if (moduleName === 'rill/host/preset') {
        return {
          type: 'sourceFile',
          filePath: path.resolve(rillPath, 'src', 'host', 'preset', 'index.ts'),
        };
      }

      // Dedupe react/react-reconciler to local node_modules
      if (moduleName === 'react') {
        return {
          type: 'sourceFile',
          filePath: path.resolve(rootDir, 'node_modules', 'react', 'index.js'),
        };
      }
      if (moduleName === 'react/jsx-runtime') {
        return {
          type: 'sourceFile',
          filePath: path.resolve(rootDir, 'node_modules', 'react', 'jsx-runtime.js'),
        };
      }
      if (moduleName === 'react/jsx-dev-runtime') {
        return {
          type: 'sourceFile',
          filePath: path.resolve(rootDir, 'node_modules', 'react', 'jsx-dev-runtime.js'),
        };
      }
      if (moduleName === 'react-reconciler') {
        return {
          type: 'sourceFile',
          filePath: path.resolve(rootDir, 'node_modules', 'react-reconciler', 'index.js'),
        };
      }

      // Windows platform: redirect react-native → react-native-windows
      // RNW is a full RN fork, so all relative imports cascade within RNW
      // where .windows.js overlay files are found by Metro's platform resolution
      if (platform === 'windows') {
        if (moduleName === 'react-native') {
          return resolve(context, 'react-native-windows', platform);
        }
        if (moduleName.startsWith('react-native/')) {
          const subPath = moduleName.slice('react-native/'.length);
          return resolve(context, 'react-native-windows/' + subPath, platform);
        }
      }

      return resolve(context, moduleName, platform);
    },
    extraNodeModules: {
      react: path.resolve(rootDir, 'node_modules/react'),
      'react-reconciler': path.resolve(rootDir, 'node_modules/react-reconciler'),
    },
    unstable_enablePackageExports: true,
    sourceExts: ['ts', 'tsx', 'js', 'jsx', 'json', 'mjs', 'cjs'],
  },
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
};

module.exports = mergeConfig(defaultConfig, customConfig);
