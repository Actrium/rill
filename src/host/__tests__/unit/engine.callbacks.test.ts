/**
 * Engine callback and message handling tests
 *
 * Covers:
 * - handleCallFunction (lines 470-480)
 * - handleHostEvent (lines 485-495)
 * - Event listener error handling (lines 520-521)
 * - sendToSandbox with metrics (line 504)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { HostMsg } from '../../types';
import { Engine } from '../../engine';

describe('Engine Callback Handling', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = new Engine({ sandbox: 'node-vm', debug: false });
  });

  afterEach(() => {
    engine.destroy();
  });

  // Note: CALL_FUNCTION and HOST_EVENT tests removed - covered by Bridge.test.ts
  // Bridge handles message encoding/decoding, Engine just dispatches to Bridge

  it('should handle CONFIG_UPDATE message', async () => {
    await engine.loadBundle('console.log("loaded")', { theme: 'light' });

    await engine.sendToSandbox({
      type: HostMsg.CONFIG_UPDATE,
      config: { theme: 'dark', fontSize: 16 },
    });

    expect(engine.isLoaded).toBe(true);
  });

  it('should handle DESTROY message', async () => {
    await engine.loadBundle('console.log("loaded")');
    expect(engine.isDestroyed).toBe(false);

    await engine.sendToSandbox({
      type: HostMsg.DESTROY,
    });

    expect(engine.isDestroyed).toBe(true);
  });

  it('should not send message when engine is destroyed', async () => {
    await engine.loadBundle('console.log("loaded")');
    engine.destroy();

    await expect(
      engine.sendToSandbox({
        type: HostMsg.HOST_EVENT,
        eventName: 'TEST',
        payload: null,
      })
    ).resolves.toBeUndefined();
  });
});

describe('Engine Event Listener Error Handling', () => {
  let engine: Engine;
  let customLogger: {
    log: ReturnType<typeof mock>;
    warn: ReturnType<typeof mock>;
    error: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    customLogger = {
      log: mock(),
      warn: mock(),
      error: mock(),
    };
    engine = new Engine({
      sandbox: 'node-vm',
      logger: customLogger,
      debug: false,
    });
  });

  afterEach(() => {
    engine.destroy();
  });

  it('should catch and log errors thrown by event listeners', async () => {
    // Register a listener that throws
    engine.on('load', () => {
      throw new Error('Listener error!');
    });

    // Also register a successful listener to verify it still runs
    const successHandler = mock();
    engine.on('load', successHandler);

    // Load should not throw despite listener error
    await engine.loadBundle('console.log("test")');

    expect(customLogger.error).toHaveBeenCalledWith(
      '[rill] Event listener error:',
      expect.any(Error)
    );
    expect(successHandler).toHaveBeenCalled();
  });

  it('should continue with other listeners after one throws', async () => {
    const handlers = [mock(), mock(), mock()];

    // First handler throws
    handlers[0].mockImplementation(() => {
      throw new Error('First handler error');
    });

    handlers.forEach((h) => engine.on('load', h));

    await engine.loadBundle('console.log("test")');

    // All handlers should be called despite first one throwing
    expect(handlers[0]).toHaveBeenCalled();
    expect(handlers[1]).toHaveBeenCalled();
    expect(handlers[2]).toHaveBeenCalled();
  });
});

describe('Engine Metrics', () => {
  let engine: Engine;
  let metricsCollector: Array<{ name: string; value: number; extra?: Record<string, unknown> }>;

  beforeEach(() => {
    metricsCollector = [];
    engine = new Engine({
      sandbox: 'node-vm',
      onMetric: (name, value, extra) => {
        metricsCollector.push({ name, value, extra });
      },
    });
  });

  afterEach(() => {
    engine.destroy();
  });

  it('should emit metrics for sendToSandbox', async () => {
    await engine.loadBundle('console.log("test")');

    await engine.sendToSandbox({
      type: HostMsg.HOST_EVENT,
      eventName: 'TEST',
      payload: { data: 'value' },
    });

    const sendMetric = metricsCollector.find((m) => m.name === 'bridge.sendToSandbox');
    expect(sendMetric).toBeDefined();
    expect(sendMetric?.extra).toHaveProperty('type');
  });

  it('should emit metrics for resolveSource with URL', async () => {
    const mockFetch = mock().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('console.log("fetched")'),
    });
    // Restore: bun test shares one process across files — a leaked global
    // fetch mock breaks later files that talk to a real local server.
    const realFetch = global.fetch;
    global.fetch = mockFetch;
    try {
      await engine.loadBundle('https://example.com/bundle.js');

      const fetchMetric = metricsCollector.find((m) => m.name === 'engine.fetchBundle');
      expect(fetchMetric).toBeDefined();
      expect(fetchMetric?.extra).toHaveProperty('status', 200);
      expect(fetchMetric?.extra).toHaveProperty('size');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('should emit metrics for executeBundle', async () => {
    await engine.loadBundle('console.log("test")');

    const execMetric = metricsCollector.find((m) => m.name === 'engine.executeBundle');
    expect(execMetric).toBeDefined();
    expect(execMetric?.extra).toHaveProperty('size');
  });

  it('should emit metrics for initializeRuntime', async () => {
    await engine.loadBundle('console.log("test")');

    const initMetric = metricsCollector.find((m) => m.name === 'engine.initializeRuntime');
    expect(initMetric).toBeDefined();
  });
});

describe('Engine RequireWhitelist', () => {
  it('should use default whitelist when not provided', async () => {
    const engine = new Engine({ sandbox: 'node-vm'});

    // Default whitelist includes react, react-native, etc.
    // Use var instead of const to avoid redeclaration error since React is already injected as global
    await engine.loadBundle(`
      var _React = require('react');
    `);

    expect(engine.isLoaded).toBe(true);
    engine.destroy();
  });

  it('should enforce custom whitelist', async () => {
    const customLogger = { log: mock(), warn: mock(), error: mock() };
    const engine = new Engine({
      sandbox: 'node-vm',
      requireWhitelist: ['custom-module'],
      logger: customLogger,
    });

    // Attempting to require non-whitelisted module should throw (sync path)
    expect(() => engine.loadBundle(`const x = require('lodash');`)).toThrow();

    engine.destroy();
  });

  it('should allow whitelisted modules', async () => {
    const engine = new Engine({
      sandbox: 'node-vm',
      requireWhitelist: ['react', 'my-custom-lib'],
    });

    // Use var instead of const to avoid redeclaration error since React is already injected as global
    await engine.loadBundle(`var _React = require('react');`);
    expect(engine.isLoaded).toBe(true);

    engine.destroy();
  });
});

describe('Engine getDiagnostics().health', () => {
  it('should return health snapshot', async () => {
    const engine = new Engine({ sandbox: 'node-vm'});

    let health = engine.getDiagnostics().health;
    expect(health.loaded).toBe(false);
    expect(health.destroyed).toBe(false);
    expect(health.errorCount).toBe(0);
    expect(health.lastErrorAt).toBeNull();
    expect(health.receiverNodes).toBe(0);

    await engine.loadBundle('console.log("test")');

    health = engine.getDiagnostics().health;
    expect(health.loaded).toBe(true);
    expect(health.destroyed).toBe(false);

    engine.destroy();
  });

  it('should track error count', async () => {
    const engine = new Engine({ sandbox: 'node-vm'});

    try {
      await engine.loadBundle('throw new Error("test error")');
    } catch {
      // Expected
    }

    const health = engine.getDiagnostics().health;
    expect(health.errorCount).toBe(1);
    expect(health.lastErrorAt).not.toBeNull();

    engine.destroy();
  });

  it('should report receiver node count', async () => {
    const engine = new Engine({ sandbox: 'node-vm'});
    engine.createReceiver();

    await engine.loadBundle(`
      __rill_sendBatch({
        version: 1,
        batchId: 1,
        operations: [
          { op: 'CREATE', id: 1, type: 'View', props: {} },
          { op: 'APPEND', id: 1, parentId: 0, childId: 1 }
        ]
      });
    `);

    const health = engine.getDiagnostics().health;
    expect(health.receiverNodes).toBeGreaterThan(0);

    engine.destroy();
  });
});
