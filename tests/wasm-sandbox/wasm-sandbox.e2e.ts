/**
 * WASM Sandbox E2E Tests
 *
 * Tests QuickJS WASM sandbox in real browser environment.
 * Verifies that timers and useEffect work correctly.
 */

import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    // biome-ignore lint/suspicious/noExplicitAny: WASM module has dynamic Emscripten API
    WASMModule: any;
    WASMReady: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: Error object can have any structure
    WASMError: any;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Wait for WASM to be ready
  await page.waitForFunction(() => window.WASMReady === true, { timeout: 10000 });
});

// =============================================================================
// Basic WASM Functionality
// =============================================================================
test.describe('WASM Basic', () => {
  test('should load WASM module', async ({ page }) => {
    const ready = await page.evaluate(() => window.WASMReady);
    expect(ready).toBe(true);
  });

  test('should have QuickJS functions', async ({ page }) => {
    const hasFunctions = await page.evaluate(() => {
      const m = window.WASMModule;
      return (
        typeof m._qjs_init === 'function' &&
        typeof m._qjs_eval === 'function' &&
        typeof m._qjs_destroy === 'function'
      );
    });
    expect(hasFunctions).toBe(true);
  });

  test('should evaluate simple expression', async ({ page }) => {
    const result = await page.evaluate(() => {
      const m = window.WASMModule;
      m._qjs_init();
      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);
      const resultPtr = evalCode('1 + 2');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);
      m._qjs_destroy();
      return JSON.parse(result);
    });
    expect(result).toBe(3);
  });
});

// =============================================================================
// Timer Functionality
// =============================================================================
test.describe('WASM Timers', () => {
  test('should have setTimeout defined', async ({ page }) => {
    const result = await page.evaluate(() => {
      const m = window.WASMModule;
      m._qjs_init();
      m._qjs_install_timer_functions();

      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);
      const resultPtr = evalCode('typeof setTimeout');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);
      m._qjs_destroy();
      return JSON.parse(result);
    });
    expect(result).toBe('function');
  });

  test('should execute setTimeout callback', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      m._qjs_init();

      // Set up timer callback
      const pendingTimers = new Map();
      const timerCallback = m.addFunction((encodedValue: number) => {
        const timerId = encodedValue >> 16;
        const delay = encodedValue & 0xffff;

        const handle = setTimeout(() => {
          pendingTimers.delete(timerId);
          m._qjs_fire_timer(timerId);
          m._qjs_execute_pending_jobs();
        }, delay);

        pendingTimers.set(timerId, handle);
      }, 'vi');

      m._qjs_set_timer_callback(timerCallback);
      m._qjs_install_timer_functions();

      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      // Set up timer test
      evalCode(`
        globalThis.timerFired = false;
        setTimeout(() => {
          globalThis.timerFired = true;
        }, 10);
      `);

      // Wait for timer
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check result
      const resultPtr = evalCode('globalThis.timerFired');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);

      // Cleanup
      m.removeFunction(timerCallback);
      m._qjs_destroy();

      return JSON.parse(result);
    });
    expect(result).toBe(true);
  });

  test('should handle Promise with setTimeout', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      m._qjs_init();

      // Set up timer callback
      const pendingTimers = new Map();
      const timerCallback = m.addFunction((encodedValue: number) => {
        const timerId = encodedValue >> 16;
        const delay = encodedValue & 0xffff;

        const handle = setTimeout(() => {
          pendingTimers.delete(timerId);
          m._qjs_fire_timer(timerId);
          m._qjs_execute_pending_jobs();
        }, delay);

        pendingTimers.set(timerId, handle);
      }, 'vi');

      m._qjs_set_timer_callback(timerCallback);
      m._qjs_install_timer_functions();

      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      // Test Promise + setTimeout
      evalCode(`
        globalThis.promiseResult = 'pending';
        (async () => {
          await new Promise(resolve => setTimeout(resolve, 20));
          globalThis.promiseResult = 'resolved';
        })();
      `);

      // Wait for promise
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check result
      const resultPtr = evalCode('globalThis.promiseResult');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);

      // Cleanup
      m.removeFunction(timerCallback);
      m._qjs_destroy();

      return JSON.parse(result);
    });
    expect(result).toBe('resolved');
  });
});

// =============================================================================
// React useEffect Simulation
// =============================================================================
test.describe('WASM useEffect Simulation', () => {
  test('should handle effect-like scheduling', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      m._qjs_init();

      // Set up timer callback
      const timerCallback = m.addFunction((encodedValue: number) => {
        const timerId = encodedValue >> 16;
        const delay = encodedValue & 0xffff;

        setTimeout(() => {
          m._qjs_fire_timer(timerId);
          m._qjs_execute_pending_jobs();
        }, delay);
      }, 'vi');

      m._qjs_set_timer_callback(timerCallback);
      m._qjs_install_timer_functions();

      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      // Simulate useEffect scheduling (similar to react-reconciler)
      evalCode(`
        globalThis.effectLog = [];

        // Simulate scheduleCallback (like react-reconciler does)
        function scheduleEffect(callback) {
          setTimeout(() => {
            callback();
            globalThis.effectLog.push('effect executed');
          }, 0);
        }

        // Simulate component mount with useEffect
        globalThis.effectLog.push('render');
        scheduleEffect(() => {
          globalThis.effectLog.push('effect callback');
        });
        globalThis.effectLog.push('render complete');
      `);

      // Wait for effects to run
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check result
      const resultPtr = evalCode('JSON.stringify(globalThis.effectLog)');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);

      // Cleanup
      m.removeFunction(timerCallback);
      m._qjs_destroy();

      return JSON.parse(JSON.parse(result));
    });

    // Effect should run after render
    expect(result).toEqual(['render', 'render complete', 'effect callback', 'effect executed']);
  });

  test('should handle cleanup in effect-like pattern', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      m._qjs_init();

      // Set up timer callback
      const timerCallback = m.addFunction((encodedValue: number) => {
        const timerId = encodedValue >> 16;
        const delay = encodedValue & 0xffff;

        setTimeout(() => {
          m._qjs_fire_timer(timerId);
          m._qjs_execute_pending_jobs();
        }, delay);
      }, 'vi');

      m._qjs_set_timer_callback(timerCallback);
      m._qjs_install_timer_functions();

      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      // Simulate useEffect with cleanup
      evalCode(`
        globalThis.eventLog = [];
        globalThis.cleanup = null;

        function useEffectSimulation(effect) {
          setTimeout(() => {
            // Run cleanup from previous effect
            if (globalThis.cleanup) {
              globalThis.cleanup();
            }
            // Run new effect
            globalThis.cleanup = effect();
          }, 0);
        }

        // First mount
        useEffectSimulation(() => {
          globalThis.eventLog.push('effect 1 setup');
          return () => {
            globalThis.eventLog.push('effect 1 cleanup');
          };
        });
      `);

      await new Promise((resolve) => setTimeout(resolve, 30));

      // Simulate re-render (would trigger cleanup + new effect)
      evalCode(`
        useEffectSimulation(() => {
          globalThis.eventLog.push('effect 2 setup');
          return () => {
            globalThis.eventLog.push('effect 2 cleanup');
          };
        });
      `);

      await new Promise((resolve) => setTimeout(resolve, 30));

      // Check result
      const resultPtr = evalCode('JSON.stringify(globalThis.eventLog)');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);

      // Cleanup
      m.removeFunction(timerCallback);
      m._qjs_destroy();

      return JSON.parse(JSON.parse(result));
    });

    expect(result).toEqual(['effect 1 setup', 'effect 1 cleanup', 'effect 2 setup']);
  });
});
