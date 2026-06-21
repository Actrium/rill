/**
 * Engine end-to-end round-trip on the tenant-manager provider (audit medium gap
 * `parity-tenant-manager-no-real-roundtrip`).
 *
 * The production default path on a device with the native module is TenantManager:
 * Engine -> TenantManagerProvider -> __RillTenantManager (JSI) -> per-tenant sandbox.
 * The existing tenant-manager-provider.test.ts only asserts the TS delegation SHAPE
 * (spies that evalInTenant/setTenantGlobal are called) — `evalInTenant` returns a fake
 * string and never executes guest JS, so no real host<->guest contract is exercised.
 *
 * Here we install an in-process fake `__RillTenantManager` whose per-tenant
 * eval/inject/extract are backed by a REAL NodeVMProvider context (same process, so
 * function references cross the boundary just like the native JSI HostObject keeps the
 * guest realm in C++). That lets a real Engine drive the same core contracts it drives
 * on node-vm/wasm — render batch and host-event round-trip — through the tenant-manager
 * code path, asserting the production default path actually works end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { HostMsg } from '../../../shared';
import { Engine } from '../../engine';
import { NodeVMProvider } from '../../sandbox/providers/node-vm-provider';
import type { JSEngineRuntime, SandboxScope } from '../../sandbox/types/provider';
import type { RillTenantManagerJSI } from '../../tenant-manager/types';

/**
 * A fake __RillTenantManager whose tenants are backed by real NodeVMProvider contexts.
 * Only the methods the Engine actually drives for a render + host-event round-trip
 * (createTenant / destroyTenant / evalInTenant / setTenantGlobal / getTenantGlobal) carry
 * real behaviour; the remaining JSI surface is stubbed (unused on this path).
 */
function createVmBackedTenantManager(): RillTenantManagerJSI {
  const nodeVm = new NodeVMProvider();
  const tenants = new Map<number, { runtime: JSEngineRuntime; ctx: SandboxScope }>();
  let nextId = 1;
  let nextTimerId = 1;

  return {
    createTenant: () => {
      const id = nextId++;
      const runtime = nodeVm.createRuntime() as JSEngineRuntime;
      const ctx = runtime.createContext();
      tenants.set(id, { runtime, ctx });
      return id;
    },
    destroyTenant: (tenantId) => {
      const t = tenants.get(tenantId);
      if (t) {
        t.runtime.dispose();
        tenants.delete(tenantId);
      }
    },
    evalInTenant: (tenantId, code) => {
      const t = tenants.get(tenantId);
      if (!t) throw new Error(`Tenant not found: ${tenantId}`);
      return t.ctx.eval(code);
    },
    setTenantGlobal: (tenantId, name, value) => {
      tenants.get(tenantId)?.ctx.inject(name, value);
    },
    getTenantGlobal: (tenantId, name) => {
      return tenants.get(tenantId)?.ctx.extract(name);
    },

    // --- Unused on the render/host-event round-trip: minimal stubs ---
    pauseTenant: () => {},
    resumeTenant: () => {},
    loadBundle: () => {},
    sendEvent: () => {},
    broadcast: () => {},
    setHostCallbacks: () => {},
    getTenantInfo: (tenantId) => ({
      id: tenantId,
      appId: `app-${tenantId}`,
      state: 4,
      disposed: false,
      quota: {
        activeTimers: 0,
        maxTimers: 1000,
        activeCallbacks: 0,
        maxCallbacks: 10000,
        currentHeapBytes: 0,
        maxHeapBytes: 0,
      },
      violations: { componentDenied: 0, apiDenied: 0, quotaExceeded: 0 },
      overQuota: false,
      nearQuota: false,
    }),
    getMetrics: () => ({
      totalTenants: tenants.size,
      registryTotal: tenants.size,
      registryActive: tenants.size,
      running: tenants.size,
      paused: 0,
      error: 0,
      activeThreads: tenants.size,
    }),
    scheduleTenantTimeout: () => nextTimerId++,
    scheduleTenantInterval: () => nextTimerId++,
    cancelTenantTimer: () => {},
    pauseTenantTimers: () => {},
    resumeTenantTimers: () => {},
    canUseComponent: () => true,
    canUseAPI: () => true,
    isOverQuota: () => false,
    isNearQuota: () => false,
    busPublish: () => true,
    busBroadcast: () => true,
    busUnicast: () => true,
    busMulticast: () => true,
    busSubscribe: () => 1,
    busUnsubscribe: () => {},
    busUnsubscribeAll: () => {},
    busGetStats: () => ({
      totalPublished: 0,
      totalDelivered: 0,
      totalDropped: 0,
      activeSubscriptions: 0,
      activeChannels: 0,
    }),
    busCreateChannel: () => {},
  };
}

// biome-ignore lint/suspicious/noExplicitAny: reach into the private sandbox scope for assertions
function scope(engine: Engine): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return (engine as any).context;
}

// biome-ignore lint/suspicious/noExplicitAny: test mock component
const mockComponent = ((p: any) => p) as any;

describe('Engine end-to-end on tenant-manager (vm-backed fake __RillTenantManager)', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__RillTenantManager = createVmBackedTenantManager();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__RillTenantManager;
  });

  it('routes a guest render batch to the host Receiver', async () => {
    const engine = new Engine({ sandbox: 'tenant-manager', tenant: { appId: 'com.test.render' } });
    engine.register({ View: mockComponent });
    // biome-ignore lint/suspicious/noExplicitAny: captured batches
    const batches: any[] = [];
    engine.on('operation', (b) => batches.push(b));
    engine.createReceiver();

    await engine.loadBundle(`
      globalThis.__rill_sendBatch({
        version: 1, batchId: 9,
        operations: [
          { op: 'CREATE', id: 1, type: 'View', props: {} },
          { op: 'APPEND', parentId: 0, childId: 1 }
        ]
      });
    `);

    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0]?.batchId).toBe(9);

    const receiver = engine.getReceiver();
    expect(receiver).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
    expect(receiver!.nodeCount).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: see above
    expect(receiver!.findNodesByType('View')).toHaveLength(1);

    engine.destroy();
  });

  it('delivers a host event to a guest __rill_onHostEvent listener', async () => {
    const engine = new Engine({ sandbox: 'tenant-manager', tenant: { appId: 'com.test.event' } });
    await engine.loadBundle(`
      globalThis.__pingPayload = null;
      globalThis.__rill_onHostEvent('PING', function(p){ globalThis.__pingPayload = p; });
    `);

    await engine.sendToSandbox({
      type: HostMsg.HOST_EVENT,
      eventName: 'PING',
      // biome-ignore lint/suspicious/noExplicitAny: BridgeValue payload
      payload: { ok: 1 } as any,
    });

    expect(scope(engine).extract('__pingPayload')).toEqual({ ok: 1 });
    engine.destroy();
  });

  it('exposes initial config to the guest via __rill_getConfig()', async () => {
    const engine = new Engine({ sandbox: 'tenant-manager', tenant: { appId: 'com.test.config' } });
    await engine.loadBundle('globalThis.__cfg = globalThis.__rill_getConfig();', {
      title: 'tenant',
      n: 3,
    });
    expect(scope(engine).extract('__cfg')).toEqual({ title: 'tenant', n: 3 });
    engine.destroy();
  });
});

/**
 * Native JSI providers (jsc / quickjs / hermes) are an explicit matrix dimension the
 * in-process host suite STRUCTURALLY cannot cover: the JSI HostObject bindings
 * (__JSCSandboxJSI / __QuickJSSandboxJSI / __HermesSandboxJSI) only exist inside a real
 * React Native runtime. The same core contracts asserted here (render batch, host-event,
 * config, callback round-trip) are enforced against those providers by the on-device e2e
 * suite (run on macOS/iOS/Android), not by this suite.
 *
 * This skipped block documents that dimension in code so a JSI-only regression is a known
 * coverage boundary (covered on-device) rather than a silent gap. See the rn-macos
 * reconciler e2e tests for the executable native-side assertions.
 */
describe.skip('native JSI providers — covered by on-device e2e, not host suite', () => {
  for (const provider of ['jsc', 'quickjs', 'hermes'] as const) {
    it(`${provider}: render / host-event / config / callback round-trip (on-device only)`, () => {
      // Intentionally skipped in the host suite — the native JSI binding is unavailable
      // here. The on-device e2e suite runs the same contract assertions against ${provider}.
    });
  }
});
