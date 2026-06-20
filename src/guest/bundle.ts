/**
 * Guest Bundle - Unified Entry Point
 *
 * This is the single entry point for all Guest sandbox code.
 * Build script compiles this into a single bundle that is eval'd once.
 *
 * Import order is critical:
 * 1. init.ts - Sets up __RILL_GUEST_ENV__ and __rill.callbacks FIRST
 * 2. globals-setup.ts - Sets up console and runtime helpers
 * 3. react-global.ts - Exposes React/JSX runtimes on globalThis
 * 4. sdk - Exposes rill/guest as globalThis.RillGuest
 * 5. reconciler - RillReconciler (uses React)
 *
 * Output:
 * - globalThis.React - React API
 * - globalThis.ReactJSXRuntime - JSX runtime for modern transform
 * - globalThis.ReactJSXDevRuntime - JSX dev runtime
 * - globalThis.RillGuest - rill/guest module exports (for externalized guest bundles)
 * - globalThis.RillReconciler - Reconciler API (render, unmount, etc.)
 * - globalThis.__REACT_SHIM__ - Marker that shims are loaded
 * - globalThis.console - Console object (wraps Host callbacks)
 * - globalThis.__rill_onHostEvent - Subscribe to Host events
 * - globalThis.__rill.dispatchEvent - Called by Host to dispatch events
 */

// ============================================
// 1. Guest Environment Initialization (MUST BE FIRST)
// ============================================
import './runtime/init';

// ============================================
// 2. Console and Runtime Helpers Setup
// ============================================
import './runtime/globals-setup';

// ============================================
// 3. React globals
// ============================================
import './runtime/react-global';

// ============================================
// 4. Guest SDK (rill/guest)
// ============================================
import * as RillGuestModule from '../sdk';

(globalThis as Record<string, unknown>).RillGuest = RillGuestModule;

// ============================================
// 5. Reconciler
// ============================================
import {
  getCallbackCount,
  invokeCallback,
  registerComponentType,
  releaseCallback,
  render,
  unmount,
  unmountAll,
  unregisterComponentTypes,
} from './runtime/reconciler';

// Export RillReconciler to globalThis
(globalThis as Record<string, unknown>).RillReconciler = {
  render,
  unmount,
  unmountAll,
  invokeCallback,
  releaseCallback,
  getCallbackCount,
  registerComponentType,
  unregisterComponentTypes,
};

// ============================================
// Debug logging
// ============================================
if ((globalThis as Record<string, unknown>).__RILL_DEBUG__) {
  console.log('[rill:guest-bundle] Guest bundle initialized');
  console.log('[rill:guest-bundle] - React:', typeof (globalThis as Record<string, unknown>).React);
  console.log(
    '[rill:guest-bundle] - ReactJSXRuntime:',
    typeof (globalThis as Record<string, unknown>).ReactJSXRuntime
  );
  console.log(
    '[rill:guest-bundle] - RillGuest:',
    typeof (globalThis as Record<string, unknown>).RillGuest
  );
  console.log(
    '[rill:guest-bundle] - RillReconciler:',
    typeof (globalThis as Record<string, unknown>).RillReconciler
  );
}

// Export marker for build verification
export const GUEST_BUNDLE_COMPLETE = true;
