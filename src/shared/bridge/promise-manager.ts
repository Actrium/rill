/**
 * @rill/runtime/bridge - Promise Manager
 *
 * Handles Promise lifecycle across the Bridge boundary:
 * - Registration of outgoing promises
 * - Creation of pending promises for incoming promise IDs
 * - Timeout management to prevent memory leaks
 * - Settlement of promises with resolve/reject
 */

import type { ReviewedUnknown } from '../types';

export interface PromiseSettleResult {
  status: 'fulfilled' | 'rejected';
  value?: ReviewedUnknown;
  reason?: ReviewedUnknown;
}

export interface PromiseManagerOptions {
  /**
   * Timeout in milliseconds. Set to 0 to disable.
   * Default: 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Callback when a promise is ready to send results to peer
   */
  onSendResult?: (promiseId: string, result: PromiseSettleResult) => void;

  /**
   * Debug mode
   */
  debug?: boolean;
}

interface PendingPromise {
  resolve: (value: ReviewedUnknown) => void;
  reject: (reason: ReviewedUnknown) => void;
  timerId?: ReturnType<typeof setTimeout>;
}

/**
 * PromiseManager - Manages Promise lifecycle across boundaries
 *
 * Responsibilities:
 * - Track outgoing promises and generate IDs
 * - Create pending promises for incoming promise IDs
 * - Handle timeouts to prevent memory leaks
 * - Settle promises when results arrive
 */
export class PromiseManager {
  private promiseIdCounter = 0;
  private pendingPromises = new Map<string, PendingPromise>();
  private timeout: number;
  private onSendResult?: (promiseId: string, result: PromiseSettleResult) => void;
  private debug: boolean;

  constructor(options: PromiseManagerOptions = {}) {
    this.timeout = options.timeout ?? 30000;
    this.onSendResult = options.onSendResult;
    this.debug = options.debug ?? false;
  }

  /**
   * Register an outgoing promise
   * Returns a promiseId that can be serialized and sent to peer
   */
  register(promise: Promise<ReviewedUnknown>): string {
    const promiseId = `p_${++this.promiseIdCounter}`;

    promise.then(
      (value) => {
        if (this.debug) {
          console.log(`[PromiseManager] Promise ${promiseId} resolved`);
        }
        this.onSendResult?.(promiseId, { status: 'fulfilled', value });
      },
      (reason) => {
        if (this.debug) {
          console.log(`[PromiseManager] Promise ${promiseId} rejected`);
        }
        this.onSendResult?.(promiseId, { status: 'rejected', reason });
      }
    );

    return promiseId;
  }

  /**
   * Create a pending promise for an incoming promise ID
   * The promise will be settled when `settle()` is called
   */
  createPending(promiseId: string): Promise<ReviewedUnknown> {
    return new Promise((resolve, reject) => {
      const entry: PendingPromise = { resolve, reject };

      // Set up timeout if enabled
      if (this.timeout > 0) {
        entry.timerId = setTimeout(() => {
          if (this.pendingPromises.has(promiseId)) {
            this.pendingPromises.delete(promiseId);
            reject(new Error(`Promise ${promiseId} timed out after ${this.timeout}ms`));
            if (this.debug) {
              console.warn(
                `[PromiseManager] Promise ${promiseId} timed out after ${this.timeout}ms`
              );
            }
          }
        }, this.timeout);
      }

      this.pendingPromises.set(promiseId, entry);
    });
  }

  /**
   * Settle a pending promise with a result
   */
  settle(promiseId: string, result: PromiseSettleResult): void {
    const pending = this.pendingPromises.get(promiseId);
    if (!pending) {
      if (this.debug) {
        console.warn(`[PromiseManager] No pending promise found for ID: ${promiseId}`);
      }
      return;
    }

    // Clear timeout if exists
    if (pending.timerId) {
      clearTimeout(pending.timerId);
    }

    // Remove from pending
    this.pendingPromises.delete(promiseId);

    // Settle the promise
    if (result.status === 'fulfilled') {
      pending.resolve(result.value);
    } else {
      pending.reject(result.reason);
    }

    if (this.debug) {
      console.log(`[PromiseManager] Promise ${promiseId} settled (${result.status})`);
    }
  }

  /**
   * Check if a promise is pending
   */
  hasPending(promiseId: string): boolean {
    return this.pendingPromises.has(promiseId);
  }

  /**
   * Get number of pending promises
   */
  get pendingCount(): number {
    return this.pendingPromises.size;
  }

  /**
   * Clear all pending promises (for cleanup/destroy)
   * Uses silent rejection to avoid unhandled promise rejection errors during shutdown.
   */
  clear(): void {
    for (const [, pending] of this.pendingPromises) {
      if (pending.timerId) {
        clearTimeout(pending.timerId);
      }
      // Silent rejection: resolve with undefined to avoid unhandled rejection errors
      // This is appropriate during destroy/cleanup when results are no longer needed
      pending.resolve(undefined);
    }
    this.pendingPromises.clear();
    this.promiseIdCounter = 0;
  }
}
