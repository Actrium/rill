/**
 * Event System for Engine
 * Manages event listeners with memory leak detection
 */

import type { EngineEvents, EventListener } from './types';

export class EventManager {
  private listeners: Map<keyof EngineEvents, Set<EventListener<unknown>>> = new Map();
  private maxListeners = 10;
  private warnedEvents = new Set<keyof EngineEvents>();

  constructor(
    private logger: {
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    },
    private debug = false
  ) {}

  /**
   * Emit event to all registered listeners
   */
  emit<K extends keyof EngineEvents>(
    event: K,
    ...args: EngineEvents[K] extends () => void ? [] : [Parameters<EngineEvents[K]>[0]]
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          listener(args[0]);
        } catch (error) {
          this.logger.error(`[rill] Event listener error:`, error);
        }
      });
    }
  }

  /**
   * Register event listener
   * Returns unsubscribe function
   */
  on<K extends keyof EngineEvents>(
    event: K,
    listener: EngineEvents[K] extends () => void
      ? () => void
      : (data: Parameters<EngineEvents[K]>[0]) => void
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<unknown>);

    // Memory leak detection - warn if listener count exceeds threshold
    if (this.debug) {
      const count = this.listeners.get(event)!.size;
      if (count > this.maxListeners && !this.warnedEvents.has(event)) {
        this.logger.warn(
          `[rill] Possible EventEmitter memory leak detected. ` +
            `${count} listeners added for event "${String(event)}". ` +
            `Use setMaxListeners() to increase limit.`
        );
        this.warnedEvents.add(event);
      }
    }

    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(listener as EventListener<unknown>);
      // Clear warning if count drops below threshold
      if (this.warnedEvents.has(event)) {
        const count = this.listeners.get(event)?.size ?? 0;
        if (count <= this.maxListeners) {
          this.warnedEvents.delete(event);
        }
      }
    };
  }

  /**
   * Set maximum listener count before warning
   */
  setMaxListeners(n: number): void {
    this.maxListeners = n;
  }

  /**
   * Get current maximum listener threshold
   */
  getMaxListeners(): number {
    return this.maxListeners;
  }

  /**
   * Remove all listeners
   */
  removeAllListeners(): void {
    this.listeners.clear();
    this.warnedEvents.clear();
  }
}
