/**
 * Guest-side Encoder / Decoder
 *
 * Shared encoder and decoder for serializing/deserializing props using Bridge TypeRules.
 * Used by both host-config.ts and element-transform.ts.
 *
 * ALL type handling is centralized in type-rules.ts — this module only wires
 * the TypeRules pipeline to the Guest-side globalCallbackRegistry.
 */

import {
  type CodecCallbacks,
  createDecoder,
  createEncoder,
  DEFAULT_TYPE_RULES,
  encodeObject,
  globalCallbackRegistry,
  isSerializedFunction,
  type SerializedValue,
  type SerializedValueObject,
} from '../../../shared';

/**
 * Create Guest-side CodecCallbacks using globalCallbackRegistry
 */
function createGuestEncodeContext(): CodecCallbacks {
  // Reason: Context must reference encoder which references context (circular)
  const context = {} as CodecCallbacks;

  // Use shared encoder from Bridge
  const encoder = createEncoder(DEFAULT_TYPE_RULES, context);

  // Complete context initialization
  context.encode = encoder;
  context.decode = (v) => v; // Not used in Guest encoding
  context.registerFunction = (fn) =>
    globalCallbackRegistry.register(fn as (...args: unknown[]) => unknown);
  context.invokeFunction = (fnId, args) => globalCallbackRegistry.invoke(fnId, args);

  return context;
}

/**
 * Shared Guest encoder (created once, reused)
 */
const guestContext = createGuestEncodeContext();

/**
 * Guest encoder function
 */
export const guestEncoder = guestContext.encode;

/**
 * Serialize object props using shared Bridge utilities
 * Functions automatically become { __type: 'function', __fnId }
 */
export function serializeProps(props: Record<string, unknown>): SerializedValueObject {
  return encodeObject(props, guestEncoder) as SerializedValueObject;
}

// ============================================
// Guest-side Decoder (for sandbox wrapper props)
// ============================================

/**
 * Create Guest-side decode context.
 *
 * Used by sandbox wrappers to restore serialized function markers
 * ({ __type: 'function', __fnId }) back to callable proxy functions
 * before passing props to Guest sandbox components.
 *
 * The decode pipeline uses type-rules.ts 'serialized-function' rule,
 * keeping ALL type handling centralized.
 */
function createGuestDecodeContext(): CodecCallbacks {
  const context = {} as CodecCallbacks;

  const decoder = createDecoder(DEFAULT_TYPE_RULES, context);

  // encode: used by serialized-function decode rule to encode args
  // before invoking the original callback (JSI safety)
  context.encode = guestEncoder;
  context.decode = decoder;
  context.registerFunction = (fn) =>
    globalCallbackRegistry.register(fn as (...args: unknown[]) => unknown);
  context.invokeFunction = (fnId, args) => globalCallbackRegistry.invoke(fnId, args);

  return context;
}

const guestDecodeContext = createGuestDecodeContext();

/**
 * Guest decoder function
 */
export const guestDecoder = guestDecodeContext.decode;

/**
 * Deserialize props: restore function markers back to callable proxy functions.
 * Used by element-transform.ts sandbox wrapper before calling Guest component.
 *
 * Creates lightweight callable wrappers for serialized function markers.
 * Only function markers are converted; all other values pass through unchanged
 * (reference-preserving for React reconciliation).
 */
export function deserializeProps(props: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isSerializedFunction(value as SerializedValue)) {
      const { __fnId } = value as { __fnId: string };
      result[key] = createLightweightProxy(__fnId);
      changed = true;
    } else {
      result[key] = value;
    }
  }
  return changed ? result : props;
}

/**
 * Create a lightweight callable proxy for a serialized function marker.
 *
 * Unlike the full TypeRules serialized-function decode proxy, this:
 * - Does NOT encode args (avoids re-entrancy into guestEncoder)
 * - Does NOT use console.error in catch (avoids JSI circular ref traversal in JSC)
 * - Has no metadata properties (minimal footprint)
 * - Directly invokes the callback registry
 */
function createLightweightProxy(fnId: string): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => globalCallbackRegistry.invoke(fnId, args);
}
