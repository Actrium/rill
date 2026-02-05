/**
 * Rill useEffect E2E Tests
 *
 * Tests React useEffect behavior in WASM QuickJS sandbox.
 * These tests verify that the timer mechanism works correctly for
 * effect scheduling, which was broken in the mock test environment.
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

// Helper to set up WASM sandbox with timer support
// biome-ignore lint/suspicious/noExplicitAny: Playwright page object with dynamic API
async function setupSandbox(page: any) {
  return page.evaluate(() => {
    const m = window.WASMModule;
    m._qjs_init();

    // Set up timer callback
    const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const timerCallback = m.addFunction((encodedValue: number) => {
      const timerId = encodedValue >> 16;
      const delay = encodedValue & 0xffff;

      const handle = setTimeout(() => {
        pendingTimers.delete(timerId);
        try {
          m._qjs_fire_timer(timerId);
          m._qjs_execute_pending_jobs();
        } catch (e) {
          console.error('Timer callback error:', e);
        }
      }, delay);

      pendingTimers.set(timerId, handle);
    }, 'vi');

    m._qjs_set_timer_callback(timerCallback);
    m._qjs_install_timer_functions();
    m._qjs_install_console();

    // Store for cleanup
    // biome-ignore lint/suspicious/noExplicitAny: Adding custom cleanup property to window
    (window as any).sandboxCleanup = () => {
      for (const handle of pendingTimers.values()) {
        clearTimeout(handle);
      }
      pendingTimers.clear();
      m.removeFunction(timerCallback);
      m._qjs_destroy();
    };

    return true;
  });
}

// Helper to evaluate code in sandbox
// biome-ignore lint/suspicious/noExplicitAny: Playwright page object with dynamic API
async function evalInSandbox(page: any, code: string): Promise<any> {
  return page.evaluate((code: string) => {
    const m = window.WASMModule;
    const evalCode = m.cwrap('qjs_eval', 'number', ['string']);
    const resultPtr = evalCode(code);
    const result = m.UTF8ToString(resultPtr);
    m._qjs_free_string(resultPtr);
    m._qjs_execute_pending_jobs();
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }, code);
}

// Helper to cleanup sandbox
// biome-ignore lint/suspicious/noExplicitAny: Playwright page object with dynamic API
async function cleanupSandbox(page: any) {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: Accessing custom cleanup property on window
    if ((window as any).sandboxCleanup) {
      // biome-ignore lint/suspicious/noExplicitAny: Accessing custom cleanup property on window
      (window as any).sandboxCleanup();
    }
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.WASMReady === true, { timeout: 10000 });
});

// =============================================================================
// React-like Hook System in Pure JS (for testing in sandbox)
// =============================================================================

const REACT_SHIM = `
// Minimal React-like implementation for testing useEffect
(function() {
  'use strict';

  // Polyfill setInterval using setTimeout (WASM bindings only have setTimeout)
  if (typeof globalThis.setInterval === 'undefined') {
    const intervals = new Map();
    let intervalId = 0;

    globalThis.setInterval = function(callback, delay) {
      const id = ++intervalId;
      intervals.set(id, true); // Mark as active

      function tick() {
        if (!intervals.has(id)) return; // Check if cleared
        callback();
        if (intervals.has(id)) { // Check again after callback (might have been cleared)
          setTimeout(tick, delay);
        }
      }
      setTimeout(tick, delay);
      return id;
    };

    globalThis.clearInterval = function(id) {
      intervals.delete(id);
    };
  }

  let hookIndex = 0;
  let hooks = [];
  let pendingEffects = [];
  let cleanupFunctions = [];
  let componentFn = null;
  let renderScheduled = false;
  let isMounted = false;

  function scheduleRender() {
    if (!isMounted || renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      if (isMounted) render();
    }, 0);
  }

  globalThis.React = {
    useState: function(initialValue) {
      const idx = hookIndex++;
      if (hooks[idx] === undefined) {
        hooks[idx] = typeof initialValue === 'function' ? initialValue() : initialValue;
      }
      const setterIdx = idx;
      const setter = function(newValue) {
        const current = hooks[setterIdx];
        const next = typeof newValue === 'function' ? newValue(current) : newValue;
        if (next !== current) {
          hooks[setterIdx] = next;
          scheduleRender();
        }
      };
      return [hooks[idx], setter];
    },

    useEffect: function(effect, deps) {
      const idx = hookIndex++;
      const prevHook = hooks[idx];
      const prevDeps = prevHook?.deps;

      let shouldRun = true;
      if (deps !== undefined && prevDeps !== undefined) {
        shouldRun = deps.length !== prevDeps.length ||
          deps.some((d, i) => d !== prevDeps[i]);
      }

      hooks[idx] = { deps, cleanup: prevHook?.cleanup };

      if (shouldRun) {
        // Schedule effect to run after render (like React does)
        pendingEffects.push({ effect, hookIdx: idx });
      }
    },

    useRef: function(initialValue) {
      const idx = hookIndex++;
      if (hooks[idx] === undefined) {
        hooks[idx] = { current: initialValue };
      }
      return hooks[idx];
    },

    useCallback: function(callback, deps) {
      const idx = hookIndex++;
      const prevDeps = hooks[idx]?.deps;

      if (prevDeps === undefined ||
          deps.length !== prevDeps.length ||
          deps.some((d, i) => d !== prevDeps[i])) {
        hooks[idx] = { callback, deps };
      }
      return hooks[idx].callback;
    },

    useMemo: function(factory, deps) {
      const idx = hookIndex++;
      const prev = hooks[idx];

      if (prev === undefined ||
          deps.length !== prev.deps.length ||
          deps.some((d, i) => d !== prev.deps[i])) {
        hooks[idx] = { value: factory(), deps };
      }
      return hooks[idx].value;
    },

    createElement: function(type, props, ...children) {
      return { type, props: props || {}, children };
    }
  };

  function runPendingEffects() {
    const effects = pendingEffects.slice();
    pendingEffects = [];

    for (const { effect, hookIdx } of effects) {
      // Run cleanup from previous effect
      const hook = hooks[hookIdx];
      if (hook && hook.cleanup) {
        hook.cleanup();
        hook.cleanup = null;
      }
      // Run new effect and store cleanup
      const cleanup = effect();
      if (typeof cleanup === 'function') {
        hooks[hookIdx].cleanup = cleanup;
      }
    }
  }

  function render() {
    if (!componentFn || !isMounted) return;

    hookIndex = 0;
    const element = componentFn();

    // Run effects after render (scheduled via setTimeout, like React)
    if (pendingEffects.length > 0) {
      setTimeout(runPendingEffects, 0);
    }

    return element;
  }

  globalThis.mountComponent = function(fn) {
    componentFn = fn;
    hooks = [];
    pendingEffects = [];
    isMounted = true;
    return render();
  };

  globalThis.unmountComponent = function() {
    isMounted = false;
    // Run all cleanup functions
    for (const hook of hooks) {
      if (hook && hook.cleanup) {
        hook.cleanup();
      }
    }
    componentFn = null;
  };

  globalThis.forceRender = function() {
    return render();
  };
})();
`;

// =============================================================================
// useEffect with Async State Updates (mirrors 03-async-operations.test.ts)
// =============================================================================
test.describe('useEffect: Async State Updates', () => {
  test('should handle async data fetch in useEffect', async ({ page }) => {
    await setupSandbox(page);

    // Inject React shim
    await evalInSandbox(page, REACT_SHIM);

    // Test async state update
    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      evalCode(`
        globalThis.testLog = [];

        function App() {
          const [data, setData] = React.useState('loading');

          React.useEffect(() => {
            testLog.push('effect-start');

            const fetchData = async () => {
              await new Promise(resolve => setTimeout(resolve, 50));
              setData('loaded');
              testLog.push('data-loaded');
            };
            fetchData();

            return () => {
              testLog.push('effect-cleanup');
            };
          }, []);

          testLog.push('render:' + data);
          return { type: 'Text', props: { testID: 'status' }, children: [data] };
        }

        mountComponent(App);
      `);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Get results
      const resultPtr = evalCode('JSON.stringify(testLog)');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);
      return JSON.parse(result);
    });

    await cleanupSandbox(page);

    // Verify sequence: render -> effect -> async update -> re-render
    expect(result).toContain('render:loading');
    expect(result).toContain('effect-start');
    expect(result).toContain('data-loaded');
    expect(result).toContain('render:loaded');

    // Effect should run after initial render
    const renderIdx = result.indexOf('render:loading');
    const effectIdx = result.indexOf('effect-start');
    expect(effectIdx).toBeGreaterThan(renderIdx);
  });

  test('should handle multiple concurrent async operations', async ({ page }) => {
    await setupSandbox(page);
    await evalInSandbox(page, REACT_SHIM);

    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      evalCode(`
        globalThis.testResults = null;

        function App() {
          const [results, setResults] = React.useState([]);

          React.useEffect(() => {
            const fetchAll = async () => {
              const promises = [
                new Promise(resolve => setTimeout(() => resolve('A'), 30)),
                new Promise(resolve => setTimeout(() => resolve('B'), 20)),
                new Promise(resolve => setTimeout(() => resolve('C'), 10))
              ];

              const values = await Promise.all(promises);
              setResults(values);
              globalThis.testResults = values;
            };
            fetchAll();
          }, []);

          return { type: 'View', props: {}, children: results };
        }

        mountComponent(App);
      `);

      await new Promise((resolve) => setTimeout(resolve, 150));

      // qjs_eval already returns JSON, so just parse once
      const resultPtr = evalCode('globalThis.testResults');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);
      return JSON.parse(result);
    });

    await cleanupSandbox(page);

    expect(result).toEqual(['A', 'B', 'C']);
  });

  test('should handle Promise.race correctly', async ({ page }) => {
    await setupSandbox(page);
    await evalInSandbox(page, REACT_SHIM);

    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      evalCode(`
        globalThis.winner = null;

        function App() {
          const [winner, setWinner] = React.useState(null);

          React.useEffect(() => {
            const race = async () => {
              const result = await Promise.race([
                new Promise(resolve => setTimeout(() => resolve('slow'), 100)),
                new Promise(resolve => setTimeout(() => resolve('fast'), 10))
              ]);
              setWinner(result);
              globalThis.winner = result;
            };
            race();
          }, []);

          return { type: 'Text', props: {}, children: [winner] };
        }

        mountComponent(App);
      `);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const resultPtr = evalCode('globalThis.winner');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);
      return JSON.parse(result);
    });

    await cleanupSandbox(page);

    expect(result).toBe('fast');
  });
});

// =============================================================================
// useEffect with Timer Operations (mirrors 03-async-operations.test.ts)
// =============================================================================
test.describe('useEffect: Timer Operations', () => {
  test('should handle setTimeout correctly', async ({ page }) => {
    await setupSandbox(page);
    await evalInSandbox(page, REACT_SHIM);

    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      evalCode(`
        globalThis.timerFired = false;

        function App() {
          const [count, setCount] = React.useState(0);

          React.useEffect(() => {
            const timer = setTimeout(() => {
              setCount(1);
              globalThis.timerFired = true;
            }, 50);

            return () => clearTimeout(timer);
          }, []);

          return { type: 'Text', props: {}, children: [count] };
        }

        mountComponent(App);
      `);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const resultPtr = evalCode('globalThis.timerFired');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);
      return JSON.parse(result);
    });

    await cleanupSandbox(page);

    expect(result).toBe(true);
  });

  test('should handle setInterval with cleanup', async ({ page }) => {
    await setupSandbox(page);
    await evalInSandbox(page, REACT_SHIM);

    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      evalCode(`
        globalThis.ticks = [];

        function App() {
          const [count, setCount] = React.useState(0);
          const countRef = React.useRef(0);

          React.useEffect(() => {
            const interval = setInterval(() => {
              countRef.current++;
              setCount(countRef.current);
              globalThis.ticks.push(countRef.current);

              if (countRef.current >= 3) {
                clearInterval(interval);
              }
            }, 30);

            return () => clearInterval(interval);
          }, []);

          return { type: 'Text', props: {}, children: [count] };
        }

        mountComponent(App);
      `);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // qjs_eval already returns JSON, so just parse once
      const resultPtr = evalCode('globalThis.ticks');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);
      return JSON.parse(result);
    });

    await cleanupSandbox(page);

    expect(result).toEqual([1, 2, 3]);
  });

  test('should cleanup timers on unmount', async ({ page }) => {
    await setupSandbox(page);
    await evalInSandbox(page, REACT_SHIM);

    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      evalCode(`
        globalThis.log = [];

        function App() {
          React.useEffect(() => {
            const timer = setTimeout(() => {
              globalThis.log.push('TIMER_AFTER_UNMOUNT');
            }, 100);

            return () => {
              clearTimeout(timer);
              globalThis.log.push('CLEANUP_CALLED');
            };
          }, []);

          return { type: 'View', props: {}, children: [] };
        }

        mountComponent(App);
      `);

      // Wait a bit then unmount
      await new Promise((resolve) => setTimeout(resolve, 30));

      evalCode('unmountComponent()');
      m._qjs_execute_pending_jobs();

      // Wait to see if timer fires after unmount
      await new Promise((resolve) => setTimeout(resolve, 150));

      const resultPtr = evalCode('JSON.stringify(globalThis.log)');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);
      return JSON.parse(result);
    });

    await cleanupSandbox(page);

    expect(result).toContain('CLEANUP_CALLED');
    expect(result).not.toContain('TIMER_AFTER_UNMOUNT');
  });
});

// =============================================================================
// useEffect Dependencies
// =============================================================================
test.describe('useEffect: Dependencies', () => {
  test('should re-run effect when dependencies change', async ({ page }) => {
    await setupSandbox(page);
    await evalInSandbox(page, REACT_SHIM);

    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      evalCode(`
        globalThis.effectRuns = [];
        globalThis.incrementCount = 0;

        function App() {
          const [value, setValue] = React.useState(0);

          React.useEffect(() => {
            globalThis.effectRuns.push('effect:' + value);
          }, [value]);

          // Auto-increment - only schedule once per value
          React.useEffect(() => {
            if (value < 2) {
              globalThis.incrementCount++;
              if (globalThis.incrementCount <= 2) {
                setTimeout(() => setValue(value + 1), 20);
              }
            }
          }, [value]);

          return { type: 'Text', props: {}, children: [value] };
        }

        mountComponent(App);
      `);

      await new Promise((resolve) => setTimeout(resolve, 200));

      const resultPtr = evalCode('JSON.stringify(globalThis.effectRuns)');
      const result = m.UTF8ToString(resultPtr);
      m._qjs_free_string(resultPtr);
      return JSON.parse(result);
    });

    await cleanupSandbox(page);

    // Effect should run for each value: 0, 1, 2
    expect(result).toContain('effect:0');
    expect(result).toContain('effect:1');
    expect(result).toContain('effect:2');
  });

  test('should not re-run effect with empty deps after initial render', async ({ page }) => {
    await setupSandbox(page);
    await evalInSandbox(page, REACT_SHIM);

    const result = await page.evaluate(async () => {
      const m = window.WASMModule;
      const evalCode = m.cwrap('qjs_eval', 'number', ['string']);

      evalCode(`
        globalThis.effectRuns = 0;
        globalThis.renderCount = 0;

        function App() {
          const [count, setCount] = React.useState(0);
          globalThis.renderCount++;

          React.useEffect(() => {
            globalThis.effectRuns++;
          }, []); // Empty deps - should only run once

          // Force re-renders
          React.useEffect(() => {
            if (count < 3) {
              setTimeout(() => setCount(c => c + 1), 20);
            }
          }, [count]);

          return { type: 'Text', props: {}, children: [count] };
        }

        mountComponent(App);
      `);

      await new Promise((resolve) => setTimeout(resolve, 200));

      const renderCountPtr = evalCode('globalThis.renderCount');
      const renderCount = JSON.parse(m.UTF8ToString(renderCountPtr));
      m._qjs_free_string(renderCountPtr);

      const effectRunsPtr = evalCode('globalThis.effectRuns');
      const effectRuns = JSON.parse(m.UTF8ToString(effectRunsPtr));
      m._qjs_free_string(effectRunsPtr);

      return { renderCount, effectRuns };
    });

    await cleanupSandbox(page);

    // Should have rendered multiple times but effect only ran once
    expect(result.renderCount).toBeGreaterThan(1);
    expect(result.effectRuns).toBe(1);
  });
});
