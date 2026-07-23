/**
 * CdpDebugSession (Milestone B web-debug side, design P2) — the in-worker driver for
 * the FAT CDP debug wasm.
 *
 * It replaces the deferred `dbg.*` stubs {@link WorkerDispatch} left behind (the
 * `TODO(milestone-b)` block that acknowledged debugger requests without a real guest
 * suspend). The fat artifact — `native/quickjs/build-debug/quickjs-cdp-debug.{mjs,wasm}`,
 * proven end-to-end in `native/quickjs/test/run-cdp-wasm.mjs` — embeds the real CDP engine
 * (AdapterDebugTarget → DebuggerAdapter → QuickJSEngineDebugger → core) and speaks RAW
 * Chrome DevTools Protocol. This module pipes bytes; it never re-translates CDP in TS.
 *
 * ============================================================================
 * The two invariants it upholds (web counterpart of native cross-unwind evaluate)
 * ============================================================================
 *  - {@link runGuest} (guest-eval ENTRY) is funnelled through the WI-2 {@link TurnGate}, so
 *    a turn is never re-entered on top of a stack already parked at a breakpoint. With the
 *    Asyncify debug build a breakpoint unwinds and parks the C stack; a second eval on top of
 *    it is undefined behaviour. While the parked eval's Promise is pending the gate reports
 *    the slot busy, so a later {@link runGuest} queues behind it.
 *  - {@link sendCdp} (the control plane: `Debugger.evaluateOnCallFrame` / `getProperties` /
 *    `resume`) BYPASSES the gate. These are sub-operations OF the already-suspended turn:
 *    `qjsd_cdp_dispatch` is synchronous and the thread is free while the eval Promise is
 *    parked, so it services the pause without deadlocking behind the very turn it must
 *    resume. This mirrors {@link isControlPlaneDbg}'s classification on the `dbg.*` channel.
 *
 * ============================================================================
 * Code-split: the 3.6MB debug wasm is NEVER in the production bundle
 * ============================================================================
 * The Emscripten factory is reached ONLY through a dynamic `import()`, so a bundler splits
 * the debug artifact into its own chunk that is fetched the first time a debug session
 * starts. A static `import` of the factory anywhere in `src/` would drag those 3.6MB into
 * every production build; `cdp-debug-guard.test.ts` fails the build if that ever happens.
 */

import type { TurnGate } from './turn-gate';

/**
 * The Emscripten `Module` surface this driver uses from the fat CDP debug wasm.
 * `ccall(name, ret, argTypes, args, { async: true })` returns a Promise so a breakpoint
 * can suspend mid-eval (Asyncify unwind) and resolve after resume.
 */
export interface CdpDebugModule {
  ccall(
    name: string,
    returnType: string | null,
    argTypes: string[],
    // Reason: ccall args are a heterogeneous positional list (numbers / strings)
    args: unknown[],
    opts?: { async?: boolean }
    // Reason: ccall's return is number | null | Promise<number> depending on signature
  ): unknown;
}

/** The Emscripten factory: the default export of `quickjs-cdp-debug.mjs` (EXPORT_NAME in
 *  native/quickjs/build-wasm-cdp.sh), resolving to the wasm Module. */
export type CdpDebugFactory = () => Promise<CdpDebugModule>;

/** A sink for every OUTBOUND raw CDP message. Responses carry `id`; events carry `method`. */
export type CdpMessageSink = (connId: number, rawJson: string) => void;

/** The `globalThis.__rillCdp` shape the wasm calls into for each outbound CDP message. */
interface RillCdpGlobal {
  onMessage(connId: number, json: string): void;
}

/**
 * Default lazy loader — the ONLY place the debug artifact is named, and only inside a
 * dynamic `import()` so the 3.6MB wasm is code-split out of the production bundle. In a
 * published package `native/quickjs/build-debug/` is absent; a host that ships a debug
 * build overrides {@link CdpDebugSessionOptions.loadModule} to point at its hosted artifact.
 */
async function defaultLoadModule(): Promise<CdpDebugModule> {
  // The specifier is kept in a variable so bundlers treat it as a dynamic (split) import
  // and never try to inline it. NEVER turn this into a static top-level import.
  const specifier = '../../../../native/quickjs/build-debug/quickjs-cdp-debug.mjs';
  const mod = (await import(/* @vite-ignore */ specifier)) as { default: CdpDebugFactory };
  return mod.default();
}

/** Options for {@link CdpDebugSession}. */
export interface CdpDebugSessionOptions {
  /**
   * Sink for every OUTBOUND raw CDP message (the worker postMessages it to the page). The
   * session pipes the exact bytes the wasm emits — no CDP translation happens here.
   */
  sink: CdpMessageSink;
  /**
   * The WI-2 guest-eval gate {@link runGuest} funnels through. Inject the SAME instance
   * {@link WorkerDispatch} uses so guest-eval entry stays serialized across both paths.
   */
  gate: TurnGate;
  /**
   * Watchdog hook: an outbound `Debugger.paused` was seen. A breakpoint is an intentional,
   * unbounded pause, so the caller MUST disarm the eval watchdog here or the parked turn
   * would be mistaken for a runaway and terminate the worker.
   */
  onPaused?: () => void;
  /** Watchdog hook: an outbound `Debugger.resumed` was seen — rearm the eval watchdog. */
  onResumed?: () => void;
  /**
   * Overrides the lazy wasm loader. Defaults to a dynamic `import()` of the debug artifact
   * factory (kept out of the production bundle). Tests inject a real/mock module here.
   */
  loadModule?: () => Promise<CdpDebugModule>;
}

export class CdpDebugSession {
  #sink: CdpMessageSink;
  #gate: TurnGate;
  #onPaused?: () => void;
  #onResumed?: () => void;
  #loadModule: () => Promise<CdpDebugModule>;

  #module: CdpDebugModule | null = null;
  #initPromise: Promise<CdpDebugModule> | null = null;
  #connected = new Set<number>();

  constructor(options: CdpDebugSessionOptions) {
    this.#sink = options.sink;
    this.#gate = options.gate;
    this.#onPaused = options.onPaused;
    this.#onResumed = options.onResumed;
    this.#loadModule = options.loadModule ?? defaultLoadModule;
  }

  /** True once the wasm module has been imported, initialized, and the sink installed. */
  get isReady(): boolean {
    return this.#module !== null;
  }

  /**
   * Start a CDP connection. Lazily imports + initializes the debug wasm on first call
   * (installing the `__rillCdp.onMessage` sink BEFORE `qjsd_cdp_init` so no early outbound
   * message is dropped), then `qjsd_cdp_connect`s the given connection id. Idempotent per id.
   */
  async startSession(connId: number): Promise<void> {
    const mod = await this.#ensureModule();
    if (this.#connected.has(connId)) return;
    mod.ccall('qjsd_cdp_connect', null, ['number'], [connId]);
    this.#connected.add(connId);
  }

  /**
   * Send one raw CDP command (`Debugger.enable` / `setBreakpoint` / `evaluateOnCallFrame` /
   * `getProperties` / `resume`) straight to `qjsd_cdp_dispatch`. SYNCHRONOUS and BYPASSES the
   * {@link TurnGate}: the response (and any event) arrives via the sink within this call, and
   * because the thread is free while a guest eval is parked at a breakpoint, this services the
   * pause without deadlocking behind the parked turn.
   */
  sendCdp(connId: number, rawJson: string): void {
    const mod = this.#module;
    if (!mod) {
      throw new Error('[rill] CdpDebugSession.sendCdp before startSession()');
    }
    mod.ccall('qjsd_cdp_dispatch', null, ['number', 'string'], [connId, rawJson]);
  }

  /**
   * Run a guest program THROUGH the {@link TurnGate} (serialized guest-eval entry). Resolves
   * with `qjsd_cdp_eval`'s return code (0 ok, -1 guest exception). The guest SUSPENDS at
   * breakpoints — the returned Promise stays pending across the pause (the C stack is unwound
   * and parked), during which the gate reports its slot busy so a later {@link runGuest}
   * queues behind it, and {@link sendCdp} still services the pause. Resolves after `resume`.
   */
  runGuest(code: string): Promise<number> {
    return this.#gate.run(async () => {
      const mod = await this.#ensureModule();
      const rc = (await mod.ccall('qjsd_cdp_eval', 'number', ['string'], [code], {
        async: true,
      })) as number;
      return rc;
    });
  }

  /** Close a CDP connection (`qjsd_cdp_disconnect`). No-op if never connected. */
  disconnect(connId: number): void {
    const mod = this.#module;
    if (!mod || !this.#connected.has(connId)) return;
    mod.ccall('qjsd_cdp_disconnect', null, ['number'], [connId]);
    this.#connected.delete(connId);
  }

  #ensureModule(): Promise<CdpDebugModule> {
    if (this.#module) return Promise.resolve(this.#module);
    if (!this.#initPromise) {
      this.#initPromise = this.#init();
    }
    return this.#initPromise;
  }

  async #init(): Promise<CdpDebugModule> {
    const mod = await this.#loadModule();
    // Install the outbound sink BEFORE init: the very first messages (scriptParsed on the
    // initial eval, or an enable response) must not be dropped.
    this.#installGlobalSink();
    const rc = mod.ccall('qjsd_cdp_init', 'number', [], []) as number;
    if (rc !== 0) {
      this.#initPromise = null;
      throw new Error(`[rill] qjsd_cdp_init failed (rc=${rc})`);
    }
    this.#module = mod;
    return mod;
  }

  #installGlobalSink(): void {
    const g = globalThis as { __rillCdp?: RillCdpGlobal };
    g.__rillCdp = {
      onMessage: (connId, json) => this.#onOutbound(connId, json),
    };
  }

  #onOutbound(connId: number, json: string): void {
    // Sniff the method to drive the eval watchdog, THEN pipe the exact bytes on.
    this.#sniffForWatchdog(json);
    this.#sink(connId, json);
  }

  /**
   * Disarm the eval watchdog on `Debugger.paused` (a breakpoint is an intentional, unbounded
   * pause — terminating the worker would be a false positive) and rearm on `Debugger.resumed`.
   * Only CDP EVENTS carry `method`; responses (which carry `id`) are ignored cheaply.
   */
  #sniffForWatchdog(json: string): void {
    // Cheap pre-filter: neither event name can appear without the "Debugger." token.
    if (!json.includes('"Debugger.')) return;
    let method: string | undefined;
    try {
      method = (JSON.parse(json) as { method?: string }).method;
    } catch {
      return;
    }
    if (method === 'Debugger.paused') {
      this.#onPaused?.();
    } else if (method === 'Debugger.resumed') {
      this.#onResumed?.();
    }
  }
}
