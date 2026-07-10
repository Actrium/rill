/**
 * Worker host protocol (issue #19, L1) — message contract between the main-thread
 * {@link WorkerEngine} and the in-worker harness (`worker-host.ts`).
 *
 * Design notes:
 * - Only structured-clone-safe values cross the boundary. Render batches travel as
 *   {@link SerializedOperationBatch} (callbacks are `{__fnId}` markers, not live functions);
 *   the main thread decodes them and wires each callback back over postMessage.
 * - Every message that runs guest code carries a `turnId`. The worker replies with a matching
 *   completion (`loaded`/`loadError`/`turnDone`) so the main-thread watchdog can detect a guest
 *   that wedged the worker in a synchronous loop and `terminate()` it.
 */

import type { SerializedOperationBatch } from '../../types';

/** A serialized Error that survives structured clone. */
export interface SerializedWorkerError {
  name: string;
  message: string;
  stack?: string;
}

/** Sandbox backends valid inside a Worker (web/WASM only). */
export type WorkerSandbox = 'wasm-quickjs';

// ============================================
// Debugger sub-protocol (dbg.*) — Milestone B web side
//
// The dbg.* messages carry a Chrome DevTools Protocol (CDP) Debugger conversation
// across the worker boundary in rill's own structured-clone-safe shape. The main
// thread {@link WorkerEngine} exposes typed dbg* methods and events; a pure
// {@link CdpTranslator} (cdp-translator.ts) maps raw CDP JSON-RPC <-> these
// messages. The shapes mirror the native structs in
// native/core/src/devtools/DebuggerAdapter.h field-for-field so the JS relay and
// the native (Hermes/JSC) relays stay wire-compatible.
//
// The real suspend/resume that a paused breakpoint needs is driven by the
// QuickJS-asyncify debug wasm proven in Milestone A (native/quickjs/poc); wiring
// that into the worker eval-entry is deferred (see worker-host.ts TODOs).
// ============================================

/** CDP pause reason (mirrors native PauseReason -> pauseReasonToString). */
export type DbgPauseReason = 'breakpoint' | 'exception' | 'debugCommand' | 'step' | 'other';

/** Step granularity for dbg.step (mirrors native StepAction, minus Continue=resume). */
export type DbgStepAction = 'over' | 'into' | 'out';

/** A parsed guest script — structured-clone-safe subset of native `ScriptInfo`. */
export interface DbgScript {
  scriptId: string;
  url: string;
  startLine: number;
  endLine: number;
  hash: string;
}

/** A single scope in a call frame's scope chain (mirrors native `CallFrame::Scope`). */
export interface DbgScope {
  /** "local" | "closure" | "global" | ... */
  type: string;
  objectId: string;
  name?: string;
}

/** A call frame captured at a pause (mirrors native `CallFrame`, clone-safe). */
export interface DbgCallFrame {
  callFrameId: string;
  functionName: string;
  scriptId: string;
  url: string;
  line: number;
  column: number;
  scopeChain: DbgScope[];
  thisObjectId: string;
}

/** A resolved breakpoint location. */
export interface DbgLocation {
  scriptId: string;
  line: number;
  column: number;
}

/** Result of a resolved `dbgSetBreakpoint`. */
export interface DbgBreakpointResult {
  breakpointId: string;
  location?: DbgLocation;
}

/** Result of a `dbgEvaluateOnCallFrame`. */
export interface DbgEvalResult {
  ok: boolean;
  // Reason: guest eval result is an arbitrary serializable value
  value?: unknown;
  error?: string;
}

/**
 * One property of an object/scope (mirrors native `PropertyDescriptor` built in
 * QuickJSEngineDebugger::getProperties). `value` is the same clone-safe shape a
 * `DbgEvalResult.value` carries — a primitive inline, or an object placeholder.
 */
export interface DbgPropertyDescriptor {
  name: string;
  // Reason: a guest property value is an arbitrary serializable value
  value?: unknown;
  writable: boolean;
  configurable: boolean;
  enumerable: boolean;
}

/** Result of a `dbgGetProperties` — the own properties of one objectId. */
export interface DbgPropertiesResult {
  properties: DbgPropertyDescriptor[];
}

/** Options accepted by {@link DbgSetBreakpointMessage}/`dbgSetBreakpoint`. */
export interface DbgSetBreakpointOptions {
  scriptId?: string;
  url?: string;
  line: number;
  column?: number;
  condition?: string;
}

/** Main→worker debugger requests. Each carries a `requestId` correlated by a dbg reply. */
export type DbgSetBreakpointMessage = {
  type: 'dbg.setBreakpoint';
  requestId: number;
} & DbgSetBreakpointOptions;

export type MainToWorkerDbgMessage =
  | { type: 'dbg.enable'; requestId: number }
  | { type: 'dbg.disable'; requestId: number }
  | DbgSetBreakpointMessage
  | { type: 'dbg.removeBreakpoint'; requestId: number; breakpointId: string }
  | { type: 'dbg.pause'; requestId: number }
  | { type: 'dbg.resume'; requestId: number }
  | { type: 'dbg.step'; requestId: number; action: DbgStepAction }
  | { type: 'dbg.evaluateOnCallFrame'; requestId: number; callFrameId: string; expression: string }
  // getProperties expands a scope/object handle WHILE paused. Like evaluateOnCallFrame
  // it is a control-plane sub-operation of the already-suspended turn, never a new
  // eval turn — the worker routes it BYPASSING the guest-eval gate (see worker-dispatch).
  | { type: 'dbg.getProperties'; requestId: number; objectId: string };

/** Worker→main debugger replies (correlated by `requestId`) and async events (by `turnId`). */
export type WorkerToMainDbgMessage =
  | {
      type: 'dbg.paused';
      turnId: number;
      reason: DbgPauseReason;
      callFrames: DbgCallFrame[];
      hitBreakpoints: string[];
    }
  | { type: 'dbg.resumed'; turnId: number }
  | { type: 'dbg.scriptParsed'; script: DbgScript }
  | {
      type: 'dbg.breakpointResolved';
      requestId: number;
      breakpointId: string;
      location?: DbgLocation;
    }
  | {
      type: 'dbg.evalResult';
      requestId: number;
      ok: boolean;
      // Reason: guest eval result is an arbitrary serializable value
      value?: unknown;
      error?: string;
    }
  | { type: 'dbg.propertiesResult'; requestId: number; properties: DbgPropertyDescriptor[] }
  | { type: 'dbg.ack'; requestId: number };

/** Main thread → worker. */
export type MainToWorkerMessage =
  | {
      type: 'init';
      sandbox: WorkerSandbox;
      wasmBinary?: ArrayBuffer;
      wasmPath?: string;
      timeout?: number;
      debug?: boolean;
    }
  | { type: 'load'; turnId: number; source: string; initialProps?: Record<string, unknown> }
  // Reason: host event payload is any serializable value
  | { type: 'event'; turnId: number; eventName: string; payload?: unknown }
  // Reason: guest-callback args are arbitrary serializable values
  | { type: 'invoke'; turnId: number; fnId: string; args: unknown[] }
  | { type: 'release'; fnId: string }
  | { type: 'config'; config: Record<string, unknown> }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'destroy' }
  | MainToWorkerDbgMessage;

/** Worker → main thread. */
export type WorkerToMainMessage =
  | { type: 'ready' }
  | { type: 'initError'; error: SerializedWorkerError }
  | { type: 'loaded'; turnId: number }
  | { type: 'loadError'; turnId: number; error: SerializedWorkerError }
  | { type: 'turnDone'; turnId: number }
  | { type: 'batch'; batch: SerializedOperationBatch }
  // Reason: guest->host message payload is any serializable value
  | { type: 'message'; event: string; payload: unknown }
  | { type: 'engineError'; error: SerializedWorkerError }
  | { type: 'fatal'; error: SerializedWorkerError }
  | WorkerToMainDbgMessage;

/** Normalize an unknown thrown value into a clone-safe error. */
// Reason: catch-clause / event values are inherently unknown
export function serializeWorkerError(value: unknown): SerializedWorkerError {
  const err = value instanceof Error ? value : new Error(String(value));
  return { name: err.name, message: err.message, stack: err.stack };
}

/** Rebuild an Error from its serialized form (preserving name/stack). */
export function deserializeWorkerError(error: SerializedWorkerError): Error {
  const err = new Error(error.message);
  err.name = error.name;
  if (error.stack) {
    err.stack = error.stack;
  }
  return err;
}
