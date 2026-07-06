/**
 * Shared host <-> guest event-name constants (same pattern as `shared/keyboard.ts`).
 *
 * These names cross the sandbox boundary as plain strings (via
 * `__rill.dispatchEvent` / `__rill_emitEvent`), so both sides must agree on
 * them exactly. Keep every boundary event name here instead of inlining
 * string literals at the call sites.
 */

/**
 * Host -> guest: delivery of a REF_CALL method result. The guest `useRemoteRef`
 * hook subscribes to this event to resolve its pending ref-method promises.
 */
export const REF_RESULT_EVENT = '__REF_RESULT__';

/**
 * Guest -> host: a render-phase error caught by `RillErrorBoundary`
 * (message / stack / componentStack payload), emitted via `__rill_emitEvent`.
 */
export const RENDER_ERROR_EVENT = 'RENDER_ERROR';

/**
 * Host -> guest: a config snapshot pushed by `Engine.updateConfig()`. Guests
 * can observe it through the host-event system (`__rill_onHostEvent`).
 */
export const CONFIG_UPDATE_EVENT = 'CONFIG_UPDATE';
