/**
 * Shared demo App — Host side
 *
 * The Host creates an Engine, registers default RN components,
 * and loads Guest code that contains all business logic.
 * Guest renders its UI through the rill bridge; the Host
 * displays it via useEngineView.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  NativeModules,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Engine, useEngineView } from 'rill/host';
import { DefaultComponents } from 'rill/host/preset';

// ---------------------------------------------------------------------------
// Guest code — runs inside the sandbox engine
// Uses React.createElement (no JSX transpiler in sandbox)
// ---------------------------------------------------------------------------
const GUEST_CODE = `
  var React = require('react');
  var useState = React.useState;
  var useCallback = React.useCallback;
  var render = require('rill/reconciler').render;

  // h() shorthand for React.createElement
  var h = React.createElement;

  // ── Guest App component ─────────────────────────────────────────────────

  function GuestApp() {
    var countState = useState(0);
    var count = countState[0];
    var setCount = countState[1];

    var handleIncrement = useCallback(function() { setCount(function(c) { return c + 1; }); }, []);
    var handleDecrement = useCallback(function() { setCount(function(c) { return c - 1; }); }, []);
    var handleReset    = useCallback(function() { setCount(0); }, []);

    return h('ScrollView', { style: { flex: 1 } },
      h('View', { style: { padding: 20, paddingTop: 12 } },

        // ── Section: Counter (business logic in Guest) ──────────────────
        h('View', { style: { marginBottom: 24 } },
          h('Text', { style: styles.sectionTitle }, 'COUNTER TEST'),
          h('Text', { style: styles.sectionDesc }, 'State managed entirely in Guest sandbox'),
          h('View', { style: styles.counterRow },
            h('TouchableOpacity', { style: styles.counterBtn, onPress: handleDecrement },
              h('Text', { style: styles.counterBtnText }, '\\u2212')
            ),
            h('Text', { style: styles.counterValue }, '' + count),
            h('TouchableOpacity', { style: styles.counterBtn, onPress: handleIncrement },
              h('Text', { style: styles.counterBtnText }, '+')
            )
          ),
          h('TouchableOpacity', { style: styles.resetBtn, onPress: handleReset },
            h('Text', { style: styles.resetBtnText }, 'Reset')
          )
        ),

        // ── Section: Layout test ────────────────────────────────────────
        h('View', { style: { marginBottom: 24 } },
          h('Text', { style: styles.sectionTitle }, 'LAYOUT TEST'),
          h('Text', { style: styles.sectionDesc }, 'Flexbox rendering through sandbox bridge'),
          h('View', { style: styles.colorBoxRow },
            h('View', { style: [styles.colorBox, { backgroundColor: '#e74c3c' }] },
              h('Text', { style: styles.colorBoxLabel }, 'R')
            ),
            h('View', { style: [styles.colorBox, { backgroundColor: '#2ecc71' }] },
              h('Text', { style: styles.colorBoxLabel }, 'G')
            ),
            h('View', { style: [styles.colorBox, { backgroundColor: '#3498db' }] },
              h('Text', { style: styles.colorBoxLabel }, 'B')
            )
          )
        ),

        // ── Section: Callback round-trip test ───────────────────────────
        h('View', { style: { marginBottom: 40 } },
          h('Text', { style: styles.sectionTitle }, 'CALLBACK TEST'),
          h('Text', { style: styles.sectionDesc }, 'Host\\u2194Guest function call round-trip'),
          h('Text', { style: styles.infoText },
            'Counter onPress callbacks travel: Guest \\u2192 Bridge \\u2192 Host \\u2192 RN'
          ),
          h('Text', { style: styles.infoText },
            'State updates travel: Guest setState \\u2192 reconciler \\u2192 Bridge \\u2192 Host Receiver'
          )
        )
      )
    );
  }

  // ── Styles (Guest-side StyleSheet-like object) ──────────────────────────

  var styles = {
    sectionTitle: {
      fontSize: 12, fontWeight: '700', color: '#888',
      letterSpacing: 1, marginBottom: 4,
    },
    sectionDesc: {
      fontSize: 12, color: '#555', marginBottom: 12,
    },
    counterRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 24, marginBottom: 12,
    },
    counterBtn: {
      width: 56, height: 56, borderRadius: 12,
      backgroundColor: '#1e1e3a', alignItems: 'center', justifyContent: 'center',
    },
    counterBtnText: { fontSize: 28, color: '#fff', fontWeight: '300' },
    counterValue: {
      fontSize: 48, fontWeight: '700', color: '#fff',
      minWidth: 80, textAlign: 'center',
    },
    resetBtn: {
      alignSelf: 'center', paddingHorizontal: 20, paddingVertical: 8,
      borderRadius: 6, backgroundColor: '#2a2a4a',
    },
    resetBtnText: { fontSize: 13, color: '#888' },
    colorBoxRow: {
      flexDirection: 'row', justifyContent: 'space-around',
    },
    colorBox: {
      width: 72, height: 72, borderRadius: 12,
      alignItems: 'center', justifyContent: 'center',
    },
    colorBoxLabel: { fontSize: 20, fontWeight: '700', color: '#fff' },
    infoText: { fontSize: 12, color: '#555', marginBottom: 4 },
  };

  // ── Mount ───────────────────────────────────────────────────────────────

  render(h(GuestApp), globalThis.__rill_sendBatch);
`;

// ---------------------------------------------------------------------------
// Host App
// ---------------------------------------------------------------------------

// Detect available sandbox engines (JSI globals installed by native side)
declare const global: {
  __JSCSandboxJSI?: SandboxModule;
  __HermesSandboxJSI?: SandboxModule;
  __QuickJSSandboxJSI?: SandboxModule;
};

interface SandboxContext {
  eval(code: string): unknown;
  inject(name: string, value: unknown): void;
  extract(name: string): unknown;
  dispose(): void;
}

interface SandboxRuntime {
  createContext(): SandboxContext;
  dispose(): void;
}

interface SandboxModule {
  createRuntime(options?: { timeout?: number }): SandboxRuntime;
  isAvailable(): boolean;
}

function getDetectedEngines(): string[] {
  const engines: string[] = [];
  if (global.__JSCSandboxJSI?.isAvailable?.()) engines.push('JSC');
  if (global.__HermesSandboxJSI?.isAvailable?.()) engines.push('Hermes');
  if (global.__QuickJSSandboxJSI?.isAvailable?.()) engines.push('QuickJS');
  return engines;
}

// ---------------------------------------------------------------------------
// Android-only wrapper UI (match iOS native wrapper)
// ---------------------------------------------------------------------------
const RillDemoConfig = NativeModules.RillDemoConfig as { sandboxEngine: string } | undefined;

const RillPerformanceBridge = NativeModules.RillPerformanceBridge as
  | {
      getMemoryUsage(): number;
      startFPSTracking(): boolean;
      stopFPSTracking(): boolean;
      getCurrentFPS(): number;
      measureJSIRTT(iterations: number): number;
      measureOpsPerSecond(durationMs: number): number;
      evalInSandbox(code: string, engine: string): number;
      readAsset(path: string): string;
      log?(message: string): boolean;
    }
  | undefined;

interface PerfMetrics {
  memory: number;
  fps: number;
  rtt: number;
  throughput: number;
  fib: number;
  json: number;
  array: number;
  string: number;
}

const emptyMetrics: PerfMetrics = {
  memory: -1,
  fps: -1,
  rtt: -1,
  throughput: -1,
  fib: -1,
  json: -1,
  array: -1,
  string: -1,
};

function AndroidConfigurationBanner({
  sandboxEngine,
  isRunning,
  engineLabel,
}: {
  sandboxEngine: string;
  isRunning: boolean;
  engineLabel: string;
}) {
  return (
    <View style={ui.banner}>
      <View style={ui.bannerTopRow}>
        <View style={ui.bannerCol}>
          <Text style={ui.bannerHint}>Mode</Text>
          <Text style={ui.bannerText}>Bridgeless</Text>
        </View>

        <View style={ui.bannerDivider} />

        <View style={ui.bannerCol}>
          <Text style={ui.bannerHint}>Sandbox</Text>
          <Text style={ui.bannerText}>{sandboxEngine || 'auto'}</Text>
        </View>

        <View style={{ flex: 1 }} />

        <View style={ui.bannerStatus}>
          <View style={[ui.statusDot, { backgroundColor: isRunning ? '#2ecc71' : '#f39c12' }]} />
          <Text style={ui.bannerStatusText}>{isRunning ? 'Running' : 'Loading'}</Text>
        </View>
      </View>

      <Text style={ui.bannerSubText}>Detected: {engineLabel} • Host: Hermes</Text>
    </View>
  );
}

function MetricCard({
  title,
  value,
  unit,
  color,
}: {
  title: string;
  value: number;
  unit: string;
  color?: string;
}) {
  const displayValue =
    value < 0
      ? '--'
      : value >= 1000
        ? value.toFixed(0)
        : value >= 10
          ? value.toFixed(1)
          : value.toFixed(2);

  return (
    <View style={ui.metricCard}>
      <Text style={ui.metricTitle}>{title}</Text>
      <Text style={[ui.metricValue, color && { color }]}>{displayValue}</Text>
      {unit ? <Text style={ui.metricUnit}>{unit}</Text> : null}
    </View>
  );
}

function AndroidPerformanceDashboard({ sandboxEngine }: { sandboxEngine: string }) {
  const [expanded, setExpanded] = useState(true);
  const [metrics, setMetrics] = useState<PerfMetrics>(emptyMetrics);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!RillPerformanceBridge) return;
    RillPerformanceBridge.startFPSTracking();
    const id = setInterval(() => {
      const memory = RillPerformanceBridge.getMemoryUsage();
      const fps = RillPerformanceBridge.getCurrentFPS();
      setMetrics((prev) => ({ ...prev, memory, fps }));
    }, 1000);
    return () => {
      clearInterval(id);
      RillPerformanceBridge.stopFPSTracking();
    };
  }, []);

  const runTests = useCallback(() => {
    if (!RillPerformanceBridge || testing) return;
    setTesting(true);
    setTimeout(() => {
      const engine = sandboxEngine || 'quickjs';
      const rttMs = RillPerformanceBridge.measureJSIRTT(100);
      const rtt = rttMs >= 0 ? rttMs * 1000 : -1; // us
      const opsRaw = RillPerformanceBridge.measureOpsPerSecond(500);
      const throughput = opsRaw >= 0 ? opsRaw / 1000 : -1; // K/s

      const fibCode = RillPerformanceBridge.readAsset('TestCode/fib.js');
      const jsonCode = RillPerformanceBridge.readAsset('TestCode/json.js');
      const arrayCode = RillPerformanceBridge.readAsset('TestCode/array.js');
      const stringCode = RillPerformanceBridge.readAsset('TestCode/string.js');

      const fib = fibCode ? RillPerformanceBridge.evalInSandbox(fibCode, engine) : -1;
      const json = jsonCode ? RillPerformanceBridge.evalInSandbox(jsonCode, engine) : -1;
      const array = arrayCode ? RillPerformanceBridge.evalInSandbox(arrayCode, engine) : -1;
      const string = stringCode ? RillPerformanceBridge.evalInSandbox(stringCode, engine) : -1;

      setMetrics((prev) => ({ ...prev, rtt, throughput, fib, json, array, string }));
      setTesting(false);
    }, 50);
  }, [sandboxEngine, testing]);

  const reset = useCallback(() => {
    setMetrics((prev) => ({
      ...prev,
      rtt: -1,
      throughput: -1,
      fib: -1,
      json: -1,
      array: -1,
      string: -1,
    }));
  }, []);

  if (!RillPerformanceBridge) {
    return (
      <View style={ui.dashboardContainer}>
        <Text style={ui.dashboardUnavailable}>Performance bridge unavailable</Text>
      </View>
    );
  }

  return (
    <View style={ui.dashboardContainer}>
      <TouchableOpacity style={ui.dashboardHeader} onPress={() => setExpanded((v) => !v)}>
        <View style={ui.dashboardHeaderRow}>
          <Text style={ui.dashboardChevron}>{expanded ? '\u25BC' : '\u25B2'}</Text>
          <Text style={ui.dashboardHeaderText}>Performance</Text>
        </View>
        {!expanded && (
          <Text style={ui.dashboardSummary}>
            FPS: {metrics.fps > 0 ? metrics.fps.toFixed(0) : '--'} | Mem:{' '}
            {metrics.memory > 0 ? metrics.memory.toFixed(0) : '--'}MB
          </Text>
        )}
      </TouchableOpacity>

      {expanded && (
        <View style={ui.dashboardBody}>
          <View style={ui.metricRow}>
            <MetricCard title="Memory" value={metrics.memory} unit="MB" />
            <MetricCard title="FPS" value={metrics.fps} unit="" color="#2ecc71" />
          </View>

          <Text style={ui.sectionLabel}>JSI Performance</Text>
          <View style={ui.metricRow}>
            <MetricCard title="RTT" value={metrics.rtt} unit={'\u00B5s'} color="#007aff" />
            <MetricCard title="Throughput" value={metrics.throughput} unit="K/s" color="#007aff" />
          </View>

          <Text style={ui.sectionLabel}>Sandbox Interpreter</Text>
          <View style={ui.metricRow}>
            <MetricCard title="Fib(30)" value={metrics.fib} unit="ms" color="#e74c3c" />
            <MetricCard title="JSON" value={metrics.json} unit="ms" color="#e74c3c" />
          </View>
          <View style={ui.metricRow}>
            <MetricCard title="Array" value={metrics.array} unit="ms" color="#e74c3c" />
            <MetricCard title="String" value={metrics.string} unit="ms" color="#e74c3c" />
          </View>

          <View style={ui.actionRow}>
            <TouchableOpacity
              style={[ui.actionBtn, ui.actionBtnPrimary, testing && { opacity: 0.5 }]}
              onPress={testing ? undefined : runTests}
            >
              <View style={ui.actionBtnRow}>
                {testing ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={ui.actionBtnIcon}>{'\u25B6'}</Text>
                )}
                <Text style={[ui.actionBtnText, ui.actionBtnTextPrimary]}>
                  {testing ? 'Running\u2026' : 'Run Test'}
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity style={ui.actionBtn} onPress={reset}>
              <Text style={ui.actionBtnText}>Reset</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

function normalizeSandboxEngine(value: unknown): 'jsc' | 'quickjs' | 'hermes' | '' {
  if (value === 'jsc' || value === 'quickjs' || value === 'hermes') return value;
  return '';
}

function getSandboxModule(engineHint: string): { label: string; module: SandboxModule } {
  const requested = normalizeSandboxEngine(engineHint);
  const ordered: Array<[string, SandboxModule | undefined]> =
    requested === 'jsc'
      ? [['JSC', global.__JSCSandboxJSI]]
      : requested === 'quickjs'
        ? [['QuickJS', global.__QuickJSSandboxJSI]]
        : requested === 'hermes'
          ? [['Hermes', global.__HermesSandboxJSI]]
          : [
              ['QuickJS', global.__QuickJSSandboxJSI],
              ['Hermes', global.__HermesSandboxJSI],
              ['JSC', global.__JSCSandboxJSI],
            ];

  for (const [label, module] of ordered) {
    if (module?.isAvailable?.()) {
      return { label, module };
    }
  }

  throw new Error(`No available sandbox module for ${engineHint || 'auto'}`);
}

function assertE2E(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function logE2E(message: string) {
  console.log(message);
  try {
    RillPerformanceBridge?.log?.(message);
  } catch {
    // console.log is the source of truth for the adb logcat runner.
  }
}

async function runAndroidE2EChecks(engineHint: string) {
  const results: Array<{ name: string; status: 'passed' | 'failed'; error?: string }> = [];

  const run = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      results.push({ name, status: 'passed' });
      logE2E(`>>>RILL_ANDROID_E2E_RESULT<<< ${JSON.stringify({ name, status: 'passed' })}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, status: 'failed', error: message });
      logE2E(
        `>>>RILL_ANDROID_E2E_RESULT<<< ${JSON.stringify({
          name,
          status: 'failed',
          error: message,
        })}`
      );
    }
  };

  logE2E('>>>RILL_ANDROID_E2E_START<<<');
  logE2E(`Target: ${engineHint || 'auto'}`);

  await run('detect requested sandbox module', () => {
    const { label } = getSandboxModule(engineHint);
    if (engineHint) {
      assertE2E(label.toLowerCase() === engineHint, `expected ${engineHint}, got ${label}`);
    }
  });

  await run('eval basic expression', () => {
    const { module } = getSandboxModule(engineHint);
    const runtime = module.createRuntime({ timeout: 5000 });
    const ctx = runtime.createContext();
    try {
      assertE2E(ctx.eval('1 + 2') === 3, '1 + 2 did not evaluate to 3');
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
  });

  await run('host function callable from guest', () => {
    const { module } = getSandboxModule(engineHint);
    const runtime = module.createRuntime({ timeout: 5000 });
    const ctx = runtime.createContext();
    try {
      let received = '';
      ctx.inject('hostFn', (value: unknown) => {
        received = String(value);
        return `${received}:host`;
      });
      assertE2E(ctx.eval('hostFn("guest")') === 'guest:host', 'host callback result mismatch');
      assertE2E(received === 'guest', 'host callback argument mismatch');
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
  });

  await run('guest function callable from host', () => {
    const { module } = getSandboxModule(engineHint);
    const runtime = module.createRuntime({ timeout: 5000 });
    const ctx = runtime.createContext();
    try {
      ctx.eval('function guestDouble(x) { return x * 2; }');
      const guestDouble = ctx.extract('guestDouble') as (value: number) => number;
      assertE2E(typeof guestDouble === 'function', 'guest function was not extracted');
      assertE2E(guestDouble(21) === 42, 'guest function result mismatch');
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
  });

  await run('complex values round-trip', () => {
    const { module } = getSandboxModule(engineHint);
    const runtime = module.createRuntime({ timeout: 5000 });
    const ctx = runtime.createContext();
    try {
      ctx.inject('hostData', { nested: { ok: true }, list: [1, 2, 3] });
      assertE2E(ctx.eval('hostData.nested.ok') === true, 'nested object value mismatch');
      assertE2E(ctx.eval('hostData.list[2]') === 3, 'array value mismatch');
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
  });

  await run('errors propagate to host', () => {
    const { module } = getSandboxModule(engineHint);
    const runtime = module.createRuntime({ timeout: 5000 });
    const ctx = runtime.createContext();
    try {
      let threw = false;
      try {
        ctx.eval('throw new Error("android-e2e-error")');
      } catch {
        threw = true;
      }
      assertE2E(threw, 'guest error did not propagate');
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
  });

  await run('contexts are isolated', () => {
    const { module } = getSandboxModule(engineHint);
    const runtime = module.createRuntime({ timeout: 5000 });
    const ctx1 = runtime.createContext();
    const ctx2 = runtime.createContext();
    try {
      ctx1.eval('var sharedName = "ctx1"');
      ctx2.eval('var sharedName = "ctx2"');
      assertE2E(ctx1.eval('sharedName') === 'ctx1', 'ctx1 global mismatch');
      assertE2E(ctx2.eval('sharedName') === 'ctx2', 'ctx2 global mismatch');
    } finally {
      ctx1.dispose();
      ctx2.dispose();
      runtime.dispose();
    }
  });

  await run('disposed context rejects eval', () => {
    const { module } = getSandboxModule(engineHint);
    const runtime = module.createRuntime({ timeout: 5000 });
    const ctx = runtime.createContext();
    try {
      ctx.dispose();
      let threw = false;
      try {
        ctx.eval('1 + 1');
      } catch {
        threw = true;
      }
      assertE2E(threw, 'disposed context accepted eval');
    } finally {
      runtime.dispose();
    }
  });

  await run('native performance bridge can reach sandbox', () => {
    assertE2E(RillPerformanceBridge, 'RillPerformanceBridge is unavailable');
    const evalMs = RillPerformanceBridge.evalInSandbox('1 + 1', engineHint);
    assertE2E(Number.isFinite(evalMs) && evalMs >= 0, `evalInSandbox returned ${evalMs}`);
    const rttMs = RillPerformanceBridge.measureJSIRTT(100);
    assertE2E(Number.isFinite(rttMs) && rttMs >= 0, `measureJSIRTT returned ${rttMs}`);
  });

  const failed = results.filter((result) => result.status === 'failed');
  logE2E(`Summary: ${results.length - failed.length} passed, ${failed.length} failed`);
  logE2E(failed.length === 0 ? 'EXIT_CODE:0' : 'EXIT_CODE:1');
  logE2E('>>>RILL_ANDROID_E2E_END<<<');
}

export default function App(props: { rillE2E?: boolean; rillSandbox?: string }) {
  const engines = useMemo(() => getDetectedEngines(), []);
  const e2eStartedRef = useRef(false);

  // Determine sandbox engine (Android only)
  // 1. Try NativeModule (BuildConfig via RillDemoConfig)
  // 2. Fallback: detect from installed JSI globals
  const sandboxEngine = useMemo(() => {
    if (Platform.OS !== 'android') return '';
    const fromConfig = normalizeSandboxEngine(props.rillSandbox) || RillDemoConfig?.sandboxEngine;
    if (fromConfig) return fromConfig;
    // Bridgeless mode may not expose legacy NativeModules —
    // detect from the JSI globals that native side already installed.
    if (global.__HermesSandboxJSI?.isAvailable?.()) return 'hermes';
    if (global.__QuickJSSandboxJSI?.isAvailable?.()) return 'quickjs';
    if (global.__JSCSandboxJSI?.isAvailable?.()) return 'jsc';
    return '';
  }, [props.rillSandbox]);

  // Create Engine and register default RN components
  const engine = useMemo(() => {
    const opts: { timeout: number; debug: boolean; sandbox?: 'quickjs' | 'hermes' } = {
      timeout: 10000,
      debug: __DEV__,
    };
    // On Android, select the sandbox engine from the build flavor
    if (Platform.OS === 'android' && sandboxEngine) {
      opts.sandbox = sandboxEngine as 'quickjs' | 'hermes';
    }
    const e = new Engine(opts);
    e.register(DefaultComponents);
    return e;
  }, [sandboxEngine]);

  // Load Guest code via rill bridge
  const { loadingState, error, content } = useEngineView({
    engine,
    source: GUEST_CODE,
  });

  // Cleanup
  useEffect(() => {
    return () => {
      engine.destroy();
    };
  }, [engine]);

  const engineLabel = engines.length > 0 ? engines.join(', ') : 'None detected';

  useEffect(() => {
    if (!props.rillE2E || e2eStartedRef.current || loadingState !== 'loaded') {
      return;
    }

    e2eStartedRef.current = true;
    runAndroidE2EChecks(sandboxEngine).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logE2E(
        `>>>RILL_ANDROID_E2E_RESULT<<< ${JSON.stringify({
          name: 'runner',
          status: 'failed',
          error: message,
        })}`
      );
      logE2E('EXIT_CODE:1');
      logE2E('>>>RILL_ANDROID_E2E_END<<<');
    });
  }, [props.rillE2E, loadingState, sandboxEngine]);

  return (
    <SafeAreaView style={hostStyles.container}>
      {Platform.OS === 'android' && (
        <AndroidConfigurationBanner
          sandboxEngine={sandboxEngine}
          isRunning={loadingState === 'loaded'}
          engineLabel={engineLabel}
        />
      )}

      <View style={{ flex: 1 }}>
        {/* Guest-rendered content */}
        <View style={hostStyles.guestContainer}>
          {loadingState === 'error' && error ? (
            <View style={hostStyles.errorBox}>
              <Text style={hostStyles.errorTitle}>Guest Error</Text>
              <Text style={hostStyles.errorMessage}>{error.message}</Text>
            </View>
          ) : loadingState === 'loading' || loadingState === 'idle' ? (
            <View style={hostStyles.loadingBox}>
              <Text style={hostStyles.loadingText}>Loading Guest bundle{'\u2026'}</Text>
            </View>
          ) : (
            content
          )}
        </View>
      </View>

      {Platform.OS === 'android' && <AndroidPerformanceDashboard sandboxEngine={sandboxEngine} />}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Host styles
// ---------------------------------------------------------------------------
const hostStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  guestContainer: {
    flex: 1,
  },
  loadingBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 14,
    color: '#555',
  },
  errorBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#e74c3c',
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
  },
});

const ui = StyleSheet.create({
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    paddingTop: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5ea',
    backgroundColor: '#f2f2f7',
  },
  bannerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bannerCol: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
  },
  bannerHint: {
    fontSize: 11,
    color: '#6b7280',
  },
  bannerText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
  bannerDivider: {
    width: 1,
    height: 24,
    marginHorizontal: 12,
    backgroundColor: '#d1d5db',
  },
  bannerStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bannerStatusText: {
    fontSize: 11,
    color: '#6b7280',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  bannerSubText: {
    marginTop: 6,
    fontSize: 11,
    color: '#6b7280',
  },

  dashboardContainer: {
    borderTopWidth: 1,
    borderTopColor: '#e5e5ea',
    backgroundColor: '#f2f2f7',
    overflow: 'hidden',
  },
  dashboardUnavailable: {
    padding: 16,
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
  },
  dashboardHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#e5e5ea',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dashboardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dashboardHeaderText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  dashboardChevron: {
    fontSize: 14,
    color: '#007aff',
  },
  dashboardSummary: {
    fontSize: 12,
    color: '#6b7280',
  },
  dashboardBody: {
    padding: 12,
    paddingBottom: 14,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
    marginTop: 10,
    marginBottom: 8,
  },
  metricRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  metricCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e5ea',
  },
  metricTitle: {
    fontSize: 11,
    color: '#6b7280',
    marginBottom: 6,
  },
  metricValue: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  metricUnit: {
    fontSize: 10,
    color: '#6b7280',
    marginTop: 2,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e5ea',
  },
  actionBtnPrimary: {
    backgroundColor: '#007aff',
    borderColor: '#007aff',
  },
  actionBtnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionBtnIcon: {
    color: '#fff',
    fontSize: 12,
    marginTop: 1,
  },
  actionBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
  },
  actionBtnTextPrimary: {
    color: '#fff',
  },
});
