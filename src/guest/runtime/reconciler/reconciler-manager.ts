/**
 * Reconciler Manager
 *
 * Manages reconciler instances and provides public API for rendering.
 * Each sendToHost function gets its own isolated reconciler instance.
 */

// Use internal type alias - avoid external @types/react dependency
// biome-ignore lint/suspicious/noExplicitAny: Internal type alias for flexibility
type ReactElement = any;

import type { GuestElement } from '../../../sdk/types';
import { type CallbackRegistry, globalCallbackRegistry, type SendToHost } from '../../../shared';
import { transformGuestElement } from './element-transform';
import { createReconciler } from './host-config';
import type { RillReconciler, RootContainer } from './types';

// ============================================
// Reconciler Instance Management
// ============================================

/**
 * Reconciler instance data for each guest
 */
interface ReconcilerInstance {
  reconciler: RillReconciler;
  callbackRegistry: CallbackRegistry;
  collector: ReturnType<typeof createReconciler>['collector'];
  container: RootContainer;
  root: ReturnType<RillReconciler['createContainer']>;
}

/**
 * Map of sendToHost functions to their reconciler instances
 * This allows multiple guests to each have their own isolated reconciler
 *
 * Stored on globalThis for idempotent initialization:
 * - Engine may inject GUEST_BUNDLE_CODE first
 * - Then user guest bundle executes
 * - Both should share the same reconcilerMap instance
 */
const globals = globalThis as Record<string, unknown>;
const reconcilerMap: Map<SendToHost, ReconcilerInstance> =
  (globals.__rillReconcilerMap as Map<SendToHost, ReconcilerInstance>) ??
  (globals.__rillReconcilerMap = new Map<SendToHost, ReconcilerInstance>());

// Export globalCallbackRegistry from shared for public API
// (re-export the singleton from shared module)
export { globalCallbackRegistry } from '../../../shared';

// ============================================
// Public API
// ============================================

/**
 * Render React element
 *
 * Each sendToHost function creates and manages its own isolated reconciler instance.
 * This allows multiple guests to run simultaneously without interfering with each other.
 *
 * Note: Bridge now handles all serialization internally.
 * The sendToHost should be Bridge.sendToHost for proper serialization.
 *
 * @param element - React element to render
 * @param sendToHost - Function to send operations to host (typically Bridge.sendToHost)
 */
export function render(element: ReactElement, sendToHost: SendToHost): void {
  const debugEnabled = Boolean((globalThis as Record<string, unknown>).__RILL_RECONCILER_DEBUG__);
  if (debugEnabled) {
    const elAny = element as unknown as Record<string, unknown>;
    try {
      const props = elAny?.props as Record<string, unknown> | undefined;
      console.log(
        `[rill:reconciler] render called | type=${String(elAny?.type)} | typeType=${typeof elAny?.type} | marker=${String(elAny?.__rillTypeMarker)} | fragment=${String(elAny?.__rillFragmentType)} | propsKeys=${props ? Object.keys(props).join(',') : 'null'}`
      );
    } catch {
      console.log('[rill:reconciler] render called (log format failed)');
    }
  }

  // Transform Guest element to use Host's Symbol registry
  // ReactElement is compatible with GuestElement at runtime
  const transformedElement = transformGuestElement(element as unknown as GuestElement);
  if (debugEnabled) {
    try {
      const t = transformedElement as ReactElement | null;
      console.log(
        `[rill:reconciler] transformed element | type=${String(t?.type)} | typeType=${typeof t?.type} | propsKeys=${t?.props ? Object.keys(t.props as Record<string, unknown>).join(',') : 'null'}`
      );
    } catch {
      console.log('[rill:reconciler] transformed element (log format failed)');
    }
  }

  let instance = reconcilerMap.get(sendToHost);

  if (!instance) {
    // Create new reconciler instance for this guest
    // Note: sendToHost should be Bridge.sendToHost for proper serialization
    const reconcilerInstance = createReconciler(sendToHost, globalCallbackRegistry);
    const container: RootContainer = { children: [] };
    const root = reconcilerInstance.reconciler.createContainer(
      container,
      0, // ConcurrentRoot
      null, // hydrationCallbacks
      false, // isStrictMode
      null, // concurrentUpdatesByDefaultOverride
      'rill', // identifierPrefix
      // biome-ignore lint/suspicious/noExplicitAny: Error could be non-standard
      (error: any) => {
        // String-only console to avoid JSI circular ref traversal
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? (error.stack ?? '') : '';
        console.error(`[rill] onUncaughtError: ${msg}`);
        if (stack) console.error(`[rill] stack: ${stack}`);
      }, // onUncaughtError
      // biome-ignore lint/suspicious/noExplicitAny: Error could be non-standard
      (error: any) => {
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? (error.stack ?? '') : '';
        console.error(`[rill] onCaughtError: ${msg}`);
        if (stack) console.error(`[rill] stack: ${stack}`);
      }, // onCaughtError
      // biome-ignore lint/suspicious/noExplicitAny: Error could be non-standard
      (error: any) => {
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? (error.stack ?? '') : '';
        console.error(`[rill] onRecoverableError: ${msg}`);
        if (stack) console.error(`[rill] stack: ${stack}`);
      }, // onRecoverableError
      () => {}, // onDefaultTransitionIndicator
      null // transitionCallbacks
    );

    instance = {
      ...reconcilerInstance,
      container,
      root,
    };

    reconcilerMap.set(sendToHost, instance);
  }

  instance.reconciler.updateContainer(transformedElement, instance.root, null, () => {});
}

/**
 * Unmount a specific guest instance
 */
export function unmount(sendToHost?: SendToHost): void {
  if (!sendToHost) return;
  const instance = reconcilerMap.get(sendToHost);
  if (instance) {
    instance.reconciler.updateContainer(null, instance.root, null, () => {});
    // DO NOT clear the global callback registry here, as it's shared
    // instance.callbackRegistry.clear();
    reconcilerMap.delete(sendToHost);
  }
}

/**
 * Unmount all guest instances
 */
export function unmountAll(): void {
  reconcilerMap.forEach((instance) => {
    instance.reconciler.updateContainer(null, instance.root, null, () => {});
    instance.callbackRegistry.clear();
  });
  reconcilerMap.clear();
}

/**
 * Get callback registry for a specific guest instance
 * Used for resource monitoring and debugging
 */
export function getCallbackRegistry(sendToHost?: SendToHost): CallbackRegistry | null {
  if (!sendToHost) {
    return null;
  }
  const instance = reconcilerMap.get(sendToHost);
  return instance ? instance.callbackRegistry : null;
}

/**
 * Check if a callback exists (global registry)
 *
 * Note: In RN / VM runtimes, Guest-side functions are seen by Host-side reconciler
 * as callable handles and registered in CallbackRegistry.
 * No need to rely on Guest runtime injected globalThis.__rill.callbacks / __rill.invokeCallback.
 */
export function hasCallback(fnId: string): boolean {
  return globalCallbackRegistry.getMap().has(fnId);
}

/**
 * Invoke a callback (global registry)
 */
export function invokeCallback(fnId: string, args: unknown[] = []): unknown {
  return globalCallbackRegistry.invoke(fnId, args);
}

/**
 * Release a callback (global registry)
 * Used by Host's Bridge for cleanup
 */
export function releaseCallback(fnId: string): void {
  globalCallbackRegistry.release(fnId);
}

/**
 * Get callback count (global registry)
 * Used by Host for testing/debugging
 */
export function getCallbackCount(): number {
  return globalCallbackRegistry.size;
}
