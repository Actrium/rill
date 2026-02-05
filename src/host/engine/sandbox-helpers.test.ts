/**
 * Sandbox Helper Functions Tests
 *
 * Tests for console formatting and sandbox global utilities
 */

import { describe, expect, test } from 'bun:test';
import {
  CONSOLE_SETUP_CODE,
  createCommonJSGlobals,
  createReactNativeShim,
  formatArg,
  formatConsoleArgs,
  formatWithPlaceholders,
  RUNTIME_HELPERS_CODE,
} from './sandbox-helpers';

describe('SandboxHelpers', () => {
  describe('formatArg()', () => {
    test('should handle null and undefined', () => {
      expect(formatArg(null)).toBe(null);
      expect(formatArg(undefined)).toBe(undefined);
    });

    test('should handle primitives', () => {
      expect(formatArg(123)).toBe(123);
      expect(formatArg('hello')).toBe('hello');
      expect(formatArg(true)).toBe(true);
      expect(formatArg(false)).toBe(false);
    });

    test('should handle arrays', () => {
      expect(formatArg([1, 2, 3])).toEqual([1, 2, 3]);
      expect(formatArg(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
      expect(formatArg([1, 'two', true, null])).toEqual([1, 'two', true, null]);
    });

    test('should handle nested arrays', () => {
      const input = [1, [2, [3, [4]]]];
      const output = formatArg(input);
      expect(output).toEqual([1, [2, [3, [4]]]]);
    });

    test('should handle plain objects', () => {
      const input = { a: 1, b: 'two', c: true };
      const output = formatArg(input);
      expect(output).toEqual({ a: 1, b: 'two', c: true });
    });

    test('should handle nested objects', () => {
      const input = { a: { b: { c: 'd' } } };
      const output = formatArg(input);
      expect(output).toEqual({ a: { b: { c: 'd' } } });
    });

    test('should handle circular references in objects', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      const output = formatArg(circular);
      expect(output).toEqual({ a: 1, self: '[Circular]' });
    });

    test('should handle circular references in arrays', () => {
      const circular: unknown[] = [1, 2];
      circular.push(circular);

      const output = formatArg(circular);
      expect(output).toEqual([1, 2, '[Circular]']);
    });

    test('should handle deep circular references', () => {
      const obj: Record<string, unknown> = { a: { b: {} } };
      (obj.a as Record<string, unknown>).b = obj;

      const output = formatArg(obj);
      expect(output).toEqual({ a: { b: '[Circular]' } });
    });

    test('should fallback to String() on error', () => {
      const badObj = {
        get key() {
          throw new Error('getter error');
        },
      };

      const output = formatArg(badObj);
      expect(typeof output).toBe('string');
    });

    test('should handle mixed nested structures', () => {
      const input = {
        array: [1, 2, { nested: 'obj' }],
        obj: { arr: [3, 4] },
        primitive: 'test',
      };

      const output = formatArg(input);
      expect(output).toEqual({
        array: [1, 2, { nested: 'obj' }],
        obj: { arr: [3, 4] },
        primitive: 'test',
      });
    });
  });

  describe('formatWithPlaceholders()', () => {
    test('should handle %s (string) placeholder', () => {
      expect(formatWithPlaceholders('Hello %s', ['world'])).toBe('Hello world');
      expect(formatWithPlaceholders('%s %s', ['foo', 'bar'])).toBe('foo bar');
    });

    test('should handle %d (integer) placeholder', () => {
      expect(formatWithPlaceholders('Number: %d', [42])).toBe('Number: 42');
      expect(formatWithPlaceholders('%d + %d = %d', [1, 2, 3])).toBe('1 + 2 = 3');
    });

    test('should handle %i (integer) placeholder', () => {
      expect(formatWithPlaceholders('Count: %i', [10])).toBe('Count: 10');
    });

    test('should handle %f (float) placeholder', () => {
      expect(formatWithPlaceholders('Pi: %f', [3.14])).toBe('Pi: 3.14');
    });

    test('should handle %o (object) placeholder', () => {
      const result = formatWithPlaceholders('Data: %o', [{ key: 'value' }]);
      expect(result).toContain('Data:');
      expect(result).toContain('key');
      expect(result).toContain('value');
    });

    test('should handle %O (object) placeholder', () => {
      const result = formatWithPlaceholders('Data: %O', [{ key: 'value' }]);
      expect(result).toContain('Data:');
      expect(result).toContain('key');
      expect(result).toContain('value');
    });

    test('should handle multiple different placeholders', () => {
      const result = formatWithPlaceholders('String: %s, Number: %d, Float: %f', [
        'test',
        42,
        3.14,
      ]);
      expect(result).toBe('String: test, Number: 42, Float: 3.14');
    });

    test('should handle more placeholders than params', () => {
      const result = formatWithPlaceholders('%s %s %s', ['one', 'two']);
      expect(result).toBe('one two ');
    });

    test('should handle fewer placeholders than params', () => {
      const result = formatWithPlaceholders('%s', ['one', 'two', 'three']);
      expect(result).toBe('one');
    });

    test('should handle no placeholders', () => {
      expect(formatWithPlaceholders('no placeholders', ['ignored'])).toBe('no placeholders');
    });

    test('should handle empty params', () => {
      expect(formatWithPlaceholders('Hello %s', [])).toBe('Hello ');
    });

    test('should handle object with circular reference in %o', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      const result = formatWithPlaceholders('Obj: %o', [circular]);
      expect(result).toContain('Obj:');
      expect(result).toContain('[Circular]');
    });

    test('should fallback to String() when JSON.stringify fails', () => {
      const badObj = {
        toJSON() {
          throw new Error('toJSON error');
        },
      };

      const result = formatWithPlaceholders('Bad: %o', [badObj]);
      expect(typeof result).toBe('string');
    });
  });

  describe('formatConsoleArgs()', () => {
    test('should handle simple args without placeholders', () => {
      const result = formatConsoleArgs(['hello', 'world', 123]);
      expect(result).toEqual(['hello', 'world', 123]);
    });

    test('should format template with placeholders', () => {
      const result = formatConsoleArgs(['Hello %s, you are %d years old', 'Alice', 30]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('Hello Alice, you are 30 years old');
    });

    test('should include remaining args after template', () => {
      const result = formatConsoleArgs(['Name: %s', 'Bob', 'extra', 'args']);
      expect(result).toHaveLength(3);
      expect(result[0]).toBe('Name: Bob');
      expect(result[1]).toBe('extra');
      expect(result[2]).toBe('args');
    });

    test('should stringify object args', () => {
      const result = formatConsoleArgs([{ key: 'value' }, { num: 123 }]);
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('key');
      expect(result[0]).toContain('value');
      expect(result[1]).toContain('num');
      expect(result[1]).toContain('123');
    });

    test('should handle objects with circular references', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      const result = formatConsoleArgs([circular]);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('[Circular]');
    });

    test('should handle mixed primitives and objects', () => {
      const result = formatConsoleArgs(['text', 123, { obj: 'data' }, true]);
      expect(result).toHaveLength(4);
      expect(result[0]).toBe('text');
      expect(result[1]).toBe(123);
      expect(typeof result[2]).toBe('string');
      expect(result[3]).toBe(true);
    });

    test('should handle template with remaining object args', () => {
      const result = formatConsoleArgs(['Count: %d', 5, { extra: 'data' }]);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Count: 5');
      expect(typeof result[1]).toBe('string');
      expect(result[1]).toContain('extra');
    });

    test('should fallback to formatArg when JSON.stringify fails', () => {
      const badObj = {
        toJSON() {
          throw new Error('error');
        },
      };

      const result = formatConsoleArgs([badObj]);
      expect(result).toHaveLength(1);
      expect(typeof result[0]).toBe('object'); // formatArg returns the object itself on error fallback
    });

    test('should handle empty args', () => {
      const result = formatConsoleArgs([]);
      expect(result).toEqual([]);
    });
  });

  describe('createCommonJSGlobals()', () => {
    test('should create module and exports objects', () => {
      const globals = createCommonJSGlobals();

      expect(globals).toHaveProperty('module');
      expect(globals).toHaveProperty('exports');
      expect(globals.module).toHaveProperty('exports');
      expect(globals.module.exports).toBe(globals.exports);
    });

    test('should initialize exports as empty object', () => {
      const globals = createCommonJSGlobals();
      expect(globals.exports).toEqual({});
    });

    test('should allow mutations', () => {
      const globals = createCommonJSGlobals();
      globals.exports.test = 'value';

      expect(globals.module.exports.test).toBe('value');
    });
  });

  describe('createReactNativeShim()', () => {
    test('should create shim with Platform', () => {
      const shim = createReactNativeShim();

      expect(shim.Platform).toBeDefined();
      expect(shim.Platform.OS).toBe('web');
    });

    test('should have Platform.select() that prefers web', () => {
      const shim = createReactNativeShim();

      expect(shim.Platform.select({ ios: 'iOS', android: 'Android', web: 'Web' })).toBe('Web');
      expect(shim.Platform.select({ ios: 'iOS', default: 'Default' })).toBe('Default');
    });

    test('should create shim with StyleSheet', () => {
      const shim = createReactNativeShim();

      const styles = { container: { flex: 1 } };
      expect(shim.StyleSheet.create(styles)).toBe(styles);
    });

    test('should create shim with component names', () => {
      const shim = createReactNativeShim();

      expect(shim.View).toBe('View');
      expect(shim.Text).toBe('Text');
      expect(shim.TouchableOpacity).toBe('TouchableOpacity');
    });

    test('should create shim with Image utilities', () => {
      const shim = createReactNativeShim();

      expect(shim.Image).toBeDefined();
      expect(shim.Image.type).toBe('Image');
      expect(shim.Image.resolveAssetSource({ uri: 'test' })).toEqual({ uri: 'test' });
    });

    test('should handle Image.prefetch()', async () => {
      const shim = createReactNativeShim();
      const result = await shim.Image.prefetch('https://example.com/image.png');
      expect(result).toBe(true);
    });

    test('should handle Image.queryCache()', async () => {
      const shim = createReactNativeShim();
      const result = await shim.Image.queryCache(['uri1', 'uri2']);
      expect(result).toEqual({});
    });

    test('should handle Image.getSize() with callback', () => {
      const shim = createReactNativeShim();

      let width = -1;
      let height = -1;
      shim.Image.getSize('uri', (w, h) => {
        width = w;
        height = h;
      });

      expect(width).toBe(0);
      expect(height).toBe(0);
    });

    test('should handle Image.getSize() without callback', () => {
      const shim = createReactNativeShim();
      expect(() => shim.Image.getSize('uri')).not.toThrow();
    });
  });

  describe('CONSOLE_SETUP_CODE', () => {
    test('should be valid JavaScript code', () => {
      expect(() => new Function(CONSOLE_SETUP_CODE)).not.toThrow();
    });

    test('should define console methods', () => {
      const sandbox = { __console_log: () => {}, __console_warn: () => {} };
      const code = `
        ${CONSOLE_SETUP_CODE}
        return typeof console !== 'undefined' && typeof console.log === 'function';
      `;
      const fn = new Function('__console_log', '__console_warn', code);
      expect(fn.call(sandbox, sandbox.__console_log, sandbox.__console_warn)).toBe(true);
    });
  });

  describe('RUNTIME_HELPERS_CODE', () => {
    test('should be valid JavaScript code', () => {
      expect(() => new Function(RUNTIME_HELPERS_CODE)).not.toThrow();
    });

    test('should define global helpers', () => {
      const code = `
        ${RUNTIME_HELPERS_CODE}
        return typeof globalThis.__rill.registerCallback === 'function';
      `;
      const fn = new Function(code);
      expect(fn()).toBe(true);
    });

    test('should be idempotent', () => {
      // First, run once and capture the value
      const setupCode = `
        ${RUNTIME_HELPERS_CODE}
        return globalThis.__rill.callbackId;
      `;
      const valueBefore = new Function(setupCode)();

      // Now run twice more and verify the value doesn't change
      const code = `
        ${RUNTIME_HELPERS_CODE}
        ${RUNTIME_HELPERS_CODE}
        return globalThis.__rill.callbackId;
      `;
      const fn = new Function(code);
      expect(fn()).toBe(valueBefore);
    });
  });
});
