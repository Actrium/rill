/**
 * WorkerEngine (issue #19, L1) — main-thread proxy for an Engine that runs off the UI thread.
 *
 * The real {@link Engine} + QuickJS-WASM sandbox live in a Web Worker (see `worker-host.ts`), so
 * a guest infinite loop or heavy compute no longer freezes the host page. Two robustness wins an
 * integrator cannot get without forking rill:
 *  - **off-main-thread execution**: guest CPU is on the worker;
 *  - **hard kill**: a per-turn watchdog `terminate()`s a runaway guest (a true kill, not a flag).
 *
 * This class implements the slice of the engine surface that {@link useEngineView} needs
 * (`createReceiver`/`getReceiver`/`loadBundle`/`sendEvent`/`on`/lifecycle), so a `WebEngineView`
 * can drive it exactly like an in-thread `Engine`. The Receiver lives here on the main thread
 * (that is where react-dom renders); the worker ships SERIALIZED render batches, which this
 * class decodes — turning each `{__fnId}` marker back into a proxy that invokes the guest
 * callback over postMessage.
 *
 * Not yet bridged across the worker in v1 (fail-closed or no-op, tracked as follow-ups):
 *  - `host:*` capability modules (the integrator's async host calls);
 *  - `useRemoteRef` (host→guest REF_CALL);
 *  - guest-callback release (the guest registry's own GC covers unmounted trees).
 */

import type { ReviewedUnknown } from '../../../shared';
import { CallbackRegistryImpl as CallbackRegistry } from '../../../shared';
import { Bridge } from '../../../shared/bridge/bridge';
import { Receiver } from '../../receiver';
import { type ComponentMap, ComponentRegistry } from '../../registry';
import type { BridgeValueObject, OperationBatch, SerializedOperationBatch } from '../../types';
import {
  deserializeWorkerError,
  type MainToWorkerMessage,
  type WorkerSandbox,
  type WorkerToMainMessage,
} from './protocol';

/** Events emitted by a {@link WorkerEngine}. Mirrors the subset of the core engine's events. */
export interface WorkerEngineEventMap {
  update: () => void;
  error: (error: Error) => void;
  destroy: () => void;
  load: () => void;
  fatalError: (error: Error) => void;
  // Reason: guest->host message payload is any serializable value
  message: (message: { event: string; payload: unknown }) => void;
  operation: (batch: OperationBatch) => void;
}

/** Information passed to {@link WorkerEngineOptions.onWatchdogKill}. */
export interface WatchdogKillInfo {
  /** Internal turn id of the guest turn that overran. */
  turnId: number;
  /** What kind of turn overran: bundle load, host event, or guest-callback invocation. */
  kind: 'load' | 'event' | 'invoke';
  /** The configured budget (ms) that was exceeded. */
  timeoutMs: number;
}

/** Options for {@link WorkerEngine}. */
export interface WorkerEngineOptions {
  /** Sandbox backend to run in the worker. Only `wasm-quickjs` is valid off-thread. */
  sandbox?: WorkerSandbox;
  /** QuickJS `.wasm` bytes (transferred to the worker; no fetch — strict-CSP friendly). */
  wasmBinary?: Uint8Array | ArrayBuffer;
  /** Override the `.wasm` URL the in-worker loader fetches (when `wasmBinary` is not given). */
  wasmPath?: string;
  /** Inner engine execution timeout (ms) passed through to the worker's Engine. */
  timeout?: number;
  /** Enable debug logging in the worker's Engine. */
  debug?: boolean;
  /**
   * Factory for the backing Worker. Defaults to
   * `new Worker(new URL('./worker-host.js', import.meta.url), { type: 'module' })`, which a
   * bundler that understands the `new URL(..., import.meta.url)` worker idiom (Vite, webpack,
   * esbuild) resolves automatically. Pass this to control worker creation explicitly.
   */
  createWorker?: () => Worker;
  /**
   * Watchdog budget (ms): the maximum a single guest turn (bundle load, host event, or callback)
   * may run before the worker is `terminate()`d as a runaway. `0` disables the watchdog. The
   * value is integrator policy. Note the first load also pays WASM instantiation. Default 5000.
   */
  watchdogTimeout?: number;
  /** Called when the watchdog hard-kills a runaway guest. Integrator decides what to do next. */
  onWatchdogKill?: (info: WatchdogKillInfo) => void;
  /** Max operations per batch applied by the main-thread Receiver. */
  receiverMaxBatchSize?: number;
}

type Listener = (arg?: unknown) => void;

let _workerEngineSeq = 0;

function toArrayBuffer(bin: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bin instanceof ArrayBuffer) {
    return bin;
  }
  // Copy out an exact-length buffer (the view may be a window into a larger buffer).
  return bin.slice().buffer;
}

export class WorkerEngine {
  readonly id: string;

  #worker: Worker;
  #registry = new ComponentRegistry();
  #callbacks = new CallbackRegistry();
  #bridge: Bridge;
  #receiver: Receiver | null = null;

  #listeners = new Map<keyof WorkerEngineEventMap, Set<Listener>>();

  #ready = false;
  #loaded = false;
  #destroyed = false;
  #paused = false;

  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #readyPromise: Promise<void>;
  #preReadyQueue: Array<() => void> = [];

  #turnSeq = 0;
  #watchdogs = new Map<number, ReturnType<typeof setTimeout>>();
  #watchdogKinds = new Map<number, WatchdogKillInfo['kind']>();
  #pendingLoads = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

  #watchdogTimeout: number;
  #onWatchdogKill?: (info: WatchdogKillInfo) => void;
  #receiverMaxBatchSize?: number;
  #warnedReceiverToSandbox = false;

  constructor(options: WorkerEngineOptions = {}) {
    _workerEngineSeq += 1;
    this.id = `worker-engine-${_workerEngineSeq}`;
    this.#watchdogTimeout = options.watchdogTimeout ?? 5000;
    this.#onWatchdogKill = options.onWatchdogKill;
    this.#receiverMaxBatchSize = options.receiverMaxBatchSize;

    // Main-thread bridge: decode serialized batches from the worker into live operation batches.
    // Decoded callbacks become proxies that invoke the guest callback over postMessage.
    this.#bridge = new Bridge({
      callbackRegistry: this.#callbacks,
      guestInvoker: (fnId, args) => {
        this.#invokeGuestCallback(fnId, args);
        // Fire-and-forget across the worker boundary: UI event handlers don't use the return.
        return undefined;
      },
      guestReleaseCallback: (fnId) => this.#enqueue(() => this.#postRaw({ type: 'release', fnId })),
      onGuestOperations: (batch) => {
        this.#receiver?.applyBatch(batch);
      },
      onHostMessage: () => {
        // Main thread never sends host messages through this bridge; sendEvent posts directly.
      },
    });

    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });

    this.#worker = options.createWorker
      ? options.createWorker()
      : new Worker(new URL('./worker-host.js', import.meta.url), { type: 'module' });

    this.#worker.onmessage = (event: MessageEvent) => {
      this.#onWorkerMessage(event.data as WorkerToMainMessage);
    };
    this.#worker.onerror = (event: ErrorEvent) => {
      this.#emit('error', new Error(`[rill] worker error: ${event.message ?? 'unknown'}`));
    };

    const init: MainToWorkerMessage = {
      type: 'init',
      sandbox: options.sandbox ?? 'wasm-quickjs',
      wasmBinary: options.wasmBinary ? toArrayBuffer(options.wasmBinary) : undefined,
      wasmPath: options.wasmPath,
      timeout: options.timeout,
      debug: options.debug,
    };
    this.#postRaw(init);
  }

  // ============================================
  // Engine surface used by useEngineView
  // ============================================

  register(components: ComponentMap): void {
    this.#registry.registerAll(components);
  }

  getRegistry(): ComponentRegistry {
    return this.#registry;
  }

  createReceiver(): Receiver {
    this.#receiver = new Receiver(
      this.#registry,
      (message) => this.#onReceiverToSandbox(message),
      () => this.#emit('update'),
      {
        maxBatchSize: this.#receiverMaxBatchSize,
        releaseCallback: (fnId) => this.#bridge.releaseCallback(fnId),
      }
    );
    return this.#receiver;
  }

  getReceiver(): Receiver | null {
    return this.#receiver;
  }

  loadBundle(source: string, initialProps?: Record<string, unknown>): Promise<void> {
    if (this.#destroyed) {
      return Promise.reject(new Error('[rill] WorkerEngine is destroyed'));
    }
    return this.#readyPromise.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const turnId = this.#nextTurn();
          this.#pendingLoads.set(turnId, { resolve, reject });
          this.#armWatchdog(turnId, 'load');
          this.#postRaw({ type: 'load', turnId, source, initialProps });
        })
    );
  }

  // Reason: host event payload is any serializable value (matches Engine.sendEvent)
  sendEvent(eventName: string, payload?: unknown): void {
    if (this.#destroyed) return;
    this.#enqueue(() => {
      const turnId = this.#nextTurn();
      this.#armWatchdog(turnId, 'event');
      this.#postRaw({ type: 'event', turnId, eventName, payload });
    });
  }

  updateConfig(config: BridgeValueObject): void {
    if (this.#destroyed) return;
    this.#enqueue(() => this.#postRaw({ type: 'config', config }));
  }

  pause(): void {
    if (this.#destroyed || this.#paused) return;
    this.#paused = true;
    this.#enqueue(() => this.#postRaw({ type: 'pause' }));
  }

  resume(): void {
    if (this.#destroyed || !this.#paused) return;
    this.#paused = false;
    this.#enqueue(() => this.#postRaw({ type: 'resume' }));
  }

  on<K extends keyof WorkerEngineEventMap>(
    event: K,
    listener: WorkerEngineEventMap[K] extends () => void
      ? () => void
      : (data: Parameters<WorkerEngineEventMap[K]>[0]) => void
  ): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener);
    return () => {
      this.#listeners.get(event)?.delete(listener as Listener);
    };
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  get isPaused(): boolean {
    return this.#paused;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#clearAllWatchdogs();
    this.#rejectAllPendingLoads(new Error('[rill] WorkerEngine destroyed'));
    try {
      this.#postRaw({ type: 'destroy' });
    } catch {
      // worker may already be gone
    }
    this.#worker.terminate();
    this.#receiver?.clear();
    this.#receiver = null;
    this.#emit('destroy');
  }

  // ============================================
  // Internals
  // ============================================

  #nextTurn(): number {
    this.#turnSeq += 1;
    return this.#turnSeq;
  }

  /** Run now if the worker is ready, otherwise queue until the `ready` message arrives. */
  #enqueue(action: () => void): void {
    if (this.#ready) {
      action();
    } else {
      this.#preReadyQueue.push(action);
    }
  }

  #postRaw(message: MainToWorkerMessage): void {
    this.#worker.postMessage(message);
  }

  #invokeGuestCallback(fnId: string, args: ReviewedUnknown[]): void {
    if (this.#destroyed) return;
    const turnId = this.#nextTurn();
    this.#armWatchdog(turnId, 'invoke');
    this.#postRaw({ type: 'invoke', turnId, fnId, args: args as unknown[] });
  }

  // Reason: Receiver→sandbox messages (REF_CALL) are an opaque host-message shape, dropped in v1
  #onReceiverToSandbox(_message: unknown): void {
    if (!this.#warnedReceiverToSandbox) {
      this.#warnedReceiverToSandbox = true;
      // Remote refs (useRemoteRef → host REF_CALL) are not bridged across the worker in v1.
      console.warn(
        '[rill/host/web] WorkerEngine: host→guest REF_CALL (useRemoteRef) is not supported in ' +
          'worker mode yet; the call was dropped.'
      );
    }
  }

  #armWatchdog(turnId: number, kind: WatchdogKillInfo['kind']): void {
    if (this.#watchdogTimeout <= 0) return;
    this.#watchdogKinds.set(turnId, kind);
    const timer = setTimeout(() => this.#onWatchdogFire(turnId), this.#watchdogTimeout);
    this.#watchdogs.set(turnId, timer);
  }

  #disarmWatchdog(turnId: number): void {
    const timer = this.#watchdogs.get(turnId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#watchdogs.delete(turnId);
    }
    this.#watchdogKinds.delete(turnId);
  }

  #clearAllWatchdogs(): void {
    for (const timer of this.#watchdogs.values()) {
      clearTimeout(timer);
    }
    this.#watchdogs.clear();
    this.#watchdogKinds.clear();
  }

  #onWatchdogFire(turnId: number): void {
    if (this.#destroyed) return;
    const kind = this.#watchdogKinds.get(turnId) ?? 'event';
    this.#disarmWatchdog(turnId);

    const error = new Error(
      `[rill] worker watchdog: guest turn exceeded ${this.#watchdogTimeout}ms (${kind}); worker terminated`
    );

    // Hard kill: a synchronously-wedged worker can't be recovered, only terminated.
    this.#destroyed = true;
    this.#clearAllWatchdogs();
    this.#worker.terminate();
    this.#rejectAllPendingLoads(error);

    this.#onWatchdogKill?.({ turnId, kind, timeoutMs: this.#watchdogTimeout });
    this.#emit('fatalError', error);
    this.#emit('error', error);
  }

  #rejectAllPendingLoads(error: Error): void {
    for (const pending of this.#pendingLoads.values()) {
      pending.reject(error);
    }
    this.#pendingLoads.clear();
  }

  #onWorkerMessage(message: WorkerToMainMessage): void {
    switch (message.type) {
      case 'ready': {
        this.#ready = true;
        this.#resolveReady();
        const queued = this.#preReadyQueue;
        this.#preReadyQueue = [];
        for (const action of queued) {
          action();
        }
        break;
      }
      case 'initError':
        this.#rejectReady(deserializeWorkerError(message.error));
        this.#emit('error', deserializeWorkerError(message.error));
        break;
      case 'batch':
        this.#applySerializedBatch(message.batch);
        break;
      case 'message':
        this.#emit('message', { event: message.event, payload: message.payload });
        break;
      case 'loaded': {
        this.#disarmWatchdog(message.turnId);
        this.#loaded = true;
        const pending = this.#pendingLoads.get(message.turnId);
        this.#pendingLoads.delete(message.turnId);
        pending?.resolve();
        this.#emit('load');
        break;
      }
      case 'loadError': {
        this.#disarmWatchdog(message.turnId);
        const pending = this.#pendingLoads.get(message.turnId);
        this.#pendingLoads.delete(message.turnId);
        pending?.reject(deserializeWorkerError(message.error));
        break;
      }
      case 'turnDone':
        this.#disarmWatchdog(message.turnId);
        break;
      case 'engineError':
        this.#emit('error', deserializeWorkerError(message.error));
        break;
      case 'fatal': {
        const error = deserializeWorkerError(message.error);
        this.#emit('fatalError', error);
        this.#emit('error', error);
        break;
      }
    }
  }

  #applySerializedBatch(batch: SerializedOperationBatch): void {
    if (this.#destroyed) return;
    // Decode → onGuestOperations → receiver.applyBatch → receiver schedules an 'update'.
    this.#bridge.sendSerializedBatch(batch);
  }

  #emit<K extends keyof WorkerEngineEventMap>(
    event: K,
    arg?: Parameters<WorkerEngineEventMap[K]>[0]
  ): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      listener(arg);
    }
  }
}

/** Convenience constructor mirroring `new WorkerEngine(options)`. */
export function createWorkerEngine(options?: WorkerEngineOptions): WorkerEngine {
  return options ? new WorkerEngine(options) : new WorkerEngine();
}
