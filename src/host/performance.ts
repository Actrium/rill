/**
 * Performance Optimization Module
 *
 * Provides batch update throttling, operation merging, and other optimization mechanisms.
 *
 * Note: In the dedicated engine architecture (one Engine per Tab/View), these optimizations
 * have shifted from "system-level stability guarantees" to "per-instance UI smoothness enhancements".
 * - ThrottledScheduler: Still useful to prevent a single Guest from overwhelming its own UI thread
 * - OperationMerger: Micro-optimization to reduce Host communication overhead
 * - Both are optional but recommended for better user experience
 */

import type { Operation, OperationBatch } from './types';

/**
 * Batch update configuration
 */
export interface BatchConfig {
  /**
   * Maximum batch size
   * @default 100
   */
  maxBatchSize?: number;

  /**
   * Throttle interval (milliseconds)
   * @default 16 (~60fps)
   */
  throttleMs?: number;

  /**
   * Enable operation merging
   * @default true
   */
  enableMerge?: boolean;
}

/**
 * Operation Merger
 *
 * Merges consecutive operations on the same node to reduce unnecessary updates.
 *
 * In dedicated engine architecture:
 * - Role: Micro-optimization to reduce Guest→Host communication
 * - Impact: Beneficial but not critical (single engine doesn't compete for resources)
 * - Status: Enabled by default, can be disabled via BatchConfig.enableMerge
 */
export class OperationMerger {
  /**
   * Merge operation batch
   */
  merge(operations: Operation[]): Operation[] {
    if (operations.length <= 1) return operations;

    const result: Operation[] = [];
    // Track created node IDs and their index in result for O(1) removal
    const createdIndex = new Map<number, number>();
    const lastInsertForChild = new Map<number, Extract<Operation, { op: 'INSERT' }>>();
    const lastReorderForParent = new Map<number, Extract<Operation, { op: 'REORDER' }>>();
    // Track UPDATE operations with their index in result
    const updateIndex = new Map<
      number,
      { op: Extract<Operation, { op: 'UPDATE' }>; idx: number }
    >();
    // Track removed indices for lazy cleanup
    const removedIndices = new Set<number>();

    for (const op of operations) {
      switch (op.op) {
        case 'UPDATE': {
          // Merge multiple updates on the same node
          const existing = updateIndex.get(op.id);
          if (existing) {
            // Merge props
            existing.op.props = { ...existing.op.props, ...op.props };
            // Merge removedProps using Set for O(1) dedup
            if (op.removedProps) {
              const removedSet = new Set(existing.op.removedProps || []);
              for (const key of op.removedProps) {
                removedSet.add(key);
              }
              existing.op.removedProps = Array.from(removedSet);
            }
          } else {
            const newOp = { ...op };
            const idx = result.length;
            updateIndex.set(op.id, { op: newOp, idx });
            result.push(newOp);
          }
          break;
        }

        case 'DELETE': {
          // If node was created in this batch and then deleted before flush, drop both
          const createIdx = createdIndex.get(op.id);
          if (createIdx !== undefined) {
            // Mark CREATE for removal (lazy cleanup)
            removedIndices.add(createIdx);
            createdIndex.delete(op.id);
            // also drop this DELETE
            break;
          }
          // When deleting a node, remove all previous updates for that node
          const updateEntry = updateIndex.get(op.id);
          if (updateEntry) {
            // Mark UPDATE for removal (lazy cleanup)
            removedIndices.add(updateEntry.idx);
            updateIndex.delete(op.id);
          }
          result.push(op);
          break;
        }

        case 'CREATE': {
          // If a node was previously deleted in this batch and recreated, just treat as CREATE
          createdIndex.set(op.id, result.length);
          result.push(op);
          break;
        }
        case 'INSERT': {
          // Keep only the last INSERT for the same childId within the batch (position churn)
          const ins = op as Extract<Operation, { op: 'INSERT' }>;
          lastInsertForChild.set(ins.childId, ins);
          // do not push now; we'll finalize later
          break;
        }
        case 'REORDER': {
          // Keep only the last REORDER for each parentId
          const rop = op as Extract<Operation, { op: 'REORDER' }>;
          lastReorderForParent.set(rop.parentId, rop);
          break;
        }
        default:
          result.push(op);
      }
    }

    // Append deduplicated INSERTs
    for (const ins of lastInsertForChild.values()) {
      result.push(ins);
    }
    // Append deduplicated REORDERs (last one per parent)
    for (const rop of lastReorderForParent.values()) {
      result.push(rop);
    }

    // Filter out removed operations (lazy cleanup - single pass)
    if (removedIndices.size > 0) {
      return result.filter((_, i) => !removedIndices.has(i));
    }
    return result;
  }
}

/**
 * Throttled Update Scheduler
 *
 * Controls update frequency to avoid excessive re-renders.
 *
 * In dedicated engine architecture:
 * - Previous role (pooled): System-wide stabilizer preventing cross-engine interference
 * - Current role (dedicated): Per-instance UI smoothness optimizer
 * - Use case: Prevents a single Guest from blocking its own UI with high-frequency setState
 * - Default: 16ms throttle (~60fps), can be relaxed for simpler scenarios
 */
export class ThrottledScheduler {
  private pendingOperations: Operation[] = [];
  private lastFlushTime = 0;
  private flushScheduled = false;
  private rafId: number | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  private config: Required<BatchConfig>;
  private merger: OperationMerger;
  private onFlush: (batch: OperationBatch) => void;
  private batchId = 0;
  private version = 1;

  constructor(onFlush: (batch: OperationBatch) => void, config: BatchConfig = {}) {
    this.config = {
      maxBatchSize: config.maxBatchSize ?? 100,
      throttleMs: config.throttleMs ?? 16,
      enableMerge: config.enableMerge ?? true,
    };
    this.merger = new OperationMerger();
    this.onFlush = onFlush;
  }

  /**
   * Add operation to queue
   */
  enqueue(operation: Operation): void {
    this.pendingOperations.push({
      ...operation,
      timestamp: Date.now(),
    });

    // Flush immediately if max batch size is reached
    if (this.pendingOperations.length >= this.config.maxBatchSize) {
      this.flush();
      return;
    }

    this.scheduleFlush();
  }

  /**
   * Add multiple operations
   */
  enqueueAll(operations: Operation[]): void {
    for (const op of operations) {
      this.pendingOperations.push({
        ...op,
        timestamp: Date.now(),
      });
    }

    if (this.pendingOperations.length >= this.config.maxBatchSize) {
      this.flush();
      return;
    }

    this.scheduleFlush();
  }

  /**
   * Schedule flush
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;

    const now = Date.now();
    const timeSinceLastFlush = now - this.lastFlushTime;

    if (timeSinceLastFlush >= this.config.throttleMs) {
      // Use microtask to ensure synchronous code completes
      // Check for queueMicrotask first, then fallback to setTimeout/Promise
      if (typeof globalThis.queueMicrotask === 'function') {
        globalThis.queueMicrotask(() => this.flush());
      } else if (typeof globalThis.setTimeout === 'function') {
        globalThis.setTimeout(() => this.flush(), 0);
      } else {
        Promise.resolve().then(() => this.flush());
      }
    } else {
      // Delay until next throttle cycle
      const delay = this.config.throttleMs - timeSinceLastFlush;
      if (typeof globalThis.setTimeout === 'function') {
        this.timeoutId = globalThis.setTimeout(() => this.flush(), delay);
      } else if (typeof globalThis.queueMicrotask === 'function') {
        globalThis.queueMicrotask(() => this.flush());
      } else {
        Promise.resolve().then(() => this.flush());
      }
    }
  }

  /**
   * Flush all pending operations immediately
   */
  flush(): void {
    if (this.timeoutId) {
      if (typeof globalThis.clearTimeout === 'function') {
        globalThis.clearTimeout(this.timeoutId);
      }
      this.timeoutId = null;
    }
    if (this.rafId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.flushScheduled = false;

    if (this.pendingOperations.length === 0) return;

    let operations = [...this.pendingOperations];
    this.pendingOperations = [];
    this.lastFlushTime = Date.now();

    // Apply operation merging
    if (this.config.enableMerge) {
      operations = this.merger.merge(operations);
    }

    const batch: OperationBatch = {
      version: this.version,
      batchId: ++this.batchId,
      operations,
    };

    this.onFlush(batch);
  }

  /**
   * Get pending operation count
   */
  get pendingCount(): number {
    return this.pendingOperations.length;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.rafId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingOperations = [];
    this.flushScheduled = false;
  }
}

/**
 * Virtual scroll configuration
 */
export interface VirtualScrollConfig {
  /**
   * Estimated item height
   */
  estimatedItemHeight: number;

  /**
   * Buffer items outside visible area
   * @default 5
   */
  overscan?: number;

  /**
   * Scroll throttle interval (milliseconds)
   * @default 16
   */
  scrollThrottleMs?: number;
}

/**
 * Virtual scroll state
 */
export interface VirtualScrollState {
  /** Visible items start index */
  startIndex: number;
  /** Visible items end index */
  endIndex: number;
  /** Top placeholder height */
  offsetTop: number;
  /** Bottom placeholder height */
  offsetBottom: number;
  /** Visible items */
  visibleItems: number[];
}

/**
 * Virtual Scroll Calculator
 *
 * For virtualized rendering of FlatList and other long lists
 */
export class VirtualScrollCalculator {
  private config: Required<VirtualScrollConfig>;
  private itemHeights = new Map<number, number>();
  private totalItems = 0;

  constructor(config: VirtualScrollConfig) {
    this.config = {
      estimatedItemHeight: config.estimatedItemHeight,
      overscan: config.overscan ?? 5,
      scrollThrottleMs: config.scrollThrottleMs ?? 16,
    };
  }

  /**
   * Set total item count
   */
  setTotalItems(count: number): void {
    this.totalItems = count;
  }

  /**
   * Record actual item height
   */
  setItemHeight(index: number, height: number): void {
    this.itemHeights.set(index, height);
  }

  /**
   * Get item height (actual or estimated)
   */
  getItemHeight(index: number): number {
    return this.itemHeights.get(index) ?? this.config.estimatedItemHeight;
  }

  /**
   * Calculate item offset from top
   */
  getItemOffset(index: number): number {
    let offset = 0;
    for (let i = 0; i < index; i++) {
      offset += this.getItemHeight(i);
    }
    return offset;
  }

  /**
   * Calculate total height
   */
  getTotalHeight(): number {
    let height = 0;
    for (let i = 0; i < this.totalItems; i++) {
      height += this.getItemHeight(i);
    }
    return height;
  }

  /**
   * Calculate visible range
   */
  calculate(scrollTop: number, viewportHeight: number): VirtualScrollState {
    if (this.totalItems === 0) {
      return {
        startIndex: 0,
        endIndex: 0,
        offsetTop: 0,
        offsetBottom: 0,
        visibleItems: [],
      };
    }

    // Find start index
    let startIndex = 0;
    let accumulatedHeight = 0;

    while (
      startIndex < this.totalItems &&
      accumulatedHeight + this.getItemHeight(startIndex) < scrollTop
    ) {
      accumulatedHeight += this.getItemHeight(startIndex);
      startIndex++;
    }

    // Apply overscan
    startIndex = Math.max(0, startIndex - this.config.overscan);

    // Find end index
    let endIndex = startIndex;
    let visibleHeight = 0;

    while (
      endIndex < this.totalItems &&
      visibleHeight < viewportHeight + this.config.estimatedItemHeight * this.config.overscan * 2
    ) {
      visibleHeight += this.getItemHeight(endIndex);
      endIndex++;
    }

    // Apply overscan
    endIndex = Math.min(this.totalItems, endIndex + this.config.overscan);

    // Calculate offsets
    let offsetTop = 0;
    for (let i = 0; i < startIndex; i++) {
      offsetTop += this.getItemHeight(i);
    }

    let offsetBottom = 0;
    for (let i = endIndex; i < this.totalItems; i++) {
      offsetBottom += this.getItemHeight(i);
    }

    // Generate visible items index list
    const visibleItems: number[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      visibleItems.push(i);
    }

    return {
      startIndex,
      endIndex,
      offsetTop,
      offsetBottom,
      visibleItems,
    };
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.itemHeights.clear();
    this.totalItems = 0;
  }
}

/**
 * Scroll Event Throttler
 */
export class ScrollThrottler {
  private lastScrollTop = 0;
  private lastCallTime = 0;
  private scheduledCallback: (() => void) | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private config: { throttleMs: number; minDelta: number };

  constructor(throttleMs = 16, minDelta = 1) {
    this.config = { throttleMs, minDelta };
  }

  /**
   * Handle scroll event
   */
  onScroll(scrollTop: number, callback: (scrollTop: number) => void): void {
    const now = Date.now();
    const timeDelta = now - this.lastCallTime;
    const scrollDelta = Math.abs(scrollTop - this.lastScrollTop);

    // Ignore if scroll distance is too small
    if (scrollDelta < this.config.minDelta) {
      return;
    }

    // Execute immediately if enough time has passed since last call
    if (timeDelta >= this.config.throttleMs) {
      this.execute(scrollTop, callback);
      return;
    }

    // Otherwise schedule delayed execution
    this.scheduledCallback = () => callback(scrollTop);

    if (!this.timeoutId) {
      const scheduleCallback = () => {
        if (this.scheduledCallback) {
          this.execute(scrollTop, this.scheduledCallback as (scrollTop: number) => void);
          this.scheduledCallback = null;
        }
        this.timeoutId = null;
      };

      if (typeof globalThis.setTimeout === 'function') {
        this.timeoutId = globalThis.setTimeout(
          scheduleCallback,
          this.config.throttleMs - timeDelta
        ) as ReturnType<typeof setTimeout>;
      } else {
        // Fallback: schedule using microtask if setTimeout not available
        Promise.resolve().then(scheduleCallback);
      }
    }
  }

  private execute(scrollTop: number, callback: (scrollTop: number) => void): void {
    this.lastScrollTop = scrollTop;
    this.lastCallTime = Date.now();
    callback(scrollTop);
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.timeoutId) {
      if (typeof globalThis.clearTimeout === 'function') {
        globalThis.clearTimeout(this.timeoutId);
      }
      this.timeoutId = null;
    }
    this.scheduledCallback = null;
  }
}

/**
 * Performance Monitor
 *
 * Collects and reports performance metrics
 */
export interface PerformanceMetrics {
  /** Total operations */
  totalOperations: number;
  /** Total batches */
  totalBatches: number;
  /** Average batch size */
  avgBatchSize: number;
  /** Operations saved by merging */
  mergedOperations: number;
  /** Node create count */
  createCount: number;
  /** Node update count */
  updateCount: number;
  /** Node delete count */
  deleteCount: number;
  /** Last update time */
  lastUpdateTime: number;
}

export class PerformanceMonitor {
  private metrics: PerformanceMetrics = {
    totalOperations: 0,
    totalBatches: 0,
    avgBatchSize: 0,
    mergedOperations: 0,
    createCount: 0,
    updateCount: 0,
    deleteCount: 0,
    lastUpdateTime: 0,
  };

  /**
   * Record batch
   */
  recordBatch(batch: OperationBatch, originalCount?: number): void {
    this.metrics.totalBatches++;
    this.metrics.totalOperations += batch.operations.length;
    this.metrics.avgBatchSize = this.metrics.totalOperations / this.metrics.totalBatches;
    this.metrics.lastUpdateTime = Date.now();

    if (originalCount !== undefined) {
      this.metrics.mergedOperations += originalCount - batch.operations.length;
    }

    for (const op of batch.operations) {
      switch (op.op) {
        case 'CREATE':
          this.metrics.createCount++;
          break;
        case 'UPDATE':
          this.metrics.updateCount++;
          break;
        case 'DELETE':
          this.metrics.deleteCount++;
          break;
      }
    }
  }

  /**
   * Get performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  reset(): void {
    this.metrics = {
      totalOperations: 0,
      totalBatches: 0,
      avgBatchSize: 0,
      mergedOperations: 0,
      createCount: 0,
      updateCount: 0,
      deleteCount: 0,
      lastUpdateTime: 0,
    };
  }
}
