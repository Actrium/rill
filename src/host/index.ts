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
