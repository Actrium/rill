/**
 * rill/host/web — opt-in, first-class web host adapter (issue #19).
 *
 * Provides the generic web mechanism for embedding rill on the web, kept separate from the
 * RN-first core so web deps stay opt-in:
 *
 * - **thin-DOM preset** (`WebComponents`): View→div, Text→span, Pressable→button, etc. — a
 *   tiny, auditable component set with no react-native-web and no mandatory network-bearing
 *   props. Register with `engine.register(WebComponents)`, or override any single entry.
 * - **WebEngineView** + **mountEngineView**: render the guest tree into the DOM (mount via the
 *   integrator's react-dom).
 * - **attachKeyboard**: bridge a DOM target's physical keyboard to the guest's `useKeyboard`
 *   hook, with synchronous on-demand `preventDefault` for keys the guest declares.
 * - **WorkerEngine**: run the QuickJS-WASM engine off the main thread in a Web Worker, with a
 *   `terminate()`-based watchdog that hard-kills a runaway guest. Drives `WebEngineView` exactly
 *   like the in-thread Engine.
 *
 * Policy (threat model, CSP, capability sealing) stays with the integrator. The off-main-thread
 * worker engine + async bridge (L1) is a separate, deeper change.
 *
 * ```ts
 * import { Engine } from 'rill/host';
 * import { WebComponents, WebEngineView } from 'rill/host/web';
 *
 * const engine = new Engine({ sandbox: 'wasm-quickjs' });
 * engine.register(WebComponents);
 * createRoot(el).render(<WebEngineView engine={engine} source={code} />);
 * ```
 */

// Web keyboard bridge protocol (issue #19, L3) — re-exported for host integrators.
export {
  KBD_EVENT,
  KBD_SUBSCRIBE,
  KBD_UNSUBSCRIBE,
  type KeyboardSubscribePayload,
  type KeyboardUnsubscribePayload,
  type RillKeyEvent,
} from '../../shared/keyboard';
export * from './components';
export { WebEngineView, type WebEngineViewProps } from './engine-view';
export {
  type AttachKeyboardOptions,
  attachKeyboard,
  type KeyboardAttachment,
  type KeyboardBridgeEngine,
  type KeyboardTarget,
} from './keyboard';
export { type EngineViewMount, mountEngineView } from './mount';
export { toWebStyle, type WebStyleInput, withBaseStyle } from './style';
export type {
  MainToWorkerMessage,
  WorkerSandbox,
  WorkerToMainMessage,
} from './worker/protocol';
// Off-main-thread engine (issue #19, L1)
export {
  createWorkerEngine,
  type WatchdogKillInfo,
  WorkerEngine,
  type WorkerEngineEventMap,
  type WorkerEngineOptions,
} from './worker/worker-engine';
