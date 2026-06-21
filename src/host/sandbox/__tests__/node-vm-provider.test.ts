import { describe, expect, it } from 'bun:test';
import vm from 'node:vm';
import { NodeVMProvider } from '../providers/node-vm-provider';

// These tests are specific to the NodeVMProvider and should only run in a Node.js/Bun environment.
describe.skipIf(!vm)('NodeVMProvider', () => {
  it('should create runtime and context', () => {
    const provider = new NodeVMProvider({ timeout: 1000 });
    const runtime = provider.createRuntime();
    const context = runtime.createContext();

    expect(runtime).toBeDefined();
    expect(context).toBeDefined();
    expect(context.eval).toBeDefined();
    expect(context.inject).toBeDefined();
    expect(context.extract).toBeDefined();
    expect(context.dispose).toBeDefined();

    context.dispose();
    runtime.dispose();
  });

  it('should execute code in isolated context', () => {
    const provider = new NodeVMProvider({ timeout: 1000 });
    const runtime = provider.createRuntime();
    const context = runtime.createContext();

    // Set a global
    context.inject('myVar', 42);

    // Eval code that uses the global
    const result = context.eval('myVar + 8');
    expect(result).toBe(50);

    // Clean up
    context.dispose();
    runtime.dispose();
  });

  it('should interrupt a dead-loop with a timeout', () => {
    const provider = new NodeVMProvider({ timeout: 100 });
    const runtime = provider.createRuntime();
    const context = runtime.createContext();

    let threw = false;
    let error: Error | null = null;
    try {
      context.eval('for(;;){}');
    } catch (e) {
      threw = true;
      if (e instanceof Error) {
        error = e;
      }
    }

    expect(threw).toBe(true);
    expect(error?.message).toContain('Script execution timed out');

    context.dispose();
    runtime.dispose();
  });

  it('should handle dispose correctly', () => {
    const provider = new NodeVMProvider({ timeout: 1000 });
    const runtime = provider.createRuntime();
    const context = runtime.createContext();

    // Set up context state
    context.inject('testVar', 123);
    expect(context.extract('testVar')).toBe(123);

    // Dispose context
    context.dispose();

    // Dispose runtime
    runtime.dispose();

    // Should not throw
    expect(true).toBe(true);
  });

  it('should use default timeout when not specified', () => {
    const provider = new NodeVMProvider(); // No timeout specified
    const runtime = provider.createRuntime();
    const context = runtime.createContext();

    // Should work with default timeout
    const result = context.eval('1 + 1');
    expect(result).toBe(2);

    context.dispose();
    runtime.dispose();
  });

  it('should support global functions', () => {
    const provider = new NodeVMProvider({ timeout: 1000 });
    const runtime = provider.createRuntime();
    const context = runtime.createContext();

    const calls: number[] = [];
    context.inject('track', (n: number) => calls.push(n));

    context.eval('track(1); track(2); track(3);');
    expect(calls).toEqual([1, 2, 3]);

    context.dispose();
    runtime.dispose();
  });

  it('should isolate between contexts', () => {
    const provider = new NodeVMProvider({ timeout: 1000 });
    const runtime = provider.createRuntime();
    const context1 = runtime.createContext();
    const context2 = runtime.createContext();

    context1.inject('shared', 'context1');
    context2.inject('shared', 'context2');

    expect(context1.extract('shared')).toBe('context1');
    expect(context2.extract('shared')).toBe('context2');

    context1.dispose();
    context2.dispose();
    runtime.dispose();
  });
});
