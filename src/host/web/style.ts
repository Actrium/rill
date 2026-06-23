/**
 * RN-style → DOM/CSS style normalization for the thin-DOM web preset.
 *
 * Guests author React-Native-style objects (numeric lengths, flexbox-first layout, possibly
 * arrays of styles). The browser/React DOM renderer already turns most numeric values into
 * `px` for known CSS properties, so this layer only needs to:
 *  - flatten the RN array/nested-array style form into a single object,
 *  - drop nullish/false entries (RN allows `style={[base, cond && extra]}`),
 *  - leave actual CSS mapping to React.
 *
 * It intentionally does NOT try to be a full RN layout engine — the thin-DOM preset gives
 * each container flexbox-column defaults (see view.tsx) and otherwise passes styles through.
 */

import type { CSSProperties } from 'react';

// A guest-supplied style: an object, an array (possibly nested), or a falsy slot.
export type WebStyleInput =
  // Reason: guest style values are arbitrary RN style objects validated at the boundary
  Record<string, unknown> | WebStyleInput[] | null | undefined | false;

/**
 * Flatten an RN-style value (object | nested array | falsy) into a single CSS object.
 */
export function toWebStyle(input: WebStyleInput): CSSProperties {
  const out: Record<string, unknown> = {};
  flattenInto(input, out);
  return out as CSSProperties;
}

function flattenInto(input: WebStyleInput, out: Record<string, unknown>): void {
  if (!input) return;
  if (Array.isArray(input)) {
    for (const entry of input) flattenInto(entry, out);
    return;
  }
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value !== undefined) out[key] = value;
  }
}

/**
 * Merge a base style under one or more guest styles (base wins only where the guest omits).
 * Used by container components to apply flexbox-column defaults without clobbering the guest.
 */
export function withBaseStyle(base: CSSProperties, input: WebStyleInput): CSSProperties {
  return { ...base, ...toWebStyle(input) };
}
