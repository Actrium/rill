import fs from 'fs';

const bundlePath = './dist/host-modules.bundle.js';
const manifestPath = './dist/rill-capabilities.json';

function readRequiredFile(path: string): string {
  if (!fs.existsSync(path)) {
    throw new Error(`Missing required file: ${path}`);
  }

  return fs.readFileSync(path, 'utf-8');
}

function expectContains(label: string, value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${label} does not contain ${expected}`);
  }
}

function expectNotContains(label: string, value: string, expected: string): void {
  if (value.includes(expected)) {
    throw new Error(`${label} unexpectedly contains ${expected}`);
  }
}

const bundle = readRequiredFile(bundlePath);
const manifest = JSON.parse(readRequiredFile(manifestPath));

expectContains('bundle', bundle, 'globalThis.__rill_importHostModule("host:analytics")');
expectContains('bundle', bundle, 'globalThis.__rill_importHostModule("host:navigation")');
expectContains('bundle', bundle, 'globalThis.__rill_importHostModule("host:theme")');
expectContains('bundle', bundle, 'Host module resolver');

expectNotContains('bundle', bundle, 'require("host:analytics")');
expectNotContains('bundle', bundle, 'require("host:navigation")');
expectNotContains('bundle', bundle, 'require("host:theme")');
expectNotContains('bundle', bundle, "require('host:analytics')");
expectNotContains('bundle', bundle, "require('host:navigation')");
expectNotContains('bundle', bundle, "require('host:theme')");

const expectedManifest = {
  contractVersion: '1.0.0',
  hostCapabilities: [
    'host:analytics.track',
    'host:navigation.openProfile',
    'host:theme.onThemeChanged',
  ],
  guestExports: ['refresh'],
};

if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
  throw new Error(
    `Unexpected capability manifest.\nExpected: ${JSON.stringify(
      expectedManifest,
      null,
      2
    )}\nActual: ${JSON.stringify(manifest, null, 2)}`
  );
}

console.log('Host module bundle verified.');
