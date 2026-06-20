export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!(k in b)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

export function expect<T>(received: T) {
  const not = {
    toBe(expected: unknown) {
      if (Object.is(received, expected)) {
        throw new AssertionError(`Expected value not to be ${String(expected)}`);
      }
    },
    toBeNull() {
      if (received === null) throw new AssertionError('Expected value not to be null');
    },
    toBeUndefined() {
      if (received === undefined) throw new AssertionError('Expected value not to be undefined');
    },
  };

  return {
    not,
    toBe(expected: unknown) {
      if (!Object.is(received, expected)) {
        throw new AssertionError(`Expected ${String(received)} to be ${String(expected)}`);
      }
    },
    toEqual(expected: unknown) {
      if (!deepEqual(received, expected)) {
        throw new AssertionError(`Expected ${JSON.stringify(received)} to equal ${JSON.stringify(expected)}`);
      }
    },
    toBeTruthy() {
      if (!received) throw new AssertionError(`Expected ${String(received)} to be truthy`);
    },
    toBeFalsy() {
      if (received) throw new AssertionError(`Expected ${String(received)} to be falsy`);
    },
    toBeNull() {
      if (received !== null) throw new AssertionError(`Expected ${String(received)} to be null`);
    },
    toBeUndefined() {
      if (received !== undefined) throw new AssertionError(`Expected ${String(received)} to be undefined`);
    },
    toBeDefined() {
      if (received === undefined) throw new AssertionError(`Expected value to be defined, but got undefined`);
    },
  };
}
