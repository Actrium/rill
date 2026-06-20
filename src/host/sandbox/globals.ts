/**
 * Sandbox Global Type Definitions
 *
 * Centralized type definitions for globals available in the sandbox environment.
 * These are injected by the Engine into the Guest context.
 */

import type { HostMessage, ReviewedUnknown, SendToHost } from '../types';

/**
 * RillReconciler interface - the Guest-side reconciler API
 * Injected into sandbox as a global via GUEST_BUNDLE_CODE
 */
export interface RillReconcilerGlobal {
  render: (element: ReviewedUnknown, sendToHost: SendToHost) => void;
  unmount: (sendToHost?: SendToHost) => void;
  unmountAll: () => void;
  invokeCallback?: (fnId: string, args: ReviewedUnknown[]) => ReviewedUnknown;
  releaseCallback?: (fnId: string) => void;
  registerComponentType?: (fn: ReviewedUnknown, engineId?: string) => string | null;
  unregisterComponentTypes?: (ownerId: string) => void;
  getCallbackCount?: () => number;
}

/**
 * Rill hooks state - used for useState/useEffect tracking
 */
export interface RillHooksState {
  index: number;
  rootElement?: ReviewedUnknown;
  sendToHost?: SendToHost;
}

export type RillEventCallback = (payload: ReviewedUnknown) => void;

export type RillOnHostEvent = (eventName: string, callback: RillEventCallback) => () => void;

/**
 * Type-safe accessor for sandbox globals
 * Use this instead of `as any` when accessing sandbox context
 */
export interface SandboxGlobals {
  RillReconciler?: RillReconcilerGlobal;
  __rillHooks?: RillHooksState;
  __REACT_SHIM__?: boolean;
  __rill?: {
    callbacks?: Map<string, (...args: ReviewedUnknown[]) => ReviewedUnknown>;
    callbackId?: number;
    registerCallback?: (fn: (...args: ReviewedUnknown[]) => ReviewedUnknown) => string;
    invokeCallback?: (fnId: string, args: ReviewedUnknown[]) => ReviewedUnknown;
    removeCallback?: (id: string) => void;
    config?: Record<string, ReviewedUnknown>;
    eventListeners?: Map<string, Set<RillEventCallback>>;
    dispatchEvent?: (eventName: string, payload: ReviewedUnknown) => void;
    guest?: ReviewedUnknown;
  };
  __rill_emitEvent?: (eventName: string, payload?: ReviewedUnknown) => void;
  __rill_onHostEvent?: RillOnHostEvent;
  __rill_getConfig?: () => Record<string, ReviewedUnknown>;
  __rill_sendBatch?: SendToHost;
  __rill_sendOperation?: (op: ReviewedUnknown) => void;
  __rill_handleMessage?: (message: HostMessage) => void;
  __rill_scheduleRender?: () => void;
  __rill_registerComponentType?: (fn: ReviewedUnknown) => string | null;
  __RILL_GUEST_ENV__?: boolean;
  __RILL_DEBUG__?: boolean;
  __RILL_DEVTOOLS_ENABLED__?: boolean;
  React?: ReviewedUnknown;
  ReactJSXRuntime?: ReviewedUnknown;
}

/**
 * Helper to safely get a sandbox global with proper typing
 */
export function getSandboxGlobal<K extends keyof SandboxGlobals>(
  context: { extract: (name: string) => ReviewedUnknown } | null | undefined,
  key: K
): SandboxGlobals[K] {
  return context?.extract(key) as SandboxGlobals[K];
}
