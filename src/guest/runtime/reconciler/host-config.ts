/**
 * React Reconciler Host Configuration
 *
 * Implements the host config for react-reconciler to transform
 * React render operations into serialized operations for the Host.
 */

import React from 'react';
import Reconciler from 'react-reconciler';
import { DefaultEventPriority } from 'react-reconciler/constants';
import type { SandboxGlobals } from '../../../host/sandbox/globals';
import type {
  SerializedCreateOperation,
  SerializedUpdateOperation,
  VNode,
} from '../../../sdk/types';
import type {
  CallbackRegistry,
  ReviewedUnknown,
  SendToHost,
  SerializedFunction,
  SerializedValue,
} from '../../../shared';
import { isSerializedFunction } from '../../../shared';
import { isDevToolsEnabled, type RenderTiming, sendDevToolsMessage } from './devtools';
import { serializeProps } from './guest-encoder';
import { OperationCollector } from './operation-collector';
import { nowMs } from './sandbox-compat';
import type { ExtendedHostConfig, PublicInstance, RillReconciler, RootContainer } from './types';
import { getRemovedProps } from './types';

// ============================================
// Configurable Scheduler
// ============================================

/**
 * Scheduler configuration for the reconciler.
 *
 * By default, uses globalThis.setTimeout/clearTimeout.
 * Engine can override this at runtime to use its own timer polyfills,
 * which is essential for sandbox environments (QuickJS, Mock, etc.)
 * where the reconciler needs to use the Engine-provided timers.
 */
type ScheduleTimeoutFn = (fn: (...args: unknown[]) => unknown, delay?: number) => number;
type CancelTimeoutFn = (id: number | ReturnType<typeof setTimeout>) => void;

let _scheduleTimeout: ScheduleTimeoutFn = (fn, delay) =>
  globalThis.setTimeout(fn, delay) as unknown as number;
let _cancelTimeout: CancelTimeoutFn = (id) => globalThis.clearTimeout(id);

/**
 * Configure the scheduler functions used by the reconciler.
 *
 * This should be called by Engine before any render() calls to ensure
 * effects and other scheduled work use the correct timer implementation.
 *
 * @param schedule - setTimeout replacement
 * @param cancel - clearTimeout replacement
 */
export function setReconcilerScheduler(schedule: ScheduleTimeoutFn, cancel: CancelTimeoutFn): void {
  _scheduleTimeout = schedule;
  _cancelTimeout = cancel;
}

/**
 * Reset scheduler to default (globalThis.setTimeout/clearTimeout)
 */
export function resetReconcilerScheduler(): void {
  _scheduleTimeout = (fn, delay) => globalThis.setTimeout(fn, delay) as unknown as number;
  _cancelTimeout = (id) => globalThis.clearTimeout(id);
}

// ============================================
// Create Reconciler
// ============================================

/**
 * Create custom renderer
 *
 * Note: Bridge now handles all serialization internally.
 * Reconciler sends raw props (including functions) to sendToHost,
 * which should be Bridge.sendToHost for proper serialization.
 */
export function createReconciler(
  sendToHost: SendToHost,
  callbackRegistry: CallbackRegistry
): {
  reconciler: RillReconciler;
  callbackRegistry: CallbackRegistry;
  collector: OperationCollector;
} {
  // react-reconciler is already statically imported at the top of this file

  const collector = new OperationCollector();
  let nodeIdCounter = 0;
  const pendingDeleteRoots = new Map<number, VNode>();

  // DevTools: render timing collection
  let renderTimings: RenderTiming[] = [];
  let commitStartTime = 0;

  // Sync callbackRegistry with globalThis.__rill.callbacks
  // This allows Engine.handleCallFunction() to find callbacks via __rill.invokeCallback()
  const _g = globalThis as unknown as SandboxGlobals;
  _g.__rill = _g.__rill || {};
  _g.__rill.callbacks = callbackRegistry.getMap();

  const hostConfig: ExtendedHostConfig = {
    // ============ Core Methods ============

    createInstance(type: string, props: Record<string, unknown>): VNode {
      const startTime = isDevToolsEnabled() ? nowMs() : 0;
      const id = ++nodeIdCounter;

      // Filter out children (handled separately via appendChild/appendInitialChild).
      // Avoid destructuring key/ref — React dev mode defines warning getters on
      // element.props for these special props, and reading them emits console.error.
      const { children, ...filteredProps } = props as {
        children?: ReviewedUnknown;
        [key: string]: ReviewedUnknown;
      };
      delete filteredProps.key;
      delete filteredProps.ref;

      // Serialize props using TypeRules
      // Functions are converted to { __type: 'function', __fnId }
      const serializedProps = serializeProps(filteredProps);

      // Create VNode with raw props (VNode stores original for internal use)
      const node: VNode = {
        id,
        type,
        props: filteredProps,
        children: [],
        parent: null,
      };

      // Send serialized props to Host
      // Functions are now properly serialized with fnIds
      const op: SerializedCreateOperation = {
        op: 'CREATE',
        id,
        type,
        props: serializedProps,
      };
      collector.add(op);

      // DevTools: record mount timing
      if (isDevToolsEnabled()) {
        renderTimings.push({
          nodeId: id,
          type,
          phase: 'mount',
          duration: nowMs() - startTime,
          timestamp: Date.now(),
        });
      }

      return node;
    },

    createTextInstance(text: string): VNode {
      const id = ++nodeIdCounter;
      const node: VNode = {
        id,
        type: '__TEXT__',
        props: { text },
        children: [],
        parent: null,
      };

      const op: SerializedCreateOperation = {
        op: 'CREATE',
        id,
        type: '__TEXT__',
        props: { text },
      };
      collector.add(op);
      return node;
    },

    appendChild(parent: VNode, child: VNode): void {
      parent.children.push(child);
      child.parent = parent;
      collector.add({ op: 'APPEND', id: child.id, parentId: parent.id, childId: child.id });
    },

    appendInitialChild(parent: VNode, child: VNode): void {
      parent.children.push(child);
      child.parent = parent;
      collector.add({ op: 'APPEND', id: child.id, parentId: parent.id, childId: child.id });
    },

    appendChildToContainer(container: RootContainer, child: VNode): void {
      container.children.push(child);
      // parentId=0 signals root container on the host side
      collector.add({ op: 'APPEND', id: child.id, parentId: 0, childId: child.id });
    },

    insertBefore(parent: VNode, child: VNode, beforeChild: VNode): void {
      const index = parent.children.indexOf(beforeChild);
      if (index !== -1) {
        parent.children.splice(index, 0, child);
        child.parent = parent;
        collector.add({
          op: 'INSERT',
          id: child.id,
          parentId: parent.id,
          childId: child.id,
          index,
        });
      }
    },

    insertInContainerBefore(container: RootContainer, child: VNode, beforeChild: VNode): void {
      const index = container.children.indexOf(beforeChild);
      if (index !== -1) {
        container.children.splice(index, 0, child);
        // parentId=0 signals root container on the host side
        collector.add({ op: 'INSERT', id: child.id, parentId: 0, childId: child.id, index });
      }
    },

    removeChild(parent: VNode, child: VNode): void {
      const index = parent.children.indexOf(child);
      if (index !== -1) {
        parent.children.splice(index, 1);
        child.parent = null;
        collector.add({ op: 'REMOVE', id: child.id, parentId: parent.id, childId: child.id });

        // Store deleted root for cleanup after commit
        pendingDeleteRoots.set(child.id, child);
      }
    },

    removeChildFromContainer(container: RootContainer, child: VNode): void {
      const index = container.children.indexOf(child);
      if (index !== -1) {
        container.children.splice(index, 1);
        // parentId=0 signals root container on the host side
        collector.add({ op: 'REMOVE', id: child.id, parentId: 0, childId: child.id });

        // Store deleted root for cleanup after commit
        pendingDeleteRoots.set(child.id, child);
      }
    },

    // React 18/19 compatibility for commitUpdate signature
    // - React 18: commitUpdate(instance, updatePayload, type, prevProps, nextProps, internalHandle)
    // - React 19: commitUpdate(instance, type, prevProps, nextProps, internalHandle)
    // Reason: Parameter types differ between React 18/19, determined at runtime
    commitUpdate(
      instance: VNode,
      updatePayloadOrType: unknown,
      typeOrPrevProps: unknown,
      prevPropsOrNextProps: unknown,
      nextPropsOrInternalHandle: unknown,
      _internalHandleMaybe?: unknown
    ): void {
      const startTime = isDevToolsEnabled() ? nowMs() : 0;

      const isReact19 = typeof updatePayloadOrType === 'string';
      const type = isReact19 ? (updatePayloadOrType as string) : (typeOrPrevProps as string);
      const oldProps = isReact19
        ? (typeOrPrevProps as Record<string, unknown>)
        : (prevPropsOrNextProps as Record<string, unknown>);
      const newProps = isReact19
        ? (prevPropsOrNextProps as Record<string, unknown>)
        : (nextPropsOrInternalHandle as Record<string, unknown>);

      // Filter out children.
      // Avoid destructuring key/ref — React dev mode warning getters (see createInstance).
      const { children, ...filteredProps } = newProps as {
        children?: ReviewedUnknown;
        [key: string]: ReviewedUnknown;
      };
      delete filteredProps.key;
      delete filteredProps.ref;

      // Serialize props using TypeRules
      // Functions are converted to { __type: 'function', __fnId }
      const serializedProps = serializeProps(filteredProps);

      // Update VNode with raw props (VNode stores original for internal use)
      instance.props = filteredProps;

      const removedProps = getRemovedProps(oldProps, newProps);

      const op: SerializedUpdateOperation = {
        op: 'UPDATE',
        id: instance.id,
        props: serializedProps,
        removedProps,
      };
      collector.add(op);

      // DevTools: record update timing
      if (isDevToolsEnabled()) {
        renderTimings.push({
          nodeId: instance.id,
          type,
          phase: 'update',
          duration: nowMs() - startTime,
          timestamp: Date.now(),
        });
      }
    },

    commitTextUpdate(textInstance: VNode, _oldText: string, newText: string): void {
      textInstance.props = { text: newText };
      const op: SerializedUpdateOperation = {
        op: 'UPDATE',
        id: textInstance.id,
        props: { text: newText },
        removedProps: [],
      };
      collector.add(op);
    },

    // ============ Container Methods ============

    getRootHostContext(): object {
      return {};
    },

    getChildHostContext(parentContext: object): object {
      return parentContext;
    },

    getPublicInstance(instance: VNode): PublicInstance {
      return { nodeId: instance.id };
    },

    prepareForCommit(): null {
      commitStartTime = isDevToolsEnabled() ? nowMs() : 0;
      renderTimings = [];
      return null;
    },

    resetAfterCommit(): void {
      // Send DELETE operations for removed nodes (before flush)
      // This ensures Host's Receiver removes nodes from nodeMap
      for (const node of pendingDeleteRoots.values()) {
        collectDeleteOperations(node, collector);
      }

      collector.flush(sendToHost);

      // Clean up callbacks for deleted nodes after commit
      for (const node of pendingDeleteRoots.values()) {
        cleanupNodeCallbacks(node, callbackRegistry);
      }
      pendingDeleteRoots.clear();

      // Send DevTools timing data
      if (isDevToolsEnabled() && renderTimings.length > 0) {
        const commitDuration = nowMs() - commitStartTime;
        sendDevToolsMessage('RILL_RENDER_TIMINGS', {
          timings: renderTimings,
          commitDuration,
          totalNodes: renderTimings.length,
        });
      }
    },

    clearContainer(container: RootContainer): void {
      container.children = [];
    },

    preparePortalMount(): void {
      // No-op
    },

    finalizeInitialChildren(): boolean {
      return false;
    },

    shouldSetTextContent(): boolean {
      return false;
    },

    // ============ Configuration ============

    supportsMutation: true,
    supportsHydration: false,
    supportsPersistence: false,
    isPrimaryRenderer: true,

    // ============ Scheduling ============
    // Use configurable scheduler to support runtime polyfills.
    // Engine calls setReconcilerScheduler() to inject its timer functions.
    scheduleTimeout: (fn: (...args: unknown[]) => unknown, delay?: number) =>
      _scheduleTimeout(fn, delay),
    cancelTimeout: (id: number | ReturnType<typeof setTimeout>) => _cancelTimeout(id),
    noTimeout: -1,

    getInstanceFromNode(): null {
      return null;
    },

    beforeActiveInstanceBlur(): void {
      // No-op
    },

    afterActiveInstanceBlur(): void {
      // No-op
    },

    prepareScopeUpdate(): void {
      // No-op
    },

    getInstanceFromScope(): null {
      return null;
    },

    detachDeletedInstance(): void {
      // No-op
    },

    // ============ React 19 Methods ============

    resolveUpdatePriority(): number {
      return DefaultEventPriority;
    },

    setCurrentUpdatePriority(): void {
      // No-op
    },

    getCurrentUpdatePriority(): number {
      return DefaultEventPriority;
    },

    maySuspendCommit(): boolean {
      return false;
    },

    preloadInstance(): boolean {
      return false;
    },

    startSuspendingCommit(): void {
      // No-op
    },

    suspendInstance(): void {
      // No-op
    },

    waitForCommitToBeReady(): null {
      return null;
    },

    NotPendingTransition: null,
    // biome-ignore lint/suspicious/noExplicitAny: React transition context requires any for type compatibility
    HostTransitionContext: React.createContext(null) as any,

    requestPostPaintCallback(): void {
      // No-op
    },

    shouldAttemptEagerTransition(): boolean {
      return false;
    },

    resolveEventType(): null {
      return null;
    },

    resolveEventTimeStamp(): number {
      return Date.now();
    },

    resetFormInstance(): void {
      // No-op
    },

    trackSchedulerEvent(): void {
      // No-op
    },
  };

  const reconciler = Reconciler(hostConfig);

  return { reconciler, callbackRegistry, collector };
}

// ============================================
// Cleanup Helpers
// ============================================

/**
 * Recursively collect DELETE operations for node and its children
 *
 * DELETE operations tell Host's Receiver to remove nodes from nodeMap.
 * Children are deleted first (depth-first) to ensure proper cleanup order.
 */
function collectDeleteOperations(node: VNode, collector: OperationCollector): void {
  // Delete children first (depth-first)
  if (node.children) {
    for (const child of node.children) {
      collectDeleteOperations(child, collector);
    }
  }

  // Then delete this node
  collector.add({ op: 'DELETE', id: node.id });
}

/**
 * Recursively clean up callbacks for node and its children
 *
 * This cleans up Guest-side callbacks (globalCallbackRegistry).
 * Host-side cleanup is handled by Receiver with reference counting.
 */
function cleanupNodeCallbacks(node: VNode, registry: CallbackRegistry): void {
  // Release function references for this node
  // Uses centralized isSerializedFunction type guard from TypeRules
  if (node.props) {
    for (const value of Object.values(node.props)) {
      if (isSerializedFunction(value as SerializedValue)) {
        const fnId = (value as SerializedFunction).__fnId;
        if (registry.has(fnId)) {
          registry.release(fnId);
        }
      }
    }
  }

  // Recursively clean up children
  if (node.children) {
    for (const child of node.children) {
      cleanupNodeCallbacks(child, registry);
    }
  }
}
