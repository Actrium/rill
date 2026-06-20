import { describe, expect, it } from 'bun:test';
import { Bridge } from './bridge';
import type { SerializedValueObject } from '../types';

describe('Bridge.extractFnIds', () => {
  it('should extract fnIds from serialized props', () => {
    const props: SerializedValueObject = {
      onPress: {
        __type: 'function',
        __fnId: 'fn_test_1',
      },
    };

    const fnIds = Bridge.extractFnIds(props);
    console.log('[TEST] Extracted fnIds:', Array.from(fnIds));
    expect(fnIds.size).toBe(1);
    expect(fnIds.has('fn_test_1')).toBe(true);
  });

  it('should extract nested fnIds', () => {
    const props: SerializedValueObject = {
      handlers: {
        onPress: {
          __type: 'function',
          __fnId: 'fn_test_1',
        },
        onLongPress: {
          __type: 'function',
          __fnId: 'fn_test_2',
        },
      },
    };

    const fnIds = Bridge.extractFnIds(props);
    console.log('[TEST] Extracted nested fnIds:', Array.from(fnIds));
    expect(fnIds.size).toBe(2);
    expect(fnIds.has('fn_test_1')).toBe(true);
    expect(fnIds.has('fn_test_2')).toBe(true);
  });
});
