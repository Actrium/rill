/**
 * Timer Management for Engine
 *
 * Manages setTimeout/setInterval in sandbox with proper cleanup
 * Supports pause/resume with true clock freezing
 */

export interface TimerManagerOptions {
  debug: boolean;
  logger: {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  engineId: string;
  onError?: (error: Error) => void;
}

/** Common fields shared by timeout and interval entries */
interface TimerEntryBase {
  id: number;
  handle: ReturnType<typeof setTimeout> | null;
  remainingTime: number | null;
  pendingToken: number;
}

/** Metadata for a timeout timer */
interface TimeoutEntry extends TimerEntryBase {
  callback: () => void;
  delay: number;
  createdAt: number;
}

/** Metadata for an interval timer */
interface IntervalEntry extends TimerEntryBase {
  callback: () => void;
  delay: number;
  lastTickAt: number;
}

// Sentinel handles for internal scheduling state
const MICROTASK_HANDLE = -1 as unknown as ReturnType<typeof setTimeout>;
const PENDING_HANDLE = -2 as unknown as ReturnType<typeof setTimeout>;

export class TimerManager {
  private timeoutMap = new Map<number, TimeoutEntry>();
  private intervalMap = new Map<number, IntervalEntry>();
  private timeoutIdCounter = 0;
  private intervalIdCounter = 0;
  private _isPaused = false;

  // Native timer references (captured during initialization)
  private nativeSetTimeout: typeof setTimeout;
  private nativeClearTimeout: typeof clearTimeout;
  // Microtask scheduler for zero-delay optimisation
  private nativeQueueMicrotask: (fn: () => void) => void;

  constructor(private options: TimerManagerOptions) {
    // Save native timer functions to avoid recursion issues (with fallbacks for test environments)
    const fallbackSetTimeout = ((fn: () => void) => {
      Promise.resolve().then(fn);
      // biome-ignore lint/suspicious/noExplicitAny: Test/internal structure with dynamic types
      return 0 as any;
    }) as typeof setTimeout;

    const fallbackClearTimeout = (() => {}) as typeof clearTimeout;
    // Bind to globalThis: in the browser, window.setTimeout/clearTimeout throw
    // "Illegal invocation" when called with any other `this` (a detached reference).
    // Node/Bun don't care, which is why this only surfaces on the WASM/web path.
    this.nativeSetTimeout =
      typeof globalThis.setTimeout === 'function'
        ? globalThis.setTimeout.bind(globalThis)
        : fallbackSetTimeout;
    this.nativeClearTimeout =
      typeof globalThis.clearTimeout === 'function'
        ? globalThis.clearTimeout.bind(globalThis)
        : fallbackClearTimeout;
    this.nativeQueueMicrotask =
      typeof globalThis.queueMicrotask === 'function'
        ? globalThis.queueMicrotask.bind(globalThis)
        : (fn: () => void) => Promise.resolve().then(fn);

    if (this.options.debug) {
      this.options.logger.log(
        `[TimerManager] Constructor: globalThis.setTimeout is ${typeof globalThis.setTimeout}`
      );
    }
  }

  private isMicrotaskHandle(handle: ReturnType<typeof setTimeout> | null): boolean {
    return handle === MICROTASK_HANDLE;
  }

  private isPendingHandle(handle: ReturnType<typeof setTimeout> | null): boolean {
    return handle === PENDING_HANDLE;
  }

  /**
   * Common microtask-based scheduling with pending token invalidation.
   *
   * Pattern shared by setTimeout and setInterval scheduling:
   * 1. Increment pendingToken to invalidate any stale microtask
   * 2. Set handle = PENDING_HANDLE (marker)
   * 3. Queue microtask that checks token validity + paused state
   * 4. If still valid, call onSchedule to set up the native timer
   */
  private scheduleWithPendingToken<E extends TimerEntryBase>(
    entry: E,
    entryMap: Map<number, E>,
    pauseTimeRef: number,
    delay: number,
    onSchedule: (current: E) => void
  ): void {
    const token = ++entry.pendingToken;
    entry.handle = PENDING_HANDLE;

    this.nativeQueueMicrotask(() => {
      const current = entryMap.get(entry.id);
      if (!current || current.pendingToken !== token) return;
      if (this._isPaused) {
        const elapsed = Date.now() - pauseTimeRef;
        current.remainingTime = Math.max(0, delay - elapsed);
        current.handle = null;
        return;
      }
      onSchedule(current as E);
    });
  }

  private scheduleNativeTimeout(entry: TimeoutEntry): void {
    this.scheduleWithPendingToken(
      entry,
      this.timeoutMap,
      entry.createdAt,
      entry.delay,
      (current) => {
        current.handle = this.nativeSetTimeout(() => {
          this.timeoutMap.delete(entry.id);
          this.executeCallback(current.callback, 'setTimeout');
        }, entry.delay);
      }
    );
  }

  private scheduleIntervalTick(entry: IntervalEntry, delay: number): void {
    this.scheduleWithPendingToken(
      entry,
      this.intervalMap as Map<number, IntervalEntry>,
      entry.lastTickAt,
      delay,
      (current) => {
        const handle = this.nativeSetTimeout(() => {
          current.lastTickAt = Date.now();

          try {
            current.callback();
          } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            this.options.logger.error(
              `[rill:${this.options.engineId}] setInterval callback error:`,
              error
            );
            this.options.onError?.(error);
          }

          if (!this.intervalMap.has(current.id)) return;
          if (this._isPaused) {
            current.remainingTime = current.delay;
            current.handle = null;
            return;
          }
          this.scheduleIntervalTick(current, current.delay);
        }, delay);

        current.handle = handle as unknown as ReturnType<typeof setInterval>;
      }
    );
  }

  /**
   * Whether the timer manager is currently paused
   */
  get isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Pause all timers - freeze their clocks
   * Stores remaining time for each timer and clears native handles
   */
  pause(): void {
    if (this._isPaused) return;
    this._isPaused = true;

    const now = Date.now();

    // Pause all timeouts - calculate and store remaining time
    for (const entry of this.timeoutMap.values()) {
      if (entry.handle !== null) {
        const elapsed = now - entry.createdAt;
        entry.remainingTime = Math.max(0, entry.delay - elapsed);
        if (!this.isMicrotaskHandle(entry.handle) && !this.isPendingHandle(entry.handle)) {
          this.nativeClearTimeout(entry.handle);
        }
        // For microtask-dispatched timeouts (handle === -1), the microtask callback
        // checks timeoutMap.has(id) — setting handle=null prevents re-clear on resume.
        entry.handle = null;
        entry.pendingToken++;
      }
    }

    // Pause all intervals - calculate remaining time until next tick
    for (const entry of this.intervalMap.values()) {
      if (entry.handle !== null) {
        const elapsed = now - entry.lastTickAt;
        entry.remainingTime = Math.max(0, entry.delay - elapsed);
        if (!this.isPendingHandle(entry.handle)) {
          // Intervals use recursive setTimeout, so we must use clearTimeout
          this.nativeClearTimeout(entry.handle);
        }
        entry.handle = null;
        entry.pendingToken++;
      }
    }

    if (this.options.debug) {
      this.options.logger.log(
        `[rill:${this.options.engineId}] Paused ${this.timeoutMap.size} timeouts, ${this.intervalMap.size} intervals`
      );
    }
  }

  /**
   * Resume all timers - continue from where they left off
   * Recreates native handles with remaining time
   */
  resume(): void {
    if (!this._isPaused) return;
    this._isPaused = false;

    const now = Date.now();

    // Resume all timeouts with remaining time
    for (const entry of this.timeoutMap.values()) {
      if (entry.handle === null && entry.remainingTime !== null) {
        entry.createdAt = now; // Reset creation time for accurate tracking
        entry.delay = entry.remainingTime; // Use remaining time as new delay
        entry.remainingTime = null;
        this.scheduleNativeTimeout(entry);
      }
    }

    // Resume all intervals
    for (const entry of this.intervalMap.values()) {
      if (entry.handle === null && entry.remainingTime !== null) {
        // First, schedule the next tick with remaining time
        const remainingTime = entry.remainingTime;
        entry.remainingTime = null;
        this.scheduleIntervalTick(entry, remainingTime);
      }
    }

    if (this.options.debug) {
      this.options.logger.log(
        `[rill:${this.options.engineId}] Resumed ${this.timeoutMap.size} timeouts, ${this.intervalMap.size} intervals`
      );
    }
  }

  /**
   * Execute a callback with error handling
   */
  private executeCallback(callback: () => void, source: string): void {
    try {
      callback();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.options.logger.error(`[rill:${this.options.engineId}] ${source} callback error:`, error);
      this.options.onError?.(error);
    }
  }

  /**
   * Create setTimeout polyfill for sandbox
   * Returns a function that can be injected into sandbox context
   */
  createSetTimeoutPolyfill(): (fn: () => void, delay: number) => number {
    return (fn: () => void, delay: number) => {
      const id = ++this.timeoutIdCounter;
      const now = Date.now();

      const entry: TimeoutEntry = {
        id,
        handle: null,
        callback: fn,
        delay,
        createdAt: now,
        remainingTime: null,
        pendingToken: 0,
      };

      // Only create native timer if not paused
      if (!this._isPaused) {
        // OPTIMISATION: For zero/near-zero delays, use queueMicrotask instead of
        // native setTimeout. In XPC ViewBridge service context, native RCTTiming
        // is stalled (~24s delay). queueMicrotask fires instantly.
        if (delay <= 0) {
          // Use a sentinel handle to distinguish microtask-dispatched timeouts
          entry.handle = MICROTASK_HANDLE;
          this.nativeQueueMicrotask(() => {
            if (!this.timeoutMap.has(id)) return; // cleared
            this.timeoutMap.delete(id);
            this.executeCallback(fn, 'setTimeout');
          });
        } else {
          this.scheduleNativeTimeout(entry);
        }
      } else {
        // If paused, store remaining time as the full delay
        entry.remainingTime = delay;
      }

      this.timeoutMap.set(id, entry);
      return id;
    };
  }

  /**
   * Create clearTimeout polyfill for sandbox
   */
  createClearTimeoutPolyfill(): (id: number) => void {
    return (id: number) => {
      const entry = this.timeoutMap.get(id);
      if (entry) {
        if (
          entry.handle !== null &&
          !this.isMicrotaskHandle(entry.handle) &&
          !this.isPendingHandle(entry.handle)
        ) {
          this.nativeClearTimeout(entry.handle);
        }
        // For microtask-dispatched timeouts (handle === -1), deletion from the map
        // is sufficient — the microtask callback checks timeoutMap.has(id) before firing.
        this.timeoutMap.delete(id);
        entry.pendingToken++;
      }
    };
  }

  /**
   * Create setInterval polyfill for sandbox
   */
  createSetIntervalPolyfill(): (fn: () => void, delay: number) => number {
    return (fn: () => void, delay: number) => {
      const id = ++this.intervalIdCounter;
      const now = Date.now();

      const entry: IntervalEntry = {
        id,
        handle: null,
        callback: fn,
        delay,
        lastTickAt: now,
        remainingTime: null,
        pendingToken: 0,
      };

      // Only create native timer if not paused
      if (!this._isPaused) {
        this.scheduleIntervalTick(entry, delay);
      } else {
        // If paused, store remaining time as the full delay
        entry.remainingTime = delay;
      }

      this.intervalMap.set(id, entry);
      return id;
    };
  }

  /**
   * Create clearInterval polyfill for sandbox
   */
  createClearIntervalPolyfill(): (id: number) => void {
    return (id: number) => {
      const entry = this.intervalMap.get(id);
      if (entry) {
        if (entry.handle !== null && !this.isPendingHandle(entry.handle)) {
          // Intervals use recursive setTimeout, so we must use clearTimeout
          this.nativeClearTimeout(entry.handle);
        }
        this.intervalMap.delete(id);
        entry.pendingToken++;
      }
    };
  }

  /**
   * Clear all pending timers (timeouts and intervals)
   * Called during engine cleanup
   */
  clearAllTimers(): void {
    // Clear all timeouts
    for (const entry of this.timeoutMap.values()) {
      if (
        entry.handle !== null &&
        !this.isMicrotaskHandle(entry.handle) &&
        !this.isPendingHandle(entry.handle)
      ) {
        this.nativeClearTimeout(entry.handle);
      }
      entry.pendingToken++;
    }
    this.timeoutMap.clear();

    // Clear all intervals
    for (const entry of this.intervalMap.values()) {
      if (entry.handle !== null && !this.isPendingHandle(entry.handle)) {
        // Intervals use recursive setTimeout, so we must use clearTimeout
        this.nativeClearTimeout(entry.handle);
      }
      entry.pendingToken++;
    }
    this.intervalMap.clear();

    if (this.options.debug) {
      this.options.logger.log(`[rill:${this.options.engineId}] Cleared all timers`);
    }
  }

  /**
   * Get timer statistics
   */
  getStats(): { timeouts: number; intervals: number; isPaused: boolean } {
    return {
      timeouts: this.timeoutMap.size,
      intervals: this.intervalMap.size,
      isPaused: this._isPaused,
    };
  }
}
