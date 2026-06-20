/**
 * OrchestratorProvider Unit Tests
 *
 * Tests the TypeScript delegation layer that routes Engine sandbox operations
 * through the native __RillOrchestrator JSI HostObject.
 *
 * Since __RillOrchestrator is a native JSI object not available in Bun/Node,
 * we mock it to verify correct delegation behavior.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RillOrchestratorJSI } from '../../orchestrator/types';

// --- Mock __RillOrchestrator ---

function createMockOrchestrator() {
  let nextTenantId = 1;
  let nextTimerId = 100;
  let nextSubId = 1;
  const channels = new Map<string, Record<string, unknown>>();
  const channelSubs = new Map<string, Array<{ id: number; tenantId: number; channel: string; handler: (event: unknown) => void }>>();
  const busStats = { totalPublished: 0, totalDelivered: 0, totalDropped: 0 };
  const tenants = new Map<number, {
    globals: Map<string, unknown>;
    state: number;
    disposed: boolean;
    timers: Map<number, { callbackId: string; type: 'timeout' | 'interval' }>;
    timersPaused: boolean;
    allowedComponents: Set<string>;
    allowAllComponents: boolean;
    allowedAPIs: Set<string>;
    allowAllAPIs: boolean;
    activeTimers: number;
    maxTimers: number;
    quotaExceeded: number;
    componentViolations: number;
    apiViolations: number;
  }>();

  const orchestrator: RillOrchestratorJSI = {
    createTenant: mock((config: { appId: string; apis?: string[]; quota?: { maxTimers?: number } }) => {
      const id = nextTenantId++;
      tenants.set(id, {
        globals: new Map(),
        state: 4, // Running
        disposed: false,
        timers: new Map(),
        timersPaused: false,
        allowedComponents: new Set<string>(),
        allowAllComponents: true, // default: allow all
        allowedAPIs: config.apis ? new Set(config.apis) : new Set<string>(),
        allowAllAPIs: !config.apis || config.apis.length === 0,
        activeTimers: 0,
        maxTimers: config.quota?.maxTimers ?? 1000,
        quotaExceeded: 0,
        componentViolations: 0,
        apiViolations: 0,
      });
      return id;
    }),
    destroyTenant: mock((tenantId: number) => {
      const t = tenants.get(tenantId);
      if (t) {
        t.disposed = true;
        t.state = 6; // Destroyed
      }
    }),
    pauseTenant: mock((tenantId: number) => {
      const t = tenants.get(tenantId);
      if (t) t.state = 3; // Paused
    }),
    resumeTenant: mock((tenantId: number) => {
      const t = tenants.get(tenantId);
      if (t) t.state = 4; // Running
    }),
    loadBundle: mock((_tenantId: number, _code: string) => {}),
    sendEvent: mock((_tenantId: number, _name: string, _payload?: unknown) => {}),
    broadcast: mock((_name: string, _payload?: unknown) => {}),
    setHostCallbacks: mock((_callbacks: unknown) => {}),
    getTenantInfo: mock((tenantId: number) => {
      const t = tenants.get(tenantId);
      return {
        id: tenantId,
        appId: `app-${tenantId}`,
        state: t?.state ?? 0,
        disposed: t?.disposed ?? false,
        quota: {
          activeTimers: t?.activeTimers ?? 0,
          maxTimers: t?.maxTimers ?? 1000,
          activeCallbacks: 0,
          maxCallbacks: 10000,
          currentHeapBytes: 0,
          maxHeapBytes: 64 * 1024 * 1024,
        },
        violations: {
          componentDenied: t?.componentViolations ?? 0,
          apiDenied: t?.apiViolations ?? 0,
          quotaExceeded: t?.quotaExceeded ?? 0,
        },
        overQuota: false,
        nearQuota: false,
      };
    }),
    getMetrics: mock(() => ({
      totalTenants: tenants.size,
      registryTotal: tenants.size,
      registryActive: tenants.size,
      running: 0,
      paused: 0,
      error: 0,
      activeThreads: tenants.size,
    })),
    evalInTenant: mock((tenantId: number, code: string) => {
      const t = tenants.get(tenantId);
      if (!t) throw new Error(`Tenant not found: ${tenantId}`);
      // Simple mock: return the code for verification
      return `eval:${code}`;
    }),
    setTenantGlobal: mock((tenantId: number, name: string, value: unknown) => {
      const t = tenants.get(tenantId);
      if (!t) throw new Error(`Tenant not found: ${tenantId}`);
      t.globals.set(name, value);
    }),
    getTenantGlobal: mock((tenantId: number, name: string) => {
      const t = tenants.get(tenantId);
      if (!t) throw new Error(`Tenant not found: ${tenantId}`);
      return t.globals.get(name);
    }),
    // --- Timer operations (P0.2) ---
    scheduleTenantTimeout: mock((tenantId: number, callbackId: string, _delayMs: number) => {
      const t = tenants.get(tenantId);
      if (!t) throw new Error(`Tenant not found: ${tenantId}`);
      const timerId = nextTimerId++;
      t.timers.set(timerId, { callbackId, type: 'timeout' });
      return timerId;
    }),
    scheduleTenantInterval: mock((tenantId: number, callbackId: string, _intervalMs: number) => {
      const t = tenants.get(tenantId);
      if (!t) throw new Error(`Tenant not found: ${tenantId}`);
      const timerId = nextTimerId++;
      t.timers.set(timerId, { callbackId, type: 'interval' });
      return timerId;
    }),
    cancelTenantTimer: mock((tenantId: number, timerId: number) => {
      const t = tenants.get(tenantId);
      if (t) t.timers.delete(timerId);
    }),
    pauseTenantTimers: mock((tenantId: number) => {
      const t = tenants.get(tenantId);
      if (t) t.timersPaused = true;
    }),
    resumeTenantTimers: mock((tenantId: number) => {
      const t = tenants.get(tenantId);
      if (t) t.timersPaused = false;
    }),
    // --- Permission / quota queries (P1) ---
    canUseComponent: mock((tenantId: number, componentName: string) => {
      const t = tenants.get(tenantId);
      if (!t) return false;
      if (t.allowAllComponents) return true;
      const allowed = t.allowedComponents.has(componentName);
      if (!allowed) t.componentViolations++;
      return allowed;
    }),
    canUseAPI: mock((tenantId: number, apiName: string) => {
      const t = tenants.get(tenantId);
      if (!t) return false;
      if (t.allowAllAPIs) return true;
      const allowed = t.allowedAPIs.has(apiName);
      if (!allowed) t.apiViolations++;
      return allowed;
    }),
    isOverQuota: mock((tenantId: number) => {
      const t = tenants.get(tenantId);
      if (!t) return false;
      return t.activeTimers > t.maxTimers;
    }),
    isNearQuota: mock((tenantId: number) => {
      const t = tenants.get(tenantId);
      if (!t) return false;
      return t.activeTimers > t.maxTimers * 0.8;
    }),
    // --- EventBus operations (P2) ---
    busPublish: mock((event: { channel: string; name: string; payload: string; sourceTenantId?: number }) => {
      const ch = channels.get(event.channel);
      if (!ch) return false;
      if (ch.systemOnly && event.sourceTenantId && event.sourceTenantId > 0) return false;
      busStats.totalPublished++;
      // deliver to subscribers
      const subs = channelSubs.get(event.channel) ?? [];
      for (const sub of subs) {
        sub.handler(event);
        busStats.totalDelivered++;
      }
      return true;
    }),
    busBroadcast: mock((channel: string, name: string, payload: string) => {
      const ch = channels.get(channel);
      if (!ch) return false;
      busStats.totalPublished++;
      const subs = channelSubs.get(channel) ?? [];
      for (const sub of subs) {
        sub.handler({ channel, name, payload, sourceTenantId: 0 });
        busStats.totalDelivered++;
      }
      return true;
    }),
    busUnicast: mock((targetTenantId: number, channel: string, name: string, payload: string) => {
      const ch = channels.get(channel);
      if (!ch) return false;
      busStats.totalPublished++;
      const subs = channelSubs.get(channel) ?? [];
      for (const sub of subs) {
        if (sub.tenantId === targetTenantId) {
          sub.handler({ channel, name, payload, sourceTenantId: 0 });
          busStats.totalDelivered++;
        }
      }
      return true;
    }),
    busMulticast: mock((targetTenantIds: number[], channel: string, name: string, payload: string) => {
      const ch = channels.get(channel);
      if (!ch) return false;
      busStats.totalPublished++;
      const targetSet = new Set(targetTenantIds);
      const subs = channelSubs.get(channel) ?? [];
      for (const sub of subs) {
        if (targetSet.has(sub.tenantId)) {
          sub.handler({ channel, name, payload, sourceTenantId: 0 });
          busStats.totalDelivered++;
        }
      }
      return true;
    }),
    busSubscribe: mock((tenantId: number, channel: string, _filter: string) => {
      if (!channels.has(channel)) return 0;
      const subId = nextSubId++;
      const sub = { id: subId, tenantId, channel, handler: (_event: unknown) => {} };
      if (!channelSubs.has(channel)) channelSubs.set(channel, []);
      channelSubs.get(channel)!.push(sub);
      return subId;
    }),
    busUnsubscribe: mock((subscriptionId: number) => {
      for (const [ch, subs] of channelSubs.entries()) {
        const idx = subs.findIndex(s => s.id === subscriptionId);
        if (idx >= 0) {
          subs.splice(idx, 1);
          break;
        }
      }
    }),
    busUnsubscribeAll: mock((tenantId: number) => {
      for (const [ch, subs] of channelSubs.entries()) {
        channelSubs.set(ch, subs.filter(s => s.tenantId !== tenantId));
      }
    }),
    busGetStats: mock(() => ({
      totalPublished: busStats.totalPublished,
      totalDelivered: busStats.totalDelivered,
      totalDropped: busStats.totalDropped,
      activeSubscriptions: [...channelSubs.values()].reduce((sum, s) => sum + s.length, 0),
      activeChannels: channels.size,
    })),
    busCreateChannel: mock((policy: { name: string; systemOnly?: boolean }) => {
      channels.set(policy.name, { ...policy });
    }),
  };

  return { orchestrator, tenants, channels, channelSubs, busStats };
}

// Import after defining mocks
import { OrchestratorProvider } from '../../orchestrator/orchestrator-provider';

describe('OrchestratorProvider', () => {
  let mockOrch: ReturnType<typeof createMockOrchestrator>;

  beforeEach(() => {
    mockOrch = createMockOrchestrator();
    (globalThis as Record<string, unknown>).__RillOrchestrator = mockOrch.orchestrator;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__RillOrchestrator;
  });

  // ─── Static: isAvailable ───

  describe('isAvailable', () => {
    it('should return true when __RillOrchestrator is set', () => {
      expect(OrchestratorProvider.isAvailable()).toBe(true);
    });

    it('should return false when __RillOrchestrator is not set', () => {
      delete (globalThis as Record<string, unknown>).__RillOrchestrator;
      expect(OrchestratorProvider.isAvailable()).toBe(false);
    });

    it('should return false when __RillOrchestrator is undefined', () => {
      (globalThis as Record<string, unknown>).__RillOrchestrator = undefined;
      expect(OrchestratorProvider.isAvailable()).toBe(false);
    });
  });

  // ─── Constructor ───

  describe('constructor', () => {
    it('should create provider with minimal config', () => {
      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.test' },
      });
      expect(provider).toBeDefined();
    });

    it('should create provider with full config', () => {
      const provider = new OrchestratorProvider({
	        tenantConfig: {
	          appId: 'com.test',
	          debug: true,
	          timeout: 3000,
	          quota: { maxTimers: 50, maxCallbacks: 200, maxHeapBytes: 1024 * 1024 },
	          apis: ['fetch', 'storage'],
	        },
	        timeout: 5000,
	      });
      expect(provider).toBeDefined();
    });
  });

  // ─── createRuntime ───

  describe('createRuntime', () => {
    it('should call native createTenant with appId', () => {
      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.myapp' },
      });
      const runtime = provider.createRuntime();
      expect(runtime).toBeDefined();
      expect(mockOrch.orchestrator.createTenant).toHaveBeenCalled();

      const callArgs = (mockOrch.orchestrator.createTenant as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[0].appId).toBe('com.myapp');
    });

    it('should pass timeout to createTenant config', () => {
      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.timeout' },
        timeout: 7000,
      });
      provider.createRuntime();

      const callArgs = (mockOrch.orchestrator.createTenant as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[0].timeout).toBe(7000);
    });

    it('should merge runtime options into config', () => {
      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.opts' },
      });
      provider.createRuntime({ timeout: 9000, memoryLimit: 64 * 1024 * 1024 });

	      const callArgs = (mockOrch.orchestrator.createTenant as ReturnType<typeof mock>).mock.calls[0];
	      expect(callArgs[0].timeout).toBe(9000);
	      expect(callArgs[0].quota?.maxHeapBytes).toBe(64 * 1024 * 1024);
	    });

    it('should return synchronously (not a Promise)', () => {
      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.sync' },
      });
      const result = provider.createRuntime();
      // Must be synchronous — OrchestratorProvider.createRuntime returns JSEngineRuntime, not Promise
      expect(result).toBeDefined();
      expect(result.createContext).toBeInstanceOf(Function);
      expect(result.dispose).toBeInstanceOf(Function);
    });

    it('should throw when __RillOrchestrator is not available', () => {
      delete (globalThis as Record<string, unknown>).__RillOrchestrator;

      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.missing' },
      });

      expect(() => provider.createRuntime()).toThrow('__RillOrchestrator not available');
    });

    it('should create unique tenant IDs for multiple runtimes', () => {
      const provider1 = new OrchestratorProvider({ tenantConfig: { appId: 'app1' } });
      const provider2 = new OrchestratorProvider({ tenantConfig: { appId: 'app2' } });

      provider1.createRuntime();
      provider2.createRuntime();

      expect(mockOrch.orchestrator.createTenant).toHaveBeenCalledTimes(2);
      expect(mockOrch.tenants.size).toBe(2);
    });

    it('should preserve debug flag from tenantConfig', () => {
      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.debug', debug: true },
      });
      provider.createRuntime();

      const callArgs = (mockOrch.orchestrator.createTenant as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[0].debug).toBe(true);
    });

    it('should preserve APIs whitelist', () => {
      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.apis', apis: ['fetch', 'storage'] },
      });
      provider.createRuntime();

      const callArgs = (mockOrch.orchestrator.createTenant as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[0].apis).toEqual(['fetch', 'storage']);
    });
  });

  // ─── Runtime ───

  describe('runtime', () => {
    it('should have createContext and dispose methods', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.rt' } });
      const runtime = provider.createRuntime();

      expect(typeof runtime.createContext).toBe('function');
      expect(typeof runtime.dispose).toBe('function');
    });

    it('dispose should call native destroyTenant', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.dispose' } });
      const runtime = provider.createRuntime();

      runtime.dispose();

      expect(mockOrch.orchestrator.destroyTenant).toHaveBeenCalledTimes(1);
    });

    it('dispose should be idempotent', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.idem' } });
      const runtime = provider.createRuntime();

      runtime.dispose();
      runtime.dispose();
      runtime.dispose();

      // Only one actual destroyTenant call
      expect(mockOrch.orchestrator.destroyTenant).toHaveBeenCalledTimes(1);
    });

    it('createContext after dispose should throw', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.after-dispose' } });
      const runtime = provider.createRuntime();

      runtime.dispose();

      expect(() => runtime.createContext()).toThrow('disposed');
    });
  });

  // ─── Context: eval ───

  describe('context.eval', () => {
    it('should delegate to native evalInTenant', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.eval' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const result = context.eval('1 + 1');

      expect(mockOrch.orchestrator.evalInTenant).toHaveBeenCalled();
      expect(result).toBe('eval:1 + 1');
    });

    it('should pass correct tenantId to evalInTenant', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.eval-id' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.eval('test code');

      const callArgs = (mockOrch.orchestrator.evalInTenant as ReturnType<typeof mock>).mock.calls[0];
      expect(typeof callArgs[0]).toBe('number');
      expect(callArgs[1]).toBe('test code');
    });

    it('should propagate errors from native eval', () => {
      // Override mock to throw
      (mockOrch.orchestrator.evalInTenant as ReturnType<typeof mock>).mockImplementation(() => {
        throw new Error('SyntaxError: unexpected token');
      });

      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.eval-err' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      expect(() => context.eval('invalid {')).toThrow('SyntaxError');
    });

    it('should throw after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.eval-disposed' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();

      expect(() => context.eval('1')).toThrow('disposed');
    });

    it('should handle empty code string', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.empty' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const result = context.eval('');
      expect(result).toBe('eval:');
    });

    it('should handle multiline code', () => {
      const code = 'var a = 1;\nvar b = 2;\na + b;';
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.multi' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.eval(code);

      const callArgs = (mockOrch.orchestrator.evalInTenant as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[1]).toBe(code);
    });
  });

  // ─── Context: inject ───

  describe('context.inject', () => {
    it('should delegate to native setTenantGlobal', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.set' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.inject('myVar', 42);

      expect(mockOrch.orchestrator.setTenantGlobal).toHaveBeenCalled();
    });

    it('should pass correct arguments', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.set-args' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.inject('testName', { key: 'value' });

      const callArgs = (mockOrch.orchestrator.setTenantGlobal as ReturnType<typeof mock>).mock.calls[0];
      expect(typeof callArgs[0]).toBe('number'); // tenantId
      expect(callArgs[1]).toBe('testName');
      expect(callArgs[2]).toEqual({ key: 'value' });
    });

    it('should handle function values', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.set-fn' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const fn = () => 'hello';
      context.inject('myFn', fn);

      const callArgs = (mockOrch.orchestrator.setTenantGlobal as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[2]).toBe(fn);
    });

    it('should handle undefined values', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.set-undef' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.inject('gone', undefined);

      expect(mockOrch.orchestrator.setTenantGlobal).toHaveBeenCalled();
    });

    it('should silently no-op after dispose', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.set-disposed' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      // Should not throw — silently no-op
      context.inject('x', 1);

      // setTenantGlobal should NOT have been called after dispose
      expect(mockOrch.orchestrator.setTenantGlobal).not.toHaveBeenCalled();
    });

    it('should support multiple inject calls', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.set-multi' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.inject('a', 1);
      context.inject('b', 'hello');
      context.inject('c', [1, 2, 3]);

      expect(mockOrch.orchestrator.setTenantGlobal).toHaveBeenCalledTimes(3);
    });
  });

  // ─── Context: extract ───

  describe('context.extract', () => {
    it('should delegate to native getTenantGlobal', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.get' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      // First set, then get
      context.inject('myVar', 42);
      const result = context.extract('myVar');

      expect(mockOrch.orchestrator.getTenantGlobal).toHaveBeenCalled();
      expect(result).toBe(42); // Mock stores and returns it
    });

    it('should return undefined for non-existent globals', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.get-none' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const result = context.extract('nonExistent');

      expect(result).toBeUndefined();
    });

    it('should return undefined after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.get-disposed' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      const result = context.extract('x');

      // Should return undefined, not throw
      expect(result).toBeUndefined();
      // Should NOT call native method
      expect(mockOrch.orchestrator.getTenantGlobal).not.toHaveBeenCalled();
    });

    it('should retrieve value set by inject', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.roundtrip' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const testObj = { nested: { deep: true }, arr: [1, 2] };
      context.inject('obj', testObj);
      const result = context.extract('obj');

      expect(result).toEqual(testObj);
    });
  });

  // ─── Context: dispose ───

  describe('context.dispose', () => {
    it('should be idempotent', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.ctx-dispose' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      context.dispose();
      context.dispose();

      // Should not crash
    });

    it('should prevent further eval calls', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.ctx-dis-eval' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();

      expect(() => context.eval('1')).toThrow('disposed');
    });

    it('should not call destroyTenant (runtime owns lifecycle)', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.ctx-no-destroy' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();

      // Context dispose does NOT destroy the tenant — only runtime.dispose does
      expect(mockOrch.orchestrator.destroyTenant).not.toHaveBeenCalled();
    });
  });

  // ─── Multiple tenants ───

  describe('multi-tenant isolation', () => {
    it('should create separate tenants for each runtime', () => {
      const p1 = new OrchestratorProvider({ tenantConfig: { appId: 'app-1' } });
      const p2 = new OrchestratorProvider({ tenantConfig: { appId: 'app-2' } });

      const r1 = p1.createRuntime();
      const r2 = p2.createRuntime();

      expect(mockOrch.orchestrator.createTenant).toHaveBeenCalledTimes(2);
      expect(mockOrch.tenants.size).toBe(2);

      r1.dispose();
      r2.dispose();
    });

    it('should have isolated globals between tenants', () => {
      const p1 = new OrchestratorProvider({ tenantConfig: { appId: 'iso-1' } });
      const p2 = new OrchestratorProvider({ tenantConfig: { appId: 'iso-2' } });

      const c1 = p1.createRuntime().createContext();
      const c2 = p2.createRuntime().createContext();

      c1.inject('shared', 'tenant-1');
      c2.inject('shared', 'tenant-2');

      // Each tenant has its own globals map in the mock
      expect(c1.extract('shared')).toBe('tenant-1');
      expect(c2.extract('shared')).toBe('tenant-2');
    });

    it('should destroy only the targeted tenant', () => {
      const p1 = new OrchestratorProvider({ tenantConfig: { appId: 'destroy-1' } });
      const p2 = new OrchestratorProvider({ tenantConfig: { appId: 'destroy-2' } });

      const r1 = p1.createRuntime();
      const r2 = p2.createRuntime();

      r1.dispose();

      // Only one destroyTenant call
      expect(mockOrch.orchestrator.destroyTenant).toHaveBeenCalledTimes(1);

      // r2 should still work
      const c2 = r2.createContext();
      c2.inject('alive', true);
      expect(c2.extract('alive')).toBe(true);

      r2.dispose();
    });
  });

  // ─── Context: timer delegation (P0.2) ───

  describe('context.scheduleTimeout', () => {
    it('should delegate to native scheduleTenantTimeout', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.timeout' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const timerId = (context as any).scheduleTimeout('cb-1', 1000);

      expect(mockOrch.orchestrator.scheduleTenantTimeout).toHaveBeenCalled();
      expect(typeof timerId).toBe('number');
    });

    it('should pass correct tenantId, callbackId, and delay', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.to-args' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).scheduleTimeout('my-callback', 500);

      const callArgs = (mockOrch.orchestrator.scheduleTenantTimeout as ReturnType<typeof mock>).mock.calls[0];
      expect(typeof callArgs[0]).toBe('number'); // tenantId
      expect(callArgs[1]).toBe('my-callback');
      expect(callArgs[2]).toBe(500);
    });

    it('should return unique timer IDs', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.to-ids' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const id1 = (context as any).scheduleTimeout('cb-a', 100);
      const id2 = (context as any).scheduleTimeout('cb-b', 200);

      expect(id1).not.toBe(id2);
    });

    it('should throw after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.to-disposed' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();

      expect(() => (context as any).scheduleTimeout('cb', 100)).toThrow('disposed');
    });
  });

  describe('context.scheduleInterval', () => {
    it('should delegate to native scheduleTenantInterval', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.interval' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const timerId = (context as any).scheduleInterval('cb-int', 200);

      expect(mockOrch.orchestrator.scheduleTenantInterval).toHaveBeenCalled();
      expect(typeof timerId).toBe('number');
    });

    it('should pass correct arguments', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.int-args' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).scheduleInterval('repeat-cb', 300);

      const callArgs = (mockOrch.orchestrator.scheduleTenantInterval as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[1]).toBe('repeat-cb');
      expect(callArgs[2]).toBe(300);
    });

    it('should throw after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.int-disposed' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();

      expect(() => (context as any).scheduleInterval('cb', 100)).toThrow('disposed');
    });
  });

  describe('context.cancelTimer', () => {
    it('should delegate to native cancelTenantTimer', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.cancel' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const timerId = (context as any).scheduleTimeout('cb-cancel', 1000);
      (context as any).cancelTimer(timerId);

      expect(mockOrch.orchestrator.cancelTenantTimer).toHaveBeenCalled();
      const callArgs = (mockOrch.orchestrator.cancelTenantTimer as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[1]).toBe(timerId);
    });

    it('should remove timer from mock state', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.cancel-state' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const timerId = (context as any).scheduleTimeout('cb-rm', 500);
      // Verify timer exists in mock
      const tenantEntry = [...mockOrch.tenants.values()][0];
      expect(tenantEntry.timers.has(timerId)).toBe(true);

      (context as any).cancelTimer(timerId);
      expect(tenantEntry.timers.has(timerId)).toBe(false);
    });

    it('should silently no-op after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.cancel-disposed' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const timerId = (context as any).scheduleTimeout('cb-noop', 500);
      context.dispose();

      // Should not throw
      (context as any).cancelTimer(timerId);
      expect(mockOrch.orchestrator.cancelTenantTimer).not.toHaveBeenCalled();
    });
  });

  // ─── Runtime: timer lifecycle (P0.2) ───

  describe('runtime.pauseTimers', () => {
    it('should delegate to native pauseTenantTimers', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.pause-t' } });
      const runtime = provider.createRuntime();

      (runtime as any).pauseTimers();

      expect(mockOrch.orchestrator.pauseTenantTimers).toHaveBeenCalled();
    });

    it('should pass correct tenantId', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.pause-id' } });
      const runtime = provider.createRuntime();

      (runtime as any).pauseTimers();

      const callArgs = (mockOrch.orchestrator.pauseTenantTimers as ReturnType<typeof mock>).mock.calls[0];
      expect(typeof callArgs[0]).toBe('number');
    });

    it('should silently no-op after runtime is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.pause-disposed' } });
      const runtime = provider.createRuntime();

      runtime.dispose();
      (runtime as any).pauseTimers();

      // pauseTenantTimers should not be called after dispose
      expect(mockOrch.orchestrator.pauseTenantTimers).not.toHaveBeenCalled();
    });

    it('should update mock timer state', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.pause-state' } });
      const runtime = provider.createRuntime();

      (runtime as any).pauseTimers();

      const tenantEntry = [...mockOrch.tenants.values()][0];
      expect(tenantEntry.timersPaused).toBe(true);
    });
  });

  describe('runtime.resumeTimers', () => {
    it('should delegate to native resumeTenantTimers', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.resume-t' } });
      const runtime = provider.createRuntime();

      // Pause first, then resume
      (runtime as any).pauseTimers();
      (runtime as any).resumeTimers();

      expect(mockOrch.orchestrator.resumeTenantTimers).toHaveBeenCalled();
    });

    it('should update mock timer state back to unpaused', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.resume-state' } });
      const runtime = provider.createRuntime();

      (runtime as any).pauseTimers();
      const tenantEntry = [...mockOrch.tenants.values()][0];
      expect(tenantEntry.timersPaused).toBe(true);

      (runtime as any).resumeTimers();
      expect(tenantEntry.timersPaused).toBe(false);
    });

    it('should silently no-op after runtime is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.resume-disposed' } });
      const runtime = provider.createRuntime();

      runtime.dispose();
      (runtime as any).resumeTimers();

      expect(mockOrch.orchestrator.resumeTenantTimers).not.toHaveBeenCalled();
    });
  });

  // ─── Multi-tenant timer isolation ───

  describe('multi-tenant timer isolation', () => {
    it('should schedule timers on different tenants independently', () => {
      const p1 = new OrchestratorProvider({ tenantConfig: { appId: 'timer-1' } });
      const p2 = new OrchestratorProvider({ tenantConfig: { appId: 'timer-2' } });

      const r1 = p1.createRuntime();
      const r2 = p2.createRuntime();
      const c1 = r1.createContext();
      const c2 = r2.createContext();

      const t1 = (c1 as any).scheduleTimeout('cb-t1', 100);
      const t2 = (c2 as any).scheduleTimeout('cb-t2', 200);

      expect(t1).not.toBe(t2);
      expect(mockOrch.orchestrator.scheduleTenantTimeout).toHaveBeenCalledTimes(2);

      // Verify each tenant has its own timer
      const [tenant1, tenant2] = [...mockOrch.tenants.values()];
      expect(tenant1.timers.size).toBe(1);
      expect(tenant2.timers.size).toBe(1);

      r1.dispose();
      r2.dispose();
    });

    it('should cancel timers without affecting other tenants', () => {
      const p1 = new OrchestratorProvider({ tenantConfig: { appId: 'cancel-1' } });
      const p2 = new OrchestratorProvider({ tenantConfig: { appId: 'cancel-2' } });

      const r1 = p1.createRuntime();
      const r2 = p2.createRuntime();
      const c1 = r1.createContext();
      const c2 = r2.createContext();

      const t1 = (c1 as any).scheduleTimeout('cb-c1', 100);
      (c2 as any).scheduleTimeout('cb-c2', 200);

      (c1 as any).cancelTimer(t1);

      const [tenant1, tenant2] = [...mockOrch.tenants.values()];
      expect(tenant1.timers.size).toBe(0);
      expect(tenant2.timers.size).toBe(1);

      r1.dispose();
      r2.dispose();
    });

    it('should pause/resume timers per tenant independently', () => {
      const p1 = new OrchestratorProvider({ tenantConfig: { appId: 'pr-1' } });
      const p2 = new OrchestratorProvider({ tenantConfig: { appId: 'pr-2' } });

      const r1 = p1.createRuntime();
      const r2 = p2.createRuntime();

      (r1 as any).pauseTimers();

      const [tenant1, tenant2] = [...mockOrch.tenants.values()];
      expect(tenant1.timersPaused).toBe(true);
      expect(tenant2.timersPaused).toBe(false);

      (r1 as any).resumeTimers();
      (r2 as any).pauseTimers();

      expect(tenant1.timersPaused).toBe(false);
      expect(tenant2.timersPaused).toBe(true);

      r1.dispose();
      r2.dispose();
    });
  });

  // ─── Context: permission queries (P1) ───

  describe('context.canUseComponent', () => {
    it('should delegate to native canUseComponent', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.perm' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const result = (context as any).canUseComponent('View');

      expect(mockOrch.orchestrator.canUseComponent).toHaveBeenCalled();
      expect(result).toBe(true); // allowAll = true by default
    });

    it('should deny when component not in whitelist', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.perm-deny' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      // Override tenant to have restricted components
      const tenantEntry = [...mockOrch.tenants.values()][0];
      tenantEntry.allowAllComponents = false;
      tenantEntry.allowedComponents = new Set(['View', 'Text']);

      expect((context as any).canUseComponent('View')).toBe(true);
      expect((context as any).canUseComponent('WebView')).toBe(false);
    });

    it('should return false after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.perm-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      expect((context as any).canUseComponent('View')).toBe(false);
    });
  });

  describe('context.canUseAPI', () => {
    it('should delegate to native canUseAPI', () => {
      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.api', apis: ['fetch', 'storage'] },
      });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      expect((context as any).canUseAPI('fetch')).toBe(true);
      expect(mockOrch.orchestrator.canUseAPI).toHaveBeenCalled();
    });

    it('should deny unlisted APIs', () => {
      const provider = new OrchestratorProvider({
        tenantConfig: { appId: 'com.api-deny', apis: ['fetch'] },
      });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      expect((context as any).canUseAPI('fetch')).toBe(true);
      expect((context as any).canUseAPI('camera')).toBe(false);
    });

    it('should return false after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.api-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      expect((context as any).canUseAPI('fetch')).toBe(false);
    });
  });

  describe('context.isOverQuota / isNearQuota', () => {
    it('should delegate isOverQuota to native', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.quota' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      expect((context as any).isOverQuota()).toBe(false);
      expect(mockOrch.orchestrator.isOverQuota).toHaveBeenCalled();
    });

    it('should delegate isNearQuota to native', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.near-q' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      expect((context as any).isNearQuota()).toBe(false);
      expect(mockOrch.orchestrator.isNearQuota).toHaveBeenCalled();
    });

    it('should return false after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.q-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      expect((context as any).isOverQuota()).toBe(false);
      expect((context as any).isNearQuota()).toBe(false);
    });
  });

  // ─── Context: EventBus delegation (P2) ───

  describe('context.busCreateChannel', () => {
    it('should delegate to native busCreateChannel', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-ch' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busCreateChannel({ name: 'test-channel' });

      expect(mockOrch.orchestrator.busCreateChannel).toHaveBeenCalled();
      expect(mockOrch.channels.has('test-channel')).toBe(true);
    });

    it('should no-op after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-ch-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      (context as any).busCreateChannel({ name: 'never' });

      expect(mockOrch.orchestrator.busCreateChannel).not.toHaveBeenCalled();
    });
  });

  describe('context.busSubscribe', () => {
    it('should delegate to native busSubscribe with tenantId', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-sub' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busCreateChannel({ name: 'events' });
      const subId = (context as any).busSubscribe('events', '*');

      expect(mockOrch.orchestrator.busSubscribe).toHaveBeenCalled();
      expect(typeof subId).toBe('number');
      expect(subId).toBeGreaterThan(0);
    });

    it('should return 0 for non-existent channel', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-sub-none' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const subId = (context as any).busSubscribe('nonexistent', '*');
      expect(subId).toBe(0);
    });

    it('should return 0 after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-sub-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      const subId = (context as any).busSubscribe('test', '*');
      expect(subId).toBe(0);
    });
  });

  describe('context.busUnsubscribe', () => {
    it('should delegate to native busUnsubscribe', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-unsub' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busCreateChannel({ name: 'ch' });
      const subId = (context as any).busSubscribe('ch', '*');
      (context as any).busUnsubscribe(subId);

      expect(mockOrch.orchestrator.busUnsubscribe).toHaveBeenCalled();
    });
  });

  describe('context.busUnsubscribeAll', () => {
    it('should delegate to native busUnsubscribeAll with tenantId', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-unsub-all' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busUnsubscribeAll();

      expect(mockOrch.orchestrator.busUnsubscribeAll).toHaveBeenCalled();
    });

    it('should no-op after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-unsub-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      (context as any).busUnsubscribeAll();

      expect(mockOrch.orchestrator.busUnsubscribeAll).not.toHaveBeenCalled();
    });
  });

  describe('context.busBroadcast', () => {
    it('should delegate to native busBroadcast', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-bcast' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busCreateChannel({ name: 'broadcast-ch' });
      const result = (context as any).busBroadcast('broadcast-ch', 'ping', '{}');

      expect(mockOrch.orchestrator.busBroadcast).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return false for non-existent channel', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-bcast-none' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const result = (context as any).busBroadcast('nonexistent', 'ping', '{}');
      expect(result).toBe(false);
    });

    it('should return false after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-bcast-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      const result = (context as any).busBroadcast('ch', 'ping', '{}');
      expect(result).toBe(false);
    });
  });

  describe('context.busPublish', () => {
    it('should delegate to native busPublish', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-pub' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busCreateChannel({ name: 'pub-ch' });
      const result = (context as any).busPublish({
        channel: 'pub-ch',
        name: 'test-event',
        payload: '{"key":"value"}',
      });

      expect(mockOrch.orchestrator.busPublish).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should auto-set sourceTenantId to context tenantId', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-pub-id' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busCreateChannel({ name: 'pub-ch2' });
      (context as any).busPublish({
        channel: 'pub-ch2',
        name: 'event',
        payload: '{}',
      });

      const callArgs = (mockOrch.orchestrator.busPublish as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[0].sourceTenantId).toBeGreaterThan(0);
    });

    it('should return false after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-pub-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      const result = (context as any).busPublish({
        channel: 'ch', name: 'evt', payload: '{}',
      });
      expect(result).toBe(false);
    });
  });

  describe('context.busUnicast', () => {
    it('should delegate to native busUnicast', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-uni' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busCreateChannel({ name: 'uni-ch' });
      const result = (context as any).busUnicast(42, 'uni-ch', 'hello', '{}');

      expect(mockOrch.orchestrator.busUnicast).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return false after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-uni-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      const result = (context as any).busUnicast(1, 'ch', 'evt', '{}');
      expect(result).toBe(false);
    });
  });

  describe('context.busMulticast', () => {
    it('should delegate to native busMulticast', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-multi' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busCreateChannel({ name: 'mcast-ch' });
      const result = (context as any).busMulticast([1, 2, 3], 'mcast-ch', 'hello', '{}');

      expect(mockOrch.orchestrator.busMulticast).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return false after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-multi-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      const result = (context as any).busMulticast([1], 'ch', 'evt', '{}');
      expect(result).toBe(false);
    });
  });

  describe('context.busGetStats', () => {
    it('should return stats even after publish activity', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-stats' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      (context as any).busCreateChannel({ name: 'stats-ch' });
      (context as any).busBroadcast('stats-ch', 'ping', '{}');

      const stats = (context as any).busGetStats();
      expect(stats.totalPublished).toBeGreaterThanOrEqual(1);
      expect(stats.activeChannels).toBeGreaterThanOrEqual(1);
    });

    it('should work even after context is disposed', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.bus-stats-dis' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();
      // busGetStats does NOT check disposed — it's a global query
      const stats = (context as any).busGetStats();
      expect(stats).toBeDefined();
      expect(typeof stats.totalPublished).toBe('number');
    });
  });

  // ─── JSEngineProvider interface compliance ───

  describe('JSEngineProvider interface', () => {
    it('createRuntime returns object with createContext and dispose', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.iface' } });
      const runtime = provider.createRuntime();

      expect(runtime).toHaveProperty('createContext');
      expect(runtime).toHaveProperty('dispose');
    });

    it('createContext returns object with eval, inject, extract, dispose', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.ctx-iface' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      expect(context).toHaveProperty('eval');
      expect(context).toHaveProperty('inject');
      expect(context).toHaveProperty('extract');
      expect(context).toHaveProperty('dispose');
    });

    it('all context methods are functions', () => {
      const provider = new OrchestratorProvider({ tenantConfig: { appId: 'com.fns' } });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      expect(typeof context.eval).toBe('function');
      expect(typeof context.inject).toBe('function');
      expect(typeof context.extract).toBe('function');
      expect(typeof context.dispose).toBe('function');
    });
  });
});
