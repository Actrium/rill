/**
 * Reconciler Type Definitions
 *
 * Core types for React reconciler configuration and instances.
 */

import type { HostConfig, Reconciler as ReconcilerType } from 'react-reconciler';
import type { VNode } from '../../../sdk/types';

/**
 * Root container type
 */
export interface RootContainer {
  children: VNode[];
}

/**
 * Public instance exposed to refs
 * Contains nodeId for Remote Ref mechanism
 */
export interface PublicInstance {
  nodeId: number;
}

/**
 * Reconciler instance type
 */
export type RillReconciler = ReconcilerType<
  RootContainer, // Container
  VNode, // Instance
  VNode, // TextInstance
  unknown, // SuspenseInstance
  VNode, // FormInstance
  PublicInstance // PublicInstance
>;

/**
 * Extended host config with React 19 internal methods
 * These methods are used internally by React 19 but not yet in official types
 */
export interface ExtendedHostConfig
  extends HostConfig<
    string, // Type
    Record<string, unknown>, // Props
    RootContainer, // Container
    VNode, // Instance
    VNode, // TextInstance
    unknown, // SuspenseInstance
    unknown, // HydratableInstance
    VNode, // FormInstance
    PublicInstance, // PublicInstance - exposed to refs with nodeId
    object, // HostContext
    unknown, // ChildSet
    number, // TimeoutHandle
    -1, // NoTimeout
    null // TransitionStatus
  > {
  // Priority and scheduling methods
  resolveUpdatePriority: () => number;
  setCurrentUpdatePriority: () => void;
  getCurrentUpdatePriority: () => number;

  // Suspense-related methods
  maySuspendCommit: () => boolean;
  preloadInstance: () => boolean;
  startSuspendingCommit: () => void;
  suspendInstance: () => void;
  waitForCommitToBeReady: () => null;

  // Transition context
  NotPendingTransition: null;

  // Misc methods
  requestPostPaintCallback: () => void;
  shouldAttemptEagerTransition: () => boolean;
  resolveEventType: () => null;
  resolveEventTimeStamp: () => number;
  resetFormInstance: () => void;
  trackSchedulerEvent: () => void;
}

/**
 * Helper: Get removed props between old and new props
 */
export function getRemovedProps(
  oldProps: Record<string, unknown>,
  newProps: Record<string, unknown>
): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(oldProps)) {
    if (key !== 'children' && !(key in newProps)) {
      removed.push(key);
    }
  }
  return removed;
}
