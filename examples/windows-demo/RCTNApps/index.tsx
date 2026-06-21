/**
 * windows-demo — React Native + rill sandbox
 *
 * IMPORTANT: Sandbox JSI bindings and the TenantManager shim MUST be installed
 * BEFORE importing rill. We use dynamic require() to ensure correct ordering
 * (static imports get hoisted by Babel).
 */

import React from 'react';
import { AppRegistry, NativeModules, Platform } from 'react-native';

type NativeSandboxModule = {
  install?: () => boolean;
  getCompiledSandboxEngine?: () => string;
};

const nativeSandbox = NativeModules.RillSandboxNative as NativeSandboxModule | undefined;
const compiledEngine = nativeSandbox?.getCompiledSandboxEngine?.();

const getSandboxModuleForEngine = (engine?: string): any => {
  const key = (engine || '').toLowerCase();
  const qjsModule = (globalThis as any).__QuickJSSandboxJSI;
  const hermesModule = (globalThis as any).__HermesSandboxJSI;

  // Never silently fall back to another engine. If compiled engine is missing,
  // we should fail loudly so engine mismatch can be diagnosed.
  if (key === 'hermes') return hermesModule;
  if (key === 'quickjs') return qjsModule;
  return hermesModule || qjsModule;
};

// Step 1: Install the compile-time selected sandbox engine
if (Platform.OS === 'windows') {
  const mod = nativeSandbox;
  if (mod) {
    try {
      const ok = mod.install?.();
      console.log('[windows-demo] Sandbox install:', { ok, compiledEngine });
    } catch (e) {
      console.warn('[windows-demo] Failed to install sandbox:', e);
    }

    // Verify globals are installed
    console.log('[windows-demo] Globals check:', {
      __QuickJSSandboxJSI: typeof (globalThis as any).__QuickJSSandboxJSI,
      __HermesSandboxJSI: typeof (globalThis as any).__HermesSandboxJSI,
      __RillTenantManager: typeof (globalThis as any).__RillTenantManager,
    });
  }
}

// Step 2: Create __RillTenantManager shim wrapping whichever engine was installed.
// The rill Engine checks TenantManagerProvider.isAvailable() first, which looks
// for globalThis.__RillTenantManager. On iOS/Android, the native TenantManager
// C++ module provides this. On Windows we only have the sandbox JSI bindings,
// so we create a lightweight JS shim that delegates to the available engine.
if (Platform.OS === 'windows' && typeof (globalThis as any).__RillTenantManager === 'undefined') {
  const sandboxModule = getSandboxModuleForEngine(compiledEngine);

  if (sandboxModule) {
    let nextTenantId = 1;
    const tenants: Record<number, { runtime: any; context: any }> = {};

    (globalThis as any).__RillTenantManager = {
      // --- Tenant lifecycle ---
      createTenant(config: any): number {
        const timeout = config?.timeout ?? 30000;
        const runtime = sandboxModule.createRuntime({ timeout });
        const context = runtime.createContext();
        const id = nextTenantId++;
        tenants[id] = { runtime, context };
        console.log('[TenantManagerShim] createTenant:', id);
        return id;
      },
      destroyTenant(tenantId: number): void {
        const t = tenants[tenantId];
        if (!t) return;
        try {
          t.context.dispose();
        } catch (_e) {
          /* ignore */
        }
        try {
          t.runtime.dispose();
        } catch (_e) {
          /* ignore */
        }
        delete tenants[tenantId];
        console.log('[TenantManagerShim] destroyTenant:', tenantId);
      },
      pauseTenant(_tenantId: number): void {
        /* stub */
      },
      resumeTenant(_tenantId: number): void {
        /* stub */
      },

      // --- Code loading ---
      loadBundle(tenantId: number, code: string): void {
        const t = tenants[tenantId];
        if (t) t.context.eval(code);
      },

      // --- Communication ---
      sendEvent(_tenantId: number, _name: string, _payload?: any): void {
        /* stub */
      },
      broadcast(_name: string, _payload?: any): void {
        /* stub */
      },

      // --- Host callbacks ---
      setHostCallbacks(_callbacks: any): void {
        /* stub */
      },

      // --- Metrics ---
      getTenantInfo(_tenantId: number): any {
        return {};
      },
      getMetrics(): any {
        return { totalTenants: Object.keys(tenants).length };
      },

      // --- Per-tenant context operations (used by Engine) ---
      evalInTenant(tenantId: number, code: string): any {
        const t = tenants[tenantId];
        if (!t) throw new Error(`[TenantManagerShim] Tenant ${tenantId} not found`);
        return t.context.eval(code);
      },
      setTenantGlobal(tenantId: number, name: string, value: any): void {
        const t = tenants[tenantId];
        if (t) t.context.inject(name, value);
      },
      getTenantGlobal(tenantId: number, name: string): any {
        const t = tenants[tenantId];
        if (!t) return undefined;
        return t.context.extract(name);
      },

      // --- Timer operations (stubs — Engine's TimerManager handles timers) ---
      scheduleTenantTimeout(_tenantId: number, _callbackId: string, _delayMs: number): number {
        return 0;
      },
      scheduleTenantInterval(_tenantId: number, _callbackId: string, _intervalMs: number): number {
        return 0;
      },
      cancelTenantTimer(_tenantId: number, _timerId: number): void {
        /* stub */
      },
      pauseTenantTimers(_tenantId: number): void {
        /* stub */
      },
      resumeTenantTimers(_tenantId: number): void {
        /* stub */
      },

      // --- Permission / quota queries (stubs — allow everything) ---
      canUseComponent(_tenantId: number, _name: string): boolean {
        return true;
      },
      canUseAPI(_tenantId: number, _api: string): boolean {
        return true;
      },
      isOverQuota(_tenantId: number): boolean {
        return false;
      },
      isNearQuota(_tenantId: number): boolean {
        return false;
      },

      // --- EventBus operations (stubs) ---
      busPublish(_event: any): boolean {
        return false;
      },
      busBroadcast(_channel: string, _name: string, _payload: string): boolean {
        return false;
      },
      busUnicast(_targetId: number, _channel: string, _name: string, _payload: string): boolean {
        return false;
      },
      busMulticast(
        _targetIds: number[],
        _channel: string,
        _name: string,
        _payload: string
      ): boolean {
        return false;
      },
      busSubscribe(_tenantId: number, _channel: string, _filter: string): number {
        return 0;
      },
      busUnsubscribe(_subscriptionId: number): void {
        /* stub */
      },
      busUnsubscribeAll(_tenantId: number): void {
        /* stub */
      },
      busGetStats(): any {
        return {
          totalPublished: 0,
          totalDelivered: 0,
          totalDropped: 0,
          activeSubscriptions: 0,
          activeChannels: 0,
        };
      },
      busCreateChannel(_policy: any): void {
        /* stub */
      },
    };

    const engineName =
      compiledEngine ||
      (sandboxModule === (globalThis as any).__HermesSandboxJSI ? 'hermes' : 'quickjs');
    console.log(`[windows-demo] __RillTenantManager shim installed (backed by ${engineName})`);
  } else if (compiledEngine) {
    console.error(
      `[windows-demo] Compiled engine '${compiledEngine}' global is missing; tenant-manager shim not installed`
    );
  }
}

// Step 3: NOW import App (which imports rill) — engines are available
// Using require() to prevent Babel from hoisting this above the install code
const App = require('./App').default;

// Error boundary wrapper
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[ErrorBoundary]', error.message, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      const { View, Text, ScrollView } = require('react-native');
      return React.createElement(
        ScrollView,
        { style: { flex: 1, backgroundColor: '#2b0b0b', padding: 16 } },
        React.createElement(
          Text,
          { style: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 } },
          'Render Error'
        ),
        React.createElement(
          Text,
          { style: { color: '#ff8888', fontSize: 13, marginBottom: 16 } },
          String(this.state.error.message)
        )
      );
    }
    return this.props.children;
  }
}

const WrappedApp = (props: Record<string, unknown>) =>
  React.createElement(ErrorBoundary, null, React.createElement(App, props));

AppRegistry.registerComponent('RillDemo', () => WrappedApp);

console.log('[windows-demo] App registered as RillDemo');
