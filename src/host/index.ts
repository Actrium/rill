/**
 * @rill/runtime
 *
 * Host-side runtime for rill
 * Responsible for sandbox management, operation receiving, and UI rendering
 */

export type { EngineOptions } from './engine';
// Core exports
export { Engine } from './engine';

// Sandbox provider selection is internal and automatic (DefaultProvider / TenantManagerProvider).

// EngineView hook for custom EngineView implementations
export type { LoadingState, UseEngineViewOptions, UseEngineViewResult } from './use-engine-view';
export { useEngineView } from './use-engine-view';
export type { WasmGuestHostOptions } from './wasm-guest/wasm-guest-host';
// Native (non-JS) WASM guest: the low-level host + an EngineViewEngine adapter so
// the platform mounts a native guest through the same useEngineView pipeline.
export { WasmGuestHost } from './wasm-guest/wasm-guest-host';
export type { WasmGuestViewOptions } from './wasm-guest/wasm-guest-view';
export { createWasmGuestEngine, WasmGuestView } from './wasm-guest/wasm-guest-view';
