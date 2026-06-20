/**
 * Rill Reconciler
 *
 * Custom renderer based on react-reconciler
 * Transforms React render actions into JSON instructions
 */

// ============================================
// Re-export types from sdk/types
// ============================================
export type {
  GuestElement,
  GuestReactElement,
  SerializedOperation,
  SerializedOperationBatch,
  VNode,
} from '../../../sdk/types';
// ============================================
// Re-export from bridge
// ============================================
export type { CallbackRegistry as CallbackRegistryInterface, SendToHost } from '../../../shared';
export { CallbackRegistryImpl as CallbackRegistry } from '../../../shared';
// ============================================
// DevTools
// ============================================
export { isDevToolsEnabled, type RenderTiming, sendDevToolsMessage } from './devtools';
// ============================================
// Element Transformation
// ============================================
export {
  registerComponentType,
  transformGuestElement,
  unregisterComponentTypes,
} from './element-transform';
// ============================================
// Host Config
// ============================================
export {
  createReconciler,
  resetReconcilerScheduler,
  setReconcilerScheduler,
} from './host-config';
// ============================================
// Operation Collector
// ============================================
export { OperationCollector } from './operation-collector';
// ============================================
// Reconciler Manager (Public API)
// ============================================
export {
  getCallbackCount,
  getCallbackRegistry,
  globalCallbackRegistry,
  hasCallback,
  invokeCallback,
  releaseCallback,
  render,
  unmount,
  unmountAll,
} from './reconciler-manager';
// ============================================
// Types
// ============================================
export type { ExtendedHostConfig, PublicInstance, RillReconciler, RootContainer } from './types';
export { getRemovedProps } from './types';
