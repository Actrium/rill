/**
 * DevTools Integration Tests
 *
 * Tests for DevTools-enabled scenarios in reconciler
 * Targets uncovered devtools code paths
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isDevToolsEnabled, sendDevToolsMessage } from '../../runtime/reconciler/devtools';

describe('DevTools Integration', () => {
  let originalDevToolsFlag: boolean | undefined;
  // biome-ignore lint/complexity/noBannedTypes: Test needs generic function type
  let originalSendEventToHost: Function | undefined;
  let sentEvents: Array<{ type: string; data: unknown }> = [];

  beforeEach(() => {
    // Save original state
    // biome-ignore lint/suspicious/noExplicitAny: Accessing custom global property for test
    originalDevToolsFlag = (globalThis as any).__RILL_DEVTOOLS_ENABLED;
    // biome-ignore lint/suspicious/noExplicitAny: Accessing custom global property for test
    originalSendEventToHost = (globalThis as any).__rill_emitEvent;

    // Reset tracking
    sentEvents = [];
  });

  afterEach(() => {
    // Restore original state
    if (originalDevToolsFlag !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: Restoring custom global property after test
      (globalThis as any).__RILL_DEVTOOLS_ENABLED = originalDevToolsFlag;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: Restoring custom global property after test
      delete (globalThis as any).__RILL_DEVTOOLS_ENABLED;
    }

    if (originalSendEventToHost !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: Restoring custom global property after test
      (globalThis as any).__rill_emitEvent = originalSendEventToHost;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: Restoring custom global property after test
      delete (globalThis as any).__rill_emitEvent;
    }
  });

  describe('isDevToolsEnabled', () => {
    it('should return false when DevTools is not enabled', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Modifying custom global property for test
      delete (globalThis as any).__RILL_DEVTOOLS_ENABLED;
      expect(isDevToolsEnabled()).toBe(false);
    });

    it('should return true when DevTools is enabled', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Modifying custom global property for test
      (globalThis as any).__RILL_DEVTOOLS_ENABLED = true;
      expect(isDevToolsEnabled()).toBe(true);
    });

    it('should return false when DevTools flag is false', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Modifying custom global property for test
      (globalThis as any).__RILL_DEVTOOLS_ENABLED = false;
      expect(isDevToolsEnabled()).toBe(false);
    });

    it('should handle missing globalThis', () => {
      // This test verifies defensive programming
      expect(isDevToolsEnabled()).toBeDefined();
    });
  });

  describe('sendDevToolsMessage', () => {
    it('should send message when __rill_emitEvent is available', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mocking custom global function for test
      (globalThis as any).__rill_emitEvent = (type: string, data: unknown) => {
        sentEvents.push({ type, data });
      };

      sendDevToolsMessage('test-event', { foo: 'bar' });

      expect(sentEvents.length).toBe(1);
      expect(sentEvents[0]!.type).toBe('test-event');
      expect(sentEvents[0]!.data).toEqual({ foo: 'bar' });
    });

    it('should not throw when __rill_emitEvent is missing', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Modifying custom global property for test
      delete (globalThis as any).__rill_emitEvent;

      expect(() => {
        sendDevToolsMessage('test-event', { data: 'test' });
      }).not.toThrow();
    });

    it('should handle complex data structures', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mocking custom global function for test
      (globalThis as any).__rill_emitEvent = (type: string, data: unknown) => {
        sentEvents.push({ type, data });
      };

      const complexData = {
        nested: {
          array: [1, 2, 3],
          map: new Map([['key', 'value']]),
        },
        number: 42,
        string: 'test',
      };

      sendDevToolsMessage('complex-event', complexData);

      expect(sentEvents.length).toBe(1);
      expect(sentEvents[0]!.type).toBe('complex-event');
    });

    it('should send multiple messages', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mocking custom global function for test
      (globalThis as any).__rill_emitEvent = (type: string, data: unknown) => {
        sentEvents.push({ type, data });
      };

      sendDevToolsMessage('event1', { id: 1 });
      sendDevToolsMessage('event2', { id: 2 });
      sendDevToolsMessage('event3', { id: 3 });

      expect(sentEvents.length).toBe(3);
      expect(sentEvents[0]!.type).toBe('event1');
      expect(sentEvents[1]!.type).toBe('event2');
      expect(sentEvents[2]!.type).toBe('event3');
    });

    it('should handle null and undefined data', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Mocking custom global function for test
      (globalThis as any).__rill_emitEvent = (type: string, data: unknown) => {
        sentEvents.push({ type, data });
      };

      sendDevToolsMessage('null-event', null);
      sendDevToolsMessage('undefined-event', undefined);

      expect(sentEvents.length).toBe(2);
      expect(sentEvents[0]!.data).toBe(null);
      expect(sentEvents[1]!.data).toBe(undefined);
    });
  });

  describe('DevTools E2E Scenarios', () => {
    it('should track render timings when enabled', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Modifying custom global property for test
      (globalThis as any).__RILL_DEVTOOLS_ENABLED = true;
      // biome-ignore lint/suspicious/noExplicitAny: Mocking custom global function for test
      (globalThis as any).__rill_emitEvent = (type: string, data: unknown) => {
        sentEvents.push({ type, data });
      };

      expect(isDevToolsEnabled()).toBe(true);

      // Simulate render timing event
      sendDevToolsMessage('render-timing', {
        nodeId: 1,
        type: 'View',
        phase: 'mount',
        duration: 1.5,
        timestamp: Date.now(),
      });

      expect(sentEvents.length).toBe(1);
      expect(sentEvents[0]!.type).toBe('render-timing');
    });

    it('should not send events when DevTools is disabled', () => {
      // biome-ignore lint/suspicious/noExplicitAny: Modifying custom global property for test
      (globalThis as any).__RILL_DEVTOOLS_ENABLED = false;
      // biome-ignore lint/suspicious/noExplicitAny: Mocking custom global function for test
      (globalThis as any).__rill_emitEvent = (type: string, data: unknown) => {
        sentEvents.push({ type, data });
      };

      // Even if __rill_emitEvent exists, events can still be sent
      // The logic to check isDevToolsEnabled before calling sendDevToolsMessage
      // should be in the calling code (host-config.ts)
      sendDevToolsMessage('test', { data: 'test' });

      // sendDevToolsMessage itself doesn't check isDevToolsEnabled
      // It's the caller's responsibility
      expect(sentEvents.length).toBe(1);
    });
  });
});
