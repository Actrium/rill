/**
 * @rill/bridge - Serialization Utilities
 *
 * ， Host  Guest
 * - Host: bridge.ts
 * - Guest: reconciler （）
 *
 * Performance: Uses type-tag dispatch (O(1) Map lookup) instead of
 * linear rule traversal for serialized objects with __type field.
 */

import type { CodecCallbacks, TypeRule } from './type-rules';
import type { ReviewedUnknown } from './types';

/**  */
export interface CircularRef {
  __type: 'circular';
}

/**
 * Rule name → __type tag mapping.
 * Used to build the O(1) dispatch map for decode.
 */
const RULE_TAG_MAP: Record<string, string> = {
  circular: 'circular',
  'serialized-function': 'function',
  'serialized-promise': 'promise',
  date: 'date',
  regexp: 'regexp',
  error: 'error',
  map: 'map',
  set: 'set',
  typedarray: 'typedarray',
  arraybuffer: 'arraybuffer',
};

/**
 * Build a type-tag dispatch map from rules.
 * Maps __type string values to their corresponding TypeRule for O(1) decode dispatch.
 */
function buildTagDispatchMap(rules: TypeRule[]): Map<string, TypeRule> {
  const map = new Map<string, TypeRule>();
  for (const rule of rules) {
    const tag = RULE_TAG_MAP[rule.name];
    if (tag) {
      map.set(tag, rule);
    }
  }
  return map;
}

/**
 *
 *  TypeRules
 * ，
 *
 * ：
 * - （）
 * -
 * - instanceof
 *
 * ：
 * -  encode  WeakSet（ depth ）
 * -  encode  WeakSet（）
 * -  encode （ render ）
 */
export function createEncoder(
  typeRules: TypeRule[],
  context: CodecCallbacks
): (value: ReviewedUnknown) => ReviewedUnknown {
  // Pre-index rules by name for O(1) lookup
  const rulesByName = new Map<string, TypeRule>();
  for (const rule of typeRules) {
    rulesByName.set(rule.name, rule);
  }

  // Remaining rules not handled by fast-path dispatch (custom user rules)
  const customRules = typeRules.filter(
    (r) =>
      ![
        'null-undefined',
        'primitives',
        'function',
        'promise',
        'date',
        'regexp',
        'error',
        'map',
        'set',
        'typedarray',
        'arraybuffer',
        'toJSON',
        'array',
        'object',
        'circular',
        'serialized-function',
        'serialized-promise',
      ].includes(r.name)
  );

  // Per-call circular reference detection.
  // Reset at the start of each top-level encode call to avoid
  // false positives across different encode invocations (e.g., between renders).
  let seenPool = new WeakSet<object>();
  let depth = 0;

  const applyRule = (rule: TypeRule | undefined, value: ReviewedUnknown): ReviewedUnknown => {
    if (!rule) return value;
    return rule.encode ? rule.encode(value, context) : value;
  };

  const encode = (value: ReviewedUnknown): ReviewedUnknown => {
    // Reset seenPool at the start of each top-level encode call
    if (depth === 0) {
      seenPool = new WeakSet<object>();
    }
    depth++;

    try {
      // ：null/undefined
      if (value === null || value === undefined) {
        return value;
      }

      // ：（）
      const type = typeof value;
      if (type === 'boolean' || type === 'number' || type === 'string') {
        return value;
      }

      // ：
      if (type === 'function') {
        return applyRule(rulesByName.get('function'), value);
      }

      //  — instanceof-based dispatch
      if (type === 'object') {
        // Promise (leaf object, no circular ref detection needed)
        if (value instanceof Promise) {
          return applyRule(rulesByName.get('promise'), value);
        }

        // Date (leaf object)
        if (value instanceof Date) {
          return applyRule(rulesByName.get('date'), value);
        }

        // RegExp (leaf object)
        if (value instanceof RegExp) {
          return applyRule(rulesByName.get('regexp'), value);
        }

        // Error (leaf object)
        if (value instanceof Error) {
          return applyRule(rulesByName.get('error'), value);
        }

        // Map (needs recursive encode for entries)
        if (value instanceof Map) {
          return applyRule(rulesByName.get('map'), value);
        }

        // Set (needs recursive encode for values)
        if (value instanceof Set) {
          return applyRule(rulesByName.get('set'), value);
        }

        // TypedArray (must be before ArrayBuffer check)
        if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
          return applyRule(rulesByName.get('typedarray'), value);
        }

        // ArrayBuffer
        if (value instanceof ArrayBuffer) {
          return applyRule(rulesByName.get('arraybuffer'), value);
        }

        // Already-serialized objects (has __type tag) — pass through
        if ('__type' in (value as object)) {
          const tag = (value as { __type: string }).__type;
          const knownTags = [
            'date',
            'regexp',
            'error',
            'function',
            'circular',
            'arraybuffer',
            'typedarray',
            'map',
            'set',
            'promise',
          ];
          if (knownTags.includes(tag)) {
            return value;
          }
        }

        // toJSON support (custom serialization)
        const toJSONRule = rulesByName.get('toJSON');
        if (toJSONRule?.match(value)) {
          return applyRule(toJSONRule, value);
        }

        // Custom rules (user-provided, not built-in)
        for (const rule of customRules) {
          if (rule.match(value)) {
            return rule.encode ? rule.encode(value, context) : value;
          }
        }

        // Circular reference detection for container types
        const obj = value as object;

        if (seenPool.has(obj)) {
          return { __type: 'circular' } as CircularRef;
        }

        seenPool.add(obj);

        // Array: recursive encode
        if (Array.isArray(value)) {
          return (value as unknown[]).map(encode);
        }

        // Plain object: recursive encode
        return encodeObject(value as Record<string, unknown>, encode);
      }

      return value;
    } finally {
      depth--;
    }
  };

  return encode;
}

/**
 *
 */
export function encodeObject(
  obj: Record<string, unknown>,
  encode: (value: ReviewedUnknown) => ReviewedUnknown
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = encode(value);
  }
  return result;
}

/**
 *
 *  type-tag dispatch (O(1) Map lookup)
 *
 * ：
 * -
 * -  __type tag → O(1) Map dispatch
 * - /
 */
export function createDecoder(
  typeRules: TypeRule[],
  context: CodecCallbacks
): (value: ReviewedUnknown) => ReviewedUnknown {
  // Build type-tag dispatch map for O(1) decode
  const tagMap = buildTagDispatchMap(typeRules);

  // Non-tag rules for fallback (array, object, and custom user rules)
  const arrayRule = typeRules.find((r) => r.name === 'array');
  const objectRule = typeRules.find((r) => r.name === 'object');
  const customRules = typeRules.filter(
    (r) =>
      !RULE_TAG_MAP[r.name] &&
      r.name !== 'null-undefined' &&
      r.name !== 'primitives' &&
      r.name !== 'function' &&
      r.name !== 'promise' &&
      r.name !== 'array' &&
      r.name !== 'object'
  );

  const decode = (value: ReviewedUnknown): ReviewedUnknown => {
    // ：null/undefined
    if (value === null || value === undefined) {
      return value;
    }

    // ：
    const type = typeof value;
    if (type === 'boolean' || type === 'number' || type === 'string') {
      return value;
    }

    // Object types
    if (type === 'object') {
      // Native instances that are already decoded — passthrough
      if (value instanceof Date || value instanceof RegExp || value instanceof Error) {
        return value;
      }
      if (value instanceof Map || value instanceof Set) {
        return value;
      }

      // Type-tag dispatch: O(1) lookup for serialized objects with __type
      if ('__type' in (value as object)) {
        const tag = (value as { __type: string }).__type;
        const rule = tagMap.get(tag);
        if (rule) {
          return rule.decode ? rule.decode(value, context) : value;
        }
      }

      // Array
      if (Array.isArray(value)) {
        if (arrayRule?.decode) {
          return arrayRule.decode(value, context);
        }
        // Fallback: recursive decode
        const input = value as unknown[];
        let changed = false;
        const result = input.map((item) => {
          const decoded = decode(item);
          if (decoded !== item) changed = true;
          return decoded;
        });
        return changed ? result : value;
      }

      // Custom rules (user-provided)
      for (const rule of customRules) {
        if (rule.match(value)) {
          return rule.decode ? rule.decode(value, context) : value;
        }
      }

      // Plain object: recursive decode (reference-preserving)
      if (objectRule?.decode) {
        return objectRule.decode(value, context);
      }
      return decodeObject(value as Record<string, unknown>, decode);
    }

    // Function type in decode path (shouldn't normally happen)
    if (type === 'function') {
      return value;
    }

    return value;
  };

  return decode;
}

/**
 *
 *
 * Reference-preserving: returns the original object if no values changed.
 * This is critical for React reconciliation — creating new object references
 * for unchanged values (e.g., style objects) breaks React's shallow comparison.
 */
export function decodeObject(
  obj: Record<string, unknown>,
  decode: (value: ReviewedUnknown) => ReviewedUnknown
): Record<string, unknown> {
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const decoded = decode(value);
    result[key] = decoded;
    if (decoded !== value) changed = true;
  }
  return changed ? result : obj;
}
