/**
 * Diagnostics and Activity Tracking for Engine
 *
 * Tracks performance metrics, activity timeline, and resource usage
 */

import type { Receiver } from '../receiver';
import type {
  EngineActivityTimeline,
  EngineActivityTimelinePoint,
  EngineDiagnostics,
  EngineHealth,
} from './types';

export interface ActivitySample {
  at: number;
  ops: number;
  appliedOps: number;
  skippedOps: number;
  failedOps: number;
  applyDurationMs: number | null;
}

export interface LastBatchInfo {
  batchId: number;
  at: number;
  totalOps: number;
  applyDurationMs: number | null;
}

export interface DiagnosticsCollectorOptions {
  engineId: string;
  activityWindowMs?: number;
  activityHistoryMs?: number;
  activityBucketMs?: number;
}

export class DiagnosticsCollector {
  // Activity tracking (for Task Manager/Resource Monitor)
  private activityWindowMs: number;
  private activityHistoryMs: number;
  private activityBucketMs: number;
  private activitySamples: ActivitySample[] = [];
  private totalBatches = 0;
  private totalOps = 0;
  private lastBatch: LastBatchInfo | null = null;

  // Guest proactive event reporting observability
  private lastGuestEventName: string | null = null;
  private lastGuestEventAt: number | null = null;
  private lastGuestPayloadBytes: number | null = null;
  private guestSleeping: boolean | null = null;
  private guestSleepingAt: number | null = null;

  // Host → Guest event observability
  private lastHostEventName: string | null = null;
  private lastHostEventAt: number | null = null;
  private lastHostPayloadBytes: number | null = null;

  // Engine health tracking
  private loaded = false;
  private destroyed = false;
  private errorCount = 0;
  private lastErrorAt: number | null = null;

  constructor(private options: DiagnosticsCollectorOptions) {
    this.activityWindowMs = options.activityWindowMs ?? 5000;
    this.activityHistoryMs = options.activityHistoryMs ?? 60_000;
    this.activityBucketMs = options.activityBucketMs ?? 2000;
  }

  /**
   * Record a batch application event
   */
  recordBatch(stats: {
    batchId?: number;
    total: number;
    applied: number;
    skipped: number;
    failed: number;
    at: number;
    durationMs: number;
  }): void {
    this.totalBatches++;
    this.totalOps += stats.total;
    this.lastBatch = {
      batchId: stats.batchId ?? 0,
      at: stats.at,
      totalOps: stats.total,
      applyDurationMs: stats.durationMs,
    };

    // Record activity sample
    this.activitySamples.push({
      at: stats.at,
      ops: stats.total,
      appliedOps: stats.applied,
      skippedOps: stats.skipped,
      failedOps: stats.failed,
      applyDurationMs: stats.durationMs,
    });

    // Trim old samples beyond history window
    const cutoff = Date.now() - this.activityHistoryMs;
    while (this.activitySamples.length > 0 && this.activitySamples[0]!.at < cutoff) {
      this.activitySamples.shift();
    }
  }

  /**
   * Record guest event
   */
  recordGuestEvent(eventName: string, payloadBytes?: number): void {
    this.lastGuestEventName = eventName;
    this.lastGuestEventAt = Date.now();
    this.lastGuestPayloadBytes = payloadBytes ?? null;
  }

  /**
   * Record host event
   */
  recordHostEvent(eventName: string, payloadBytes?: number): void {
    this.lastHostEventName = eventName;
    this.lastHostEventAt = Date.now();
    this.lastHostPayloadBytes = payloadBytes ?? null;
  }

  /**
   * Update guest sleeping status
   */
  setGuestSleeping(sleeping: boolean): void {
    this.guestSleeping = sleeping;
    if (sleeping) {
      this.guestSleepingAt = Date.now();
    }
  }

  /**
   * Update engine lifecycle state
   */
  setLoaded(loaded: boolean): void {
    this.loaded = loaded;
  }

  setDestroyed(destroyed: boolean): void {
    this.destroyed = destroyed;
  }

  /**
   * Record an error
   */
  recordError(): void {
    this.errorCount++;
    this.lastErrorAt = Date.now();
  }

  /**
   * Get health snapshot
   */
  getHealth(): EngineHealth {
    return {
      loaded: this.loaded,
      destroyed: this.destroyed,
      errorCount: this.errorCount,
      lastErrorAt: this.lastErrorAt,
      receiverNodes: 0, // Will be filled by caller
      batching: false,
    };
  }

  /**
   * Get full diagnostics
   */
  getDiagnostics(
    receiver: Receiver | null,
    getResourceStats: () => { timers: number; nodes: number; callbacks: number }
  ): EngineDiagnostics {
    const now = Date.now();
    const cutoff = now - this.activityWindowMs;

    // Calculate ops and batches within stats window
    let windowOps = 0;
    let windowBatches = 0;
    for (let i = this.activitySamples.length - 1; i >= 0; i--) {
      const s = this.activitySamples[i]!;
      if (s.at < cutoff) break;
      windowOps += s.ops;
      windowBatches += 1;
    }

    const seconds = this.activityWindowMs / 1000;
    const opsPerSecond = seconds > 0 ? windowOps / seconds : 0;
    const batchesPerSecond = seconds > 0 ? windowBatches / seconds : 0;

    // Timeline (for trends/attribution): aggregate recent activityHistoryMs into fixed buckets
    const timeline = this.buildTimeline(now);

    const health = this.getHealth();
    const resources = getResourceStats();

    return {
      id: this.options.engineId,
      health: {
        ...health,
        receiverNodes: resources.nodes,
      },
      resources,
      activity: {
        windowMs: this.activityWindowMs,
        opsPerSecond,
        batchesPerSecond,
        totalBatches: this.totalBatches,
        totalOps: this.totalOps,
        lastBatch: this.lastBatch,
        timeline,
      },
      receiver: receiver ? receiver.getStats() : null,
      host: {
        lastEventName: this.lastHostEventName,
        lastEventAt: this.lastHostEventAt,
        lastPayloadBytes: this.lastHostPayloadBytes,
      },
      guest: {
        lastEventName: this.lastGuestEventName,
        lastEventAt: this.lastGuestEventAt,
        lastPayloadBytes: this.lastGuestPayloadBytes,
        sleeping: this.guestSleeping,
        sleepingAt: this.guestSleepingAt,
      },
    };
  }

  /**
   * Build activity timeline from samples
   */
  private buildTimeline(now: number): EngineActivityTimeline {
    const bucketMs = this.activityBucketMs;
    const bucketCount = Math.max(1, Math.ceil(this.activityHistoryMs / bucketMs));
    const timelineWindowMs = bucketCount * bucketMs;
    const timelineStart = now - timelineWindowMs;
    const timelineEnd = timelineStart + timelineWindowMs;

    const buckets = Array.from({ length: bucketCount }, () => ({
      ops: 0,
      batches: 0,
      skippedOps: 0,
      applyMsSum: 0,
      applyMsCount: 0,
      applyMsMax: 0,
    }));

    for (const s of this.activitySamples) {
      if (s.at < timelineStart) continue;
      const atForBucket = Math.min(s.at, timelineEnd - 1);
      if (atForBucket < timelineStart) continue;
      const idx = Math.floor((atForBucket - timelineStart) / bucketMs);
      if (idx < 0 || idx >= buckets.length) continue;
      const b = buckets[idx]!;
      b.ops += s.ops;
      b.batches += 1;
      b.skippedOps += s.skippedOps;
      if (s.applyDurationMs != null) {
        b.applyMsSum += s.applyDurationMs;
        b.applyMsCount += 1;
        b.applyMsMax = Math.max(b.applyMsMax, s.applyDurationMs);
      }
    }

    return {
      windowMs: timelineWindowMs,
      bucketMs,
      points: buckets.map(
        (b, i): EngineActivityTimelinePoint => ({
          at: timelineStart + (i + 1) * bucketMs,
          ops: b.ops,
          batches: b.batches,
          skippedOps: b.skippedOps,
          applyDurationMsAvg: b.applyMsCount > 0 ? b.applyMsSum / b.applyMsCount : null,
          applyDurationMsMax: b.applyMsCount > 0 ? b.applyMsMax : null,
        })
      ),
    };
  }

  /**
   * Clear all diagnostic data
   */
  clear(): void {
    this.activitySamples = [];
    this.totalBatches = 0;
    this.totalOps = 0;
    this.lastBatch = null;
    this.lastGuestEventName = null;
    this.lastGuestEventAt = null;
    this.lastGuestPayloadBytes = null;
    this.guestSleeping = null;
    this.guestSleepingAt = null;
    this.lastHostEventName = null;
    this.lastHostEventAt = null;
    this.lastHostPayloadBytes = null;
  }
}
