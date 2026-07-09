/**
 * Bun test setup file
 * Provides compatibility shims for Bun-based tests.
 *
 * IMPORTANT: Global polyfills MUST be defined before any imports
 * because module resolution happens synchronously and some modules
 * (like react-test-renderer) expect these globals during load time.
 */

// Set __RILL_GUEST_ENV__ to enable sandbox mode for SDK tests
// This makes components return string identifiers instead of react-native components
(globalThis as Record<string, unknown>).__RILL_GUEST_ENV__ = true;

// Store original console if it exists
const originalConsole = globalThis.console;

// Suppress known test warnings that clutter output
const SUPPRESSED_WARNINGS = [
  'react-test-renderer is deprecated',
  'The current testing environment is not configured to support act',
];

const shouldSuppressMessage = (message: string): boolean => {
  return SUPPRESSED_WARNINGS.some((warning) => message.includes(warning));
};

// CRITICAL: Ensure console is ALWAYS defined and has createTask
// Some modules (react-jsx-dev-runtime) access console during module load
if (globalThis.console) {
  // Ensure createTask is available for react-test-renderer
  // biome-ignore lint/suspicious/noExplicitAny: Console polyfill requires runtime property check
  if (!(globalThis.console as any).createTask) {
    // biome-ignore lint/suspicious/noExplicitAny: Console polyfill requires runtime property assignment
    (globalThis.console as any).createTask = () => ({ run: (fn: () => void) => fn() });
  }
} else {
  // Create minimal console if it doesn't exist
  (globalThis as Record<string, unknown>).console = {
    log: () => {},
    warn: () => {},
    error: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    createTask: () => ({ run: (fn: () => void) => fn() }),
  };
}

// Ensure queueMicrotask is defined globally
if (typeof globalThis.queueMicrotask === 'undefined') {
  (globalThis as Record<string, unknown>).queueMicrotask = (callback: () => void) => {
    Promise.resolve().then(callback);
  };
}

// Ensure setTimeout/clearTimeout are defined (required by react-test-renderer)
if (typeof globalThis.setTimeout === 'undefined') {
  let timerId = 0;
  // biome-ignore lint/suspicious/noExplicitAny: Timer map stores promises with dynamic types
  const timers = new Map<number, any>();
  const originalSetTimeout = globalThis.setTimeout;

  if (originalSetTimeout) {
    // If setTimeout already exists, use it
    (globalThis as Record<string, unknown>).clearTimeout = (id: number) => {
      if (typeof originalSetTimeout !== 'undefined') {
        globalThis.clearTimeout(id);
      }
      timers.delete(id);
    };
  } else {
    // Create a polyfilled setTimeout using Bun.sleep
    // Reason: setTimeout accepts arbitrary callback signature and args
    (globalThis as Record<string, unknown>).setTimeout = (
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const id = ++timerId;
      try {
        const promise =
          globalThis.Bun?.sleep?.(ms ?? 0)?.then?.(() => {
            timers.delete(id);
            fn(...args);
          }) ??
          Promise.resolve().then(() => {
            timers.delete(id);
            fn(...args);
          });
        timers.set(id, promise);
      } catch {
        // Fallback: execute immediately
        fn(...args);
      }
      return id;
    };
    (globalThis as Record<string, unknown>).clearTimeout = (id: number) => {
      timers.delete(id);
    };
  }
}
if (typeof globalThis.setInterval === 'undefined') {
  (globalThis as Record<string, unknown>).setInterval = () => 0;
  (globalThis as Record<string, unknown>).clearInterval = () => {};
}

// Now import bun:test after polyfills are in place
import { mock, spyOn } from 'bun:test';

// CRITICAL: Ensure console is available before react modules try to load
// This is a defensive measure to prevent ReferenceError: console is not defined
// when react-jsx-dev-runtime loads
const preloadReactConsole = () => {
  if (!globalThis.console) {
    globalThis.console = {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: Console polyfill requires runtime property check
  if (!(globalThis.console as any).createTask) {
    // biome-ignore lint/suspicious/noExplicitAny: Console polyfill requires runtime property assignment
    (globalThis.console as any).createTask = () => ({ run: (fn: () => void) => fn() });
  }
};
preloadReactConsole();

// Silence console output during tests (if console exists)
// Preserve original console properties like createTask
if (globalThis.console) {
  try {
    // Store original createTask before any modifications
    const originalCreateTask =
      // biome-ignore lint/suspicious/noExplicitAny: Console polyfill requires runtime property access
      (console as any).createTask ||
      originalConsole?.createTask ||
      (() => ({ run: (fn: () => void) => fn() }));

    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});

    // CRITICAL: Restore createTask after spyOn, as spyOn may have replaced console
    // biome-ignore lint/suspicious/noExplicitAny: Console polyfill requires runtime property assignment
    (console as any).createTask = originalCreateTask;
  } catch {
    // Some test environments may not allow spying on console
    // Ensure createTask exists anyway
    // biome-ignore lint/suspicious/noExplicitAny: Console polyfill requires runtime property check
    if (!(console as any).createTask) {
      // biome-ignore lint/suspicious/noExplicitAny: Console polyfill requires runtime property assignment
      (console as any).createTask = () => ({ run: (fn: () => void) => fn() });
    }
  }
}

// Mock react-native module FIRST before any other imports
mock.module('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  ScrollView: 'ScrollView',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
    // Reason: StyleSheet.flatten accepts arbitrary style objects
    flatten: (style: unknown) => style,
  },
  Platform: {
    OS: 'ios',
    select: <T>(obj: { ios?: T; android?: T; default?: T }): T | undefined =>
      obj.ios ?? obj.default,
  },
  Dimensions: {
    get: () => ({ width: 375, height: 812 }),
  },
  Alert: {
    alert: () => {},
  },
}));

if (process.env.RILL_TEST_DOM === '1') {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  GlobalRegistrator.register();
}

// Make mock available globally for compatibility
(globalThis as Record<string, unknown>).mock = mock;

// Provide vi compatibility shim for tests that still use vi
const vi = {
  fn: mock,
  // Reason: spyOn accepts any object and method name for test mocking
  spyOn: (obj: unknown, method: string) => {
    const original = (obj as Record<string, unknown>)[method];
    const mockFn = mock(original as (...args: unknown[]) => unknown);
    (obj as Record<string, unknown>)[method] = mockFn;
    return mockFn;
  },
  useFakeTimers: () => {
    // Bun doesn't have full fake timers support yet
    if (globalThis.console?.warn) {
      globalThis.console.warn('[test] vi.useFakeTimers() is not fully supported in Bun');
    }
  },
  useRealTimers: () => {
    // No-op
  },
  advanceTimersByTime: (_ms: number) => {
    if (globalThis.console?.warn) {
      globalThis.console.warn('[test] vi.advanceTimersByTime() is not supported in Bun');
    }
  },
  runAllTimersAsync: async () => {
    // Wait for any pending microtasks
    if (typeof globalThis.setTimeout === 'function') {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
  },
  restoreAllMocks: () => {
    // No-op - Bun handles this automatically
  },
  clearAllMocks: () => {
    // No-op
  },
  resetAllMocks: () => {
    // No-op
  },
  mocked: <T>(item: T): T => item,
};

(globalThis as Record<string, unknown>).vi = vi;

// Override console.warn and console.error to suppress known noisy warnings
const originalWarn = console.warn;
const originalError = console.error;

console.warn = (...args: unknown[]) => {
  const message = args.join(' ');
  if (!shouldSuppressMessage(message)) {
    originalWarn(...args);
  }
};

console.error = (...args: unknown[]) => {
  const message = args.join(' ');
  if (!shouldSuppressMessage(message)) {
    originalError(...args);
  }
};
