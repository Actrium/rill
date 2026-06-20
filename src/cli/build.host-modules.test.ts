import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defineRillContract, rpc, subscription } from '../contract';
import { analyze, build } from './build';

describe('CLI Host Modules', () => {
  let tempDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rill-host-modules-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    fs.mkdirSync('src', { recursive: true });
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it('should analyze static host imports and guest exports', async () => {
    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
import { openProfile as open } from 'host:navigation';

export async function refresh() {
  await open({ userId: '42' });
}
`
    );

    const result = await analyze(path.join('src', 'guest.tsx'), {
      failOnViolation: true,
    });

    expect(result.hostCapabilities).toEqual(['host:navigation.openProfile']);
    expect(result.guestExports).toEqual(['refresh']);
    expect(result.violations).toEqual([]);
  });

  it('should analyze host imports against a contract file', async () => {
    fs.writeFileSync(
      path.join('src', 'rill.contract.ts'),
      `
export const contract = {
  version: '1.0.0',
  hostModules: {
    'host:navigation': {
      openProfile: { kind: 'rpc' },
    },
  },
  guestExports: {
    refresh: { kind: 'rpc' },
  },
};
`
    );

    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
import { openProfile } from 'host:navigation';

export async function refresh() {
  await openProfile({ userId: '42' });
}
`
    );

    const result = await analyze(path.join('src', 'guest.tsx'), {
      contractFile: path.join('src', 'rill.contract.ts'),
      failOnViolation: true,
    });

    expect(result.hostCapabilities).toEqual(['host:navigation.openProfile']);
    expect(result.guestExports).toEqual(['refresh']);
  });

  it('should reject host imports that are not declared in the contract', async () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:navigation': {
          openProfile: rpc<{ userId: string }, void>(),
        },
      },
      guestExports: {
        refresh: rpc<void, void>(),
      },
    });

    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
import { closeProfile } from 'host:navigation';

export async function refresh() {
  await closeProfile();
}
`
    );

    await expect(
      analyze(path.join('src', 'guest.tsx'), {
        contract,
        failOnViolation: true,
      })
    ).rejects.toThrow('Host capability "host:navigation.closeProfile" is not declared');
  });

  it('should reject host modules that are not declared in the contract', async () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:navigation': {
          openProfile: rpc<{ userId: string }, void>(),
        },
      },
      guestExports: {
        refresh: rpc<void, void>(),
      },
    });

    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
import { track } from 'host:analytics';

export async function refresh() {
  await track({ name: 'opened' });
}
`
    );

    await expect(
      analyze(path.join('src', 'guest.tsx'), {
        contract,
        failOnViolation: true,
      })
    ).rejects.toThrow('Host module "host:analytics" is not declared');
  });

  it('should reject dynamic host imports', async () => {
    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
export async function refresh() {
  await import('host:navigation');
}
`
    );

    await expect(
      analyze(path.join('src', 'guest.tsx'), {
        failOnViolation: true,
      })
    ).rejects.toThrow('Dynamic host module import is not allowed');
  });

  it('should reject non-named host imports during build', async () => {
    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
import navigation from 'host:navigation';

export default function Guest() {
  return null;
}

void navigation;
`
    );

    await expect(
      build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: false,
        sourcemap: false,
        watch: false,
        strict: true,
      })
    ).rejects.toThrow('Default import is not allowed for host module host:navigation');
  });

  it('should reject missing guest exports declared by the contract during build', async () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {},
      guestExports: {
        refresh: rpc<void, void>(),
      },
    });

    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
export default function Guest() {
  return null;
}
`
    );

    await expect(
      build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: false,
        sourcemap: false,
        watch: false,
        strict: true,
        contract,
      })
    ).rejects.toThrow('Guest export "refresh" is declared in contract but not exported');
  });

  it('should reject extra guest exports that are not declared by the contract during build', async () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {},
      guestExports: {},
    });

    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
export async function refresh() {}

export default function Guest() {
  return null;
}
`
    );

    await expect(
      build({
        entry: 'src/guest.tsx',
        outfile: 'dist/bundle.js',
        minify: false,
        sourcemap: false,
        watch: false,
        strict: true,
        contract,
      })
    ).rejects.toThrow('Guest export "refresh" is not declared in contract');
  });

  it('should externalize host modules and write a capability manifest', async () => {
    const contract = defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:analytics': {
          track: rpc<{ name: string }, void>(),
        },
        'host:navigation': {
          openProfile: rpc<{ userId: string }, void>(),
        },
        'host:theme': {
          onThemeChanged: subscription<{ theme: 'light' | 'dark' }>(),
        },
      },
      guestExports: {
        refresh: rpc<void, void>(),
      },
    });

    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
import * as React from 'react';
import { View, Text } from 'rill/guest';
import { track } from 'host:analytics';
import { openProfile } from 'host:navigation';
import { onThemeChanged } from 'host:theme';

export async function refresh() {
  await track({ name: 'refresh' });
  await openProfile({ userId: '42' });
  const unsubscribe = onThemeChanged((event) => console.log(event.theme));
  unsubscribe();
}

export default function Guest() {
  return <View><Text>OK</Text></View>;
}
`
    );

    await build({
      entry: 'src/guest.tsx',
      outfile: 'dist/bundle.js',
      minify: false,
      sourcemap: false,
      watch: false,
      strict: true,
      contract,
      capabilityManifest: 'dist/rill-capabilities.json',
    });

    const bundle = fs.readFileSync(path.join('dist', 'bundle.js'), 'utf-8');
    const manifest = JSON.parse(
      fs.readFileSync(path.join('dist', 'rill-capabilities.json'), 'utf-8')
    );

    expect(bundle).not.toContain('require("host:navigation")');
    expect(bundle).not.toContain('require("host:analytics")');
    expect(bundle).not.toContain('require("host:theme")');
    expect(bundle).toContain('__rill_importHostModule("host:navigation")');
    expect(bundle).toContain('__rill_importHostModule("host:analytics")');
    expect(bundle).toContain('__rill_importHostModule("host:theme")');
    expect(manifest).toEqual({
      contractVersion: '1.0.0',
      hostCapabilities: [
        'host:analytics.track',
        'host:navigation.openProfile',
        'host:theme.onThemeChanged',
      ],
      guestExports: ['refresh'],
    });
  });

  it('should write a capability manifest without a contract', async () => {
    fs.writeFileSync(
      path.join('src', 'guest.tsx'),
      `
import { openProfile } from 'host:navigation';

export async function refresh() {
  await openProfile({ userId: '42' });
}
`
    );

    await build({
      entry: 'src/guest.tsx',
      outfile: 'dist/bundle.js',
      minify: false,
      sourcemap: false,
      watch: false,
      strict: true,
      capabilityManifest: 'dist/rill-capabilities.json',
    });

    const manifest = JSON.parse(
      fs.readFileSync(path.join('dist', 'rill-capabilities.json'), 'utf-8')
    );

    expect(manifest).toEqual({
      contractVersion: null,
      hostCapabilities: ['host:navigation.openProfile'],
      guestExports: ['refresh'],
    });
  });
});
