import { describe, expect, it } from 'bun:test';
import { DefaultProvider } from '../../sandbox/index';
import { Engine } from '../../engine';

// Check if a timeout-capable provider is available
// NodeVMProvider uses node:vm timeout; Web/WASM providers don't have hard interrupts.
const testProvider = new DefaultProvider({ timeout: 100 });
const canInterruptLoop = testProvider.resolvedProvider.constructor.name === 'NodeVMProvider';

describe('DefaultProvider (auto) - Node/Web', () => {
  it('simple eval without passing provider', async () => {
    const engine = new Engine({ debug: false });
    await engine.loadBundle('var a = 1 + 2;');
    expect(engine.isLoaded).toBe(true);
    engine.destroy();
  });

  it('JSX shim available by default', async () => {
    const engine = new Engine({ debug: false });
    const code = `
      const a = ReactJSXRuntime.jsx('View', { id: 'ok', children: 'hi' });
    `;
    await engine.loadBundle(code);
    expect(engine.isLoaded).toBe(true);
    engine.destroy();
  });

  // Skip this test if we're using NoSandboxProvider, as it
  // cannot interrupt infinite loops (it uses eval which blocks forever)
  it.skipIf(!canInterruptLoop)('dead-loop should be interrupted by timeout', async () => {
    // This test relies on the default provider (NodeVMProvider in this env)
    // to handle the timeout correctly via the engine's timeout option.
    const engine = new Engine({
      debug: false,
      timeout: 100, // Use a short timeout
    });
    let threw = false;
    // biome-ignore lint/suspicious/noExplicitAny: Test data has dynamic structure
    let error: any;
    try {
      await engine.loadBundle('for(;;){}');
    } catch (e) {
      threw = true;
      error = e;
    }
    expect(threw).toBe(true);
    // The NodeVMProvider should throw a distinctive error
    expect(error.message).toContain('Script execution timed out');
    engine.destroy();
  });
});
