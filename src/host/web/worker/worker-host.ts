/**
 * Worker host harness (issue #19, L1) — runs INSIDE a Web Worker.
 *
 * It owns a real core {@link Engine} with the QuickJS-WASM sandbox, so the entire guest CPU
 * cost (module eval, callbacks, event handlers) runs off the main/UI thread. The synchronous
 * host-fn bridge (`__sendToHost` → `__rill_fn_ret`) stays fully inside this worker, untouched.
 *
 * What crosses the worker boundary is only what is already message-shaped:
 *  - render batches, forwarded as SERIALIZED batches via the engine's `onSerializedBatch` hook;
 *  - guest→host messages (`emit('message')`);
 *  - host events / guest-callback invocations / lifecycle, driven by main-thread requests.
 *
 * Each guest-executing request carries a `turnId`; we reply with a matching completion so the
 * main-thread watchdog can `terminate()` this worker if a guest wedges it in a sync loop.
 */

import type { ReviewedUnknown } from '../../../shared';
import { Engine } from '../../engine';
import type { BridgeValueObject } from '../../types';
import {
  type MainToWorkerMessage,
  serializeWorkerError,
  type WorkerToMainMessage,
} from './protocol';

interface WorkerScope {
  onmessage: ((event: { data: MainToWorkerMessage }) => void) | null;
  postMessage(message: WorkerToMainMessage): void;
}

const scope = self as unknown as WorkerScope;

let engine: Engine | null = null;

function post(message: WorkerToMainMessage): void {
  scope.postMessage(message);
}

function handleInit(message: Extract<MainToWorkerMessage, { type: 'init' }>): void {
  try {
    engine = new Engine({
      sandbox: message.sandbox,
      wasmBinary: message.wasmBinary,
      wasmPath: message.wasmPath,
      timeout: message.timeout,
      debug: message.debug,
      // Ship serialized render batches to the main thread instead of decoding/rendering here.
      onSerializedBatch: (batch) => post({ type: 'batch', batch }),
    });

    engine.on('message', (m) => post({ type: 'message', event: m.event, payload: m.payload }));
    engine.on('error', (e) => post({ type: 'engineError', error: serializeWorkerError(e) }));
    engine.on('fatalError', (e) => post({ type: 'fatal', error: serializeWorkerError(e) }));

    post({ type: 'ready' });
  } catch (e) {
    post({ type: 'initError', error: serializeWorkerError(e) });
  }
}

async function handleLoad(message: Extract<MainToWorkerMessage, { type: 'load' }>): Promise<void> {
  if (!engine) {
    post({
      type: 'loadError',
      turnId: message.turnId,
      error: serializeWorkerError(new Error('Worker engine not initialized')),
    });
    return;
  }
  try {
    await engine.loadBundle(message.source, message.initialProps);
    post({ type: 'loaded', turnId: message.turnId });
  } catch (e) {
    post({ type: 'loadError', turnId: message.turnId, error: serializeWorkerError(e) });
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      handleInit(message);
      break;
    case 'load':
      // Fire-and-forget: the async resolution posts loaded/loadError itself.
      void handleLoad(message);
      break;
    case 'event':
      // sendEvent drives the guest handler synchronously (the async chain runs to the WASM
      // eval before yielding), so by the time it returns the guest turn is done — or the
      // worker is wedged and this turnDone never posts, tripping the watchdog.
      try {
        engine?.sendEvent(message.eventName, message.payload);
      } finally {
        post({ type: 'turnDone', turnId: message.turnId });
      }
      break;
    case 'invoke':
      try {
        engine?.invokeGuestCallback(message.fnId, message.args as ReviewedUnknown[]);
      } finally {
        post({ type: 'turnDone', turnId: message.turnId });
      }
      break;
    case 'release':
      // v1: guest-callback release is not bridged across the worker (the guest registry's own
      // GC handles unmounted trees). A no-op here; tracked as a follow-up alongside host modules.
      break;
    case 'config':
      engine?.updateConfig(message.config as BridgeValueObject);
      break;
    case 'pause':
      engine?.pause();
      break;
    case 'resume':
      engine?.resume();
      break;
    case 'destroy':
      engine?.destroy();
      engine = null;
      break;
  }
};
