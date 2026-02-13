/**
 * Instruction Receiver
 *
 * Parses operation instructions from sandbox and builds React Native component tree
 */

import React from 'react';
import type { ComponentRegistry } from '../registry';
import {
  type BridgeValue,
  HostMsg,
  type NodeInstance,
  type Operation,
  type OperationBatch,
  type OperationType,
  type RefCallOperation,
  type ReviewedUnknown,
  type SerializedError,
  type SerializedFunction,
} from '../types';
import { AttributionTracker } from './stats';
import {
  type ReceiverApplyStats,
  type ReceiverCallbackRegistry,
  type ReceiverOptions,
  type ReceiverStats,
  type SendToSandbox,
  safeQueueMicrotask,
} from './types';

/**
 * Receiver
 *
 * Note: With the new Bridge architecture, props are already decoded
 * when received via applyBatch(). No additional deserialization needed.
 */
export class Receiver {
  private attributionTracker: AttributionTracker;
  private nodeMap = new Map<number, NodeInstance>();
  private rootChildren: number[] = [];
  // O(1) lookup index for rootChildren (Set mirrors array for fast has/delete)
  private rootChildrenSet = new Set<number>();
  // O(1) lookup index for node children (nodeId -> Set of childIds)
  private nodeChildrenSet = new Map<number, Set<number>>();
  // Reverse index: childId -> parentId (0 means root). Keeps DELETE/REMOVE O(1).
  private parentByChildId = new Map<number, number>();
  // Remote Ref ： ID → React ref
  private refMap = new Map<number, React.RefObject<ReviewedUnknown>>();
  private registry: ComponentRegistry;
  private callbackRegistry?: ReceiverCallbackRegistry;
  private releaseCallback?: (fnId: string) => void;
  private sendToSandbox: SendToSandbox;
  private onUpdate: () => void;
  private updateScheduled = false;
  private renderCount = 0;
  private lastRenderAt: number | null = null;
  private lastRenderDurationMs: number | null = null;
  private lastApply: ReceiverApplyStats | null = null;
  private totalBatches = 0;
  private totalOpsReceived = 0;
  private totalOpsApplied = 0;
  private totalOpsSkipped = 0;
  private totalOpsFailed = 0;
  private opts: {
    onMetric?: (name: string, value: number, extra?: Record<string, unknown>) => void;
    maxBatchSize: number;
    debug: boolean;
  };

  // Debug tracking (bounded, per-receiver to avoid polluting host globals)
  private debugAppendCalls = 0;
  private debugAppendParentIds: number[] = [];
  private debugAppendDetails: Array<{ parentId: number; childId: number; parentExists: boolean }> =
    [];
  private static readonly DEBUG_APPEND_TRACK_LIMIT = 1000;

  //  -
  private readonly operationHandlers: Record<
    OperationType,
    (op: Extract<Operation, { op: OperationType }>) => void
  >;

  constructor(
    registry: ComponentRegistry,
    sendToSandbox: SendToSandbox,
    onUpdate: () => void,
    options?: ReceiverOptions
  ) {
    this.attributionTracker = new AttributionTracker(
      options?.attributionWindowMs ?? 5000,
      options?.attributionHistoryMs ?? 60_000,
      options?.attributionMaxSamples ?? 200
    );

    this.registry = registry;
    this.callbackRegistry = options?.callbackRegistry;
    this.releaseCallback = options?.releaseCallback;
    this.sendToSandbox = sendToSandbox;
    this.onUpdate = onUpdate;
    this.opts = {
      onMetric: options?.onMetric,
      maxBatchSize: options?.maxBatchSize ?? 5000,
      debug: options?.debug ?? false,
    };

    //
    //  satisfies  OperationType
    this.operationHandlers = {
      CREATE: (op) => this.handleCreate(op as Extract<Operation, { op: 'CREATE' }>),
      UPDATE: (op) => this.handleUpdate(op as Extract<Operation, { op: 'UPDATE' }>),
      APPEND: (op) => this.handleAppend(op as Extract<Operation, { op: 'APPEND' }>),
      INSERT: (op) => this.handleInsert(op as Extract<Operation, { op: 'INSERT' }>),
      REMOVE: (op) => this.handleRemove(op as Extract<Operation, { op: 'REMOVE' }>),
      DELETE: (op) => this.handleDelete(op as Extract<Operation, { op: 'DELETE' }>),
      REORDER: (op) => this.handleReorder(op as Extract<Operation, { op: 'REORDER' }>),
      TEXT: (op) => this.handleText(op as Extract<Operation, { op: 'TEXT' }>),
      REF_CALL: (op) => this.handleRefCall(op as RefCallOperation),
    } satisfies Record<OperationType, (op: Operation) => void>;
  }

  // Reason: Debug logger accepts arbitrary arguments
  private log(...args: unknown[]): void {
    if (this.opts.debug) {
      console.log('[rill:Receiver]', ...args);
    }
  }

  /**
   * Release a callback - routes to releaseCallback or falls back to callbackRegistry
   */
  private doReleaseCallback(fnId: string): void {
    if (this.releaseCallback) {
      this.releaseCallback(fnId);
    } else if (this.callbackRegistry) {
      this.callbackRegistry.release(fnId);
    }
  }

  /**
   * Apply operation batch
   */
  applyBatch(batch: OperationBatch): ReceiverApplyStats {
    const start = Date.now();
    const nodesBefore = this.nodeMap.size;
    const limit = this.opts.maxBatchSize;
    let applied = 0;
    let skipped = 0;
    let failed = 0;

    const opCounts: Record<string, number> = {};
    const skippedOpCounts: Record<string, number> = {};
    const nodeTypeCounts = new Map<string, number>();
    const skippedNodeTypeCounts = new Map<string, number>();

    const incRecord = (rec: Record<string, number>, key: string, n = 1) => {
      rec[key] = (rec[key] ?? 0) + n;
    };
    const incMap = (m: Map<string, number>, key: string, n = 1) => {
      m.set(key, (m.get(key) ?? 0) + n);
    };
    const getTouchedTypes = (op: Operation): string[] => {
      switch (op.op) {
        case 'CREATE':
          return [op.type];
        case 'UPDATE':
        case 'DELETE':
        case 'TEXT': {
          const t = this.nodeMap.get(op.id)?.type;
          return t ? [t] : [];
        }
        case 'APPEND':
        case 'INSERT':
        case 'REMOVE': {
          const types: string[] = [];
          if (op.parentId !== 0) {
            const pt = this.nodeMap.get(op.parentId)?.type;
            if (pt) types.push(pt);
          }
          const ct = this.nodeMap.get(op.childId)?.type;
          if (ct) types.push(ct);
          return types;
        }
        case 'REORDER': {
          if (op.parentId === 0) return [];
          const pt = this.nodeMap.get(op.parentId)?.type;
          return pt ? [pt] : [];
        }
        default:
          return [];
      }
    };
    const topN = (m: Map<string, number>, n: number) =>
      Array.from(m.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([type, ops]) => ({ type, ops }));

    for (let i = 0; i < batch.operations.length; i++) {
      if (applied >= limit) {
        // Record skipped op distribution and attribution (for backpressure diagnosis)
        for (let j = i; j < batch.operations.length; j++) {
          const op = batch.operations[j];
          if (!op) continue;
          incRecord(skippedOpCounts, op.op);
          for (const t of getTouchedTypes(op)) incMap(skippedNodeTypeCounts, t);
        }
        skipped += batch.operations.length - i;
        break;
      }
      const op = batch.operations[i];
      if (!op) continue;
      try {
        const touchedTypes = getTouchedTypes(op);
        this.applyOperation(op);
        applied++;
        incRecord(opCounts, op.op);
        for (const t of touchedTypes) incMap(nodeTypeCounts, t);
      } catch (_e) {
        failed++;
        // continue applying remaining operations
      }
    }
    this.opts.onMetric?.('receiver.applyBatch', Date.now() - start, {
      applied,
      skipped,
      failed,
      total: batch.operations.length,
    });

    const durationMs = Date.now() - start;
    this.totalBatches += 1;
    this.totalOpsReceived += batch.operations.length;
    this.totalOpsApplied += applied;
    this.totalOpsSkipped += skipped;
    this.totalOpsFailed += failed;
    const nodesAfter = this.nodeMap.size;
    const nodeDelta = nodesAfter - nodesBefore;
    const applyStats: ReceiverApplyStats = {
      batchId: batch.batchId,
      total: batch.operations.length,
      applied,
      skipped,
      failed,
      at: Date.now(),
      durationMs,
      nodesBefore,
      nodesAfter,
      nodeDelta,
      opCounts,
      skippedOpCounts,
      topNodeTypes: topN(nodeTypeCounts, 6),
      topNodeTypesSkipped: topN(skippedNodeTypeCounts, 6),
    };
    this.lastApply = applyStats;
    this.attributionTracker.recordSample(applyStats);

    if (skipped > 0) {
      // Inform guest about backpressure/skip to allow adaptive throttling upstream
      try {
        this.sendToSandbox({
          type: HostMsg.HOST_EVENT,
          eventName: 'RECEIVER_BACKPRESSURE',
          payload: { batchId: batch.batchId, skipped, applied, total: batch.operations.length },
        });
      } catch {
        // Silently ignore errors when sending backpressure notifications
      }
    }

    this.scheduleUpdate();
    return applyStats;
  }

  /**
   * Schedule update (debounced)
   */
  private scheduleUpdate(): void {
    if (this.updateScheduled) return;
    this.updateScheduled = true;

    // Use microtask to ensure batch operations complete before updating
    safeQueueMicrotask(() => {
      this.updateScheduled = false;
      this.log('calling onUpdate, rootChildren:', this.rootChildren.length);
      this.onUpdate();
      this.log('onUpdate completed');
    });
  }

  /**
   * Apply single operation
   */
  private applyOperation(op: Operation): void {
    if (this.opts.onMetric) {
      this.opts.onMetric('receiver.operation', 0, { op: op.op, id: op.id });
    }
    // Add detailed logging for operations
    if (op.op === 'APPEND') {
      this.log(`Applying APPEND: childId=${op.childId}, parentId=${op.parentId}`);
    } else if (op.op === 'INSERT') {
      this.log(
        `Applying INSERT: childId=${op.childId}, parentId=${op.parentId}, index=${op.index}`
      );
    } else if (op.op === 'CREATE') {
      this.log(`Applying CREATE: id=${op.id}, type=${op.type}`);
    }

    //
    // satisfies  OperationType，
    const handler = this.operationHandlers[op.op];
    handler(op);
  }

  /**
   * Handle create operation
   */
  private handleCreate(op: Extract<Operation, { op: 'CREATE' }>): void {
    // Extract fnIds from operation metadata (attached by Bridge)
    const fnIds = (op as Operation & { _fnIds?: Set<string> })._fnIds;

    const node: NodeInstance = {
      id: op.id,
      type: op.type,
      props: op.props,
      children: [],
      registeredFnIds: fnIds ? new Set(fnIds) : undefined,
    };
    this.nodeMap.set(op.id, node);
    // Initialize O(1) children lookup Set
    this.nodeChildrenSet.set(op.id, new Set());
  }

  /**
   * Handle update operation
   */
  private handleUpdate(op: Extract<Operation, { op: 'UPDATE' }>): void {
    const node = this.nodeMap.get(op.id);
    if (!node) {
      console.warn(`[rill] Protocol violation: Node ${op.id} not found for update`);
      // Throw to increment failed operation count in applyBatch
      throw new Error(`Node ${op.id} not found for update`);
    }

    // Release old function references
    if (node.registeredFnIds) {
      for (const fnId of node.registeredFnIds) {
        this.doReleaseCallback(fnId);
      }
      node.registeredFnIds = undefined;
    }

    // Merge new properties
    const newProps = op.props;
    node.props = { ...node.props, ...newProps };

    // Remove deleted properties
    if (op.removedProps) {
      for (const key of op.removedProps) {
        delete node.props[key];
      }
    }

    // Track new function references
    const fnIds = (op as Operation & { _fnIds?: Set<string> })._fnIds;
    if (fnIds && fnIds.size > 0) {
      node.registeredFnIds = new Set(fnIds);
    }
  }

  /**
   * Handle append operation
   */
  private handleAppend(op: Extract<Operation, { op: 'APPEND' }>): void {
    if (this.opts.debug) {
      this.debugAppendCalls++;

      this.debugAppendParentIds.push(op.parentId);
      if (this.debugAppendParentIds.length > Receiver.DEBUG_APPEND_TRACK_LIMIT) {
        this.debugAppendParentIds.splice(
          0,
          this.debugAppendParentIds.length - Receiver.DEBUG_APPEND_TRACK_LIMIT
        );
      }

      this.debugAppendDetails.push({
        parentId: op.parentId,
        childId: op.childId,
        parentExists: this.nodeMap.has(op.parentId),
      });
      if (this.debugAppendDetails.length > Receiver.DEBUG_APPEND_TRACK_LIMIT) {
        this.debugAppendDetails.splice(
          0,
          this.debugAppendDetails.length - Receiver.DEBUG_APPEND_TRACK_LIMIT
        );
      }
    }

    if (op.parentId === 0) {
      // Append to root container - O(1) check with Set
      if (!this.rootChildrenSet.has(op.childId)) {
        this.rootChildren.push(op.childId);
        this.rootChildrenSet.add(op.childId);
      }
    } else {
      const parent = this.nodeMap.get(op.parentId);
      const childrenSet = this.nodeChildrenSet.get(op.parentId);
      if (parent && childrenSet && !childrenSet.has(op.childId)) {
        parent.children.push(op.childId);
        childrenSet.add(op.childId);
      }
    }

    // Update reverse parent index (tree assumption: single parent)
    this.parentByChildId.set(op.childId, op.parentId);
  }

  /**
   * Handle insert operation
   */
  private handleInsert(op: Extract<Operation, { op: 'INSERT' }>): void {
    if (op.parentId === 0) {
      // Insert into root container - O(1) check with Set
      if (this.rootChildrenSet.has(op.childId)) {
        // Remove from current position (need indexOf here, but only when exists)
        const existingIndex = this.rootChildren.indexOf(op.childId);
        if (existingIndex !== -1) {
          this.rootChildren.splice(existingIndex, 1);
        }
      } else {
        this.rootChildrenSet.add(op.childId);
      }
      this.rootChildren.splice(op.index, 0, op.childId);
    } else {
      const parent = this.nodeMap.get(op.parentId);
      const childrenSet = this.nodeChildrenSet.get(op.parentId);
      if (parent && childrenSet) {
        if (childrenSet.has(op.childId)) {
          // Remove from current position (need indexOf here, but only when exists)
          const existingIndex = parent.children.indexOf(op.childId);
          if (existingIndex !== -1) {
            parent.children.splice(existingIndex, 1);
          }
        } else {
          childrenSet.add(op.childId);
        }
        parent.children.splice(op.index, 0, op.childId);
      }
    }

    this.parentByChildId.set(op.childId, op.parentId);
  }

  /**
   * Handle remove operation
   */
  private handleRemove(op: Extract<Operation, { op: 'REMOVE' }>): void {
    if (op.parentId === 0) {
      // O(1) check before O(n) indexOf
      if (this.rootChildrenSet.has(op.childId)) {
        const index = this.rootChildren.indexOf(op.childId);
        if (index !== -1) {
          this.rootChildren.splice(index, 1);
        }
        this.rootChildrenSet.delete(op.childId);
      }
    } else {
      const parent = this.nodeMap.get(op.parentId);
      const childrenSet = this.nodeChildrenSet.get(op.parentId);
      if (parent && childrenSet && childrenSet.has(op.childId)) {
        const index = parent.children.indexOf(op.childId);
        if (index !== -1) {
          parent.children.splice(index, 1);
        }
        childrenSet.delete(op.childId);
      }
    }

    // Only clear if it points to this parent (avoid stomping if moved concurrently)
    if (this.parentByChildId.get(op.childId) === op.parentId) {
      this.parentByChildId.delete(op.childId);
    }
  }

  /**
   * Handle delete operation
   */
  private handleDelete(op: Extract<Operation, { op: 'DELETE' }>): void {
    // Best-effort: detach from root/parents to avoid stale references.
    // Protocol-wise, callers SHOULD send REMOVE before DELETE, but we keep Receiver resilient.

    const parentId = this.parentByChildId.get(op.id);
    if (parentId === 0) {
      if (this.rootChildrenSet.has(op.id)) {
        const rootIndex = this.rootChildren.indexOf(op.id);
        if (rootIndex !== -1) this.rootChildren.splice(rootIndex, 1);
        this.rootChildrenSet.delete(op.id);
      }
      this.parentByChildId.delete(op.id);
    } else if (typeof parentId === 'number') {
      const parent = this.nodeMap.get(parentId);
      const childrenSet = this.nodeChildrenSet.get(parentId);
      if (parent && childrenSet && childrenSet.has(op.id)) {
        const idx = parent.children.indexOf(op.id);
        if (idx !== -1) parent.children.splice(idx, 1);
        childrenSet.delete(op.id);
      }
      this.parentByChildId.delete(op.id);
    } else {
      // Fallback (protocol violation): scan all parents using Set for O(1) check
      if (this.rootChildrenSet.has(op.id)) {
        const rootIndex = this.rootChildren.indexOf(op.id);
        if (rootIndex !== -1) {
          this.rootChildren.splice(rootIndex, 1);
        }
        this.rootChildrenSet.delete(op.id);
      }
      // Only scan nodes that might contain this child
      for (const [nodeId, childrenSet] of this.nodeChildrenSet) {
        if (childrenSet.has(op.id)) {
          const node = this.nodeMap.get(nodeId);
          if (node) {
            const idx = node.children.indexOf(op.id);
            if (idx !== -1) node.children.splice(idx, 1);
          }
          childrenSet.delete(op.id);
          break; // Tree: single parent, can stop after finding
        }
      }
      this.parentByChildId.delete(op.id);
    }

    this.deleteNodeRecursive(op.id);
  }

  /**
   * Recursively delete node
   */
  private deleteNodeRecursive(id: number): void {
    const node = this.nodeMap.get(id);
    if (!node) return;

    // Recursively delete children
    for (const childId of node.children) {
      // Keep reverse index consistent
      if (this.parentByChildId.get(childId) === id) {
        this.parentByChildId.delete(childId);
      }
      this.deleteNodeRecursive(childId);
    }

    // Release function references for this node
    if (node.registeredFnIds) {
      for (const fnId of node.registeredFnIds) {
        this.doReleaseCallback(fnId);
      }
    }

    //  Remote Ref
    this.refMap.delete(id);
    // Clean up O(1) children lookup Set
    this.nodeChildrenSet.delete(id);

    this.nodeMap.delete(id);
  }

  /**
   * Handle reorder operation
   */
  private handleReorder(op: Extract<Operation, { op: 'REORDER' }>): void {
    if (op.parentId === 0) {
      const prev = this.rootChildren;
      this.rootChildren = op.childIds;

      // Update reverse index for root children; clear entries that used to belong to root
      const nextSet = new Set(op.childIds);
      for (const childId of prev) {
        if (!nextSet.has(childId) && this.parentByChildId.get(childId) === 0) {
          this.parentByChildId.delete(childId);
        }
      }
      for (const childId of op.childIds) {
        this.parentByChildId.set(childId, 0);
      }
      // Update O(1) lookup Set
      this.rootChildrenSet = nextSet;
    } else {
      const parent = this.nodeMap.get(op.parentId);
      if (parent) {
        const prev = parent.children;
        parent.children = op.childIds;

        const nextSet = new Set(op.childIds);
        for (const childId of prev) {
          if (!nextSet.has(childId) && this.parentByChildId.get(childId) === op.parentId) {
            this.parentByChildId.delete(childId);
          }
        }
        for (const childId of op.childIds) {
          this.parentByChildId.set(childId, op.parentId);
        }
        // Update O(1) lookup Set
        this.nodeChildrenSet.set(op.parentId, nextSet);
      }
    }
  }

  /**
   * Handle text update operation
   */
  private handleText(op: Extract<Operation, { op: 'TEXT' }>): void {
    const node = this.nodeMap.get(op.id);
    if (node) {
      node.props.text = op.text;
    }
  }

  /**
   * Handle remote ref method call
   * Guest  Host （ focus, blur, scrollTo）
   */
  private handleRefCall(op: RefCallOperation): void {
    const { refId, method, args, callId } = op;

    // ，
    (async () => {
      try {
        //  ref
        const ref = this.refMap.get(refId);
        if (!ref?.current) {
          throw new Error(`Node ${refId} not mounted or has no ref`);
        }

        const instance = ref.current as Record<string, unknown>;

        //
        if (typeof instance[method] !== 'function') {
          throw new Error(`Method "${method}" not found on node ${refId}`);
        }

        // （ Promise）
        const fn = instance[method];
        // Reason: Remote Ref target method signature is runtime-defined by host component instances
        const result = await (fn as (...a: BridgeValue[]) => BridgeValue | Promise<BridgeValue>)(
          ...args
        );

        //
        // Cast result to BridgeValue - method return types are serializable values
        await this.sendToSandbox({
          type: HostMsg.REF_METHOD_RESULT,
          refId,
          callId,
          result: result as BridgeValue,
        });
      } catch (error) {
        //
        const err = error instanceof Error ? error : new Error(String(error));
        const serializedError: SerializedError = {
          __type: 'error',
          __name: err.name,
          __message: err.message,
          __stack: err.stack,
        };
        await this.sendToSandbox({
          type: HostMsg.REF_METHOD_RESULT,
          refId,
          callId,
          error: serializedError,
        });
      }
    })();
  }

  /**
   * Render component tree
   */
  render(): React.ReactElement | string | null {
    const t0 = Date.now();
    this.renderCount += 1;
    this.log(
      'render() called, rootChildren:',
      this.rootChildren.length,
      'nodeMap:',
      this.nodeMap.size
    );
    if (this.rootChildren.length === 0) {
      this.log('render() returning null (no root children)');
      const durationMs = Date.now() - t0;
      this.lastRenderAt = Date.now();
      this.lastRenderDurationMs = durationMs;
      this.opts.onMetric?.('receiver.render', durationMs, { nodeCount: this.nodeMap.size });
      return null;
    }

    // If only one root node, render directly
    const firstChild = this.rootChildren[0];
    if (this.rootChildren.length === 1 && firstChild) {
      const el = this.renderNode(firstChild);
      let elType: string = typeof el;
      if (el && typeof el === 'object' && 'type' in el) {
        const elTypeProp = el.type as unknown;
        if (elTypeProp && typeof elTypeProp === 'object' && 'name' in elTypeProp) {
          // Reason: Component name field type unknown until runtime check
          const nameVal = (elTypeProp as { name: unknown }).name;
          if (typeof nameVal === 'string') {
            elType = nameVal;
          }
        }
      }
      this.log('render() returning single element, type:', elType);
      const durationMs = Date.now() - t0;
      this.lastRenderAt = Date.now();
      this.lastRenderDurationMs = durationMs;
      this.opts.onMetric?.('receiver.render', durationMs, { nodeCount: this.nodeMap.size });
      return el;
    }

    // Multiple root nodes, wrap in Fragment
    const el = React.createElement(
      React.Fragment,
      null,
      ...this.rootChildren.map((id) => this.renderNode(id))
    );
    this.log('render() returning Fragment with', this.rootChildren.length, 'children');
    const durationMs = Date.now() - t0;
    this.lastRenderAt = Date.now();
    this.lastRenderDurationMs = durationMs;
    this.opts.onMetric?.('receiver.render', durationMs, { nodeCount: this.nodeMap.size });
    return el;
  }

  /**
   * Render single node
   *
   * Note: With the new Bridge architecture, props are already decoded.
   * No deserialization needed - functions are already callable proxies.
   */
  private renderNode(id: number): React.ReactElement | string | null {
    const node = this.nodeMap.get(id);
    if (!node) {
      console.warn(`[rill] Node ${id} not found`);
      return null;
    }

    // Handle text node
    if (node.type === '__TEXT__') {
      // React Native  Text ，
      // Reason: React module structure unknown, Text component may or may not exist
      const TextComponent =
        this.registry.get('Text') ?? (React as unknown as { Text?: unknown }).Text;
      if (!TextComponent) {
        console.error('[rill] Text component not registered; cannot render text node');
        return null;
      }
      return React.createElement(
        TextComponent as React.ComponentType,
        { key: `rill-text-${id}` },
        node.props.text as string
      );
    }

    // Get component implementation
    const Component = this.registry.get(node.type);
    if (!Component) {
      console.warn(`[rill] Component "${node.type}" not registered`);
      return null;
    }

    // Recursively render children
    const children = node.children
      .map((childId) => this.renderNode(childId))
      .filter((child): child is React.ReactElement | string => child !== null);

    //  ref（ Remote Ref ）
    let nodeRef = this.refMap.get(id);
    if (!nodeRef) {
      nodeRef = React.createRef<ReviewedUnknown>();
      this.refMap.set(id, nodeRef);
    }

    // Props are already decoded by Bridge - use directly
    // Filter out 'key' and 'ref' from node.props - these are React internals
    // that should not be passed to the underlying component
    const { key: _key, ref: _ref, ...filteredProps } = node.props;
    const props: Record<string, unknown> = {
      ...filteredProps,
      key: `rill-${id}`,
      ref: nodeRef, //  ref  Remote Ref
    };

    return React.createElement(Component, props, ...children);
  }

  /**
   * Get node count
   */
  get nodeCount(): number {
    return this.nodeMap.size;
  }

  /**
   * Clear all nodes
   */
  clear(): void {
    this.nodeMap.clear();
    this.rootChildren = [];
    this.rootChildrenSet.clear();
    this.nodeChildrenSet.clear();
    this.parentByChildId.clear();
    this.refMap.clear();
  }

  getStats(): ReceiverStats {
    return {
      nodeCount: this.nodeMap.size,
      rootChildrenCount: this.rootChildren.length,
      renderCount: this.renderCount,
      lastRenderAt: this.lastRenderAt,
      lastRenderDurationMs: this.lastRenderDurationMs,
      totalBatches: this.totalBatches,
      totalOps: {
        received: this.totalOpsReceived,
        applied: this.totalOpsApplied,
        skipped: this.totalOpsSkipped,
        failed: this.totalOpsFailed,
      },
      lastApply: this.lastApply,
      attribution: this.attributionTracker.computeWindow(Date.now()),
    };
  }

  /**
   * Get debug info
   */
  getDebugInfo(): {
    nodeCount: number;
    rootChildren: number[];
    nodes: Array<{ id: number; type: string; childCount: number }>;
    appendCalls?: number;
    appendParentIds?: number[];
    appendSample?: Array<{ parentId: number; childId: number; parentExists: boolean }>;
  } {
    return {
      nodeCount: this.nodeMap.size,
      rootChildren: [...this.rootChildren],
      nodes: Array.from(this.nodeMap.values()).map((node) => ({
        id: node.id,
        type: node.type,
        childCount: node.children.length,
      })),
      // Include APPEND tracking data (debug-only)
      appendCalls: this.opts.debug ? this.debugAppendCalls : undefined,
      appendParentIds: this.opts.debug ? [...this.debugAppendParentIds] : undefined,
      appendSample: this.opts.debug ? this.debugAppendDetails.slice(0, 10) : undefined,
    };
  }

  /**
   * Get all nodes (for testing)
   */
  getNodes(): NodeInstance[] {
    return Array.from(this.nodeMap.values());
  }

  /**
   * Find nodes by type (for testing)
   */
  findNodesByType(type: string): NodeInstance[] {
    return this.getNodes().filter((node) => node.type === type);
  }

  /**
   * Find node by testID (for testing)
   */
  findByTestId(testID: string): NodeInstance | undefined {
    return this.getNodes().find((node) => node.props.testID === testID);
  }

  // ============================================
  // DevTools Support
  // ============================================

  /**
   * DevTools component tree node
   */
  getComponentTree(): DevToolsTreeNode | null {
    if (this.rootChildren.length === 0) {
      return null;
    }

    // If multiple root children, create a virtual root
    if (this.rootChildren.length > 1) {
      return {
        id: 'root',
        type: 'Root',
        props: {},
        children: this.rootChildren
          .map((childId) => this.buildTreeNode(childId))
          .filter((n): n is DevToolsTreeNode => n !== null),
      };
    }

    // Single root
    const firstChild = this.rootChildren[0];
    if (firstChild === undefined) return null;
    return this.buildTreeNode(firstChild);
  }

  /**
   * Build tree node recursively
   */
  private buildTreeNode(nodeId: number): DevToolsTreeNode | null {
    const node = this.nodeMap.get(nodeId);
    if (!node) return null;

    // Serialize props for DevTools (remove functions, keep serializable values)
    const serializableProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.props)) {
      if (typeof value === 'function') {
        // Show function info with name for DevTools
        // Source location lookup is done on the native side using Metro's source map
        const fnMeta = value as {
          __name?: string;
          __sourceFile?: string;
          __sourceLine?: number;
        };
        const fnName = fnMeta.__name || (value as { name?: string }).name || 'anonymous';

        // Use SerializedFunction type for consistent type marker format
        const serialized: SerializedFunction = {
          __type: 'function',
          __fnId: '', // DevTools display only, not invocable
          __name: fnName,
          __sourceFile: fnMeta.__sourceFile,
          __sourceLine: fnMeta.__sourceLine,
        };
        serializableProps[key] = serialized;
      } else if (value instanceof Date) {
        serializableProps[key] = value.toISOString();
      } else if (value instanceof RegExp) {
        serializableProps[key] = value.toString();
      } else if (value instanceof Map || value instanceof Set) {
        serializableProps[key] = Array.from(value);
      } else {
        serializableProps[key] = value;
      }
    }

    return {
      id: String(nodeId),
      type: node.type,
      props: serializableProps,
      children: node.children
        .map((childId) => this.buildTreeNode(childId))
        .filter((n): n is DevToolsTreeNode => n !== null),
    };
  }

  /**
   * Get node by ID (for DevTools inspection)
   */
  getNodeById(nodeId: number): NodeInstance | undefined {
    return this.nodeMap.get(nodeId);
  }

  /**
   * Get ref for a node (for DevTools frame measurement)
   */
  getNodeRef(nodeId: number): React.RefObject<ReviewedUnknown> | undefined {
    return this.refMap.get(nodeId);
  }

  /**
   * Get all node refs (for DevTools inspection)
   */
  getAllNodeRefs(): Map<number, React.RefObject<ReviewedUnknown>> {
    return new Map(this.refMap);
  }
}

/**
 * DevTools tree node structure
 */
export interface DevToolsTreeNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children: DevToolsTreeNode[];
}
