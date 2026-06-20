/**
 * Operation Collector
 * Collects operations during render phase, sends all during commit phase
 */

import type { SendToHost, SerializedOperation, SerializedOperationBatch } from '../../../sdk/types';
import { BinaryEncoder } from './binary-encoder';

export interface OperationCollectorConfig {
  /**
   * Enable binary encoding for batches (default: false)
   * When enabled, flush() sends ArrayBuffer instead of JSON objects
   */
  binaryEncoding?: boolean;
}

export class OperationCollector {
  private operations: SerializedOperation[] = [];
  private batchId = 0;
  private version = 1;
  private binaryEncoder: BinaryEncoder | null = null;
  private _flushing = false;

  constructor(config?: OperationCollectorConfig) {
    if (config?.binaryEncoding) {
      this.binaryEncoder = new BinaryEncoder({ persistentIntern: true });
    }
  }

  private isDebugEnabled(): boolean {
    try {
      return Boolean((globalThis as Record<string, unknown>).__RILL_RECONCILER_DEBUG__);
    } catch {
      return false;
    }
  }

  /**
   * Add operation
   */
  add(op: SerializedOperation): void {
    this.operations.push({
      ...op,
      timestamp: Date.now(),
    });

    // ：， CREATE/APPEND/UPDATE （）
    if (this.isDebugEnabled()) {
      const len = this.operations.length;
      if (len <= 10 || len % 50 === 0) {
        console.log('[rill:reconciler] add op', op.op, 'len', len);
      }
    }
  }

  /**
   * Flush and send all operations
   */
  flush(sendToHost: SendToHost): void {
    // Reentry guard: prevent flush-during-flush if sendToHost synchronously
    // triggers state changes that cause another commit/flush cycle.
    if (this._flushing) {
      return;
    }
    this._flushing = true;

    try {
      // Diagnostic accumulator: write to globalThis.__rill_drain_diag for HOST readout
      try {
        let diag = (globalThis as Record<string, unknown>).__rill_drain_diag as
          | string[]
          | undefined;
        if (!diag) {
          diag = [];
          (globalThis as Record<string, unknown>).__rill_drain_diag = diag;
        }
        diag.push(`${Date.now()}:[rill:reconciler] flush ops=${this.operations.length}`);
      } catch {
        /* ignore */
      }

      if (this.operations.length === 0) {
        if (this.isDebugEnabled()) {
          console.warn('[rill:reconciler] flush called with 0 ops');
        }
        return;
      }

      const opLen = this.operations.length;
      const debug = this.isDebugEnabled();
      if (debug) console.log('[rill:reconciler] flush ops=', opLen);

      // /： ops（ debug ）
      if (debug) {
        try {
          if (opLen <= 30) {
            console.log('[rill:reconciler] ops detail', JSON.stringify(this.operations));
          } else {
            const opCounts: Record<string, number> = {};
            for (const op of this.operations) {
              opCounts[op.op] = (opCounts[op.op] || 0) + 1;
            }
            console.log('[rill:reconciler] opCounts', JSON.stringify(opCounts));
            console.log('[rill:reconciler] ops head', JSON.stringify(this.operations.slice(0, 5)));
          }
        } catch {
          // ignore
        }
      }

      const batch: SerializedOperationBatch = {
        version: this.version,
        batchId: ++this.batchId,
        operations: [...this.operations],
      };

      this.operations = [];

      // Binary encoding path: encode to ArrayBuffer for efficient transfer
      if (this.binaryEncoder) {
        const binary = this.binaryEncoder.encodeBatch(batch);
        sendToHost(binary);
      } else {
        // JSON-serialize the batch before crossing the JSI boundary.
        // On Android (and other native sandbox hosts), the JSI bridge recursively
        // converts nested JS objects (qjsToJSI / sandboxToHost), which overflows
        // the native stack for large render batches. Passing a JSON string avoids
        // this: strings are primitive values in JSI — no recursive conversion.
        // The Host Bridge detects string input and JSON.parse's it back.
        sendToHost(JSON.stringify(batch));
      }
    } finally {
      this._flushing = false;
    }
  }

  /**
   * Get pending operation count
   */
  get pendingCount(): number {
    return this.operations.length;
  }
}
