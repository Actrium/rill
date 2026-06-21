/**
 * WASM Provider Tests
 *
 * Tests the QuickJSNativeWASMProvider to ensure it works correctly
 * with our C API bindings.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { QuickJSNativeWASMProvider } from '../providers/quickjs-native-wasm-provider';
import type { SandboxScope, JSEngineRuntime } from '../types/provider';

// Skip if WASM not available (e.g., in some CI environments)
const describeIfWASM = typeof WebAssembly !== 'undefined' ? describe : describe.skip;

describeIfWASM('QuickJSNativeWASMProvider', () => {
  let provider: QuickJSNativeWASMProvider;
  let runtime: JSEngineRuntime;
  let context: SandboxScope;

  beforeAll(async () => {
    provider = new QuickJSNativeWASMProvider({ debug: false });
    runtime = await provider.createRuntime();
    context = runtime.createContext();
  });

  afterAll(() => {
    context?.dispose();
    runtime?.dispose();
  });

  describe('Basic Evaluation', () => {
    it('should evaluate simple expressions', () => {
      const result = context.eval('1 + 2');
      expect(result).toBe(3);
    });

    it('should handle string results', () => {
      const result = context.eval('"hello" + " " + "world"');
      expect(result).toBe('hello world');
    });

    it('should handle objects', () => {
      const result = context.eval('({ a: 1, b: 2 })');
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('should handle arrays', () => {
      const result = context.eval('[1, 2, 3]');
      expect(result).toEqual([1, 2, 3]);
    });

    it('should handle null and undefined', () => {
      expect(context.eval('null')).toBeNull();
      expect(context.eval('undefined')).toBeUndefined();
    });

    // evalAsync is the path the Engine actually uses on this provider (engine.ts routes
    // through ctx.evalAsync whenever a context defines it), yet was never asserted.
    it('evalAsync resolves with the value and rejects on a runtime error', async () => {
      // biome-ignore lint/style/noNonNullAssertion: evalAsync is defined on this provider
      expect(await context.evalAsync!('1 + 2')).toBe(3);
      // biome-ignore lint/style/noNonNullAssertion: see above
      expect(await context.evalAsync!('({ a: 1, b: [2, 3] })')).toEqual({ a: 1, b: [2, 3] });
      // biome-ignore lint/style/noNonNullAssertion: see above
      await expect(context.evalAsync!('undefinedVariable.property')).rejects.toThrow();
    });
  });

  describe('Global Variables', () => {
    it('should set and get global variables', () => {
      context.inject('testVar', 42);
      const result = context.eval('testVar');
      expect(result).toBe(42);
    });

    it('should set objects as globals', () => {
      context.inject('testObj', { x: 1, y: 2 });
      const result = context.eval('testObj.x + testObj.y');
      expect(result).toBe(3);
    });

    it('should set arrays as globals', () => {
      context.inject('testArr', [1, 2, 3]);
      const result = context.eval('testArr.reduce((a, b) => a + b, 0)');
      expect(result).toBe(6);
    });
  });

  describe('Timers (engine-owned, not provider-native)', () => {
    // Issue #10 (approach A): the WASM provider no longer installs the native C timers.
    // The host Engine injects its own TimerManager-backed setTimeout/setInterval/
    // setImmediate polyfills (whose callback arguments now cross the bridge by id —
    // approach B), keeping a single, freezable clock. So the BARE provider realm — used
    // without an Engine — has no setTimeout/clearTimeout of its own.
    it('does not install native setTimeout/clearTimeout (the engine owns timing)', () => {
      expect(context.eval('typeof setTimeout')).toBe('undefined');
      expect(context.eval('typeof clearTimeout')).toBe('undefined');
    });
  });

  describe('Error Handling', () => {
    it('should throw on syntax errors', () => {
      expect(() => {
        context.eval('function {');
      }).toThrow();
    });

    it('should throw on runtime errors', () => {
      expect(() => {
        context.eval('undefinedVariable.property');
      }).toThrow();
    });
  });

  describe('Console', () => {
    it('should have console defined', () => {
      const result = context.eval('typeof console');
      expect(result).toBe('object');
    });

    it('should have console.log defined', () => {
      const result = context.eval('typeof console.log');
      expect(result).toBe('function');
    });
  });
});

describeIfWASM('QuickJSNativeWASMProvider - Multi Context', () => {
  let provider: QuickJSNativeWASMProvider;
  let runtime: JSEngineRuntime;

  beforeAll(async () => {
    provider = new QuickJSNativeWASMProvider({ debug: false });
    runtime = await provider.createRuntime();
  });

  afterAll(() => {
    runtime?.dispose();
  });

  it('should support creating and disposing multiple contexts', async () => {
    const ctx1 = runtime.createContext();
    ctx1.inject('value', 1);
    expect(ctx1.eval('value')).toBe(1);
    ctx1.dispose();

    const ctx2 = runtime.createContext();
    ctx2.inject('value', 2);
    expect(ctx2.eval('value')).toBe(2);
    ctx2.dispose();
  });
});
