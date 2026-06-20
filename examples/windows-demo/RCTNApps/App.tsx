/**
 * Windows Demo — Full Engine + useEngineView test.
 * Creates a Rill Engine, registers DefaultComponents, and loads guest code
 * that renders a counter, layout boxes, and callback test.
 * Includes a performance dashboard for JSI + sandbox benchmarking.
 *
 * Engine is selected at compile time via RILL_SANDBOX_ENGINE.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  NativeModules,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Engine, useEngineView } from 'rill/host';
import { DefaultComponents } from 'rill/host/preset';

// Guest code — runs inside the sandbox.
// Uses React.createElement (no JSX in sandbox).
const GUEST_CODE = `
  var React = require('react');
  var useState = React.useState;
  var useCallback = React.useCallback;
  var render = require('rill/reconciler').render;
  var h = React.createElement;

  function GuestApp() {
    var countState = useState(0);
    var count = countState[0];
    var setCount = countState[1];

    var handleIncrement = useCallback(function() {
      setCount(function(c) { return c + 1; });
    }, []);
    var handleDecrement = useCallback(function() {
      setCount(function(c) { return c - 1; });
    }, []);
    var handleReset = useCallback(function() {
      setCount(0);
    }, []);

    return h('ScrollView', { style: { flex: 1, backgroundColor: '#0f0f1a' } },
      h('View', { style: { padding: 20, paddingTop: 12 } },

        h('Text', { style: { fontSize: 22, fontWeight: '700', color: '#fff', marginBottom: 4 } },
          'Rill Windows Demo'),
        h('Text', { style: { fontSize: 12, color: '#555', marginBottom: 24 } },
          'Guest UI rendered via sandbox engine'),

        h('View', { style: { marginBottom: 24 } },
          h('Text', { style: { fontSize: 11, fontWeight: '700', color: '#888', letterSpacing: 1, marginBottom: 8 } },
            'COUNTER'),
          h('View', { style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12 } },
            h('TouchableOpacity', {
              style: { width: 56, height: 56, borderRadius: 12, backgroundColor: '#1e1e3a', alignItems: 'center', justifyContent: 'center' },
              onPress: handleDecrement
            }, h('Text', { style: { fontSize: 28, color: '#fff', fontWeight: '300' } }, String.fromCharCode(8722))),
            h('Text', { style: { fontSize: 48, fontWeight: '700', color: '#fff', minWidth: 80, textAlign: 'center', marginHorizontal: 16 } },
              '' + count),
            h('TouchableOpacity', {
              style: { width: 56, height: 56, borderRadius: 12, backgroundColor: '#1e1e3a', alignItems: 'center', justifyContent: 'center' },
              onPress: handleIncrement
            }, h('Text', { style: { fontSize: 28, color: '#fff', fontWeight: '300' } }, '+'))
          ),
          h('TouchableOpacity', {
            style: { alignSelf: 'center', paddingHorizontal: 20, paddingVertical: 8, borderRadius: 6, backgroundColor: '#2a2a4a' },
            onPress: handleReset
          }, h('Text', { style: { fontSize: 13, color: '#888' } }, 'Reset'))
        ),

        h('View', { style: { marginBottom: 24 } },
          h('Text', { style: { fontSize: 11, fontWeight: '700', color: '#888', letterSpacing: 1, marginBottom: 8 } },
            'LAYOUT'),
          h('View', { style: { flexDirection: 'row', justifyContent: 'space-around' } },
            h('View', { style: { width: 72, height: 72, borderRadius: 12, backgroundColor: '#e74c3c', alignItems: 'center', justifyContent: 'center' } },
              h('Text', { style: { fontSize: 20, fontWeight: '700', color: '#fff' } }, 'R')),
            h('View', { style: { width: 72, height: 72, borderRadius: 12, backgroundColor: '#2ecc71', alignItems: 'center', justifyContent: 'center' } },
              h('Text', { style: { fontSize: 20, fontWeight: '700', color: '#fff' } }, 'G')),
            h('View', { style: { width: 72, height: 72, borderRadius: 12, backgroundColor: '#3498db', alignItems: 'center', justifyContent: 'center' } },
              h('Text', { style: { fontSize: 20, fontWeight: '700', color: '#fff' } }, 'B'))
          )
        ),

        h('View', null,
          h('Text', { style: { fontSize: 11, fontWeight: '700', color: '#888', letterSpacing: 1, marginBottom: 8 } },
            'INFO'),
          h('Text', { style: { fontSize: 12, color: '#555' } },
            'Guest code runs in a sandboxed engine. State, callbacks, and rendering all work through the Rill bridge.')
        )
      )
    );
  }

  render(h(GuestApp), globalThis.__rill_sendBatch);
`;

const GUEST_BYTECODE_ASSET = 'bytecode/guest.hbc';

// ---------------------------------------------------------------------------
// Inline benchmark test code (avoids Windows asset packaging complexity)
// ---------------------------------------------------------------------------
const TEST_CODE = {
  fib: `(() => {
  function fib(n) {
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
  }
  return fib(30);
})();`,
  json: `(() => {
  var data = [];
  for (var i = 0; i < 10000; i++) {
    data.push({ id: i, name: 'item' + i, value: Math.random() });
  }
  var json = JSON.stringify(data);
  var parsed = JSON.parse(json);
  return parsed.length;
})();`,
  array: `(() => {
  var arr = [];
  for (var i = 0; i < 100000; i++) arr.push(i);
  var result = arr
    .map(function(x) { return x * 2; })
    .filter(function(x) { return x % 3 === 0; })
    .reduce(function(a, b) { return a + b; }, 0);
  return result;
})();`,
  string: `(() => {
  var str = '';
  for (var i = 0; i < 10000; i++) {
    str += 'hello world ' + i + ' ';
  }
  var matches = str.match(/world/g);
  return matches ? matches.length : 0;
})();`,
};

const TEST_BYTECODE_ASSET: Record<keyof typeof TEST_CODE, string> = {
  fib: 'bytecode/fib.hbc',
  json: 'bytecode/json.hbc',
  array: 'bytecode/array.hbc',
  string: 'bytecode/string.hbc',
};

// ---------------------------------------------------------------------------
// Native module access
// ---------------------------------------------------------------------------
declare const global: {
  __JSCSandboxJSI?: { isAvailable(): boolean };
  __HermesSandboxJSI?: { isAvailable(): boolean };
  __QuickJSSandboxJSI?: { isAvailable(): boolean };
  HermesInternal?: {
    getRuntimeProperties?: () => Record<string, string>;
  };
};

function getDetectedEngine(): { name: string; key: string } | null {
  if (global.__HermesSandboxJSI?.isAvailable?.()) return { name: 'Hermes', key: 'hermes' };
  if (global.__QuickJSSandboxJSI?.isAvailable?.()) return { name: 'QuickJS', key: 'quickjs' };
  if (global.__JSCSandboxJSI?.isAvailable?.()) return { name: 'JSC', key: 'jsc' };
  return null;
}

function normalizeEngineKey(engine?: string | null): 'hermes' | 'quickjs' | 'jsc' | null {
  const key = (engine || '').toLowerCase();
  if (key === 'hermes' || key === 'quickjs' || key === 'jsc') return key;
  return null;
}

function getDetectedEngineWithHint(
  preferredEngine?: 'hermes' | 'quickjs' | 'jsc' | null
): { name: string; key: string } | null {
  const byKey = {
    hermes: {
      name: 'Hermes',
      key: 'hermes',
      available: global.__HermesSandboxJSI?.isAvailable?.(),
    },
    quickjs: {
      name: 'QuickJS',
      key: 'quickjs',
      available: global.__QuickJSSandboxJSI?.isAvailable?.(),
    },
    jsc: { name: 'JSC', key: 'jsc', available: global.__JSCSandboxJSI?.isAvailable?.() },
  } as const;

  if (preferredEngine) {
    if (byKey[preferredEngine].available) {
      return { name: byKey[preferredEngine].name, key: byKey[preferredEngine].key };
    }
    return { name: `${byKey[preferredEngine].name} (missing)`, key: byKey[preferredEngine].key };
  }
  return getDetectedEngine();
}

function getHermesVersion(): string {
  try {
    const props = global.HermesInternal?.getRuntimeProperties?.();
    if (props?.['OSS Release Version']) return props['OSS Release Version'];
  } catch {}
  return '';
}

const RillSandboxNative = NativeModules.RillSandboxNative as
  | {
      install(): boolean;
      getCompiledSandboxEngine?(): string;
      testQuickJS?(): string;
      testQuickJSLevel?(level: number): string;
      testHermesNAPI?(level: number): string;
      getMemoryUsage(): number;
      measureJSIRTT(iterations: number): number;
      measureOpsPerSecond(durationMs: number): number;
      evalInSandbox(code: string, engine: string): number;
      evalBytecodeAsset?(path: string, engine: string): number;
      supportsBytecodeEval?(engine: string): boolean;
      runSandboxBenchmark?(
        code: string,
        bytecodePath: string,
        engine: string,
        warmup: number,
        iterations: number
      ): number;
    }
  | undefined;

// ---------------------------------------------------------------------------
// Performance types
// ---------------------------------------------------------------------------
interface EngineMetrics {
  fib: number;
  json: number;
  array: number;
  string: number;
}

interface PerfMetrics {
  memory: number;
  rtt: number;
  throughput: number;
  engine: EngineMetrics;
}

const emptyEngineMetrics: EngineMetrics = { fib: -1, json: -1, array: -1, string: -1 };

const emptyMetrics: PerfMetrics = {
  memory: -1,
  rtt: -1,
  throughput: -1,
  engine: { ...emptyEngineMetrics },
};

// ---------------------------------------------------------------------------
// Configuration Banner
// ---------------------------------------------------------------------------
function ConfigurationBanner({
  isRunning,
  detectedEngine,
  hermesVersion,
}: {
  isRunning: boolean;
  detectedEngine: string;
  hermesVersion: string;
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
          <Text style={[ui.bannerText, { color: '#007aff' }]}>{detectedEngine}</Text>
        </View>

        <View style={{ flex: 1 }} />

        <View style={ui.bannerStatus}>
          <View style={[ui.statusDot, { backgroundColor: isRunning ? '#2ecc71' : '#f39c12' }]} />
          <Text style={ui.bannerStatusText}>{isRunning ? 'Running' : 'Loading'}</Text>
        </View>
      </View>

      <Text style={ui.bannerSubText}>
        Engine: {detectedEngine} {'\u2022'} Host: Hermes{hermesVersion ? ` ${hermesVersion}` : ''}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Metric Card
// ---------------------------------------------------------------------------
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
      <Text style={[ui.metricValue, color ? { color } : undefined]}>{displayValue}</Text>
      {unit ? <Text style={ui.metricUnit}>{unit}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Performance Dashboard
// ---------------------------------------------------------------------------
function PerformanceDashboard({ engineKey }: { engineKey: string }) {
  const [expanded, setExpanded] = useState(false);
  const [metrics, setMetrics] = useState<PerfMetrics>(emptyMetrics);
  const [testing, setTesting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll memory periodically
  useEffect(() => {
    if (!RillSandboxNative) return;
    pollTimerRef.current = setInterval(() => {
      try {
        const memory = RillSandboxNative.getMemoryUsage();
        setMetrics((prev) => ({ ...prev, memory }));
      } catch {
        // ignore
      }
    }, 1000);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const runTests = useCallback(() => {
    if (!RillSandboxNative || testing) return;

    const safeNumber = (fn: () => number): number => {
      try {
        const v = fn();
        return Number.isFinite(v) ? v : -1;
      } catch {
        return -1;
      }
    };

    const canUseBytecode = Boolean(
      engineKey === 'hermes' && RillSandboxNative.supportsBytecodeEval?.(engineKey)
    );

    const runBench = (name: keyof typeof TEST_CODE, engineHint: string): number => {
      if (RillSandboxNative.runSandboxBenchmark) {
        return safeNumber(() =>
          RillSandboxNative.runSandboxBenchmark!(
            TEST_CODE[name],
            canUseBytecode ? TEST_BYTECODE_ASSET[name] : '',
            engineHint,
            2,
            10
          )
        );
      }
      return runEval(name, engineHint);
    };

    const runEval = (name: keyof typeof TEST_CODE, engineHint: string): number => {
      if (canUseBytecode && RillSandboxNative.evalBytecodeAsset) {
        const bytecodeResult = safeNumber(() =>
          RillSandboxNative.evalBytecodeAsset!(TEST_BYTECODE_ASSET[name], engineHint)
        );
        if (bytecodeResult >= 0) return bytecodeResult;
      }
      return safeNumber(() => RillSandboxNative.evalInSandbox(TEST_CODE[name], engineHint));
    };

    setTesting(true);
    try {
      const memory = safeNumber(() => RillSandboxNative.getMemoryUsage());

      // Native returns ms/call; UI shows μs
      const rttMs = safeNumber(() => RillSandboxNative.measureJSIRTT(20000));
      const rtt = rttMs < 0 ? -1 : rttMs * 1000;

      // Native returns ops/s; UI shows K/s
      const opsPerSecond = safeNumber(() => RillSandboxNative.measureOpsPerSecond(250));
      const throughput = opsPerSecond < 0 ? -1 : opsPerSecond / 1000;

      const engine: EngineMetrics = {
        fib: runBench('fib', engineKey),
        json: runBench('json', engineKey),
        array: runBench('array', engineKey),
        string: runBench('string', engineKey),
      };

      setMetrics({ memory, rtt, throughput, engine });
    } finally {
      setTesting(false);
    }
  }, [testing, engineKey]);

  const reset = useCallback(() => {
    setMetrics((prev) => ({
      ...prev,
      rtt: -1,
      throughput: -1,
      engine: { ...emptyEngineMetrics },
    }));
  }, []);

  if (!RillSandboxNative) {
    return (
      <View style={ui.dashboardContainer}>
        <Text style={ui.dashboardUnavailable}>Performance bridge unavailable</Text>
      </View>
    );
  }

  const engineColor = engineKey === 'hermes' ? '#f39c12' : '#e74c3c';

  return (
    <View style={ui.dashboardContainer}>
      {expanded && (
        <ScrollView style={ui.dashboardScroll} contentContainerStyle={ui.dashboardBody}>
          <View style={ui.metricRow}>
            <MetricCard title="Memory" value={metrics.memory} unit="MB" />
          </View>

          <Text style={ui.sectionLabel}>JSI Performance</Text>
          <View style={ui.metricRow}>
            <MetricCard title="RTT" value={metrics.rtt} unit={'\u03BCs'} color="#007aff" />
            <MetricCard title="Throughput" value={metrics.throughput} unit="K/s" color="#007aff" />
          </View>

          <Text style={ui.sectionLabel}>Sandbox Engine</Text>
          <View style={ui.metricRow}>
            <MetricCard title="Fib(30)" value={metrics.engine.fib} unit="ms" color={engineColor} />
            <MetricCard title="JSON" value={metrics.engine.json} unit="ms" color={engineColor} />
          </View>
          <View style={ui.metricRow}>
            <MetricCard title="Array" value={metrics.engine.array} unit="ms" color={engineColor} />
            <MetricCard
              title="String"
              value={metrics.engine.string}
              unit="ms"
              color={engineColor}
            />
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
        </ScrollView>
      )}

      <TouchableOpacity style={ui.dashboardHeader} onPress={() => setExpanded((v) => !v)}>
        <View style={ui.dashboardHeaderRow}>
          <Text style={ui.dashboardChevron}>{expanded ? '\u25BC' : '\u25B2'}</Text>
          <Text style={ui.dashboardHeaderText}>Performance</Text>
        </View>
        {!expanded && (
          <Text style={ui.dashboardSummary}>
            Mem: {metrics.memory > 0 ? metrics.memory.toFixed(0) : '--'}MB
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Host App
// ---------------------------------------------------------------------------

// Isolated engine view
function EngineView({ sandbox }: { sandbox: string }) {
  const [initError, setInitError] = useState<string | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);

  // Deferred initialization via useEffect (not in render) to avoid crash during commit
  useEffect(() => {
    console.log(`[EngineView] Creating Engine with sandbox=${sandbox}`);
    try {
      const e = new Engine({ timeout: 10000, debug: __DEV__, sandbox: sandbox as any });
      console.log(`[EngineView] Engine created OK: ${e.id}`);
      e.register(DefaultComponents);
      console.log(`[EngineView] DefaultComponents registered`);
      setEngine(e);
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error(`[EngineView] Engine creation FAILED:`, msg);
      setInitError(msg);
    }
    return () => {
      setEngine((prev) => {
        if (prev) {
          console.log(`[EngineView] Destroying engine ${prev.id}`);
          try {
            prev.destroy();
          } catch (e: any) {
            console.error('[EngineView] destroy error:', e?.message);
          }
          console.log(`[EngineView] Engine destroyed`);
        }
        return null;
      });
    };
  }, [sandbox]);

  if (initError) {
    return (
      <View style={s.errorBox}>
        <Text style={s.errorTitle}>Engine Init Error</Text>
        <Text style={s.errorMsg}>{initError}</Text>
      </View>
    );
  }

  if (!engine) {
    return (
      <View style={s.loadingBox}>
        <Text style={s.loadingText}>Initializing {sandbox} engine...</Text>
      </View>
    );
  }

  return <EngineViewInner engine={engine} sandbox={sandbox} />;
}

function EngineViewInner({ engine, sandbox }: { engine: Engine; sandbox: string }) {
  const { loadingState, error, content } = useEngineView({
    engine,
    source: GUEST_CODE,
    bytecodeAssetPath: sandbox === 'hermes' ? GUEST_BYTECODE_ASSET : undefined,
  });

  if (loadingState === 'error' && error) {
    return (
      <View style={s.errorBox}>
        <Text style={s.errorTitle}>Error</Text>
        <Text style={s.errorMsg}>{error.message}</Text>
      </View>
    );
  }
  if (loadingState === 'loaded') {
    return <>{content}</>;
  }
  return (
    <View style={s.loadingBox}>
      <Text style={s.loadingText}>Loading Guest...</Text>
    </View>
  );
}

export default function App() {
  const hermesVersion = useMemo(() => getHermesVersion(), []);
  const preferredEngine = useMemo(
    () => normalizeEngineKey(RillSandboxNative?.getCompiledSandboxEngine?.()),
    []
  );
  const detected = useMemo(() => getDetectedEngineWithHint(preferredEngine), [preferredEngine]);
  const engineName = detected?.name ?? 'None';
  const engineKey = preferredEngine ?? detected?.key ?? 'quickjs';

  return (
    <View style={s.container}>
      <ConfigurationBanner
        isRunning={true}
        detectedEngine={engineName}
        hermesVersion={hermesVersion}
      />
      <View style={s.guest}>
        <EngineView sandbox={engineKey} />
      </View>
      <PerformanceDashboard engineKey={engineKey} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Host styles
// ---------------------------------------------------------------------------
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  guest: { flex: 1 },
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { fontSize: 14, color: '#555' },
  errorBox: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  errorTitle: { fontSize: 18, fontWeight: '600', color: '#e74c3c', marginBottom: 8 },
  errorMsg: { fontSize: 13, color: '#888', textAlign: 'center' },
});

const ui = StyleSheet.create({
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    paddingTop: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a2e',
    backgroundColor: '#141428',
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
    color: '#666',
  },
  bannerText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ccc',
  },
  bannerDivider: {
    width: 1,
    height: 24,
    marginHorizontal: 12,
    backgroundColor: '#333',
  },
  bannerStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bannerStatusText: {
    fontSize: 11,
    color: '#666',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  bannerSubText: {
    marginTop: 6,
    fontSize: 11,
    color: '#666',
  },

  dashboardContainer: {
    borderTopWidth: 1,
    borderTopColor: '#1a1a2e',
    backgroundColor: '#141428',
    overflow: 'hidden',
  },
  dashboardUnavailable: {
    padding: 16,
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
  },
  dashboardHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1a1a2e',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#252540',
  },
  dashboardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dashboardHeaderText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  dashboardChevron: {
    fontSize: 14,
    color: '#007aff',
  },
  dashboardSummary: {
    fontSize: 12,
    color: '#666',
  },
  dashboardScroll: {},
  dashboardBody: {
    padding: 12,
    paddingBottom: 14,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
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
    backgroundColor: '#1a1a2e',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#252540',
  },
  metricTitle: {
    fontSize: 11,
    color: '#666',
    marginBottom: 6,
  },
  metricValue: {
    fontSize: 22,
    fontWeight: '700',
    color: '#fff',
  },
  metricUnit: {
    fontSize: 10,
    color: '#666',
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
    backgroundColor: '#1a1a2e',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#252540',
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
    color: '#ccc',
  },
  actionBtnTextPrimary: {
    color: '#fff',
  },
});
