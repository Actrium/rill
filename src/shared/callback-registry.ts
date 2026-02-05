/**
 * Callback Registry - Guest Side
 *
 * 管理 Guest 侧的函数引用
 * - 为函数生成唯一 ID (fnId)
 * - 使用引用计数防止内存泄漏
 * - 与 Host 注入的 __rill.callbacks Map 共享（在 Guest 环境中）
 */

import type { SandboxGlobals } from '../host/sandbox/globals';
import type { CallbackRegistry as ICallbackRegistry, ReviewedUnknown } from './types';

// Extend globalThis to include Rill-specific properties
declare global {
  var __RILL_GUEST_ENV__: boolean | undefined;
  // __rill namespace holds callbacks, callbackId, registerCallback, etc.
}

export class CallbackRegistry implements ICallbackRegistry {
  private callbacks: Map<string, (...args: ReviewedUnknown[]) => ReviewedUnknown>;
  private refCounts = new Map<string, number>();
  private counter = 0;
  private instanceId = Math.random().toString(36).substring(2, 7);
  private useGuestCallbacks: boolean;

  constructor() {
    // Check if we're in Guest environment
    // Guest environment is marked by __RILL_GUEST_ENV__ flag set by Host injection
    const isGuestEnv = globalThis.__RILL_GUEST_ENV__ === true;
    const rillNs = (globalThis as unknown as SandboxGlobals).__rill;
    const guestCallbacks = rillNs?.callbacks;

    if (isGuestEnv && guestCallbacks instanceof Map) {
      // Guest environment: share the same Map with Host-injected __rill.callbacks
      this.callbacks = guestCallbacks;
      this.useGuestCallbacks = true;
    } else {
      // Host environment or test environment: use internal Map
      this.callbacks = new Map();
      this.useGuestCallbacks = false;
    }
  }

  /**
   * Get internal callbacks Map (for syncing with globalThis.__rill.callbacks)
   */
  getMap(): Map<string, (...args: ReviewedUnknown[]) => ReviewedUnknown> {
    return this.callbacks;
  }

  /**
   * Register callback function with initial reference count of 1
   */
  register(fn: (...args: ReviewedUnknown[]) => ReviewedUnknown): string {
    // Use Guest's __rill.registerCallback if available (for consistent fnId format)
    if (
      this.useGuestCallbacks &&
      typeof (globalThis as unknown as SandboxGlobals).__rill?.registerCallback === 'function'
    ) {
      const fnId = (globalThis as unknown as SandboxGlobals).__rill!.registerCallback!(fn);
      this.refCounts.set(fnId, 1);
      return fnId;
    }
    // Default: generate fnId with instanceId
    const fnId = `fn_${this.instanceId}_${++this.counter}`;
    this.callbacks.set(fnId, fn);
    this.refCounts.set(fnId, 1);
    return fnId;
  }

  /**
   * Increase reference count for a callback
   */
  retain(fnId: string): void {
    const count = this.refCounts.get(fnId) || 0;
    this.refCounts.set(fnId, count + 1);
  }

  /**
   * Decrease reference count and remove callback if count reaches 0
   */
  release(fnId: string): void {
    const count = (this.refCounts.get(fnId) || 1) - 1;
    if (count <= 0) {
      this.callbacks.delete(fnId);
      this.refCounts.delete(fnId);
    } else {
      this.refCounts.set(fnId, count);
    }
  }

  /**
   * Invoke callback function
   */
  invoke(fnId: string, args: ReviewedUnknown[]): ReviewedUnknown {
    const fn = this.callbacks.get(fnId);
    if (fn) {
      try {
        return fn(...args);
      } catch (error) {
        // String-only console to avoid JSI circular ref traversal in JSC sandbox.
        // Error objects may contain React fiber tree references (circular).
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? (error.stack ?? '') : '';
        console.error(`[rill] Callback ${fnId} threw error: ${msg}`);
        if (stack) console.error(`[rill] stack: ${stack}`);
        throw error;
      }
    }
    console.warn(`[rill] Callback ${fnId} not found`);
    return undefined;
  }

  /**
   * Remove a callback by fnId (immediate removal, ignores ref count)
   */
  remove(fnId: string): void {
    this.callbacks.delete(fnId);
    this.refCounts.delete(fnId);
  }

  /**
   * Check if callback function exists
   */
  has(fnId: string): boolean {
    return this.callbacks.has(fnId);
  }

  /**
   * Clear all callbacks
   */
  clear(): void {
    this.callbacks.clear();
    this.refCounts.clear();
    this.counter = 0;
  }

  /**
   * Get registered callback count
   */
  get size(): number {
    return this.callbacks.size;
  }

  /**
   * Get reference count for a callback (for debugging)
   */
  getRefCount(fnId: string): number {
    return this.refCounts.get(fnId) || 0;
  }
}

/**
 * Global callback registry for Guest environment
 * Used by reconciler for function serialization
 *
 * IMPORTANT: Use globalThis pattern to ensure singleton across all modules.
 * Without this, bundlers (esbuild) may create separate instances in different
 * modules, causing callback registration/lookup mismatches.
 */
const globals = globalThis as Record<string, unknown>;
export const globalCallbackRegistry: ICallbackRegistry =
  (globals.__rillGlobalCallbackRegistry as ICallbackRegistry) ??
  (globals.__rillGlobalCallbackRegistry = new CallbackRegistry());
