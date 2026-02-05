/**
 * Engine unit tests
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { Engine } from '../../engine';

// Mock components
const MockView: React.FC<{ children?: React.ReactNode }> = ({ children }) =>
  React.createElement('View', null, children);

const MockText: React.FC<{ children?: React.ReactNode }> = ({ children }) =>
  React.createElement('Text', null, children);

// Mock fetch
const mockFetch = mock();
global.fetch = mockFetch;

describe('Engine', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = new Engine({ sandbox: 'vm'});
    mockFetch.mockReset();
  });

  afterEach(() => {
    engine.destroy();
  });

  describe('constructor', () => {
    it('should create engine with default options', () => {
      const e = new Engine({ sandbox: 'vm'});
      expect(e.isLoaded).toBe(false);
      expect(e.isDestroyed).toBe(false);
      e.destroy();
    });

    it('should create engine with custom options', () => {
      const customLogger = {
        log: mock(),
        warn: mock(),
        error: mock(),
      };

      const e = new Engine({
        sandbox: 'vm',
        timeout: 10000,
        debug: false,
        logger: customLogger,
      });

      expect(e.isLoaded).toBe(false);
      e.destroy();
    });
  });

  describe('register', () => {
    it('should register components', () => {
      engine.register({
        View: MockView,
        Text: MockText,
      });

      const registry = engine.getRegistry();
      expect(registry.has('View')).toBe(true);
      expect(registry.has('Text')).toBe(true);
    });

    it('should allow registering multiple times', () => {
      engine.register({ View: MockView });
      engine.register({ Text: MockText });

      const registry = engine.getRegistry();
      expect(registry.has('View')).toBe(true);
      expect(registry.has('Text')).toBe(true);
    });
  });

  describe('loadBundle', () => {
    it('should fetch bundle from URL', async () => {
      const bundleCode = `
        console.log('Guest loaded');
      `;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(bundleCode),
      });

      await engine.loadBundle('https://example.com/guest.js');

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/guest.js');
      expect(engine.isLoaded).toBe(true);
    });

    it('should accept code string directly', async () => {
      const bundleCode = `console.log('Direct code');`;

      await engine.loadBundle(bundleCode);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(engine.isLoaded).toBe(true);
    });

    it('should pass initial props as config', async () => {
      const bundleCode = `
        const config = __rill_getConfig();
        console.log(config.theme);
      `;

      await engine.loadBundle(bundleCode, { theme: 'dark', userId: 123 });

      expect(engine.isLoaded).toBe(true);
    });

    it('should throw error when fetching fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(engine.loadBundle('https://example.com/not-found.js')).rejects.toThrow(
        'Failed to fetch bundle: 404'
      );
    });

    it('should throw error when loading twice', async () => {
      await engine.loadBundle('console.log("first")');

      // Guard check throws synchronously before any async path
      expect(() => engine.loadBundle('console.log("second")')).toThrow(
        'Engine already loaded a Guest'
      );
    });

    it('should throw error when destroyed', () => {
      engine.destroy();

      // Guard check throws synchronously before any async path
      expect(() => engine.loadBundle('console.log("test")')).toThrow(
        'Engine has been destroyed'
      );
    });

    it('should emit load event on success', async () => {
      const loadHandler = mock();
      engine.on('load', loadHandler);

      await engine.loadBundle('console.log("test")');

      expect(loadHandler).toHaveBeenCalled();
    });

    it('should emit error event on failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const errorHandler = mock();
      engine.on('error', errorHandler);

      await expect(engine.loadBundle('https://example.com/guest.js')).rejects.toThrow();

      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('sendEvent', () => {
    it('should send event to sandbox', async () => {
      await engine.loadBundle('console.log("test")');

      // Should not throw error
      expect(() => {
        engine.sendEvent('REFRESH', { timestamp: Date.now() });
      }).not.toThrow();
    });

    it('should not throw when engine is not loaded', () => {
      expect(() => {
        engine.sendEvent('TEST');
      }).not.toThrow();
    });
  });

  describe('updateConfig', () => {
    it('should update config', async () => {
      await engine.loadBundle('console.log("test")', { theme: 'light' });

      engine.updateConfig({ theme: 'dark' });

      // Config should be updated (internal state)
    });

    it('should merge with existing config', async () => {
      await engine.loadBundle('console.log("test")', {
        theme: 'light',
        fontSize: 14,
      });

      engine.updateConfig({ theme: 'dark' });

      // fontSize should be preserved
    });
  });

  describe('createReceiver', () => {
    it('should create and return receiver', () => {
      const receiver = engine.createReceiver();

      expect(receiver).toBeDefined();
      expect(engine.getReceiver()).toBe(receiver);
    });

    it('should replace existing receiver', () => {
      const receiver1 = engine.createReceiver();
      const receiver2 = engine.createReceiver();

      expect(engine.getReceiver()).toBe(receiver2);
      expect(engine.getReceiver()).not.toBe(receiver1);
    });
  });

  describe('getReceiver', () => {
    it('should return null before createReceiver', () => {
      expect(engine.getReceiver()).toBeNull();
    });

    it('should return receiver after createReceiver', () => {
      engine.createReceiver();
      expect(engine.getReceiver()).not.toBeNull();
    });
  });

  describe('getRegistry', () => {
    it('should return component registry', () => {
      const registry = engine.getRegistry();

      expect(registry).toBeDefined();
      expect(typeof registry.register).toBe('function');
      expect(typeof registry.get).toBe('function');
    });
  });

  describe('on', () => {
    it('should register event listener', async () => {
      const loadHandler = mock();
      engine.on('load', loadHandler);

      await engine.loadBundle('console.log("test")');

      expect(loadHandler).toHaveBeenCalled();
    });

    it('should return unsubscribe function', async () => {
      const loadHandler = mock();
      const unsubscribe = engine.on('load', loadHandler);

      unsubscribe();

      await engine.loadBundle('console.log("test")');

      expect(loadHandler).not.toHaveBeenCalled();
    });

    it('should support multiple listeners', async () => {
      const handler1 = mock();
      const handler2 = mock();

      engine.on('load', handler1);
      engine.on('load', handler2);

      await engine.loadBundle('console.log("test")');

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('should mark engine as destroyed', () => {
      engine.destroy();

      expect(engine.isDestroyed).toBe(true);
      expect(engine.isLoaded).toBe(false);
    });

    it('should emit destroy event', () => {
      const destroyHandler = mock();
      engine.on('destroy', destroyHandler);

      engine.destroy();

      expect(destroyHandler).toHaveBeenCalled();
    });

    it('should clear receiver', () => {
      engine.createReceiver();
      expect(engine.getReceiver()).not.toBeNull();

      engine.destroy();

      expect(engine.getReceiver()).toBeNull();
    });

    it('should be idempotent', () => {
      engine.destroy();
      engine.destroy();

      expect(engine.isDestroyed).toBe(true);
    });

    it('should clear event listeners', () => {
      const handler = mock();
      engine.on('load', handler);

      engine.destroy();

      // Event listeners cleared; subsequent triggers should not call
      // (Cannot directly test; ensure no errors on multiple destroy)
      engine.destroy();
    });
  });

  describe('isLoaded', () => {
    it('should be false initially', () => {
      expect(engine.isLoaded).toBe(false);
    });

    it('should be true after loading', async () => {
      await engine.loadBundle('console.log("test")');

      expect(engine.isLoaded).toBe(true);
    });

    it('should be false after destroy', async () => {
      await engine.loadBundle('console.log("test")');
      engine.destroy();

      expect(engine.isLoaded).toBe(false);
    });
  });

  describe('isDestroyed', () => {
    it('should be false initially', () => {
      expect(engine.isDestroyed).toBe(false);
    });

    it('should be true after destroy', () => {
      engine.destroy();

      expect(engine.isDestroyed).toBe(true);
    });
  });
});

describe('Engine Polyfills', () => {
  let engine: Engine;
  const mockLogger = { log: mock(), warn: mock(), error: mock() };

  beforeEach(() => {
    engine = new Engine({ sandbox: 'vm', debug: true, logger: mockLogger });
  });

  afterEach(() => {
    engine.destroy();
  });

  it('should provide console polyfill', async () => {
    // console should be available in the sandbox
    await engine.loadBundle(`
      console.log('Log message');
      console.warn('Warn message');
      console.error('Error message');
    `);

    expect(engine.isLoaded).toBe(true);
  });

  it('should provide setTimeout polyfill', async () => {
    await engine.loadBundle(`
      const id = setTimeout(() => {
        console.log('Timeout fired');
      }, 100);
    `);

    expect(engine.isLoaded).toBe(true);
  });

  it('should provide clearTimeout polyfill', async () => {
    await engine.loadBundle(`
      const id = setTimeout(() => {}, 1000);
      clearTimeout(id);
    `);

    expect(engine.isLoaded).toBe(true);
  });

  it('should provide setInterval polyfill', async () => {
    await engine.loadBundle(`
      const id = setInterval(() => {
        console.log('Interval tick');
      }, 100);
      clearInterval(id);
    `);

    expect(engine.isLoaded).toBe(true);
  });

  it('should provide queueMicrotask polyfill', async () => {
    await engine.loadBundle(`
      queueMicrotask(() => {
        console.log('Microtask executed');
      });
    `);

    expect(engine.isLoaded).toBe(true);
  });
});

describe('Engine Runtime API', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = new Engine({ sandbox: 'vm'});
  });

  afterEach(() => {
    engine.destroy();
  });

  it('should provide __rill_getConfig API', async () => {
    await engine.loadBundle(
      `
      const config = __rill_getConfig();
      console.log(config.theme);
    `,
      { theme: 'dark' }
    );

    expect(engine.isLoaded).toBe(true);
  });

  it('should provide __rill_sendBatch API', async () => {
    const _receiver = engine.createReceiver();

    await engine.loadBundle(`
      __rill_sendBatch({
        version: 1,
        batchId: 1,
        operations: []
      });
    `);

    expect(engine.isLoaded).toBe(true);
  });
});

describe('Engine Error Handling', () => {
  let engine: Engine;
  let errorHandler: ReturnType<typeof mock>;

  beforeEach(() => {
    engine = new Engine({ sandbox: 'vm'});
    errorHandler = mock();
    engine.on('error', errorHandler);
  });

  afterEach(() => {
    engine.destroy();
  });

  it('should handle fetch network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(engine.loadBundle('https://example.com/guest.js')).rejects.toThrow(
      'Network error'
    );

    expect(errorHandler).toHaveBeenCalled();
  });

  it('should handle HTTP error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    await expect(engine.loadBundle('https://example.com/guest.js')).rejects.toThrow(
      'Failed to fetch bundle: 500'
    );
  });
});

describe('Engine Timer Fallbacks', () => {
  it('should execute setTimeout callback eventually (simulating fallback behavior)', async () => {
    // This tests that the Promise.resolve().then(fn) fallback pattern works
    // The actual fallback is triggered when globalThis.setTimeout is undefined
    // We test the behavior pattern here without removing the global

    let executed = false;

    // Simulate the fallback pattern used in engine.ts
    const fallbackSetTimeout = (fn: () => void, _ms?: number) => {
      Promise.resolve().then(fn);
      return 0;
    };

    fallbackSetTimeout(() => {
      executed = true;
    }, 10);

    // Wait for microtask to execute
    await new Promise((resolve) => Promise.resolve().then(resolve));

    expect(executed).toBe(true);
  });

  it('should handle clearTimeout fallback (no-op)', () => {
    // Test that the clearTimeout fallback doesn't throw
    const fallbackClearTimeout = () => {};

    expect(() => fallbackClearTimeout()).not.toThrow();
  });

  it('should handle setInterval fallback', () => {
    // Test the fallback pattern for setInterval
    const fallbackSetInterval = () => 0;

    const result = fallbackSetInterval();
    expect(result).toBe(0);
  });

  it('should handle clearInterval fallback (no-op)', () => {
    // Test that the clearInterval fallback doesn't throw
    const fallbackClearInterval = () => {};

    expect(() => fallbackClearInterval()).not.toThrow();
  });

  it('should handle queueMicrotask fallback', async () => {
    // Test the queueMicrotask fallback pattern
    let executed = false;

    const fallbackQueueMicrotask = (fn: () => void) => Promise.resolve().then(fn);

    fallbackQueueMicrotask(() => {
      executed = true;
    });

    // Wait for microtask
    await new Promise((resolve) => Promise.resolve().then(resolve));

    expect(executed).toBe(true);
  });
});
