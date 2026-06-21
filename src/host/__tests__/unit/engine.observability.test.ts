import { describe, expect, it, mock } from 'bun:test';
import { HostMsg } from '../../types';
import { Engine } from '../../engine';

describe('Engine observability metrics', () => {
  it('tracks errors and exposes getHealth', async () => {
    const engine = new Engine({ sandbox: 'node-vm', debug: false });
    await expect(
      Promise.resolve().then(() => engine.loadBundle('throw new Error("boom")'))
    ).rejects.toThrow();
    const health = engine.getDiagnostics().health;
    expect(health.errorCount).toBeGreaterThan(0);
    expect(typeof health.lastErrorAt === 'number' || health.lastErrorAt === null).toBeTruthy();
    engine.destroy();
  });

  it('emits metrics for sendToSandbox and receiver', async () => {
    const onMetric = mock();
    const engine = new Engine({ sandbox: 'node-vm', debug: false, onMetric });
    await Promise.resolve().then(() => engine.loadBundle('console.log("hi")'));
    engine.createReceiver();
    // Use sendToSandbox directly to ensure we wait for the async operation
    await engine.sendToSandbox({ type: HostMsg.HOST_EVENT, eventName: 'PING', payload: null });
    // render metrics
    engine.getReceiver()!.render();
    const names = onMetric.mock.calls.map((c) => c[0]);
    expect(names).toContain('bridge.sendToSandbox');
    expect(names).toContain('receiver.render');
    engine.destroy();
  });

  it('should call onMetric with named metrics', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Test telemetry data has dynamic structure
    const metrics: any[] = [];
    const engine = new Engine({
      sandbox: 'node-vm',
      onMetric: (n, v, e) => metrics.push({ n, v, e }),
      debug: false,
    });
    await engine.loadBundle('/* noop */');
    expect(metrics.find((m) => m.n === 'engine.initializeRuntime')).toBeTruthy();
    expect(metrics.find((m) => m.n === 'engine.executeBundle')).toBeTruthy();
    const health = engine.getDiagnostics().health;
    expect('loaded' in health && 'receiverNodes' in health).toBe(true);
    engine.destroy();
  });
});

describe('Engine setMaxListeners', () => {
  it('should set and get maxListeners', async () => {
    const engine = new Engine({
      sandbox: 'node-vm',
      debug: false,
    });
    await engine.loadBundle('/* noop */');

    // Test setMaxListeners
    engine.setMaxListeners(20);
    expect(engine.getMaxListeners()).toBe(20);

    // Test with different value
    engine.setMaxListeners(5);
    expect(engine.getMaxListeners()).toBe(5);

    engine.destroy();
  });

  it('should warn when listeners exceed maxListeners limit', async () => {
    const engine = new Engine({
      sandbox: 'node-vm',
      debug: false,
    });
    await engine.loadBundle('/* noop */');

    // Set a low limit
    engine.setMaxListeners(2);

    // Add listeners (should warn on the 3rd)
    const listener1 = () => {};
    const listener2 = () => {};
    const listener3 = () => {};

    engine.on('test-event', listener1);
    engine.on('test-event', listener2);
    // This should trigger a warning in console
    engine.on('test-event', listener3);

    engine.destroy();
  });
});

describe('Engine console.debug and console.info', () => {
  it('should log console.debug when debug mode is enabled', async () => {
    const logs: string[] = [];
    const customLogger = {
      log: (...args: unknown[]) => logs.push(args.join(' ')),
      warn: console.warn,
      error: console.error,
    };

    const engine = new Engine({
      sandbox: 'node-vm',
      debug: true,
      logger: customLogger,
    });
    await engine.loadBundle('console.debug("debug message");');

    // Check that debug message was logged
    expect(logs.some((l) => l.includes('debug message') && l.includes('debug'))).toBe(true);
    engine.destroy();
  });

  it('should log console.info when debug mode is enabled', async () => {
    const logs: string[] = [];
    const customLogger = {
      log: (...args: unknown[]) => logs.push(args.join(' ')),
      warn: console.warn,
      error: console.error,
    };

    const engine = new Engine({
      sandbox: 'node-vm',
      debug: true,
      logger: customLogger,
    });
    await engine.loadBundle('console.info("info message");');

    // Check that info message was logged
    expect(logs.some((l) => l.includes('info message') && l.includes('info'))).toBe(true);
    engine.destroy();
  });

  it('should NOT log console.debug when debug mode is disabled', async () => {
    const logs: string[] = [];
    const customLogger = {
      log: (...args: unknown[]) => logs.push(args.join(' ')),
      warn: console.warn,
      error: console.error,
    };

    const engine = new Engine({
      sandbox: 'node-vm',
      debug: false,
      logger: customLogger,
    });
    await engine.loadBundle('console.debug("should not appear");');

    // Debug message should NOT be logged
    expect(logs.some((l) => l.includes('should not appear'))).toBe(false);
    engine.destroy();
  });

  it('should NOT log console.info when debug mode is disabled', async () => {
    const logs: string[] = [];
    const customLogger = {
      log: (...args: unknown[]) => logs.push(args.join(' ')),
      warn: console.warn,
      error: console.error,
    };

    const engine = new Engine({
      sandbox: 'node-vm',
      debug: false,
      logger: customLogger,
    });
    await engine.loadBundle('console.info("should not appear");');

    // Info message should NOT be logged
    expect(logs.some((l) => l.includes('should not appear'))).toBe(false);
    engine.destroy();
  });
});
