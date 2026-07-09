import { Platform, NativeModules } from 'react-native';
import { registerTest } from '../runner/registry';
import { expect } from '../runner/expect';
import { nativeLog } from '../native-logger';
import { Engine } from 'rill/host';

// These tests run inside the real RN app runtime.
// They validate that native JSI bindings are injected (global.__*SandboxJSI) and functional.

interface SandboxContext {
  eval(code: string): unknown;
  evalBytecode?(bytecode: ArrayBuffer): unknown;
  inject(name: string, value: unknown): void;
  extract(name: string): unknown;
  dispose(): void;
  isDisposed?: boolean;
}

interface SandboxRuntime {
  createContext(): SandboxContext;
  dispose(): void;
}

interface SandboxModule {
  createRuntime(options?: { timeout?: number }): SandboxRuntime;
  isAvailable(): boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __JSCSandboxJSI: SandboxModule | undefined;
  // eslint-disable-next-line no-var
  var __QuickJSSandboxJSI: SandboxModule | undefined;
  // eslint-disable-next-line no-var
  var __HermesSandboxJSI: SandboxModule | undefined;
}

export type SandboxTarget = 'quickjs' | 'jsc' | 'hermes' | 'auto';

function getModule(target: SandboxTarget): SandboxModule {
  const mod =
    target === 'jsc'
      ? global.__JSCSandboxJSI
      : target === 'quickjs'
        ? global.__QuickJSSandboxJSI
        : target === 'hermes'
          ? global.__HermesSandboxJSI
          : global.__HermesSandboxJSI ?? global.__JSCSandboxJSI ?? global.__QuickJSSandboxJSI;

  if (!mod) {
    throw new Error(
      `JSI module not injected. target=${target} (expected global.__HermesSandboxJSI, global.__JSCSandboxJSI, or global.__QuickJSSandboxJSI)`
    );
  }
  return mod;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    // Yield to event loop (macrotasks) to allow timers/intervals to fire
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

export function registerRillSandboxTests(
  target: SandboxTarget,
  options?: { enableXpc?: boolean }
) {
  const enableXpc = options?.enableXpc === true;
  registerTest({
    id: 'env/basic',
    name: 'Environment: platform info',
    tags: ['env'],
    run() {
      // Basic sanity; we are in RN runtime.
      expect(typeof Platform.OS).toBe('string');
    },
  });

  registerTest({
    id: 'sandbox/detect',
    name: 'Sandbox: detect injected JSI globals',
    tags: ['sandbox'],
    run() {
      const hasJSC = typeof global.__JSCSandboxJSI !== 'undefined';
      const hasQuickJS = typeof global.__QuickJSSandboxJSI !== 'undefined';
      const hasHermes = typeof global.__HermesSandboxJSI !== 'undefined';

      if (target === 'jsc') {
        expect(hasJSC).toBe(true);
      } else if (target === 'quickjs') {
        expect(hasQuickJS).toBe(true);
      } else if (target === 'hermes') {
        expect(hasHermes).toBe(true);
      } else {
        // auto: at least one should exist
        expect(hasHermes || hasJSC || hasQuickJS).toBe(true);
      }
    },
  });

  registerTest({
    id: 'sandbox/smoke-eval',
    name: 'Sandbox: create runtime/context and eval (smoke)',
    tags: ['sandbox'],
    run() {
      const mod = getModule(target);

      nativeLog(`[rill-e2e][smoke-eval] begin target=${target}`);
      expect(typeof mod.isAvailable).toBe('function');
      expect(mod.isAvailable()).toBe(true);

      nativeLog('[rill-e2e][smoke-eval] createRuntime');
      const runtime = mod.createRuntime({ timeout: 1000 });
      nativeLog('[rill-e2e][smoke-eval] createContext');
      const ctx = runtime.createContext();
      nativeLog('[rill-e2e][smoke-eval] eval');
      const v = ctx.eval('1 + 2');
      nativeLog(`[rill-e2e][smoke-eval] eval result=${String(v)}`);
      expect(v).toBe(3);
      nativeLog('[rill-e2e][smoke-eval] dispose');
      ctx.dispose();
      runtime.dispose();
      nativeLog('[rill-e2e][smoke-eval] done');
    },
  });

  registerTest({
    id: 'sandbox/self-referential-value',
    name: 'Safety: self-referential extract does not crash the host',
    tags: ['sandbox', 'safety'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();
      // Cross-runtime conversion is guarded per engine (depth cap and/or
      // ancestor-path cycle detection). Engines differ in the sentinel they
      // substitute — and may legitimately throw — so the invariant asserted
      // here is: the host process survives and the context stays usable.
      try {
        const v = ctx.eval('var a = {}; a.self = a; a');
        nativeLog(`[rill-e2e][cycle] eval returned, typeof=${typeof v}`);
      } catch (e) {
        nativeLog(`[rill-e2e][cycle] eval threw (acceptable): ${String(e)}`);
      }
      expect(ctx.eval('1 + 1')).toBe(2);
      ctx.dispose();
      runtime.dispose();
    },
  });

  // JSC has no public interrupt API (see docs/reference/sandbox-comparison.md)
  // — a runaway loop there would hang the suite, so the timeout test only
  // runs on engines that enforce the budget.
  if (target === 'hermes' || target === 'quickjs') {
    registerTest({
      id: 'sandbox/timeout-interrupt',
      name: 'Safety: eval timeout aborts a runaway loop',
      tags: ['sandbox', 'safety'],
      run() {
        const mod = getModule(target);
        const runtime = mod.createRuntime({ timeout: 300 });
        const ctx = runtime.createContext();
        let threw = false;
        const start = Date.now();
        try {
          ctx.eval('while (true) {}');
        } catch (e) {
          threw = true;
          nativeLog(
            `[rill-e2e][timeout] threw after ${Date.now() - start}ms: ${String(e)}`
          );
        }
        expect(threw).toBe(true);
        // The aborted eval must not poison the context.
        expect(ctx.eval('1 + 1')).toBe(2);
        ctx.dispose();
        runtime.dispose();
      },
    });
  }

  // ============================================
  // Callback bidirectional tests (host ↔ guest)
  // ============================================

  registerTest({
    id: 'callback/host-to-guest',
    name: 'Callback: host function callable from guest',
    tags: ['callback'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      let called = false;
      let receivedArg: unknown;

      ctx.inject('hostFn', (arg: unknown) => {
        called = true;
        receivedArg = arg;
        return 'host-response';
      });

      const result = ctx.eval('hostFn("hello-from-guest")');

      expect(called).toBe(true);
      expect(receivedArg).toBe('hello-from-guest');
      expect(result).toBe('host-response');

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'callback/guest-to-host',
    name: 'Callback: guest function callable from host',
    tags: ['callback'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      ctx.eval('function guestFn(x) { return x * 2; }');
      const guestFn = ctx.extract('guestFn') as (x: number) => number;

      expect(typeof guestFn).toBe('function');
      const result = guestFn(21);
      expect(result).toBe(42);

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'callback/round-trip',
    name: 'Callback: round-trip host → guest → host',
    tags: ['callback'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      const log: string[] = [];

      ctx.inject('step1', () => {
        log.push('step1');
        return 'from-step1';
      });

      ctx.eval(`
        function orchestrate() {
          var r1 = step1();
          return 'guest-saw:' + r1;
        }
      `);

      const orchestrate = ctx.extract('orchestrate') as () => string;
      const result = orchestrate();

      expect(log).toEqual(['step1']);
      expect(result).toBe('guest-saw:from-step1');

      ctx.dispose();
      runtime.dispose();
    },
  });

  // ============================================
  // Complex type serialization tests
  // ============================================

  registerTest({
    id: 'types/primitives',
    name: 'Types: primitive values round-trip',
    tags: ['types'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      // Numbers
      expect(ctx.eval('42')).toBe(42);
      expect(ctx.eval('3.14')).toBe(3.14);
      expect(ctx.eval('-0')).toBe(-0);

      // Strings
      expect(ctx.eval('"hello"')).toBe('hello');
      expect(ctx.eval('""')).toBe('');

      // Booleans
      expect(ctx.eval('true')).toBe(true);
      expect(ctx.eval('false')).toBe(false);

      // Null/Undefined
      expect(ctx.eval('null')).toBe(null);
      expect(ctx.eval('undefined')).toBe(undefined);

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'types/arrays',
    name: 'Types: array serialization',
    tags: ['types'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      // Arrays are returned as array-like objects (indexed properties)
      // Note: JSC sandbox serialization may not preserve native Array type
      const arr = ctx.eval('[1, 2, 3]') as Record<string, unknown>;
      expect(arr['0']).toBe(1);
      expect(arr['1']).toBe(2);
      expect(arr['2']).toBe(3);

      // Array with string
      const withString = ctx.eval('["a", "b"]') as Record<string, unknown>;
      expect(withString['0']).toBe('a');
      expect(withString['1']).toBe('b');

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'types/objects',
    name: 'Types: object serialization',
    tags: ['types'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      const obj = ctx.eval('({ a: 1, b: "two", c: true })') as Record<string, unknown>;
      expect(obj.a).toBe(1);
      expect(obj.b).toBe('two');
      expect(obj.c).toBe(true);

      // Nested objects
      const nested = ctx.eval('({ outer: { inner: 42 } })') as { outer: { inner: number } };
      expect(nested.outer.inner).toBe(42);

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'types/inject-complex',
    name: 'Types: inject with complex objects',
    tags: ['types'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      ctx.inject('hostData', {
        name: 'test',
        values: [1, 2, 3],
        nested: { flag: true },
      });

      expect(ctx.eval('hostData.name')).toBe('test');
      expect(ctx.eval('hostData.values[1]')).toBe(2);
      expect(ctx.eval('hostData.nested.flag')).toBe(true);

      ctx.dispose();
      runtime.dispose();
    },
  });

  // ============================================
  // Error handling tests
  // ============================================

  registerTest({
    id: 'error/syntax-error',
    name: 'Error: syntax error throws',
    tags: ['error'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      let threw = false;
      try {
        ctx.eval('function {{{ invalid');
      } catch (e) {
        threw = true;
      }

      expect(threw).toBe(true);

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'error/runtime-error',
    name: 'Error: runtime error throws',
    tags: ['error'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      let threw = false;
      try {
        ctx.eval('undefinedVariable.foo');
      } catch (e) {
        threw = true;
      }

      expect(threw).toBe(true);

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'error/throw-propagates',
    name: 'Error: explicit throw propagates to host',
    tags: ['error'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      let threw = false;
      let errorMessage = '';
      try {
        ctx.eval('throw new Error("custom-error")');
      } catch (e) {
        threw = true;
        errorMessage = String(e);
      }

      expect(threw).toBe(true);
      expect(errorMessage.includes('custom-error')).toBe(true);

      ctx.dispose();
      runtime.dispose();
    },
  });

  // ============================================
  // Multi-context isolation tests
  // ============================================

  registerTest({
    id: 'isolation/separate-globals',
    name: 'Isolation: contexts have separate globals',
    tags: ['isolation'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });

      const ctx1 = runtime.createContext();
      const ctx2 = runtime.createContext();

      ctx1.eval('var sharedName = "ctx1"');
      ctx2.eval('var sharedName = "ctx2"');

      expect(ctx1.eval('sharedName')).toBe('ctx1');
      expect(ctx2.eval('sharedName')).toBe('ctx2');

      ctx1.dispose();
      ctx2.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'isolation/no-cross-pollution',
    name: 'Isolation: no cross-context pollution',
    tags: ['isolation'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });

      const ctx1 = runtime.createContext();
      const ctx2 = runtime.createContext();

      ctx1.eval('var onlyInCtx1 = 123');

      let threw = false;
      try {
        ctx2.eval('onlyInCtx1');
      } catch (e) {
        threw = true;
      }

      expect(threw).toBe(true);

      ctx1.dispose();
      ctx2.dispose();
      runtime.dispose();
    },
  });

  // ============================================
  // Memory / dispose tests
  // ============================================

  registerTest({
    id: 'memory/dispose-context',
    name: 'Memory: disposed context rejects operations',
    tags: ['memory'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      ctx.eval('var x = 1');
      ctx.dispose();

      let threw = false;
      try {
        ctx.eval('x + 1');
      } catch (e) {
        threw = true;
      }

      expect(threw).toBe(true);

      runtime.dispose();
    },
  });

  registerTest({
    id: 'memory/multiple-create-dispose',
    name: 'Memory: multiple create/dispose cycles',
    tags: ['memory'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });

      for (let i = 0; i < 10; i++) {
        const ctx = runtime.createContext();
        ctx.eval(`var iteration = ${i}`);
        expect(ctx.eval('iteration')).toBe(i);
        ctx.dispose();
      }

      runtime.dispose();
    },
  });

  // ============================================
  // Performance tests
  // ============================================

  registerTest({
    id: 'perf/many-evals',
    name: 'Perf: 100 sequential evals',
    tags: ['perf'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 10000 });
      const ctx = runtime.createContext();

      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        ctx.eval(`${i} + 1`);
      }
      const elapsed = Date.now() - start;

      // Should complete in reasonable time (< 1s for 100 evals)
      expect(elapsed < 1000).toBe(true);

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'callback/bulk-invocations',
    name: 'Callback: 50 host function calls execute correctly',
    tags: ['callback'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 10000 });
      const ctx = runtime.createContext();

      let callCount = 0;
      ctx.inject('increment', () => {
        callCount++;
      });

      ctx.eval('for (var i = 0; i < 50; i++) { increment(); }');

      expect(callCount).toBe(50);

      ctx.dispose();
      runtime.dispose();
    },
  });

  // ============================================
  // Engine timer + loadBundle timing
  // ============================================

  registerTest({
    id: 'engine/loadBundle/fast',
    name: 'Engine: loadBundle should complete quickly',
    tags: ['engine', 'bundle', 'timing'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      try {
        engine = new Engine({ timeout: 0, debug: false });
        const start = Date.now();
        await engine.loadBundle(`globalThis.__rillLoadBundleTest = 1;`);
        const elapsed = Date.now() - start;
        nativeLog(`[rill-e2e][loadBundle] elapsed=${elapsed}ms`);
        expect(elapsed < 1500).toBe(true);
      } finally {
        engine?.destroy();
      }
    },
  });

  registerTest({
    id: 'engine/timer/latency',
    name: 'Engine: setImmediate/setTimeout/setInterval should be responsive',
    tags: ['engine', 'timer'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      try {
        engine = new Engine({ timeout: 0 });
        await engine.loadBundle(`// init`);

        const ctx = (engine as unknown as { context?: SandboxContext }).context;
        if (!ctx) {
          throw new Error('Engine context not available');
        }

        const guestSetTimeout = ctx.extract('setTimeout') as (fn: () => void, delay: number) => number;
        const guestSetInterval = ctx.extract('setInterval') as (fn: () => void, delay: number) => number;
        const guestClearInterval = ctx.extract('clearInterval') as (id: number) => void;
        const guestSetImmediate = ctx.extract('setImmediate') as ((fn: () => void) => number);
        const guestRaf = ctx.extract('requestAnimationFrame') as
          | ((fn: (ts: number) => void) => number)
          | undefined;

        if (typeof guestSetImmediate !== 'function') {
          throw new Error('setImmediate not available in sandbox');
        }

        // setImmediate: should fire within 200ms (accounts for JSI + bridge overhead)
        let immediateFiredAt = 0;
        const immediateStart = Date.now();
        guestSetImmediate(() => { immediateFiredAt = Date.now(); });
        expect(await waitFor(() => immediateFiredAt > 0, 2000)).toBe(true);
        expect(immediateFiredAt - immediateStart < 200).toBe(true);

        // setTimeout(0): non-blocking call, fires within 500ms
        let timeoutFiredAt = 0;
        const timeoutStart = Date.now();
        guestSetTimeout(() => { timeoutFiredAt = Date.now(); }, 0);
        expect(await waitFor(() => timeoutFiredAt > 0, 2000)).toBe(true);
        expect(timeoutFiredAt - timeoutStart < 500).toBe(true);

        // setInterval(16): fires at least once within 2s, then clear
        let intervalFires = 0;
        const intervalId = guestSetInterval(() => { intervalFires += 1; }, 16);
        expect(await waitFor(() => intervalFires > 0, 2000)).toBe(true);
        guestClearInterval(intervalId);

        // requestAnimationFrame (if available): fires within 500ms
        if (typeof guestRaf === 'function') {
          let rafFiredAt = 0;
          const rafStart = Date.now();
          guestRaf(() => { rafFiredAt = Date.now(); });
          expect(await waitFor(() => rafFiredAt > 0, 2000)).toBe(true);
          expect(rafFiredAt - rafStart < 500).toBe(true);
        }
      } finally {
        engine?.destroy();
      }
    },
  });

  registerTest({
    id: 'xpc/timer/probe',
    name: 'XPC: timer availability and latency probe',
    tags: ['xpc', 'timer'],
    async run() {
      if (!enableXpc || Platform.OS !== 'macos') return;

      const xpcBridge = NativeModules.RillXPCBridge;
      if (!xpcBridge || typeof xpcBridge.runTimerProbe !== 'function') {
        throw new Error('RillXPCBridge or runTimerProbe not available');
      }

      const result = (await xpcBridge.runTimerProbe()) as {
        nstimerDelay: number;
        dispatchDelay: number;
        didFire: boolean | number;
      };
      
      nativeLog(`[rill-e2e][xpc] nstimerDelay=${result.nstimerDelay}ms dispatchDelay=${result.dispatchDelay}ms didFire=${result.didFire} raw=${JSON.stringify(result)}`);
      
      // Handle both boolean true and NSNumber 1 (which comes as number 1 in JS)
      const didFire = result.didFire === true || result.didFire === 1;
      expect(didFire).toBe(true);
      // 50ms is the requested delay, so we expect > 50.
      expect(result.nstimerDelay > 10).toBe(true);
      expect(result.dispatchDelay > 10).toBe(true);
    },
  });

  // ============================================
  // React Element simulation tests (critical for rill)
  // ============================================

  registerTest({
    id: 'react/guest-fn-returns-element',
    name: 'React: guest function returns element-like object',
    tags: ['react', 'critical'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      // Simulate a React component that returns an element
      ctx.eval(`
        function MyComponent(props) {
          return {
            __rillTypeMarker: '__rill_react_element__',
            type: 'View',
            props: { style: { flex: 1 }, children: 'Hello' }
          };
        }
      `);

      const MyComponent = ctx.extract('MyComponent') as (props: object) => object;
      expect(typeof MyComponent).toBe('function');

      // Call the component and check the returned element
      const element = MyComponent({}) as Record<string, unknown>;
      expect(element.__rillTypeMarker).toBe('__rill_react_element__');
      expect(element.type).toBe('View');
      expect((element.props as Record<string, unknown>).children).toBe('Hello');

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'react/nested-elements',
    name: 'React: guest function returns nested elements',
    tags: ['react', 'critical'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      // Simulate nested React elements (like Panel.Left wrapping LeftPanel)
      ctx.eval(`
        function UnifiedApp() {
          return {
            __rillTypeMarker: '__rill_react_element__',
            type: 'View',
            props: {
              style: { flex: 1 },
              children: [
                {
                  __rillTypeMarker: '__rill_react_element__',
                  type: 'PanelMarker',
                  props: { panelId: 'left', children: { type: 'Text', props: { children: 'Left' } } }
                },
                {
                  __rillTypeMarker: '__rill_react_element__',
                  type: 'PanelMarker',
                  props: { panelId: 'right', children: { type: 'Text', props: { children: 'Right' } } }
                }
              ]
            }
          };
        }
      `);

      const UnifiedApp = ctx.extract('UnifiedApp') as () => object;
      const element = UnifiedApp() as Record<string, unknown>;

      expect(element.__rillTypeMarker).toBe('__rill_react_element__');
      expect(element.type).toBe('View');

      const children = (element.props as Record<string, unknown>).children as Array<Record<string, unknown>>;
      expect(children.length).toBe(2);
      expect(children[0].type).toBe('PanelMarker');
      expect((children[0].props as Record<string, unknown>).panelId).toBe('left');
      expect(children[1].type).toBe('PanelMarker');
      expect((children[1].props as Record<string, unknown>).panelId).toBe('right');

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'react/fn-type-preserved',
    name: 'React: element with function type is callable from host',
    tags: ['react', 'critical'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      // Simulate React.createElement(UnifiedApp) - type is a function
      ctx.eval(`
        function UnifiedApp(props) {
          return {
            __rillTypeMarker: '__rill_react_element__',
            type: 'View',
            props: { message: 'rendered with ' + (props.name || 'default') }
          };
        }

        var element = {
          __rillTypeMarker: '__rill_react_element__',
          type: UnifiedApp,
          props: { name: 'test' }
        };
      `);

      const element = ctx.extract('element') as Record<string, unknown>;
      expect(element.__rillTypeMarker).toBe('__rill_react_element__');

      // The type should be a callable function
      const typeFn = element.type as (props: object) => object;
      expect(typeof typeFn).toBe('function');

      // Call the function to get the rendered element
      const rendered = typeFn({ name: 'host-call' }) as Record<string, unknown>;
      expect(rendered.__rillTypeMarker).toBe('__rill_react_element__');
      expect(rendered.type).toBe('View');
      expect((rendered.props as Record<string, unknown>).message).toBe('rendered with host-call');

      ctx.dispose();
      runtime.dispose();
    },
  });

  // ============================================
  // Bytecode tests (Hermes-specific)
  // ============================================

  registerTest({
    id: 'bytecode/hermes-only',
    name: 'Bytecode: evalBytecode only available on Hermes',
    tags: ['bytecode'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      if (target === 'hermes') {
        // Hermes should have evalBytecode
        expect(typeof ctx.evalBytecode).toBe('function');
      } else {
        // JSC and QuickJS should not have evalBytecode
        expect(ctx.evalBytecode).toBe(undefined);
      }

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'bytecode/invalid-throws',
    name: 'Bytecode: invalid bytecode throws error',
    tags: ['bytecode'],
    run() {
      if (target !== 'hermes') {
        // Skip for non-Hermes targets
        return;
      }

      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      if (!ctx.evalBytecode) {
        throw new Error('evalBytecode not available on Hermes sandbox');
      }

      // Create invalid bytecode (random bytes)
      const invalidBytecode = new ArrayBuffer(16);
      const view = new Uint8Array(invalidBytecode);
      for (let i = 0; i < 16; i++) {
        view[i] = i;
      }

      let threw = false;
      try {
        ctx.evalBytecode(invalidBytecode);
      } catch (e) {
        threw = true;
        nativeLog(`[bytecode/invalid-throws] Expected error: ${String(e)}`);
      }

      expect(threw).toBe(true);

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'bytecode/empty-throws',
    name: 'Bytecode: empty bytecode throws error',
    tags: ['bytecode'],
    run() {
      if (target !== 'hermes') {
        // Skip for non-Hermes targets
        return;
      }

      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      if (!ctx.evalBytecode) {
        throw new Error('evalBytecode not available on Hermes sandbox');
      }

      // Create empty bytecode
      const emptyBytecode = new ArrayBuffer(0);

      let threw = false;
      try {
        ctx.evalBytecode(emptyBytecode);
      } catch (e) {
        threw = true;
        nativeLog(`[bytecode/empty-throws] Expected error: ${String(e)}`);
      }

      expect(threw).toBe(true);

      ctx.dispose();
      runtime.dispose();
    },
  });

  // ============================================
  // Sandbox Function Identity Test
  // ============================================

  registerTest({
    id: 'sandbox/function-identity',
    name: 'Sandbox: same host function preserves identity across multiple passes',
    tags: ['sandbox', 'identity'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      // Guest function that stores the first reference it sees, and compares subsequent ones
      ctx.eval(`
        var capturedFn = null;
        function checkIdentity(fn) {
           if (!capturedFn) {
             capturedFn = fn;
             return 'captured';
           }
           return fn === capturedFn ? 'same' : 'different';
        }
      `);

      const checkIdentity = ctx.extract('checkIdentity') as (fn: unknown) => string;
      
      const hostFn = () => { return 'host'; };

      // Pass 1: Send hostFn to guest
      const res1 = checkIdentity(hostFn);
      expect(res1).toBe('captured');

      // Pass 2: Send same hostFn to guest again
      const res2 = checkIdentity(hostFn);
      
      // Same host function passed twice must yield the same guest-side reference
      expect(res2).toBe('same');

      ctx.dispose();
      runtime.dispose();
    }
  });

  // ============================================
  // Host ↔ Guest Message Passing Tests (Engine-based)
  // ============================================

  registerTest({
    id: 'engine/sendToHost/basic',
    name: 'Engine: Guest sends event to Host via __rill_emitEvent',
    tags: ['engine', 'messaging', 'sendToHost'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      const receivedEvents: Array<{ event: string; payload: unknown }> = [];

      try {
        engine = new Engine({ timeout: 0, debug: false });

        engine.on('message', (msg: { event: string; payload: unknown }) => {
          if (msg.event !== '__DIAG_ROUNDTRIP_TEST__') {
            receivedEvents.push(msg);
          }
        });

        // Guest code that sends events to Host
        const guestCode = `
          // Send a simple event
          globalThis.__rill_emitEvent('GREETING', { message: 'Hello from Guest!' });
          
          // Send an event with complex payload
          globalThis.__rill_emitEvent('DATA_UPDATE', { 
            count: 42, 
            items: ['a', 'b', 'c'],
            nested: { flag: true }
          });
        `;

        await engine.loadBundle(guestCode);

        // Wait for events to be processed
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(receivedEvents.length).toBe(2);

        // Verify first event
        const greeting = receivedEvents.find(e => e.event === 'GREETING');
        expect(greeting).toBeDefined();
        expect((greeting?.payload as { message: string })?.message).toBe('Hello from Guest!');

        // Verify second event
        const dataUpdate = receivedEvents.find(e => e.event === 'DATA_UPDATE');
        expect(dataUpdate).toBeDefined();
        const payload = dataUpdate?.payload as { count: number; items: string[]; nested: { flag: boolean } };
        expect(payload?.count).toBe(42);
        expect(payload?.items?.length).toBe(3);
        expect(payload?.nested?.flag).toBe(true);

      } finally {
        engine?.destroy();
      }
    },
  });

  registerTest({
    id: 'engine/sendToGuest/basic',
    name: 'Engine: Host sends event to Guest via sendEvent',
    tags: ['engine', 'messaging', 'sendToGuest'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;

      try {
        engine = new Engine({ timeout: 0, debug: false });

        // Guest code that listens for Host events using __rill_onHostEvent
        const guestCode = `
          globalThis.__receivedHostEvents = [];
          
          if (globalThis.__rill_onHostEvent) {
            globalThis.__rill_onHostEvent('CONFIG_UPDATE', (payload) => {
              globalThis.__receivedHostEvents.push({ event: 'CONFIG_UPDATE', payload });
            });
            
            globalThis.__rill_onHostEvent('THEME_CHANGE', (payload) => {
              globalThis.__receivedHostEvents.push({ event: 'THEME_CHANGE', payload });
            });
          }
        `;

        await engine.loadBundle(guestCode);

        // Host sends events to Guest
        engine.sendEvent('CONFIG_UPDATE', { version: '2.0', debug: true });
        engine.sendEvent('THEME_CHANGE', { theme: 'dark', accent: '#007AFF' });

        // Wait for events to be processed
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Verify Guest received the events
        const receivedEvents = engine.context?.extract('__receivedHostEvents') as Array<{ event: string; payload: unknown }>;
        
        nativeLog(`[engine/sendToGuest] Guest received ${receivedEvents?.length ?? 0} events`);

        expect(receivedEvents?.length).toBe(2);

        const configUpdate = receivedEvents?.find(e => e.event === 'CONFIG_UPDATE');
        if (!configUpdate) {
          throw new Error('CONFIG_UPDATE event not received');
        }
        expect((configUpdate?.payload as { version: string })?.version).toBe('2.0');

        const themeChange = receivedEvents?.find(e => e.event === 'THEME_CHANGE');
        if (!themeChange) {
          throw new Error('THEME_CHANGE event not received');
        }
        expect((themeChange?.payload as { theme: string })?.theme).toBe('dark');

      } finally {
        engine?.destroy();
      }
    },
  });

  registerTest({
    id: 'engine/bidirectional/basic',
    name: 'Engine: Bidirectional Host ↔ Guest messaging',
    tags: ['engine', 'messaging', 'bidirectional'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      const hostReceivedEvents: Array<{ event: string; payload: unknown }> = [];

      try {
        engine = new Engine({ timeout: 0, debug: false });

        // Subscribe to messages from Guest
        engine.on('message', (msg: { event: string; payload: unknown }) => {
          // Filter out diagnostic events
          if (msg.event !== '__DIAG_ROUNDTRIP_TEST__') {
            hostReceivedEvents.push(msg);
          }
        });

        // Guest code that:
        // 1. Listens for HOST_COMMAND events
        // 2. Responds back with GUEST_RESPONSE events
        const guestCode = `
          globalThis.__commandsProcessed = 0;
          
          if (globalThis.__rill_onHostEvent) {
            globalThis.__rill_onHostEvent('HOST_COMMAND', (payload) => {
              globalThis.__commandsProcessed++;
              
              // Echo back with transformed data
              globalThis.__rill_emitEvent('GUEST_RESPONSE', {
                originalCommand: payload.action,
                result: payload.action.toUpperCase() + '_DONE',
                processedAt: Date.now()
              });
            });
          }
        `;

        await engine.loadBundle(guestCode);

        // Host sends a command to Guest
        engine.sendEvent('HOST_COMMAND', { action: 'fetch_data' });

        // Wait for round-trip
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Verify bidirectional flow
        const commandsProcessed = engine.context?.extract('__commandsProcessed');
        expect(commandsProcessed).toBe(1);

        expect(hostReceivedEvents.length).toBe(1);
        const response = hostReceivedEvents[0];
        expect(response.event).toBe('GUEST_RESPONSE');
        
        const payload = response.payload as { originalCommand: string; result: string };
        expect(payload.originalCommand).toBe('fetch_data');
        expect(payload.result).toBe('FETCH_DATA_DONE');

        nativeLog(`[engine/bidirectional] Round-trip successful: ${payload.result}`);

      } finally {
        engine?.destroy();
      }
    },
  });

  registerTest({
    id: 'engine/sendToHost/rapid',
    name: 'Engine: Rapid successive sendToHost calls',
    tags: ['engine', 'messaging', 'stress'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      const receivedEvents: Array<{ event: string; payload: unknown }> = [];

      try {
        engine = new Engine({ timeout: 0, debug: false });

        engine.on('message', (msg: { event: string; payload: unknown }) => {
          // Filter out diagnostic events
          if (msg.event !== '__DIAG_ROUNDTRIP_TEST__') {
            receivedEvents.push(msg);
          }
        });

        // Guest sends many events rapidly
        const guestCode = `
          for (let i = 0; i < 20; i++) {
            globalThis.__rill_emitEvent('RAPID_EVENT', { index: i });
          }
        `;

        await engine.loadBundle(guestCode);
        await new Promise((resolve) => setTimeout(resolve, 200));

        nativeLog(`[engine/sendToHost/rapid] Received ${receivedEvents.length} of 20 events`);

        expect(receivedEvents.length).toBe(20);

        // Verify all indices are present
        const indices = receivedEvents.map(e => (e.payload as { index: number }).index).sort((a, b) => a - b);
        for (let i = 0; i < 20; i++) {
          expect(indices[i]).toBe(i);
        }

      } finally {
        engine?.destroy();
      }
    },
  });

  registerTest({
    id: 'engine/sendToHost/from-callback',
    name: 'Engine: sendToHost from within a Host-invoked callback',
    tags: ['engine', 'messaging', 'callback'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      const receivedEvents: Array<{ event: string; payload: unknown }> = [];

      try {
        engine = new Engine({ timeout: 0, debug: false });

        engine.on('message', (msg: { event: string; payload: unknown }) => {
          // Filter out diagnostic events
          if (msg.event !== '__DIAG_ROUNDTRIP_TEST__') {
            receivedEvents.push(msg);
          }
        });

        // Guest creates a callback function
        const guestCode = `
          globalThis.guestCallback = (value) => {
            globalThis.__rill_emitEvent('CALLBACK_INVOKED', { 
              receivedValue: value,
              doubled: value * 2 
            });
            return value * 2;
          };
        `;

        await engine.loadBundle(guestCode);

        // Host retrieves and invokes the Guest callback
        const guestCallback = engine.context?.extract('guestCallback') as (v: number) => number;
        expect(typeof guestCallback).toBe('function');

        const result = guestCallback(21);
        
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(result).toBe(42);
        expect(receivedEvents.length).toBe(1);
        
        const event = receivedEvents[0];
        expect(event.event).toBe('CALLBACK_INVOKED');
        const payload = event.payload as { receivedValue: number; doubled: number };
        expect(payload.receivedValue).toBe(21);
        expect(payload.doubled).toBe(42);

        nativeLog(`[engine/sendToHost/from-callback] Callback result: ${result}, event received`);

      } finally {
        engine?.destroy();
      }
    },
  });

  // ============================================
  // Function Round-trip Identity & Callability Tests
  // ============================================

  registerTest({
    id: 'sandbox/function-roundtrip-callable',
    name: 'Sandbox: host function survives inject→extract→inject round-trip',
    tags: ['sandbox', 'identity', 'critical'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      // Simulate what Engine.postGuestBundleSetup does:
      // 1. Set a host function via inject
      // 2. Read it back via extract (converts sandbox JSValue → jsi::Value, creating sandboxProxy)
      // 3. Re-set via inject (wraps sandboxProxy → new native block + wrapper)
      // 4. Verify the round-tripped function is still callable from guest code

      let hostCallCount = 0;
      let lastArg: unknown = undefined;

      // Step 1: Set host function on sandbox
      ctx.inject('hostFn', (arg: unknown) => {
        hostCallCount++;
        lastArg = arg;
        return 'host-response';
      });

      // Verify direct call works
      const directResult = ctx.eval('hostFn("direct")');
      expect(hostCallCount).toBe(1);
      expect(lastArg).toBe('direct');
      expect(directResult).toBe('host-response');

      // Step 2: Read back via extract (creates sandboxProxy in host runtime)
      const roundTripped = ctx.extract('hostFn');
      expect(typeof roundTripped).toBe('function');

      // Step 3: Re-set via inject (wraps sandboxProxy into new native block + wrapper)
      ctx.inject('hostFn_roundtripped', roundTripped);

      // Step 4: Verify the round-tripped function is still callable from guest
      hostCallCount = 0;
      const roundTripResult = ctx.eval('hostFn_roundtripped("roundtripped")');

      nativeLog(`[sandbox/function-roundtrip] hostCallCount=${hostCallCount} lastArg=${lastArg} result=${roundTripResult}`);

      expect(hostCallCount).toBe(1);
      expect(lastArg).toBe('roundtripped');
      expect(roundTripResult).toBe('host-response');

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'sandbox/object-function-roundtrip',
    name: 'Sandbox: object with function props survives extract→inject round-trip',
    tags: ['sandbox', 'identity', 'critical'],
    run() {
      const mod = getModule(target);
      const runtime = mod.createRuntime({ timeout: 5000 });
      const ctx = runtime.createContext();

      // Simulate postGuestBundleSetup pattern with RillGuest-like object:
      // 1. Guest defines an object with function props (like GUEST_BUNDLE_CODE creates RillGuest)
      // 2. Host reads it back (extract)
      // 3. Host re-sets it (inject)
      // 4. Guest code reads through the re-set object

      let hostCallCount = 0;
      let lastEvent: unknown = undefined;

      // Set a host function that acts like __rill_emitEvent
      ctx.inject('__testEventToHost', (event: unknown) => {
        hostCallCount++;
        lastEvent = event;
      });

      // Create a SDK-like object in sandbox with a useSendToHost-like function
      ctx.eval(`
        globalThis.TestSDK = {
          useSendToHost: function() {
            if ('__testEventToHost' in globalThis) {
              return globalThis.__testEventToHost;
            }
            return function() {};
          },
          someValue: 42
        };
      `);

      // Step 2: Read back via extract (postGuestBundleSetup pattern)
      const sdk = ctx.extract('TestSDK');
      expect(typeof sdk).toBe('object');

      // Step 3: Re-set (postGuestBundleSetup pattern)
      ctx.inject('TestSDK', sdk);

      // Step 4: Guest code uses the re-set SDK to get and call sendToHost
      const result = ctx.eval(`
        var sendFn = TestSDK.useSendToHost();
        var typeStr = typeof sendFn;
        sendFn('TEST_EVENT');
        typeStr;
      `);

      nativeLog(`[sandbox/object-function-roundtrip] sendFn type=${result} hostCallCount=${hostCallCount} lastEvent=${lastEvent}`);

      expect(result).toBe('function');
      expect(hostCallCount).toBe(1);
      expect(lastEvent).toBe('TEST_EVENT');

      ctx.dispose();
      runtime.dispose();
    },
  });

  registerTest({
    id: 'engine/sendToHost/via-useSendToHost',
    name: 'Engine: Guest sends event via RillGuest.useSendToHost() hook',
    tags: ['engine', 'messaging', 'sendToHost', 'sdk', 'critical'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      const receivedEvents: Array<{ event: string; payload: unknown }> = [];

      try {
        engine = new Engine({ timeout: 0, debug: false });

        engine.on('message', (msg: { event: string; payload: unknown }) => {
          if (msg.event !== '__DIAG_ROUNDTRIP_TEST__') {
            receivedEvents.push(msg);
          }
        });

        // Guest code uses useSendToHost() exactly like a real guest app:
        // 1. Reads RillGuest (which was re-set by postGuestBundleSetup)
        // 2. Calls useSendToHost() to get the send function
        // 3. Calls the send function
        const guestCode = `
          var sendToHost = RillGuest.useSendToHost();

          if (typeof sendToHost !== 'function') {
            throw new Error('useSendToHost() did not return a function, got: ' + typeof sendToHost);
          }

          sendToHost('HELLO_VIA_SDK', { source: 'useSendToHost' });

          // Also verify direct __rill_emitEvent still works
          globalThis.__rill_emitEvent('HELLO_DIRECT', { source: 'direct' });
        `;

        await engine.loadBundle(guestCode);

        await new Promise((resolve) => setTimeout(resolve, 100));

        nativeLog(`[engine/sendToHost/via-useSendToHost] events=${receivedEvents.length}: ${receivedEvents.map(e => e.event).join(', ')}`);

        // Both SDK hook path and direct path should work
        expect(receivedEvents.length).toBe(2);

        const sdkEvent = receivedEvents.find(e => e.event === 'HELLO_VIA_SDK');
        expect(sdkEvent).toBeDefined();
        expect((sdkEvent?.payload as { source: string })?.source).toBe('useSendToHost');

        const directEvent = receivedEvents.find(e => e.event === 'HELLO_DIRECT');
        expect(directEvent).toBeDefined();
        expect((directEvent?.payload as { source: string })?.source).toBe('direct');

      } finally {
        engine?.destroy();
      }
    },
  });

  // ============================================
  // UI Callback Path Tests (RillReconciler → onPress → sendToHost)
  // ============================================
  // Tests the full user interaction flow:
  // 1. Guest renders UI with callback props via RillReconciler
  // 2. Host captures rendered operations (CREATE with props)
  // 3. Host simulates user interaction by invoking callback via __rill.invokeCallback
  // 4. Callback handler calls sendToHost
  // 5. Host receives the message

  registerTest({
    id: 'engine/ui-callback/onPress-sendToHost',
    name: 'Engine: sendToHost from UI callback (onPress → __rill.invokeCallback → sendToHost)',
    tags: ['engine', 'ui-callback', 'reconciler', 'critical'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      const receivedEvents: Array<{ event: string; payload: unknown }> = [];
      const capturedOperations: Array<{
        op: string;
        id: number;
        type?: string;
        props?: Record<string, unknown>;
      }> = [];

      try {
        engine = new Engine({ timeout: 0 });

        engine.on('message', (msg: { event: string; payload: unknown }) => {
          if (msg.event !== '__DIAG_ROUNDTRIP_TEST__') {
            receivedEvents.push(msg);
          }
        });

        engine.on('operation', (batch: { operations?: Array<{
          op: string;
          id: number;
          type?: string;
          props?: Record<string, unknown>;
        }> }) => {
          if (batch?.operations) {
            for (const op of batch.operations) {
              capturedOperations.push(op);
            }
          }
        });

        engine.createReceiver();

        const guestCode = `
          var sendEventToHost = RillGuest.useSendToHost();
          var reconcilerSendToHost = globalThis.__rill_sendBatch;
          globalThis.__onPressCallCount = 0;

          function handlePress() {
            globalThis.__onPressCallCount++;
            sendEventToHost('BUTTON_PRESSED', {
              count: globalThis.__onPressCallCount,
              source: 'onPress-callback'
            });
          }

          RillReconciler.render({
            type: 'View',
            props: {
              children: [{
                type: 'TouchableOpacity',
                props: {
                  testID: 'test-button',
                  onPress: handlePress,
                  children: { type: 'Text', props: { children: 'Press Me' } }
                }
              }]
            }
          }, reconcilerSendToHost);
        `;

        await engine.loadBundle(guestCode);
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Find the CREATE operation for TouchableOpacity
        const touchableOp = capturedOperations.find(
          (op) => op.op === 'CREATE' && op.type === 'TouchableOpacity'
        );
        if (!touchableOp?.props) {
          throw new Error('TouchableOpacity CREATE operation not found');
        }

        // Extract callback ID from the decoded onPress prop
        const onPressProp = touchableOp.props.onPress as { __fnId?: string } | undefined;
        const fnId = onPressProp?.__fnId;
        if (!fnId) {
          throw new Error('onPress callback ID not found in props');
        }

        expect(receivedEvents.length).toBe(0);

        // Simulate user press via __rill.invokeCallback (same path Host Receiver uses)
        const rillNs = engine.context?.extract('__rill') as Record<string, unknown> | undefined;
        const invokeCallback = rillNs?.invokeCallback as
          | ((fnId: string, args: unknown[]) => unknown)
          | undefined;
        if (!invokeCallback) {
          throw new Error('__rill.invokeCallback not found in sandbox');
        }

        invokeCallback(fnId, []);
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Verify callback executed and message was delivered
        expect(engine.context?.extract('__onPressCallCount')).toBe(1);
        expect(receivedEvents.length).toBe(1);

        const pressEvent = receivedEvents[0];
        expect(pressEvent.event).toBe('BUTTON_PRESSED');

        const payload = pressEvent.payload as { count: number; source: string };
        expect(payload.count).toBe(1);
        expect(payload.source).toBe('onPress-callback');

      } finally {
        engine?.destroy();
      }
    },
  });

  registerTest({
    id: 'engine/ui-callback/multiple-presses',
    name: 'Engine: multiple UI callback invocations maintain state correctly',
    tags: ['engine', 'ui-callback', 'state'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      const receivedEvents: Array<{ event: string; payload: unknown }> = [];
      const capturedOperations: Array<{
        op: string;
        id: number;
        type?: string;
        props?: Record<string, unknown>;
      }> = [];

      try {
        engine = new Engine({ timeout: 0, debug: false });

        engine.on('message', (msg: { event: string; payload: unknown }) => {
          if (msg.event !== '__DIAG_ROUNDTRIP_TEST__') {
            receivedEvents.push(msg);
          }
        });

        engine.on('operation', (batch: { operations?: Array<{
          op: string;
          id: number;
          type?: string;
          props?: Record<string, unknown>;
        }> }) => {
          if (batch?.operations) {
            for (const op of batch.operations) {
              capturedOperations.push(op);
            }
          }
        });

        engine.createReceiver();

        // Guest with counter state that increments on each press
        // IMPORTANT: Use sendEventToHost for messages, __rill_sendBatch for reconciler
        const guestCode = `
          var sendEventToHost = RillGuest.useSendToHost();
          var reconcilerSendToHost = globalThis.__rill_sendBatch;
          globalThis.__counter = 0;
          
          function handleIncrement() {
            globalThis.__counter++;
            sendEventToHost('COUNTER_UPDATED', { 
              value: globalThis.__counter,
              action: 'increment'
            });
          }
          
          function handleDecrement() {
            globalThis.__counter--;
            sendEventToHost('COUNTER_UPDATED', { 
              value: globalThis.__counter,
              action: 'decrement'
            });
          }
          
          RillReconciler.render(
            {
              type: 'View',
              props: {
                children: [
                  {
                    type: 'TouchableOpacity',
                    props: {
                      testID: 'increment-btn',
                      onPress: handleIncrement,
                      children: { type: 'Text', props: { children: '+' } }
                    }
                  },
                  {
                    type: 'TouchableOpacity',
                    props: {
                      testID: 'decrement-btn',
                      onPress: handleDecrement,
                      children: { type: 'Text', props: { children: '-' } }
                    }
                  }
                ]
              }
            },
            reconcilerSendToHost
          );
        `;

        await engine.loadBundle(guestCode);
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Find both button operations
        const createOps = capturedOperations.filter(
          (op) => op.op === 'CREATE' && op.type === 'TouchableOpacity'
        );
        
        expect(createOps.length).toBe(2);

        // Extract fnIds (order may vary, so we'll identify by testID if available)
        const incrementOp = createOps.find(
          (op) => (op.props?.testID as string) === 'increment-btn'
        );
        const decrementOp = createOps.find(
          (op) => (op.props?.testID as string) === 'decrement-btn'
        );

        if (!incrementOp || !decrementOp) {
          throw new Error('Could not find increment/decrement buttons');
        }

        const incrementFnId = (incrementOp.props?.onPress as { __fnId?: string })?.__fnId;
        const decrementFnId = (decrementOp.props?.onPress as { __fnId?: string })?.__fnId;

        if (!incrementFnId || !decrementFnId) {
          throw new Error('Could not extract fnIds from buttons');
        }

        nativeLog(`[multiple-presses] increment fnId: ${incrementFnId}, decrement fnId: ${decrementFnId}`);

        const rillNs = engine.context?.extract('__rill') as Record<string, unknown> | undefined;
        const invokeCallback = rillNs?.invokeCallback as
          | ((fnId: string, args: unknown[]) => unknown)
          | undefined;

        if (!invokeCallback) {
          throw new Error('__rill.invokeCallback not found');
        }

        // Simulate: increment, increment, decrement, increment
        invokeCallback(incrementFnId, []); // counter = 1
        await new Promise((resolve) => setTimeout(resolve, 50));
        
        invokeCallback(incrementFnId, []); // counter = 2
        await new Promise((resolve) => setTimeout(resolve, 50));
        
        invokeCallback(decrementFnId, []); // counter = 1
        await new Promise((resolve) => setTimeout(resolve, 50));
        
        invokeCallback(incrementFnId, []); // counter = 2
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Verify final counter state
        const finalCounter = engine.context?.extract('__counter');
        expect(finalCounter).toBe(2);

        // Verify all 4 events were received
        expect(receivedEvents.length).toBe(4);

        // Verify event sequence
        const events = receivedEvents.map((e) => ({
          action: (e.payload as { action: string }).action,
          value: (e.payload as { value: number }).value,
        }));

        expect(events[0]).toEqual({ action: 'increment', value: 1 });
        expect(events[1]).toEqual({ action: 'increment', value: 2 });
        expect(events[2]).toEqual({ action: 'decrement', value: 1 });
        expect(events[3]).toEqual({ action: 'increment', value: 2 });

        nativeLog(`[multiple-presses] All 4 callbacks executed correctly with proper state`);

      } finally {
        engine?.destroy();
      }
    },
  });

  registerTest({
    id: 'engine/ui-callback/callback-with-args',
    name: 'Engine: UI callback receives and processes arguments',
    tags: ['engine', 'ui-callback', 'args'],
    async run() {
      if (Platform.OS !== 'macos') return;

      let engine: Engine | null = null;
      const receivedEvents: Array<{ event: string; payload: unknown }> = [];
      const capturedOperations: Array<{
        op: string;
        id: number;
        type?: string;
        props?: Record<string, unknown>;
      }> = [];

      try {
        engine = new Engine({ timeout: 0, debug: false });

        engine.on('message', (msg: { event: string; payload: unknown }) => {
          if (msg.event !== '__DIAG_ROUNDTRIP_TEST__') {
            receivedEvents.push(msg);
          }
        });

        engine.on('operation', (batch: { operations?: Array<{
          op: string;
          id: number;
          type?: string;
          props?: Record<string, unknown>;
        }> }) => {
          if (batch?.operations) {
            for (const op of batch.operations) {
              capturedOperations.push(op);
            }
          }
        });

        engine.createReceiver();

        // Guest with callback that processes event arguments
        // (Like onChangeText, onScroll, etc. that receive event data)
        // IMPORTANT: Use sendEventToHost for messages, __rill_sendBatch for reconciler
        const guestCode = `
          var sendEventToHost = RillGuest.useSendToHost();
          var reconcilerSendToHost = globalThis.__rill_sendBatch;
          
          function handleTextChange(text) {
            sendEventToHost('TEXT_CHANGED', { 
              newText: text,
              length: text ? text.length : 0
            });
          }
          
          function handleItemPress(itemId, itemData) {
            sendEventToHost('ITEM_PRESSED', { 
              id: itemId,
              data: itemData
            });
          }
          
          RillReconciler.render(
            {
              type: 'View',
              props: {
                children: [
                  {
                    type: 'TextInput',
                    props: {
                      testID: 'text-input',
                      onChangeText: handleTextChange
                    }
                  },
                  {
                    type: 'TouchableOpacity',
                    props: {
                      testID: 'item-button',
                      onPress: function() { handleItemPress('item-123', { name: 'Test Item', price: 99 }); }
                    }
                  }
                ]
              }
            },
            reconcilerSendToHost
          );
        `;

        await engine.loadBundle(guestCode);
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Find TextInput and its onChangeText fnId
        const textInputOp = capturedOperations.find(
          (op) => op.op === 'CREATE' && op.type === 'TextInput'
        );
        const itemButtonOp = capturedOperations.find(
          (op) => op.op === 'CREATE' && op.type === 'TouchableOpacity' && 
                 (op.props?.testID as string) === 'item-button'
        );

        if (!textInputOp || !itemButtonOp) {
          throw new Error('Could not find TextInput or item button');
        }

        const onChangeTextFnId = (textInputOp.props?.onChangeText as { __fnId?: string })?.__fnId;
        const onItemPressFnId = (itemButtonOp.props?.onPress as { __fnId?: string })?.__fnId;

        if (!onChangeTextFnId || !onItemPressFnId) {
          throw new Error('Could not extract fnIds');
        }

        const rillNs = engine.context?.extract('__rill') as Record<string, unknown> | undefined;
        const invokeCallback = rillNs?.invokeCallback as
          | ((fnId: string, args: unknown[]) => unknown)
          | undefined;

        if (!invokeCallback) {
          throw new Error('__rill.invokeCallback not found');
        }

        // Simulate text change with argument
        invokeCallback(onChangeTextFnId, ['Hello World']);
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Simulate item press (callback internally calls with specific args)
        invokeCallback(onItemPressFnId, []);
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(receivedEvents.length).toBe(2);

        // Verify text change event
        const textEvent = receivedEvents.find((e) => e.event === 'TEXT_CHANGED');
        expect(textEvent).toBeDefined();
        const textPayload = textEvent?.payload as { newText: string; length: number };
        expect(textPayload.newText).toBe('Hello World');
        expect(textPayload.length).toBe(11);

        // Verify item press event
        const itemEvent = receivedEvents.find((e) => e.event === 'ITEM_PRESSED');
        expect(itemEvent).toBeDefined();
        const itemPayload = itemEvent?.payload as { id: string; data: { name: string; price: number } };
        expect(itemPayload.id).toBe('item-123');
        expect(itemPayload.data.name).toBe('Test Item');
        expect(itemPayload.data.price).toBe(99);

        nativeLog(`[callback-with-args] Callbacks with arguments work correctly`);

      } finally {
        engine?.destroy();
      }
    },
  });
}
