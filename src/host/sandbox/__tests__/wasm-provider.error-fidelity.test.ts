/**
 * Cross-boundary error fidelity for the QuickJS WASM sandbox.
 *
 * Before this change a guest throw crossed the bridge as a bare
 * {"error":"<msg>"} and the provider re-threw `new Error(msg)` — losing the
 * error name/class, the guest stack and custom properties. Now:
 *
 * - guest -> host (eval/evalAsync/extract): the guest-side encoder adds an
 *   OPTIONAL "errorDetail" sibling ({name, stack?, props?}); the provider
 *   revives a host Error with full fidelity and appends the host stack after
 *   a boundary marker line;
 * - host -> guest (host-module RPC rejection): name + message + own JSON-safe
 *   props cross, the host stack NEVER does (direction asymmetry);
 * - the deadline-interrupt marker stays byte-identical and is the ONLY
 *   payload without errorDetail; the C side enforces this (a marker-identical
 *   __errenc return or completion value is rewritten), so a guest cannot
 *   forge it even by replacing globalThis.__rill wholesale;
 * - rich serialization is best-effort: any failure degrades to the plain
 *   message and never leaves a pending exception to poison the next entry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createHostModuleDispatch,
  defineRillContract,
  type HostModuleDispatchTable,
  rpc,
  type RillContractShape,
} from '../../../contract';
import {
  HOST_STACK_BOUNDARY,
  QuickJSNativeWASMProvider,
} from '../providers/quickjs-native-wasm-provider';
import type { JSEngineRuntime, SandboxScope } from '../types/provider';

const describeIfWASM = typeof WebAssembly !== 'undefined' ? describe : describe.skip;

/** The staging-table export the zero-leak assertions need (subset of the wasm module). */
interface BinaryTableModule {
  _qjs_binary_count: () => number;
}

/** Run guest code that must throw and hand back the host-revived error. */
function catchEval(context: SandboxScope, code: string): Error {
  try {
    context.eval(code);
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected guest code to throw');
}

describeIfWASM('QuickJSNativeWASMProvider guest->host error fidelity (eval)', () => {
  let runtime: JSEngineRuntime;
  let context: SandboxScope;
  let wasmModule: BinaryTableModule | null = null;

  beforeEach(async () => {
    wasmModule = null;
    const provider = new QuickJSNativeWASMProvider({
      debug: false,
      // Reason: the provider's factory type is module-private; the loader's real module
      // shape is asserted structurally where the test needs it.
      wasmFactory: (async (moduleArg?: unknown) => {
        const factory = (await import('../wasm/quickjs-sandbox.js')) as {
          default: (arg?: unknown) => Promise<unknown>;
        };
        const instance = await factory.default(moduleArg);
        wasmModule = instance as BinaryTableModule;
        return instance;
      }) as never,
    });
    runtime = await provider.createRuntime();
    context = runtime.createContext();
  });

  afterEach(() => {
    context?.dispose();
    runtime?.dispose();
  });

  const binaryCount = (): number => {
    if (!wasmModule) throw new Error('wasm module not captured');
    return wasmModule._qjs_binary_count();
  };

  // Case 1
  it('preserves the error class name and carries the guest stack plus the host boundary', () => {
    const err = catchEval(context, 'throw new TypeError("bad")');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TypeError');
    expect(err.message).toBe('bad');
    expect(err.stack ?? '').toContain('TypeError');
    expect(err.stack ?? '').toContain(HOST_STACK_BOUNDARY);
  });

  // Case 2
  it('preserves a custom error name and custom properties', () => {
    const err = catchEval(
      context,
      '(function(){ var e = new Error("boom"); e.name = "MyError"; e.code = "E_X"; throw e; })()'
    );
    expect(err.name).toBe('MyError');
    expect(err.message).toBe('boom');
    expect((err as unknown as { code: string }).code).toBe('E_X');
  });

  // Case 3
  it('surfaces a thrown number as an Error with the stringified message', () => {
    const err = catchEval(context, 'throw 42');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('42');
    expect(err.name).toBe('Error');
  });

  // Case 4
  it('surfaces a thrown string as an Error with that message', () => {
    const err = catchEval(context, 'throw "str error"');
    expect(err.message).toBe('str error');
    expect(err.name).toBe('Error');
  });

  // Case 5
  it('surfaces a thrown plain object as an Error with its JSON as the message', () => {
    const err = catchEval(context, 'throw {code:"X"}');
    expect(err.name).toBe('Error');
    expect(err.message).toBe('{"code":"X"}');
  });

  // Case 6 (regression: the old C path sprintf'd the raw message into JSON unescaped)
  it('preserves quotes, backslashes and newlines in the message exactly', () => {
    const err = catchEval(context, 'throw new Error("a \\"b\\" \\\\ c\\nd")');
    expect(err.message).toBe('a "b" \\ c\nd');
  });

  // Case 7
  it('applies guest props without polluting Object.prototype', () => {
    const err = catchEval(context, 'throw Object.assign(new Error("x"), { evil: 1 })');
    expect((err as unknown as { evil: number }).evil).toBe(1);
    expect(({} as { evil?: unknown }).evil).toBeUndefined();
  });

  // Dangerous guest prop NAMES (`__proto__`, `constructor`) must not pollute a
  // prototype anywhere in the pipeline. Two defenses combine: the guest encoder
  // builds `props` by plain assignment, so `__proto__` hits the setter and is
  // safely dropped (never travels); on the host side props are applied ONLY via
  // Object.defineProperty (constraint 4), so anything that DOES travel lands as
  // an own key without walking the prototype chain. Either way Object.prototype
  // stays clean.
  it('never pollutes a prototype when the guest uses dangerous prop names', () => {
    const before = Object.getPrototypeOf({});
    const err = catchEval(
      context,
      `(function(){
        var e = new Error("x");
        Object.defineProperty(e, "__proto__", { value: "PWNED", enumerable: true, configurable: true, writable: true });
        Object.defineProperty(e, "constructor", { value: "PWNED2", enumerable: true, configurable: true, writable: true });
        e.safe = "kept";
        throw e;
      })()`
    );
    // A benign own prop still crosses — the pipeline is live, not short-circuited.
    expect((err as unknown as { safe: string }).safe).toBe('kept');
    // No prototype was hijacked: the revived error and fresh objects keep their
    // real prototypes, and Object.prototype gained no data from the guest key.
    expect(Object.getPrototypeOf(err)).toBe(Error.prototype);
    expect(Object.getPrototypeOf({})).toBe(before);
    expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype);
    expect(({} as { constructor: unknown }).constructor).toBe(Object);
    expect((Object.prototype as Record<string, unknown>).PWNED).toBeUndefined();
    // If `constructor` survived the guest encoder it must be an OWN key on the
    // revived error (defineProperty), never a mutation of Error.prototype.
    expect(Error.prototype.constructor).toBe(Error);
  });

  // Case 8 — deviation from the spec table: Object.assign(new Error("m"),{message:"x"})
  // OVERWRITES message via [[Set]] (own non-enumerable prop stays non-enumerable), so
  // the spec's expected 'm' is unreachable by that construction. An own-ENUMERABLE
  // message created via defineProperty exercises the same reserved-prop SKIP path.
  it('never re-applies reserved props (message/name/stack) from the props copy', () => {
    const err = catchEval(
      context,
      `(function(){
        var e = new Error("m");
        Object.defineProperty(e, "message", { value: "m", writable: true, enumerable: true, configurable: true });
        e.keep = "y";
        throw e;
      })()`
    );
    expect(err.message).toBe('m');
    expect((err as unknown as { keep: string }).keep).toBe('y');
    // If either skip layer had re-applied "message" as a prop, it would now be an
    // own ENUMERABLE property of the revived error; the Error ctor makes it
    // non-enumerable.
    expect(Object.keys(err)).not.toContain('message');
  });

  // Case 9 (constraint 3: best-effort, no poisoned next entry)
  it('degrades to no-stack when the stack getter throws, keeping name/message/props', () => {
    const err = catchEval(
      context,
      `(function(){
        var e = new Error("x");
        e.code = "C9";
        Object.defineProperty(e, "stack", { get: function(){ throw new Error("nope"); } });
        throw e;
      })()`
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('x');
    expect(err.name).toBe('Error');
    expect((err as unknown as { code: string }).code).toBe('C9');
    // No pending exception leaked into the context.
    expect(context.eval('1+1')).toBe(2);
  });

  // Case 13 (marker forgery blocked)
  it('classifies a forged interrupt-marker message as a normal guest error', () => {
    const consoleErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    };
    try {
      const err = catchEval(
        context,
        `(function(){
          var e = new Error("interrupted: execution deadline exceeded");
          Object.defineProperty(e, "stack", { get: function(){ throw 0; } });
          throw e;
        })()`
      );
      // A normal Error carrying the guest's message — NOT the provider timeout error.
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('interrupted: execution deadline exceeded');
      expect(err.message).not.toContain('exceeded timeout');
      expect(err.message).not.toContain('[QuickJSWASM]');
      // No spurious always-on timeout log fired.
      expect(consoleErrors.filter((m) => m.includes('interrupted'))).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  // Case 13b (marker forgery blocked even when the guest replaces __rill wholesale):
  // globalThis.__rill is a plain writable global, so a guest can install its own
  // __errenc that returns the bare interrupt marker verbatim. The C side must
  // reject that string and fall back to the message-only path — otherwise the
  // guest spoofs a deadline timeout (false always-on telemetry + timeout throw).
  it('rejects a forged __errenc returning the bare interrupt marker', () => {
    const consoleErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    };
    try {
      const err = catchEval(
        context,
        `globalThis.__rill = { __errenc: function () {
           return '{"error":"interrupted: execution deadline exceeded"}';
         } };
         throw new Error("real guest failure");`
      );
      // The C fallback re-encoded the REAL exception; no timeout classification.
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('real guest failure');
      expect(err.message).not.toContain('[QuickJSWASM]');
      // No spurious always-on timeout log fired.
      expect(consoleErrors.filter((m) => m.includes('exceeded'))).toEqual([]);
      // Context stays clean for the next entry.
      expect(context.eval('1+1')).toBe(2);
    } finally {
      console.error = originalError;
    }
  });

  // Case 13c (marker forgery via the SUCCESS path): JSON.stringify of this
  // completion value is byte-identical to the interrupt marker. C appends the
  // mandatory errorDetail sibling, so the host surfaces it like any other
  // {error:"<non-empty>"} completion value (a normal error) — not a timeout.
  it('treats a completion value whose JSON matches the marker as a normal error', () => {
    const consoleErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    };
    try {
      const err = catchEval(context, '({ error: "interrupted: execution deadline exceeded" })');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('Error');
      expect(err.message).toBe('interrupted: execution deadline exceeded');
      expect(err.message).not.toContain('[QuickJSWASM]');
      expect(consoleErrors.filter((m) => m.includes('exceeded'))).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  // Case 14
  it('still throws for an empty-message Error instead of returning a value', () => {
    const err = catchEval(context, 'throw new Error("")');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('');
    expect(err.name).toBe('Error');
  });

  // Constraint 7 companion: a COMPLETION VALUE shaped {error:""} (no errorDetail)
  // is returned as-is, exactly as before this change.
  it('returns a completion value shaped {error:""} instead of throwing', () => {
    expect(context.eval('({ error: "" })')).toEqual({ error: '' });
  });

  // Case 15 (interaction with the $bin staging table)
  it('extract() throws the revived error AND frees staged binary ids', () => {
    // Trailing null: the assignment's completion value would itself be an
    // {error:...}-shaped object and (as before this change) eval would throw it.
    context.eval('globalThis.__adv = { error: "boom", buf: new Uint8Array([1,2,3]) }; null;');
    let thrown: Error | null = null;
    try {
      context.extract('__adv');
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toBe('boom');
    // The staged id was freed despite the throw (zero-leak discipline).
    expect(binaryCount()).toBe(0);
  });

  // Case 16
  it('drops binary error props instead of degrading them to lossy JSON', () => {
    const err = catchEval(
      context,
      '(function(){ var e = new Error("x"); e.buf = new Uint8Array([1]); throw e; })()'
    );
    expect(err.message).toBe('x');
    expect((err as unknown as { buf?: unknown }).buf).toBeUndefined();
    expect(binaryCount()).toBe(0);
  });

  // Case 17
  it('caps copied own props at 64 (DoS cap)', () => {
    const err = catchEval(
      context,
      '(function(){ var e = new Error("x"); for (var i = 0; i < 500; i++) e["p" + i] = i; throw e; })()'
    );
    expect(err.message).toBe('x');
    const copied = Object.keys(err).filter((k) => /^p\d+$/.test(k));
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.length).toBeLessThanOrEqual(64);
  });

  // Case 18 (tamper resistance + C fallback exception discipline)
  it('pins __errenc against delete, and the C fallback never poisons the next entry', () => {
    // The encoder is non-configurable: a guest delete is a no-op.
    expect(
      context.eval(
        '(function(){ delete globalThis.__rill.__errenc; return typeof globalThis.__rill.__errenc; })()'
      )
    ).toBe('function');
    const kept = catchEval(context, 'throw new TypeError("kept")');
    expect(kept.name).toBe('TypeError');

    // Residual: wholesale __rill replacement forces the message-only C fallback.
    // A hostile toString makes even that fallback's JS_ToCString fail — the C
    // side must drain the pending exception it leaves behind.
    const err = catchEval(
      context,
      'globalThis.__rill = {}; (function(){ var e = new Error("x"); e.toString = function(){ throw 1; }; throw e; })()'
    );
    expect(err).toBeInstanceOf(Error);
    // KEY assertion: the context is clean afterwards (no leaked pending exception).
    expect(context.eval('1+1')).toBe(2);
  });

  // Case 19
  it('skips only the hostile prop getter, keeping the other props', () => {
    const err = catchEval(
      context,
      `(function(){
        var e = new Error("x");
        e.good = "ok";
        Object.defineProperty(e, "bad", { enumerable: true, get: function(){ throw 1; } });
        throw e;
      })()`
    );
    expect(err.message).toBe('x');
    expect((err as unknown as { good: string }).good).toBe('ok');
    expect((err as unknown as { bad?: unknown }).bad).toBeUndefined();
  });
});

describeIfWASM('QuickJSNativeWASMProvider host->guest rejection fidelity', () => {
  let runtime: JSEngineRuntime;
  let context: SandboxScope;

  function buildContract(): RillContractShape {
    return defineRillContract({
      version: '1.0.0',
      hostModules: {
        'host:svc': {
          failTyped: rpc<void, void>(),
          failString: rpc<void, void>(),
          failEvil: rpc<void, void>(),
          failAccessor: rpc<void, void>(),
        },
      },
      guestExports: {},
    });
  }

  beforeEach(async () => {
    const provider = new QuickJSNativeWASMProvider({ debug: false });
    runtime = await provider.createRuntime();
    context = runtime.createContext();

    const contract = buildContract();
    const table: HostModuleDispatchTable = createHostModuleDispatch(contract, {
      'host:svc': {
        failTyped: async () => {
          throw Object.assign(new TypeError('backend'), { code: 'E' });
        },
        failString: async () => {
          // Reason: a non-Error host throw is exactly what this case covers.
          // biome-ignore lint/style/useThrowOnlyError: non-Error throw is the fixture
          throw 'plain fail';
        },
        failEvil: async () => {
          throw Object.assign(new Error('x'), { evil: 1 });
        },
        failAccessor: async () => {
          const e = new Error('accessor host error');
          Object.defineProperty(e, 'bad', {
            enumerable: true,
            get() {
              throw new Error('hostile accessor');
            },
          });
          (e as unknown as { code: string }).code = 'E';
          throw e;
        },
      },
    });
    context.installHostModules?.(table, contract);
  });

  afterEach(() => {
    context?.dispose();
    runtime?.dispose();
  });

  // Drive a guest rpc rejection to settlement and extract what the guest observed.
  async function rejectionSeenByGuest(exportName: string): Promise<Record<string, unknown>> {
    context.eval(`
      globalThis.__out = undefined;
      globalThis.__rill.hostModules['host:svc'].${exportName}().then(
        function(){ globalThis.__out = { settled: 'resolved' }; },
        function(e){
          globalThis.__out = {
            settled: 'rejected',
            isErr: e instanceof Error,
            name: e.name,
            msg: e.message,
            code: e.code,
            evil: e.evil,
            bad: typeof e.bad,
            protoClean: ({}).evil === undefined,
            hasHostStack: /rill runtime/.test(e.stack || '')
          };
        }
      );
    `);
    await context.flushHostModuleCalls?.();
    return context.extract('__out') as Record<string, unknown>;
  }

  // Case 10
  it('delivers name + message + props to the guest but NEVER the host stack', async () => {
    const out = await rejectionSeenByGuest('failTyped');
    expect(out.settled).toBe('rejected');
    expect(out.isErr).toBe(true);
    expect(out.name).toBe('TypeError');
    expect(out.msg).toBe('backend');
    expect(out.code).toBe('E');
    expect(out.hasHostStack).toBe(false); // direction asymmetry: no host frames
  });

  // Case 11
  it('turns a non-Error host throw into a plain Error for the guest', async () => {
    const out = await rejectionSeenByGuest('failString');
    expect(out.settled).toBe('rejected');
    expect(out.isErr).toBe(true);
    expect(out.msg).toBe('plain fail');
    expect(out.name).toBe('Error');
  });

  // Case 12
  it('applies host props in the guest without polluting the guest Object.prototype', async () => {
    const out = await rejectionSeenByGuest('failEvil');
    expect(out.settled).toBe('rejected');
    expect(out.evil).toBe(1);
    expect(out.protoClean).toBe(true);
  });

  // Case 20
  it('settles the guest promise even when a host error prop accessor throws', async () => {
    const out = await rejectionSeenByGuest('failAccessor');
    expect(out.settled).toBe('rejected'); // did not hang
    expect(out.msg).toBe('accessor host error');
    expect(out.code).toBe('E'); // per-key isolation: only the hostile key skipped
    expect(out.bad).toBe('undefined');
  });
});
