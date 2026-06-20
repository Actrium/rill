import { describe, expect, test } from 'bun:test';
import { CallbackRegistryImpl as CallbackRegistry } from '..';
import { Bridge } from './bridge';

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Bridge - sendPromiseResult safety', () => {
  test('should not create unhandledRejection when onHostMessage rejects', async () => {
    const registry = new CallbackRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: Test helper tracks messages with dynamic structure
    const guestReceived: any[] = [];

    const bridge = new Bridge({
      callbackRegistry: registry,
      onGuestOperations: () => {},
      onHostMessage: async (msg) => {
        guestReceived.push(msg);
        throw new Error('onHostMessage boom');
      },
      debug: true,
    });

    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };

    // Attach listener temporarily
    process.once('unhandledRejection', onUnhandled);

    // Trigger PromiseManager -> sendPromiseResult -> sendToGuest -> onHostMessage throw
    bridge.sendRawBatch({
      version: 1,
      batchId: 1,
      operations: [
        {
          op: 'CREATE',
          id: 1,
          type: 'AsyncComponent',
          props: { asyncData: Promise.resolve('ok') },
        },
      ],
    });

    // Give the promise chain time to run
    await wait(50);

    // Cleanup: remove listener if it wasn't used
    process.removeListener('unhandledRejection', onUnhandled);

    expect(unhandled).toBeNull();
    expect(guestReceived.length).toBeGreaterThan(0);
  });
});
