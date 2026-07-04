/**
 * WasmGuestView — adapts a native (non-JS) WASM guest to the `EngineViewEngine`
 * surface that `useEngineView` drives (see src/host/use-engine-view.ts). It lets
 * the platform mount a native guest through the SAME rendering pipeline as the
 * JS `Engine` — only the constructed "engine" object differs; `useEngineView`,
 * the receiver, keyboard forwarding, etc. are unchanged.
 *
 * Construction mirrors `Engine`: same `contract` + `hostModules` (the dispatch
 * is built from them, so host:* is written once and serves both guest kinds) and
 * the same `components`. It owns a `WasmGuestHost` + a `Receiver`; the guest's
 * render batches flow WasmGuestHost.onRenderBatch -> receiver.applyBatch, and
 * `sendEvent` forwards to the native event channel (rill_on_event).
 */
import type { HostModuleImplementationMap, RillContractShape } from '../../contract';
import { createHostModuleDispatch } from '../../contract';
import { Receiver } from '../receiver';
import type { ComponentType } from '../registry';
import { ComponentRegistry } from '../registry';
import { WasmGuestHost } from './wasm-guest-host';

export interface WasmGuestViewOptions {
  /** The decoded native guest `.wasm` (the caller owns any base64/gzip decode). */
  wasmBytes: BufferSource;
  /** Host-capability contract — same one an `Engine` would take. */
  contract: RillContractShape;
  /** Host-capability implementations — same shape as `Engine`'s `hostModules`. */
  hostModules: HostModuleImplementationMap;
  /** Sealed component materializers — same map as `Engine.register`. */
  components: Record<string, ComponentType>;
  /** Sink for guest `rill_log`. */
  onLog?: (message: string) => void;
}

type Listener = () => void;
type ErrorListener = (error: Error) => void;

export class WasmGuestView {
  private readonly host: WasmGuestHost;
  private readonly wasmBytes: BufferSource;
  private readonly registry: ComponentRegistry;
  private receiver: Receiver | null = null;
  private loaded = false;
  private destroyed = false;
  private readonly updateListeners = new Set<Listener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly destroyListeners = new Set<Listener>();

  constructor(options: WasmGuestViewOptions) {
    this.wasmBytes = options.wasmBytes;
    this.registry = new ComponentRegistry();
    for (const [name, component] of Object.entries(options.components)) {
      this.registry.register(name, component);
    }
    this.host = new WasmGuestHost({
      dispatch: createHostModuleDispatch(options.contract, options.hostModules),
      onLog: options.onLog,
      onRenderBatch: (batch) => this.receiver?.applyBatch(batch),
    });
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  createReceiver(): Receiver {
    if (this.receiver) return this.receiver;
    this.receiver = new Receiver(
      this.registry,
      // Native guests don't support host->guest ref method calls yet (REF_CALL);
      // this is where that transport would go.
      () => {},
      () => {
        for (const listener of this.updateListeners) listener();
      }
    );
    return this.receiver;
  }

  getReceiver(): Receiver | null {
    return this.receiver;
  }

  // Signature matches EngineViewEngine.loadBundle; the wasm bytes are provided at
  // construction, so the JS-guest `source`/props/options are not used here.
  async loadBundle(
    _source?: string,
    _initialProps?: Record<string, unknown>,
    _options?: { bytecodeAssetPath?: string }
  ): Promise<void> {
    try {
      await this.host.load(this.wasmBytes); // rill_init -> render batch -> receiver
      await this.host.drain();
      this.loaded = true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const listener of this.errorListeners) listener(err);
      throw err;
    }
  }

  /** Forward an input / lifecycle event to the native guest (rill_on_event). */
  // Reason: an event payload is any JSON-serializable value, forwarded as-is.
  sendEvent(name: string, payload?: unknown): void {
    this.host.emitEvent(name, payload);
  }

  on(event: 'update', listener: Listener): () => void;
  on(event: 'error', listener: ErrorListener): () => void;
  on(event: 'destroy', listener: Listener): () => void;
  on(event: 'update' | 'error' | 'destroy', listener: Listener | ErrorListener): () => void {
    const set =
      event === 'update'
        ? this.updateListeners
        : event === 'error'
          ? this.errorListeners
          : this.destroyListeners;
    set.add(listener as Listener & ErrorListener);
    return () => set.delete(listener as Listener & ErrorListener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of this.destroyListeners) listener();
  }
}

/** Construct a native WASM guest as an `EngineViewEngine` (+ `sendEvent` / `destroy`). */
export function createWasmGuestEngine(options: WasmGuestViewOptions): WasmGuestView {
  return new WasmGuestView(options);
}
