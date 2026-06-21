import { describe, expect, it } from 'bun:test';

import { Engine } from '../../engine';

describe('Engine diagnostics - host events', () => {
  it('records last host→guest event info', () => {
    // biome-ignore lint/suspicious/noExplicitAny: Diagnostic data has dynamic structure
    const engine = new Engine({ sandbox: 'node-vm', debug: false });

    // biome-ignore lint/suspicious/noExplicitAny: Diagnostic data has dynamic structure
    engine.sendEvent('HOST_VISIBILITY', { visible: false } as any);

    const d = engine.getDiagnostics();
    expect(d.host.lastEventName).toBe('HOST_VISIBILITY');
    expect(typeof d.host.lastEventAt).toBe('number');
    expect(d.host.lastPayloadBytes).not.toBeNull();
  });
});
