/**
 * Sandbox compatibility helpers for guest-bundle code.
 *
 * Guest sandboxes (iOS JSC, Android Hermes, QuickJS native/wasm) provide only
 * core ECMAScript intrinsics — web platform globals like `performance` and
 * `TextEncoder` are NOT guaranteed. Everything in the guest bundle that needs
 * them must go through these call-time-checked helpers instead of touching the
 * globals directly. Checks are deliberately performed on every call (not at
 * module eval) so a host that injects the globals after bundle load is picked
 * up, and so tests can simulate a bare sandbox by deleting them.
 */

interface MaybePerformance {
  performance?: { now?: () => number };
}

/**
 * Monotonic-ish milliseconds: `performance.now()` when the sandbox has it,
 * `Date.now()` otherwise. Fallback resolution is ~1ms — fine for the
 * diagnostics/stats callers this is meant for; do not use for wire data.
 */
export function nowMs(): number {
  const p = (globalThis as MaybePerformance).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

/**
 * Returns a UTF-8 encode function, byte-identical to `TextEncoder.encode` —
 * including lone surrogates, which encode as U+FFFD (ef bf bd) per WHATWG.
 * Uses a single shared TextEncoder when the sandbox has one, a pure-JS
 * fallback otherwise; the wire decoders on the host side use a fatal
 * TextDecoder, so byte-exact output is a hard requirement. Call once per
 * batch/scope and reuse the returned function inside loops.
 */
export function createUtf8Encoder(): (str: string) => Uint8Array {
  const encoderCtor = (globalThis as { TextEncoder?: typeof TextEncoder }).TextEncoder;
  if (typeof encoderCtor === 'function') {
    const encoder = new encoderCtor();
    return (str) => encoder.encode(str);
  }
  return encodeUtf8Fallback;
}

function encodeUtf8Fallback(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    // Reason: i < str.length guarantees a code point at i
    let cp = str.codePointAt(i) as number;
    if (cp > 0xffff) {
      i++; // consumed a full surrogate pair
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd; // lone surrogate → replacement char, matching TextEncoder
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return Uint8Array.from(out);
}
