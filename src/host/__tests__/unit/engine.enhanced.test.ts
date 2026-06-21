import { describe, expect, it, mock } from 'bun:test';
import { Engine } from '../../engine';

function buildBundle(code: string) {
  // Use var instead of const to avoid redeclaration error since React is already injected as global
  return `
    var _React = require('react');
    var _jsx = require('react/jsx-runtime');
    var _rill = require('rill/guest');
    ${code}
  `;
}

// Silent logger for tests - prevents expected error logs from cluttering output
const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

describe('Engine enhanced behaviors', () => {
  const load = (engine: Engine, src: string) =>
    Promise.resolve().then(() => engine.loadBundle(src));

  it('enforces require whitelist', async () => {
    const engine = new Engine({
      sandbox: 'node-vm',
      debug: false,
      logger: silentLogger,
      requireWhitelist: ['react'],
    });
    const src = "require('react-native')";
    const p = load(engine, src);
    await expect(p).rejects.toMatchObject({ name: 'RequireError' });
    await expect(p).rejects.toThrow(/Unsupported require/);
  });

  it('supports requireWhitelist wildcard patterns', async () => {
    const engine = new Engine({
      sandbox: 'node-vm',
      debug: false,
      logger: silentLogger,
      requireWhitelist: ['react', 'react/jsx-runtime', 'rill/*'],
    });
    const src = "require('rill/guest'); require('rill/reconciler');";
    await expect(load(engine, src)).resolves.toBeUndefined();
  });

  it('reports metrics via onMetric', async () => {
    const onMetric = mock();
    const engine = new Engine({ sandbox: 'node-vm', debug: false, logger: silentLogger, onMetric });
    const src = buildBundle(`console.log('hello')`);
    await load(engine, src);
    // Should have at least these metrics
    const names = onMetric.mock.calls.map((c) => c[0]);
    expect(names).toContain('engine.initializeRuntime');
    expect(names).toContain('engine.executeBundle');
  });

  it('throws ExecutionError for runtime errors', async () => {
    const engine = new Engine({ sandbox: 'node-vm', debug: false, logger: silentLogger });
    const src = buildBundle(`throw new Error('boom')`);
    await expect(load(engine, src)).rejects.toThrow('boom');
  });
});
