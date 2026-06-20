/**
 * SDK Hooks Tests
 *
 * Tests for useHostEvent, useConfig, useSendToHost, and useRemoteRef hooks
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

describe('SDK Hooks', () => {
  let React: typeof import('react');
  let TestRenderer: typeof import('react-test-renderer');
  let act: typeof import('react-test-renderer').act;
  let sdk: typeof import('../../../sdk/sdk');

  beforeAll(async () => {
    React = await import('react');
    const testRendererModule = await import('react-test-renderer');
    TestRenderer = testRendererModule.default;
    act = testRendererModule.act;

    // Set React on globalThis for SDK (especially RillErrorBoundary)
    (globalThis as Record<string, unknown>).React = React;

    sdk = await import('../../../sdk/sdk');
  });

  describe('useHostEvent()', () => {
    let cleanup: (() => void)[];

    beforeEach(() => {
      cleanup = [];
      // Setup mock global
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      (globalThis as Record<string, unknown>).__rill_onHostEvent = (
        eventName: string,
        callback: (payload: unknown) => void
      ) => {
        if (!listeners.has(eventName)) {
          listeners.set(eventName, new Set());
        }
        listeners.get(eventName)?.add(callback);

        const unsubscribe = () => {
          listeners.get(eventName)?.delete(callback);
        };
        cleanup.push(unsubscribe);
        return unsubscribe;
      };

      // Helper to trigger events
      (globalThis as Record<string, unknown>).__triggerHostEvent = (
        eventName: string,
        payload: unknown
      ) => {
        listeners.get(eventName)?.forEach((cb) => cb(payload));
      };
    });

    afterEach(() => {
      cleanup.forEach((fn) => fn());
      delete (globalThis as Record<string, unknown>).__rill_onHostEvent;
      delete (globalThis as Record<string, unknown>).__triggerHostEvent;
    });

    test('should subscribe to host events', () => {
      const received: unknown[] = [];

      const TestComponent = () => {
        sdk.useHostEvent('TEST_EVENT', (payload) => {
          received.push(payload);
        });
        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      // Trigger event
      const trigger = (globalThis as Record<string, unknown>).__triggerHostEvent as (
        name: string,
        payload: unknown
      ) => void;

      act(() => {
        trigger('TEST_EVENT', { data: 'hello' });
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ data: 'hello' });

      act(() => {
        renderer.unmount();
      });
    });

    test('should unsubscribe on unmount', () => {
      const received: unknown[] = [];

      const TestComponent = () => {
        sdk.useHostEvent('UNMOUNT_TEST', (payload) => {
          received.push(payload);
        });
        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      const trigger = (globalThis as Record<string, unknown>).__triggerHostEvent as (
        name: string,
        payload: unknown
      ) => void;

      // Trigger before unmount
      act(() => {
        trigger('UNMOUNT_TEST', 'before');
      });

      expect(received).toHaveLength(1);

      // Unmount
      act(() => {
        renderer.unmount();
      });

      // Trigger after unmount - should not receive
      act(() => {
        trigger('UNMOUNT_TEST', 'after');
      });

      expect(received).toHaveLength(1); // Still 1, not 2
    });

    test('should handle callback updates', () => {
      const received: unknown[] = [];
      let callback = (payload: unknown) => received.push({ v: 1, payload });

      const TestComponent = ({ cb }: { cb: (p: unknown) => void }) => {
        sdk.useHostEvent('CALLBACK_UPDATE', cb);
        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent, { cb: callback }));
      });

      const trigger = (globalThis as Record<string, unknown>).__triggerHostEvent as (
        name: string,
        payload: unknown
      ) => void;

      act(() => {
        trigger('CALLBACK_UPDATE', 'first');
      });

      // Update callback
      callback = (payload: unknown) => received.push({ v: 2, payload });

      act(() => {
        renderer.update(React.createElement(TestComponent, { cb: callback }));
      });

      act(() => {
        trigger('CALLBACK_UPDATE', 'second');
      });

      expect(received).toHaveLength(2);
      expect(received[0]).toEqual({ v: 1, payload: 'first' });
      expect(received[1]).toEqual({ v: 2, payload: 'second' });

      act(() => {
        renderer.unmount();
      });
    });

    test('should handle missing __rill_onHostEvent gracefully', () => {
      delete (globalThis as Record<string, unknown>).__rill_onHostEvent;

      const TestComponent = () => {
        sdk.useHostEvent('MISSING', () => {});
        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      expect(() => {
        act(() => {
          renderer = TestRenderer.create(React.createElement(TestComponent));
        });
      }).not.toThrow();

      act(() => {
        renderer.unmount();
      });
    });
  });

  describe('useConfig()', () => {
    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__rill_getConfig;
    });

    test('should return config from global', () => {
      (globalThis as Record<string, unknown>).__rill_getConfig = () => ({
        theme: 'dark',
        apiUrl: 'https://api.example.com',
      });

      const TestComponent = () => {
        const config = sdk.useConfig<{ theme: string; apiUrl: string }>();
        return React.createElement('div', null, `${config.theme}:${config.apiUrl}`);
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      const output = renderer.toJSON();
      expect((output as { children: string[] })?.children?.[0]).toBe(
        'dark:https://api.example.com'
      );

      act(() => {
        renderer.unmount();
      });
    });

    test('should return empty object when __rill_getConfig is missing', () => {
      const TestComponent = () => {
        const config = sdk.useConfig();
        return React.createElement('div', null, Object.keys(config).length.toString());
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      const output = renderer.toJSON();
      expect((output as { children: string[] })?.children?.[0]).toBe('0');

      act(() => {
        renderer.unmount();
      });
    });
  });

  describe('useSendToHost()', () => {
    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__rill_emitEvent;
    });

    test('should return send function', () => {
      const sentEvents: Array<{ name: string; payload: unknown }> = [];

      (globalThis as Record<string, unknown>).__rill_emitEvent = (
        eventName: string,
        payload?: unknown
      ) => {
        sentEvents.push({ name: eventName, payload });
      };

      const TestComponent = () => {
        const send = sdk.useSendToHost();
        React.useEffect(() => {
          send('INIT', { version: '1.0' });
        }, [send]);
        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      expect(sentEvents).toHaveLength(1);
      expect(sentEvents[0]).toEqual({ name: 'INIT', payload: { version: '1.0' } });

      act(() => {
        renderer.unmount();
      });
    });

    test('should handle missing __rill_emitEvent gracefully', () => {
      const consoleLogs: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => consoleLogs.push(args.join(' '));

      try {
        const TestComponent = () => {
          const send = sdk.useSendToHost();
          React.useEffect(() => {
            send('TEST');
          }, [send]);
          return React.createElement('div', null, 'Test');
        };

        let renderer: ReturnType<typeof TestRenderer.create>;
        act(() => {
          renderer = TestRenderer.create(React.createElement(TestComponent));
        });

        expect(consoleLogs.some((log) => log.includes('not available'))).toBe(true);

        act(() => {
          renderer.unmount();
        });
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('useRemoteRef() basic functionality', () => {
    let sentOps: unknown[];
    let eventListeners: Map<string, Set<(payload: unknown) => void>>;

    beforeEach(() => {
      sentOps = [];
      eventListeners = new Map();

      (globalThis as Record<string, unknown>).__rill_sendOperation = (op: unknown) => {
        sentOps.push(op);
      };

      (globalThis as Record<string, unknown>).__rill_onHostEvent = (
        eventName: string,
        callback: (payload: unknown) => void
      ) => {
        if (!eventListeners.has(eventName)) {
          eventListeners.set(eventName, new Set());
        }
        eventListeners.get(eventName)?.add(callback);
        return () => eventListeners.get(eventName)?.delete(callback);
      };
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__rill_sendOperation;
      delete (globalThis as Record<string, unknown>).__rill_onHostEvent;
    });

    test('should return refCallback and null initially', () => {
      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();
        return React.createElement(
          'div',
          null,
          `hasCallback:${typeof refCallback === 'function'},hasRef:${remoteRef !== null}`
        );
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      const output = renderer.toJSON();
      expect((output as { children: string[] })?.children?.[0]).toBe(
        'hasCallback:true,hasRef:false'
      );

      act(() => {
        renderer.unmount();
      });
    });

    test('should create remoteRef when callback is called', () => {
      let capturedRef: ReturnType<typeof sdk.useRemoteRef>[1] = null;

      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();
        capturedRef = remoteRef;

        React.useEffect(() => {
          refCallback({ nodeId: 42 });
        }, [refCallback]);

        return React.createElement('div', null, remoteRef ? 'has-ref' : 'no-ref');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      expect(capturedRef).not.toBe(null);
      expect(capturedRef?.nodeId).toBe(42);

      act(() => {
        renderer.unmount();
      });
    });

    test('should send REF_CALL operation when invoke is called', async () => {
      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();

        React.useEffect(() => {
          refCallback({ nodeId: 99 });

          if (remoteRef) {
            remoteRef.invoke('focus').catch(() => {});
          }
        }, [refCallback, remoteRef]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      // Wait a bit for async effect
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sentOps.length).toBeGreaterThan(0);
      const op = sentOps[0] as Record<string, unknown>;
      expect(op.op).toBe('REF_CALL');
      expect(op.refId).toBe(99);
      expect(op.method).toBe('focus');

      act(() => {
        renderer.unmount();
      });
    });

    test('should handle typed call proxy', async () => {
      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef<{ measure: () => Promise<unknown> }>();

        React.useEffect(() => {
          refCallback({ nodeId: 88 });

          if (remoteRef) {
            remoteRef.call.measure().catch(() => {});
          }
        }, [refCallback, remoteRef]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const op = sentOps.find((op) => (op as Record<string, unknown>).method === 'measure') as
        | Record<string, unknown>
        | undefined;
      expect(op).toBeDefined();
      expect(op?.op).toBe('REF_CALL');

      act(() => {
        renderer.unmount();
      });
    });

    test('should clear remoteRef when callback is called with null', () => {
      let capturedRef: ReturnType<typeof sdk.useRemoteRef>[1] = null;

      const TestComponent = ({ setNull }: { setNull: boolean }) => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();
        capturedRef = remoteRef;

        React.useEffect(() => {
          if (setNull) {
            refCallback(null);
          } else {
            refCallback({ nodeId: 42 });
          }
        }, [refCallback, setNull]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent, { setNull: false }));
      });

      expect(capturedRef).not.toBe(null);

      act(() => {
        renderer.update(React.createElement(TestComponent, { setNull: true }));
      });

      expect(capturedRef).toBe(null);

      act(() => {
        renderer.unmount();
      });
    });
  });

  describe('useRemoteRef() advanced scenarios', () => {
    let sentOps: unknown[];
    let eventListeners: Map<string, Set<(payload: unknown) => void>>;

    beforeEach(() => {
      sentOps = [];
      eventListeners = new Map();

      (globalThis as Record<string, unknown>).__rill_sendOperation = (op: unknown) => {
        sentOps.push(op);
      };

      (globalThis as Record<string, unknown>).__rill_onHostEvent = (
        eventName: string,
        callback: (payload: unknown) => void
      ) => {
        if (!eventListeners.has(eventName)) {
          eventListeners.set(eventName, new Set());
        }
        eventListeners.get(eventName)?.add(callback);
        return () => eventListeners.get(eventName)?.delete(callback);
      };
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__rill_sendOperation;
      delete (globalThis as Record<string, unknown>).__rill_onHostEvent;
    });

    test('should handle REF_METHOD_RESULT success', async () => {
      let resolvedValue: unknown = null;

      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();

        React.useEffect(() => {
          refCallback({ nodeId: 100 });

          if (remoteRef) {
            remoteRef.invoke('getValue').then((value) => {
              resolvedValue = value;
            });
          }
        }, [refCallback, remoteRef]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate host response
      const triggerEvent = (eventName: string, payload: unknown) => {
        eventListeners.get(eventName)?.forEach((cb) => cb(payload));
      };

      const sentOp = sentOps[0] as { callId: string };
      act(() => {
        triggerEvent('__REF_RESULT__', {
          refId: 100,
          callId: sentOp.callId,
          result: { data: 'success' },
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(resolvedValue).toEqual({ data: 'success' });

      act(() => {
        renderer.unmount();
      });
    });

    test('should handle REF_METHOD_RESULT error', async () => {
      let caughtError: Error | null = null;

      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();

        React.useEffect(() => {
          refCallback({ nodeId: 101 });

          if (remoteRef) {
            remoteRef.invoke('failingMethod').catch((err) => {
              caughtError = err;
            });
          }
        }, [refCallback, remoteRef]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate error response
      const triggerEvent = (eventName: string, payload: unknown) => {
        eventListeners.get(eventName)?.forEach((cb) => cb(payload));
      };

      const sentOp = sentOps[0] as { callId: string };
      act(() => {
        triggerEvent('__REF_RESULT__', {
          refId: 101,
          callId: sentOp.callId,
          error: {
            message: 'Method failed',
            name: 'MethodError',
            stack: 'Error stack trace',
          },
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(caughtError).not.toBe(null);
      expect(caughtError?.message).toBe('Method failed');
      expect(caughtError?.name).toBe('MethodError');

      act(() => {
        renderer.unmount();
      });
    });

    test('should timeout remote method call', async () => {
      let caughtError: Error | null = null;

      const TestComponent = () => {
        // Use short timeout (100ms) for faster test
        const [refCallback, remoteRef] = sdk.useRemoteRef({ timeout: 100 });

        React.useEffect(() => {
          refCallback({ nodeId: 102 });

          if (remoteRef) {
            remoteRef.invoke('slowMethod').catch((err) => {
              caughtError = err;
            });
          }
        }, [refCallback, remoteRef]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      // Wait for timeout to trigger (100ms + margin)
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(caughtError).not.toBe(null);
      // Should contain timeout error with configured timeout value
      expect(caughtError?.message).toContain('timed out');
      expect(caughtError?.message).toContain('100ms');
      expect(caughtError?.message).toContain('slowMethod');

      act(() => {
        renderer.unmount();
      });
    });

    test('should handle missing __rill_sendOperation', async () => {
      delete (globalThis as Record<string, unknown>).__rill_sendOperation;

      let caughtError: Error | null = null;

      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();

        React.useEffect(() => {
          refCallback({ nodeId: 103 });

          if (remoteRef) {
            remoteRef.invoke('anyMethod').catch((err) => {
              caughtError = err;
            });
          }
        }, [refCallback, remoteRef]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(caughtError).not.toBe(null);
      expect(caughtError?.message).toContain('__rill_sendOperation not available');

      act(() => {
        renderer.unmount();
      });
    });

    test('should handle missing __rill_onHostEvent', () => {
      delete (globalThis as Record<string, unknown>).__rill_onHostEvent;

      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();

        React.useEffect(() => {
          refCallback({ nodeId: 104 });

          if (remoteRef) {
            // This should still work, just won't receive results
            remoteRef.invoke('test').catch(() => {});
          }
        }, [refCallback, remoteRef]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      expect(() => {
        act(() => {
          renderer = TestRenderer.create(React.createElement(TestComponent));
        });
      }).not.toThrow();

      act(() => {
        renderer.unmount();
      });
    });

    test('should ignore results for different refId', async () => {
      let resolvedValue: unknown = 'not-changed';
      let _rejectedError: Error | null = null;

      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();

        React.useEffect(() => {
          refCallback({ nodeId: 105 });

          if (remoteRef) {
            remoteRef
              .invoke('getValue')
              .then((value) => {
                resolvedValue = value;
              })
              .catch((err) => {
                _rejectedError = err;
              });
          }
        }, [refCallback, remoteRef]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate response for different refId
      const triggerEvent = (eventName: string, payload: unknown) => {
        eventListeners.get(eventName)?.forEach((cb) => cb(payload));
      };

      const sentOp = sentOps[0] as { callId: string };
      act(() => {
        triggerEvent('__REF_RESULT__', {
          refId: 999, // Different refId
          callId: sentOp.callId,
          result: { data: 'wrong-ref' },
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not update because refId doesn't match
      expect(resolvedValue).toBe('not-changed');

      act(() => {
        renderer.unmount();
      });

      // Will be rejected on unmount, which is expected
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    test('should ignore results for unknown callId', async () => {
      let resolvedValue: unknown = 'not-changed';
      let _rejectedError: Error | null = null;

      const TestComponent = () => {
        const [refCallback, remoteRef] = sdk.useRemoteRef();

        React.useEffect(() => {
          refCallback({ nodeId: 106 });

          if (remoteRef) {
            remoteRef
              .invoke('getValue')
              .then((value) => {
                resolvedValue = value;
              })
              .catch((err) => {
                _rejectedError = err;
              });
          }
        }, [refCallback, remoteRef]);

        return React.createElement('div', null, 'Test');
      };

      let renderer: ReturnType<typeof TestRenderer.create>;
      act(() => {
        renderer = TestRenderer.create(React.createElement(TestComponent));
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate response for unknown callId
      const triggerEvent = (eventName: string, payload: unknown) => {
        eventListeners.get(eventName)?.forEach((cb) => cb(payload));
      };

      act(() => {
        triggerEvent('__REF_RESULT__', {
          refId: 106,
          callId: 'unknown-call-id',
          result: { data: 'wrong-call' },
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should not update because callId doesn't match
      expect(resolvedValue).toBe('not-changed');

      act(() => {
        renderer.unmount();
      });

      // Will be rejected on unmount, which is expected
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });
});
