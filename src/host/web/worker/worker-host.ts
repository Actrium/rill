/**
 * Worker host harness (issue #19, L1) — runs INSIDE a Web Worker.
 *
 * It owns a real core {@link Engine} with the QuickJS-WASM sandbox, so the entire guest CPU
 * cost (module eval, callbacks, event handlers) runs off the main/UI thread. The synchronous
 * host-fn bridge (`__sendToHost` → `__rill_fn_ret`) stays fully inside this worker, untouched.
 *
 * This module is intentionally thin: it only binds the worker's `self` (message in, postMessage
 * out) and constructs the real {@link Engine}. All message routing — guest-eval entry, the
 * guest-eval {@link TurnGate}, and the debugger `dbg.*` sub-protocol (including the
 * control-plane bypass invariant) — lives in {@link WorkerDispatch}, which is engine-agnostic
 * and headless-testable (the QuickJS-WASM sandbox cannot be imported off a worker thread).
 */

import { Engine } from '../../engine';
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol';
import { type GuestEngineLike, WorkerDispatch } from './worker-dispatch';

interface WorkerScope {
  onmessage: ((event: { data: MainToWorkerMessage }) => void) | null;
  postMessage(message: WorkerToMainMessage): void;
}

const scope = self as unknown as WorkerScope;

const dispatch = new WorkerDispatch({
  post: (message) => scope.postMessage(message),
  createEngine: (init, hooks) => {
    const engine = new Engine({
      sandbox: init.sandbox,
      wasmBinary: init.wasmBinary,
      wasmPath: init.wasmPath,
      timeout: init.timeout,
      debug: init.debug,
      onSerializedBatch: hooks.onSerializedBatch,
    });
    return engine as unknown as GuestEngineLike;
  },
});

scope.onmessage = (event) => {
  dispatch.handle(event.data);
};
