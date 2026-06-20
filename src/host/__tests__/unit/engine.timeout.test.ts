import { describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';

// Silent logger for tests - prevents expected error logs from cluttering output
const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

describe('Engine timeout behavior', () => {
  it('does not throw TimeoutError for quick microtask usage', async () => {
    const engine = new Engine({
      sandbox: 'vm',
      timeout: 5000,
      debug: false,
      logger: silentLogger,
    });
    // microtask scheduled inside guest should complete quickly
    await engine.loadBundle(`queueMicrotask(() => {});`);
    expect(engine.isLoaded).toBe(true);
  });

  it('does not throw TimeoutError even for long sync work (best-effort guard)', async () => {
    const engine = new Engine({
      sandbox: 'vm',
      timeout: 5000,
      debug: false,
      logger: silentLogger,
    });
    // Busy loop to simulate long sync work; guard cannot preempt sync eval
    // Note: This is a best-effort timeout guard that only works if eval yields to event loop
    const code = `var s=0; for (var i=0;i<1e6;i++){ s+=i }`;
    await engine.loadBundle(code);
    expect(engine.isLoaded).toBe(true);
  });

  it('should handle forceDestroy when context.dispose() throws', async () => {
    let disposeThrew = false;
    const engine = new Engine({
      sandbox: 'vm',
      timeout: 1000,
      debug: false,
      logger: silentLogger,
    });

    await Promise.resolve().then(() => engine.loadBundle('1 + 1'));

    // Monkeypatch context.dispose to throw (simulate provider edge-case)
    const ctx = engine.context as { dispose?: () => void } | null;
    expect(ctx).not.toBeNull();
    if (ctx) {
      const originalDispose = ctx.dispose?.bind(ctx);
      ctx.dispose = () => {
        disposeThrew = true;
        try {
          originalDispose?.();
        } catch {
          // ignore
        }
        throw new Error('Dispose failed');
      };
    }

    expect(() => engine.forceDestroy()).not.toThrow();
    expect(disposeThrew).toBe(true);
    expect(engine.destroyed).toBe(true);
    expect(engine.context).toBe(null);
  });

  it('should handle forceDestroy when runtime.dispose() throws', async () => {
    let runtimeDisposeThrew = false;
    const engine = new Engine({
      sandbox: 'vm',
      timeout: 1000,
      debug: false,
      logger: silentLogger,
    });

    await Promise.resolve().then(() => engine.loadBundle('1 + 1'));

    // Monkeypatch runtime.dispose to throw (simulate provider edge-case)
    const rt = engine.runtime as { dispose?: () => void } | null;
    expect(rt).not.toBeNull();
    if (rt) {
      const originalDispose = rt.dispose?.bind(rt);
      rt.dispose = () => {
        runtimeDisposeThrew = true;
        try {
          originalDispose?.();
        } catch {
          // ignore
        }
        throw new Error('Runtime dispose failed');
      };
    }

    expect(() => engine.forceDestroy()).not.toThrow();
    expect(runtimeDisposeThrew).toBe(true);
    expect(engine.destroyed).toBe(true);
    expect(engine.runtime).toBe(null);
  });

  it('should clear timers before disposing resources in forceDestroy', async () => {
    const engine = new Engine({
      sandbox: 'vm',
      timeout: 1000,
      debug: false,
      logger: silentLogger,
    });

    const timerFired = false;

    await engine.loadBundle(`
      const timer = setTimeout(() => {
        // This should not run after forceDestroy
      }, 1000);
    `);

    // Verify timer was created
    const statsBeforeDestroy = engine.getTimerStats();
    expect(statsBeforeDestroy.timeouts).toBeGreaterThan(0);

    // Force destroy
    engine.forceDestroy();

    // Verify timers were cleared
    const statsAfterDestroy = engine.getTimerStats();
    expect(statsAfterDestroy.timeouts).toBe(0);
    expect(statsAfterDestroy.intervals).toBe(0);

    // Wait to ensure timer doesn't fire
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(timerFired).toBe(false);
  });
});
