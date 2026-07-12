/**
 * WorkerDispatch (issue #19 L1 + Milestone B web-debug) — the pure, headless core
 * of the in-worker harness. It owns the message state machine that {@link WorkerEngine}
 * talks to: guest-eval entry, lifecycle, and the debugger (`dbg.*`) sub-protocol.
 *
 * It is deliberately free of any `self`/Worker or WASM/Engine dependency: the backing
 * engine is injected via {@link WorkerDispatchDeps.createEngine} (typed only as the
 * minimal {@link GuestEngineLike} surface), and outbound messages go through an injected
 * `post`. That is what makes the routing invariant below unit-testable without standing up
 * a real Worker or the QuickJS-WASM sandbox (which cannot be imported off a worker thread).
 * `worker-host.ts` is the thin `self`-bound adapter that wires a real {@link Engine} in.
 *
 * ============================================================================
 * The routing invariant (web counterpart of native cross-unwind evaluate-on-frame)
 * ============================================================================
 * All guest-eval ENTRY is funnelled through a single {@link TurnGate} while the
 * debugger is enabled, so a turn is never re-entered on top of a stack that is
 * suspended at a breakpoint (with the QuickJS-asyncify debug build a breakpoint
 * unwinds and parks the C stack; a second eval on top of it is undefined
 * behaviour). That means BOTH kinds of entry:
 *   - inbound worker messages (load / event / invoke), gated in handle(); and
 *   - engine-owned timer callbacks (setTimeout/setInterval fire from the worker
 *     event loop, not via postMessage), routed through the same gate via
 *     {@link GuestEngineLike.setGuestTurnRunner} at init.
 *
 * `dbg.evaluateOnCallFrame` and `dbg.getProperties`, however, are NOT new eval turns —
 * they are control-plane sub-operations OF the already-suspended turn (inspect a frame,
 * expand a scope). If they queued behind the suspended turn in the gate they would
 * deadlock: the suspended turn only releases the gate on `dbg.resume`, which itself can
 * only be decided after the developer has evaluated/expanded. So these two are routed
 * STRAIGHT to the (stubbed) wasm debug path, bypassing the gate and never taking an
 * eval-turn slot. Everything else on the `dbg.*` channel is either a gate control signal
 * (pause→suspend, resume→drain) or an out-of-band ack.
 *
 * Headless scope: the real suspend/resume is driven by the in-worker asyncify breakpoint
 * hook (Milestone A PoC) and stays a documented TODO. Here `dbg.pause`/`dbg.resume` stand
 * in as the gate's suspend/drain signals so the control-flow is exercisable end-to-end,
 * and the guest-suspend eval itself is stubbed (see the `dbg.*` handlers below).
 */

import type { ReviewedUnknown } from '../../../shared';
import type { BridgeValueObject, SerializedOperationBatch } from '../../types';
import type { MainToWorkerMessage, SerializedWorkerError, WorkerToMainMessage } from './protocol';
import { serializeWorkerError } from './protocol';
import { TurnGate } from './turn-gate';

/** The slice of the core {@link Engine} that the worker harness drives. */
export interface GuestEngineLike {
  on(event: 'message', cb: (m: { event: string; payload: unknown }) => void): void;
  // Reason: engine error events carry an inherently-unknown thrown value
  on(event: 'error' | 'fatalError', cb: (e: unknown) => void): void;
  loadBundle(source: string, initialProps?: Record<string, unknown>): Promise<void>;
  // Reason: host event payload is any serializable value
  sendEvent(eventName: string, payload?: unknown): void;
  invokeGuestCallback(fnId: string, args: ReviewedUnknown[]): unknown;
  updateConfig(config: BridgeValueObject): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  /**
   * Optional (the real {@link Engine} has it): route engine-owned guest entry —
   * timer callbacks the engine fires from its own event loop — through `runner`.
   * WorkerDispatch installs its TurnGate here at init, closing the re-entry
   * hole the gate's doc calls out: gating only inbound worker messages would
   * miss timer-driven guest turns entirely.
   */
  setGuestTurnRunner?(runner: ((run: () => void) => void) | null): void;
}

/** Hooks handed to {@link WorkerDispatchDeps.createEngine} at init time. */
export interface EngineHooks {
  onSerializedBatch: (batch: SerializedOperationBatch) => void;
}

/** Injected collaborators — the seam that keeps this module headless-testable. */
export interface WorkerDispatchDeps {
  post(message: WorkerToMainMessage): void;
  createEngine(
    init: Extract<MainToWorkerMessage, { type: 'init' }>,
    hooks: EngineHooks
  ): GuestEngineLike;
}

/** Control-plane `dbg.*` ops that run ON the suspended turn and MUST bypass the gate. */
const CONTROL_PLANE_DBG = new Set<MainToWorkerMessage['type']>([
  'dbg.evaluateOnCallFrame',
  'dbg.getProperties',
]);

/** True for `dbg.*` messages that must never take a guest-eval-turn slot. */
export function isControlPlaneDbg(type: MainToWorkerMessage['type']): boolean {
  return CONTROL_PLANE_DBG.has(type);
}

export class WorkerDispatch {
  #deps: WorkerDispatchDeps;
  #engine: GuestEngineLike | null = null;
  /** Serializes guest-eval entry so a suspended turn is never re-entered. */
  #gate = new TurnGate();
  /** The gate only fronts guest-eval entry while a debug session is live; otherwise
   *  guest turns run directly so the release eval path stays byte-for-byte untouched. */
  #dbgEnabled = false;

  constructor(deps: WorkerDispatchDeps) {
    this.#deps = deps;
  }

  /** Exposed for tests: whether a breakpoint suspend is outstanding in the gate. */
  get isSuspended(): boolean {
    return this.#gate.isSuspended;
  }

  /** Exposed for tests: guest-eval turns queued behind a suspend. */
  get pendingTurns(): number {
    return this.#gate.pending;
  }

  #post(message: WorkerToMainMessage): void {
    this.#deps.post(message);
  }

  /**
   * Run a guest-eval turn. While a debug session is live it goes through the gate
   * (queued behind any outstanding breakpoint suspend); otherwise it runs directly.
   * The gate is transparent when idle — it invokes `fn` synchronously — so the
   * non-debug path is unchanged.
   */
  #runGuestTurn(fn: () => void | Promise<void>): void {
    if (this.#dbgEnabled) {
      void this.#gate.run(fn);
    } else {
      void fn();
    }
  }

  handle(message: MainToWorkerMessage): void {
    switch (message.type) {
      case 'init':
        this.#handleInit(message);
        break;
      case 'load':
        // Fire-and-forget: the async resolution posts loaded/loadError itself.
        this.#runGuestTurn(() => this.#handleLoad(message));
        break;
      case 'event':
        // sendEvent drives the guest handler synchronously (the async chain runs to the
        // WASM eval before yielding), so by the time it returns the guest turn is done —
        // or the worker is wedged and this turnDone never posts, tripping the watchdog.
        this.#runGuestTurn(() => {
          try {
            this.#engine?.sendEvent(message.eventName, message.payload);
          } finally {
            this.#post({ type: 'turnDone', turnId: message.turnId });
          }
        });
        break;
      case 'invoke':
        this.#runGuestTurn(() => {
          try {
            this.#engine?.invokeGuestCallback(message.fnId, message.args as ReviewedUnknown[]);
          } finally {
            this.#post({ type: 'turnDone', turnId: message.turnId });
          }
        });
        break;
      case 'release':
        // v1: guest-callback release is not bridged across the worker (the guest registry's
        // own GC handles unmounted trees). A no-op here; tracked as a follow-up.
        break;
      case 'config':
        this.#engine?.updateConfig(message.config as BridgeValueObject);
        break;
      case 'pause':
        this.#engine?.pause();
        break;
      case 'resume':
        this.#engine?.resume();
        break;
      case 'destroy':
        this.#engine?.destroy();
        this.#engine = null;
        break;
      case 'dbg.enable':
      case 'dbg.disable':
      case 'dbg.setBreakpoint':
      case 'dbg.removeBreakpoint':
      case 'dbg.pause':
      case 'dbg.resume':
      case 'dbg.step':
      case 'dbg.evaluateOnCallFrame':
      case 'dbg.getProperties':
        this.#handleDbg(message);
        break;
    }
  }

  #handleInit(message: Extract<MainToWorkerMessage, { type: 'init' }>): void {
    try {
      const engine = this.#deps.createEngine(message, {
        // Ship serialized render batches to the main thread instead of decoding here.
        onSerializedBatch: (batch) => this.#post({ type: 'batch', batch }),
      });
      engine.on('message', (m) =>
        this.#post({ type: 'message', event: m.event, payload: m.payload })
      );
      engine.on('error', (e) => this.#post({ type: 'engineError', error: this.#err(e) }));
      engine.on('fatalError', (e) => this.#post({ type: 'fatal', error: this.#err(e) }));
      // Timer callbacks are guest-eval ENTRY too, fired by the engine's own
      // event loop rather than via a worker message — route them through the
      // same gate as load/event/invoke so they queue behind a breakpoint
      // suspend instead of re-entering the suspended runtime.
      engine.setGuestTurnRunner?.((run) => this.#runGuestTurn(run));
      this.#engine = engine;
      this.#post({ type: 'ready' });
    } catch (e) {
      this.#post({ type: 'initError', error: this.#err(e) });
    }
  }

  async #handleLoad(message: Extract<MainToWorkerMessage, { type: 'load' }>): Promise<void> {
    if (!this.#engine) {
      this.#post({
        type: 'loadError',
        turnId: message.turnId,
        error: this.#err(new Error('Worker engine not initialized')),
      });
      return;
    }
    try {
      await this.#engine.loadBundle(message.source, message.initialProps);
      this.#post({ type: 'loaded', turnId: message.turnId });
    } catch (e) {
      this.#post({ type: 'loadError', turnId: message.turnId, error: this.#err(e) });
    }
  }

  // ============================================
  // Debugger (dbg.*) worker-side handling — DEFERRED guest suspend (Milestone B).
  //
  // TODO(milestone-b): the real implementation loads the QuickJS-asyncify DEBUG wasm
  // (proven in native/quickjs/poc) and evals guest code through the Emscripten
  // `ccall(..., { async: true })` path so a breakpoint can unwind the C stack and park a
  // resume continuation; `onPaused` maps the suspended frame(s) to DbgCallFrame[] + posts
  // `dbg.paused`, and setBreakpoint/evaluateOnCallFrame/getProperties resolve against the
  // debug runtime's script table + pause-scoped object registry. None of that can run
  // without that wasm, so guest suspend is stubbed here and the release eval path is
  // left completely untouched. What IS wired is the CONTROL-FLOW: the gate and the
  // control-plane routing invariant below.
  // ============================================
  #handleDbg(message: Extract<MainToWorkerMessage, { type: `dbg.${string}` }>): void {
    // The invariant: evaluateOnCallFrame / getProperties are sub-operations of the
    // already-suspended turn. They must run NOW — bypassing the gate — even while a
    // breakpoint suspend is outstanding; queuing them would deadlock against the very
    // resume they are meant to inform.
    if (isControlPlaneDbg(message.type)) {
      this.#handleDbgControlPlane(message);
      return;
    }

    switch (message.type) {
      case 'dbg.enable':
        // Front guest-eval entry with the gate for the debug session's lifetime.
        this.#dbgEnabled = true;
        this.#post({ type: 'dbg.ack', requestId: message.requestId });
        break;
      case 'dbg.disable':
        // Leaving debug: drain the gate and drop back to the direct eval path.
        this.#dbgEnabled = false;
        this.#gate.onResume();
        this.#post({ type: 'dbg.ack', requestId: message.requestId });
        break;
      case 'dbg.setBreakpoint':
        // TODO(milestone-b): resolve against the debug runtime's script table.
        this.#post({
          type: 'dbg.breakpointResolved',
          requestId: message.requestId,
          breakpointId: '',
        });
        break;
      case 'dbg.pause':
        // Headless stand-in for the asyncify breakpoint hook: mark the gate suspended so
        // no further guest-eval turn is dispatched on top of the (would-be) parked stack.
        this.#gate.onSuspend();
        this.#post({ type: 'dbg.ack', requestId: message.requestId });
        break;
      case 'dbg.resume':
        // Re-open the gate; queued guest-eval turns drain in FIFO order.
        this.#gate.onResume();
        this.#post({ type: 'dbg.ack', requestId: message.requestId });
        break;
      default:
        // dbg.removeBreakpoint / dbg.step: acknowledged so the request/reply surface
        // stays coherent; no guest suspend occurs in this headless milestone.
        this.#post({ type: 'dbg.ack', requestId: message.requestId });
        break;
    }
  }

  /**
   * Control-plane debugger ops that inspect the SUSPENDED turn. Routed straight to the
   * (stubbed) wasm debug path — never through {@link #gate} — so they resolve even while
   * a breakpoint suspend is outstanding. This is the web counterpart of native
   * cross-unwind evaluate-on-frame (which reads a pre-unwind binding snapshot).
   */
  #handleDbgControlPlane(message: Extract<MainToWorkerMessage, { type: `dbg.${string}` }>): void {
    if (message.type === 'dbg.evaluateOnCallFrame') {
      // TODO(milestone-b): evaluate in the paused frame's snapshot via __rillDbg.
      this.#post({
        type: 'dbg.evalResult',
        requestId: message.requestId,
        ok: false,
        error: 'debugger not wired (deferred: asyncify debug wasm)',
      });
      return;
    }
    if (message.type === 'dbg.getProperties') {
      // TODO(milestone-b): read the objectId's own props off the pause-scoped
      // registry. Empty until the debug runtime is wired.
      this.#post({ type: 'dbg.propertiesResult', requestId: message.requestId, properties: [] });
    }
  }

  // Reason: catch-clause / event values are inherently unknown
  #err(value: unknown): SerializedWorkerError {
    return serializeWorkerError(value);
  }
}
