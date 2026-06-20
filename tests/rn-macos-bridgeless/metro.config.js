const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const defaultConfig = getDefaultConfig(projectRoot);

function escapeForRegex(p) {
  return p.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

const config = {
  watchFolders: [
    monorepoRoot,
  ],
  resolver: {
    useWatchman: process.env.RILL_E2E_USE_WATCHMAN === '1',
    // Ensure module resolution uses the app's node_modules, even when importing
    // source files from the monorepo (watchFolders).
    disableHierarchicalLookup: true,
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
    blockList: [
      // Avoid crawling huge folders in the monorepo (can hit EMFILE when Watchman is unavailable)
      new RegExp(`${escapeForRegex(monorepoRoot)}/node_modules/.*`),
      new RegExp(`${escapeForRegex(monorepoRoot)}/android/.*`),
      new RegExp(`${escapeForRegex(monorepoRoot)}/native/.*`),
      new RegExp(`${escapeForRegex(monorepoRoot)}/examples/.*`),
      // Keep this app's projectRoot under tests/, but exclude other test fixtures.
      new RegExp(`${escapeForRegex(monorepoRoot)}/tests/(?!rn-macos-bridgeless/).*`),
      new RegExp(`${escapeForRegex(monorepoRoot)}/dist/.*`),
      new RegExp(`${escapeForRegex(monorepoRoot)}/coverage/.*`),
      new RegExp(`${escapeForRegex(monorepoRoot)}/playwright-report/.*`),
      new RegExp(`${escapeForRegex(monorepoRoot)}/test-results/.*`),
    ],
  },
};

module.exports = mergeConfig(defaultConfig, config);
