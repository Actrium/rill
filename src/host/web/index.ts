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

export * from './components';
export { WebEngineView, type WebEngineViewProps } from './engine-view';
export { type EngineViewMount, mountEngineView } from './mount';
export { toWebStyle, type WebStyleInput, withBaseStyle } from './style';
