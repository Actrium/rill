import { describe, expect, it } from 'bun:test';
import vm from 'node:vm';
import { NodeVMProvider } from '../../sandbox/index';
import { Engine } from '../../engine';

// These tests are specific to the NodeVMProvider and should only run in a Node.js/Bun environment.
describe.skipIf(!vm)('NodeVMProvider', () => {
  it('should interrupt a dead-loop with a timeout', async () => {
    const engine = new Engine({
      sandbox: 'node-vm',
      debug: false,
      timeout: 100,
    });

    let threw = false;
    let error: Error | null = null;
    try {
      await engine.loadBundle('for(;;){}');
    } catch (e) {
      threw = true;
      if (e instanceof Error) {
        error = e;
      }
    }

    expect(threw).toBe(true);
    expect(error?.message).toContain('Script execution timed out');
    engine.destroy();
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
});
