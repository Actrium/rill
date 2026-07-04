import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../engine';
import { ComponentRegistry } from '../../registry';
import { Receiver } from '../../receiver';
import { WasmGuestHost } from '../../wasm-guest/wasm-guest-host';
import { MockComponents } from '../e2e/helpers/mock-components';
import { waitFor } from '../e2e/helpers/test-utils';

// The native guest from the wasm-guest suite: renders View > [Text, View > Text].
const UI_GUEST = readFileSync(
  join(import.meta.dir, '../../wasm-guest/__tests__/fixtures/ui-guest.wasm')
);

// A JS guest bundle (runs in the Engine's node-vm sandbox).
const JS_GUEST = `
  const { render } = require('rill/reconciler');
  function App() {
    return React.createElement('View', { testID: 'js-only' },
      React.createElement('Text', null, 'from js'));
  }
  render(React.createElement(App), globalThis.__rill_sendBatch);
`;

// One host process, two guest kinds (QuickJS-style JS guest via Engine + native
// WASM guest via WasmGuestHost). They must coexist and stay isolated — each
// renders into its own receiver with no cross-talk. Run from src/ (React interop).
describe('mixed guests — a JS guest and a native WASM guest coexist, isolated', () => {
  it('each guest renders into its own receiver with no cross-talk', async () => {
    // --- JS guest via the Engine (node-vm sandbox) ---
    const engine = new Engine({
      sandbox: 'node-vm',
      debug: false,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    engine.register(MockComponents);
    const jsReceiver = engine.createReceiver();
    await engine.loadBundle(JS_GUEST);
    await waitFor(() => jsReceiver.nodeCount > 0, 5000);

    // --- native WASM guest via WasmGuestHost ---
    const registry = new ComponentRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: opaque materializer, irrelevant here.
    registry.register('View', 'View' as any);
    // biome-ignore lint/suspicious/noExplicitAny: opaque materializer, irrelevant here.
    registry.register('Text', 'Text' as any);
    const nativeReceiver = new Receiver(
      registry,
      () => {},
      () => {}
    );
    const host = new WasmGuestHost({
      dispatch: {},
      onRenderBatch: (b) => nativeReceiver.applyBatch(b),
    });
    await host.load(UI_GUEST);

    // --- both rendered, each into its own tree ---
    const jsTree = jsReceiver.getComponentTree();
    const nativeTree = nativeReceiver.getComponentTree();

    expect(jsTree?.type).toBe('View');
    expect(jsTree?.props.testID).toBe('js-only');
    expect(JSON.stringify(jsTree)).toContain('from js');

    expect(nativeTree?.type).toBe('View');
    expect(nativeTree?.children[0].props.text).toBe('hello from rust');

    // Isolation: neither receiver sees the other guest's content.
    expect(JSON.stringify(jsTree)).not.toContain('hello from rust');
    expect(JSON.stringify(nativeTree)).not.toContain('from js');

    await engine.destroy();
  });
});
