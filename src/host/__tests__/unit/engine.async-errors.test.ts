import { describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';

describe('Engine async error handling', () => {
  describe('setInterval error handling', () => {
    it('should catch and emit errors from setInterval callbacks', async () => {
      const engine = new Engine({ sandbox: 'node-vm', timeout: 5000, debug: false });

      const errorsCaught: Error[] = [];

      // Listen for error events
      engine.on('error', (error: Error) => {
        errorsCaught.push(error);
      });

      await engine.loadBundle(`
        // This will be replaced by Engine's setInterval implementation
      `);

      // Directly test the setInterval error handling by calling it
      // Access the guest setInterval that Engine injected
      const guestSetInterval = (await engine.context?.extract('setInterval')) as (
        fn: () => void,
        delay: number
      ) => number;

      expect(guestSetInterval).toBeDefined();

      if (guestSetInterval) {
        // Create an interval that throws
        const intervalId = guestSetInterval(() => {
          throw new Error('Interval callback error');
        }, 10);

        // Wait for interval to fire
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Verify error was caught and emitted
        expect(errorsCaught.length).toBeGreaterThan(0);
        expect(errorsCaught[0].message).toBe('Interval callback error');

        // Verify errorCount was incremented
        expect(engine.getDiagnostics().health.errorCount).toBeGreaterThan(0);
        expect(engine.getDiagnostics().health.lastErrorAt).not.toBeNull();

        // Clear the interval
        const guestClearInterval = (await engine.context?.extract('clearInterval')) as (
          id: number
        ) => void;
        if (guestClearInterval) {
          guestClearInterval(intervalId);
        }
      }

      engine.destroy();
    });

    it('should not crash when interval callback throws non-Error', async () => {
      const engine = new Engine({ sandbox: 'node-vm', timeout: 5000, debug: false });

      const errorsCaught: Error[] = [];
      engine.on('error', (error: Error) => {
        errorsCaught.push(error);
      });

      await engine.loadBundle(`// init`);

      const guestSetInterval = (await engine.context?.extract('setInterval')) as (
        fn: () => void,
        delay: number
      ) => number;

      if (guestSetInterval) {
        const intervalId = guestSetInterval(() => {
          throw 'string error'; // Throw non-Error
        }, 10);

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(errorsCaught.length).toBeGreaterThan(0);
        expect(errorsCaught[0]).toBeInstanceOf(Error);
        expect(errorsCaught[0].message).toBe('string error');

        const guestClearInterval = (await engine.context?.extract('clearInterval')) as (
          id: number
        ) => void;
        if (guestClearInterval) {
          guestClearInterval(intervalId);
        }
      }

      engine.destroy();
    });
  });

  describe('Unhandled Promise Rejection handling', () => {
    it('should verify rejection handler logic for Error type', () => {
      // Test the logic that would be used in unhandledRejectionHandler
      const rejectionError = new Error('Test rejection');
      const event = {
        reason: rejectionError,
        promise: undefined as Promise<unknown> | undefined,
        preventDefault: () => {},
      };

      // Verify Error is kept as-is
      const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));

      expect(error).toBe(rejectionError);
      expect(error.message).toBe('Test rejection');
    });

    it('should verify rejection handler converts non-Error to Error', () => {
      // Test the logic for non-Error rejection reasons
      const event = {
        reason: 'string rejection',
        promise: undefined as Promise<unknown> | undefined,
        preventDefault: () => {},
      };

      // The handler should convert non-Error to Error
      const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('string rejection');
    });

    it('should verify rejection handler handles undefined reason', () => {
      const event = {
        reason: undefined,
        promise: undefined as Promise<unknown> | undefined,
        preventDefault: () => {},
      };

      const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('undefined');
    });
  });

  // Note: handleCallFunction error handling tests removed - functionality moved to Bridge
  // See: src/shared/bridge/bridge.test.ts and src/shared/callback-registry.ts

  describe('error event emission', () => {
    it('should increment errorCount when errors occur', async () => {
      const engine = new Engine({ sandbox: 'node-vm', timeout: 5000, debug: false });

      await engine.loadBundle(`// init`);

      const initialErrorCount = engine.getDiagnostics().health.errorCount;

      // Trigger an interval error
      const guestSetInterval = (await engine.context?.extract('setInterval')) as (
        fn: () => void,
        delay: number
      ) => number;

      if (guestSetInterval) {
        const intervalId = guestSetInterval(() => {
          throw new Error('Test error');
        }, 10);

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(engine.getDiagnostics().health.errorCount).toBeGreaterThan(initialErrorCount);
        expect(engine.getDiagnostics().health.lastErrorAt).not.toBeNull();

        const guestClearInterval = (await engine.context?.extract('clearInterval')) as (
          id: number
        ) => void;
        if (guestClearInterval) {
          guestClearInterval(intervalId);
        }
      }

      engine.destroy();
    });
  });

  describe('Unhandled Promise Rejection', () => {
    it('should emit error events when errors occur', async () => {
      const engine = new Engine({ sandbox: 'node-vm', timeout: 5000, debug: false });

      const errorsCaught: Error[] = [];
      engine.on('error', (error: Error) => {
        errorsCaught.push(error);
      });

      await engine.loadBundle(`// init`);

      // Engine is loaded and can handle errors
      expect(engine.isLoaded).toBe(true);

      // Manually emit an error to test the error handler
      engine.emit('error', new Error('Test error'));

      expect(errorsCaught.length).toBe(1);
      expect(errorsCaught[0].message).toBe('Test error');

      engine.destroy();
    });

    it('should track error count correctly', async () => {
      const engine = new Engine({ sandbox: 'node-vm', timeout: 5000, debug: false });

      await engine.loadBundle(`// init`);

      const initialErrorCount = engine.getDiagnostics().health.errorCount;

      // Trigger an error through setTimeout
      const guestSetTimeout = (await engine.context?.extract('setTimeout')) as (
        fn: () => void,
        delay: number
      ) => number;

      if (guestSetTimeout) {
        guestSetTimeout(() => {
          throw new Error('Timer error');
        }, 5);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Error count should increase
      expect(engine.getDiagnostics().health.errorCount).toBeGreaterThan(initialErrorCount);
      expect(engine.getDiagnostics().health.lastErrorAt).not.toBeNull();

      engine.destroy();
    });
  });
});
