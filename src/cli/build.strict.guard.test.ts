import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('Strict Guard - violation cases', () => {
  let distDir: string;
  let file: (name: string) => string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rill-cli-test-'));
    file = (name: string) => path.join(distDir, name);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('should fail when bundle contains non-whitelisted module at runtime', async () => {
    const { analyze } = await import('./build');
    fs.writeFileSync(file('guard-lodash.js'), "require('lodash');");

    await expect(
      analyze(file('guard-lodash.js'), {
        whitelist: ['react', 'react-native', 'react/jsx-runtime', 'rill/guest'],
        failOnViolation: true,
        treatEvalAsViolation: true,
        treatDynamicNonLiteralAsViolation: true,
      })
    ).rejects.toThrow('Found non-whitelisted modules: lodash');
  });

  it('should pass when bundle only contains whitelisted deps', async () => {
    const { analyze } = await import('./build');
    fs.writeFileSync(file('guard-ok.js'), "require('react'); require('rill/guest');");
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    await analyze(file('guard-ok.js'), {
      whitelist: ['react', 'react-native', 'react/jsx-runtime', 'rill/guest'],
      failOnViolation: true,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
