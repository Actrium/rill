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
  | { type: 'destroy' };

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
  | { type: 'fatal'; error: SerializedWorkerError };

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
