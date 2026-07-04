import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineRillContract } from '../../../contract';
import { createWasmGuestEngine } from '../wasm-guest-view';

// A render-only native guest (renders View > [Text, View > Text]).
const UI_GUEST = readFileSync(join(import.meta.dir, 'fixtures/ui-guest.wasm'));

// An empty host-capability contract (ui-guest makes no host:* calls).
const emptyContract = defineRillContract({ version: '1', hostModules: {}, guestExports: {} });

describe('createWasmGuestEngine — native guest as an EngineViewEngine', () => {
  it('drives a native guest through the EngineViewEngine surface (like useEngineView)', async () => {
    const engine = createWasmGuestEngine({
      wasmBytes: UI_GUEST,
      contract: emptyContract,
      hostModules: {},
      // biome-ignore lint/suspicious/noExplicitAny: opaque materializers, irrelevant here.
      components: { View: 'View' as any, Text: 'Text' as any },
    });

    let updates = 0;
    const unsub = engine.on('update', () => {
      updates++;
    });

    expect(engine.isLoaded).toBe(false);

    // useEngineView's sequence: createReceiver() then loadBundle().
    engine.createReceiver();
    await engine.loadBundle();

    expect(engine.isLoaded).toBe(true);
    expect(updates).toBeGreaterThan(0); // the guest's render batch fired an 'update'

    // Same receiver surface as the JS Engine — content is materialized.
    const tree = engine.getReceiver()?.getComponentTree();
    expect(tree?.type).toBe('View');
    expect(tree?.children[0].props.text).toBe('hello from rust');

    unsub();
    engine.destroy();
    expect(engine.isDestroyed).toBe(true);
  });

  it('forwards events via sendEvent without throwing', async () => {
    const engine = createWasmGuestEngine({
      wasmBytes: UI_GUEST,
      contract: emptyContract,
      hostModules: {},
      // biome-ignore lint/suspicious/noExplicitAny: opaque materializers, irrelevant here.
      components: { View: 'View' as any, Text: 'Text' as any },
    });
    engine.createReceiver();
    await engine.loadBundle();
    // ui-guest has no rill_on_event handler; sendEvent must be a safe no-op.
    expect(() => engine.sendEvent('key', 'a')).not.toThrow();
  });
});
