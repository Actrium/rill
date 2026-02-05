import { describe, expect, it } from 'bun:test';
import { Engine } from '../../engine';

describe('Engine health trend', () => {
  it('increments errorCount on failure, then can recover and load successfully', async () => {
    const engine = new Engine({ sandbox: 'vm', debug: false });

    await expect(
      Promise.resolve().then(() => engine.loadBundle('throw new Error("e1")'))
    ).rejects.toThrow();
    const h1 = engine.getDiagnostics().health;
    expect(h1.errorCount).toBeGreaterThan(0);
    expect(h1.loaded).toBe(false);

    await Promise.resolve().then(() => engine.loadBundle('console.log("ok")'));
    const h2 = engine.getDiagnostics().health;
    expect(h2.loaded).toBe(true);
    expect(h2.errorCount).toBeGreaterThan(0);
    expect(typeof h2.lastErrorAt === 'number' || h2.lastErrorAt === null).toBeTruthy();
  });
});
