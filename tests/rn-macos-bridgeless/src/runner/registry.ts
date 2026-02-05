export type TestStatus = 'idle' | 'running' | 'passed' | 'failed';

export interface TestCase {
  id: string;
  name: string;
  tags?: string[];
  run: () => void | Promise<void>;
}

export interface TestResult {
  id: string;
  name: string;
  status: TestStatus;
  durationMs?: number;
  error?: { message: string; stack?: string };
}

const tests: TestCase[] = [];

/** Per-test timeout in milliseconds. Prevents a single hung test from blocking the entire suite. */
const TEST_TIMEOUT_MS = 15_000;

export function registerTest(test: TestCase) {
  tests.push(test);
}

export function getTests(): TestCase[] {
  return [...tests];
}

export async function runTests(options?: {
  filter?: (t: TestCase) => boolean;
  onUpdate?: (result: TestResult) => void;
}): Promise<TestResult[]> {
  const selected = options?.filter ? tests.filter(options.filter) : tests;
  const results: TestResult[] = [];

  for (const t of selected) {
    const started = Date.now();
    const running: TestResult = { id: t.id, name: t.name, status: 'running' };
    options?.onUpdate?.(running);

    try {
      const runResult = t.run();
      if (runResult && typeof (runResult as Promise<void>).then === 'function') {
        // Async test: race against timeout
        await Promise.race([
          runResult,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Test timed out after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS)
          ),
        ]);
      }
      const passed: TestResult = {
        id: t.id,
        name: t.name,
        status: 'passed',
        durationMs: Date.now() - started,
      };
      results.push(passed);
      options?.onUpdate?.(passed);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const failed: TestResult = {
        id: t.id,
        name: t.name,
        status: 'failed',
        durationMs: Date.now() - started,
        error: { message: err.message, stack: err.stack },
      };
      results.push(failed);
      options?.onUpdate?.(failed);
    }
  }

  return results;
}
