import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  NativeModules,
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
  var h = React.createElement;

  function GuestApp() {
    var countState = useState(0);
    var count = countState[0];
    var setCount = countState[1];

    var handleIncrement = useCallback(function() { setCount(function(c) { return c + 1; }); }, []);
    var handleDecrement = useCallback(function() { setCount(function(c) { return c - 1; }); }, []);
    var handleReset    = useCallback(function() { setCount(0); }, []);

    return h('ScrollView', { style: { flex: 1 } },
      h('View', { style: { padding: 20, paddingTop: 12 } },

        h('View', { style: { marginBottom: 24 } },
          h('Text', { style: styles.sectionTitle }, 'COUNTER TEST'),
          h('Text', { style: styles.sectionDesc }, 'State managed entirely in Guest sandbox'),
          h('View', { style: styles.counterRow },
            h('TouchableOpacity', { style: styles.counterBtn, onPress: handleDecrement },
              h('Text', { style: styles.counterBtnText }, String.fromCharCode(8722))
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
};

function normalizeEngineKey(engine?: string | null): 'hermes' | 'quickjs' | 'jsc' | null {
  const key = (engine || '').toLowerCase();
  if (key === 'hermes' || key === 'quickjs' || key === 'jsc') return key;
  return null;
}

function engineLabelByKey(engine: 'hermes' | 'quickjs' | 'jsc'): string {
  if (engine === 'hermes') return 'Hermes';
  if (engine === 'quickjs') return 'QuickJS';
  return 'JSC';
}

function getDetectedEngines(preferredEngine?: 'hermes' | 'quickjs' | 'jsc' | null): string[] {
  const candidates: Array<{
    key: 'hermes' | 'quickjs' | 'jsc';
    label: string;
    available: boolean;
  }> = [
    {
      key: 'hermes',
      label: 'Hermes',
      available: Boolean(global.__HermesSandboxJSI?.isAvailable?.()),
    },
    {
      key: 'quickjs',
      label: 'QuickJS',
      available: Boolean(global.__QuickJSSandboxJSI?.isAvailable?.()),
    },
    { key: 'jsc', label: 'JSC', available: Boolean(global.__JSCSandboxJSI?.isAvailable?.()) },
  ];

  const ordered = preferredEngine
    ? [
        preferredEngine,
        ...(['hermes', 'quickjs', 'jsc'] as const).filter((k) => k !== preferredEngine),
      ]
    : (['hermes', 'quickjs', 'jsc'] as const);

  const labels: string[] = [];
  for (const key of ordered) {
    const c = candidates.find((x) => x.key === key);
    if (c && c.available) {
      labels.push(c.label);
    } else if (preferredEngine && key === preferredEngine) {
      labels.push(`${engineLabelByKey(preferredEngine)} (missing)`);
    }
  }
  return labels;
}

const RillSandboxNative = NativeModules.RillSandboxNative as
  | {
      install(): boolean;
      getCompiledSandboxEngine?(): string;
      installEngine(engine: string): boolean;
      testQuickJS(): string;
      testQuickJSLevel(level: number): string;
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
interface PerfMetrics {
  memory: number;
  rtt: number;
  throughput: number;
  fib: number;
  json: number;
  array: number;
  string: number;
}

const emptyMetrics: PerfMetrics = {
  memory: -1,
  rtt: -1,
  throughput: -1,
  fib: -1,
  json: -1,
  array: -1,
  string: -1,
};

// ---------------------------------------------------------------------------
// Configuration Banner
// ---------------------------------------------------------------------------
function ConfigurationBanner({
  isRunning,
  engineLabel,
  selectedEngine,
}: {
  isRunning: boolean;
  engineLabel: string;
  selectedEngine: string;
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
          <Text style={ui.bannerText}>{selectedEngine}</Text>
        </View>

        <View style={{ flex: 1 }} />

        <View style={ui.bannerStatus}>
          <View style={[ui.statusDot, { backgroundColor: isRunning ? '#2ecc71' : '#f39c12' }]} />
          <Text style={ui.bannerStatusText}>{isRunning ? 'Running' : 'Loading'}</Text>
        </View>
      </View>

      <Text style={ui.bannerSubText}>
        Detected: {engineLabel} {'\u2022'} Host: Hermes
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
  const [expanded, setExpanded] = useState(true);
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

    const runEval = (name: keyof typeof TEST_CODE, engineHint: string): number => {
      if (canUseBytecode && RillSandboxNative.evalBytecodeAsset) {
        const bytecodeResult = safeNumber(() =>
          RillSandboxNative.evalBytecodeAsset!(TEST_BYTECODE_ASSET[name], engineHint)
        );
        if (bytecodeResult >= 0) return bytecodeResult;
      }
      return safeNumber(() => RillSandboxNative.evalInSandbox(TEST_CODE[name], engineHint));
    };

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

    setTesting(true);
    try {
      const memory = safeNumber(() => RillSandboxNative.getMemoryUsage());

      // Native returns ms/call; UI shows μs
      const rttMs = safeNumber(() => RillSandboxNative.measureJSIRTT(20000));
      const rtt = rttMs < 0 ? -1 : rttMs * 1000;

      // Native returns ops/s; UI shows K/s
      const opsPerSecond = safeNumber(() => RillSandboxNative.measureOpsPerSecond(250));
      const throughput = opsPerSecond < 0 ? -1 : opsPerSecond / 1000;

      const fib = runBench('fib', engineKey);
      const json = runBench('json', engineKey);
      const array = runBench('array', engineKey);
      const string = runBench('string', engineKey);

      setMetrics({ memory, rtt, throughput, fib, json, array, string });
    } finally {
      setTesting(false);
    }
  }, [testing, engineKey]);

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

  if (!RillSandboxNative) {
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
            Mem: {metrics.memory > 0 ? metrics.memory.toFixed(0) : '--'}MB
          </Text>
        )}
      </TouchableOpacity>

      {expanded && (
        <View style={ui.dashboardBody}>
          <View style={ui.metricRow}>
            <MetricCard title="Memory" value={metrics.memory} unit="MB" />
          </View>

          <Text style={ui.sectionLabel}>JSI Performance</Text>
          <View style={ui.metricRow}>
            <MetricCard title="RTT" value={metrics.rtt} unit={'\u03BCs'} color="#007aff" />
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

// ---------------------------------------------------------------------------
// Host App
// ---------------------------------------------------------------------------
export default function App() {
  const preferredEngine = useMemo(
    () => normalizeEngineKey(RillSandboxNative?.getCompiledSandboxEngine?.()),
    []
  );
  const engines = useMemo(() => getDetectedEngines(preferredEngine), [preferredEngine]);
  const engineKey = preferredEngine ?? 'quickjs';
  const selectedEngineLabel = preferredEngine ? engineLabelByKey(preferredEngine) : 'Auto';

  const engine = useMemo(() => {
    const e = new Engine({ timeout: 10000, debug: __DEV__ });
    e.register(DefaultComponents);
    return e;
  }, []);

  const { loadingState, error, content } = useEngineView({
    engine,
    source: GUEST_CODE,
    bytecodeAssetPath: engineKey === 'hermes' ? GUEST_BYTECODE_ASSET : undefined,
  });

  useEffect(() => {
    return () => {
      engine.destroy();
    };
  }, [engine]);

  const engineLabel = engines.length > 0 ? engines.join(', ') : 'None detected';

  return (
    <SafeAreaView style={styles.container}>
      <ConfigurationBanner
        isRunning={loadingState === 'loaded'}
        engineLabel={engineLabel}
        selectedEngine={selectedEngineLabel}
      />

      <View style={{ flex: 1 }}>
        <View style={styles.guestContainer}>
          {loadingState === 'error' && error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>Guest Error</Text>
              <Text style={styles.errorMessage}>{error.message}</Text>
            </View>
          ) : loadingState === 'loading' || loadingState === 'idle' ? (
            <View style={styles.loadingBox}>
              <Text style={styles.loadingText}>Loading Guest bundle…</Text>
            </View>
          ) : (
            content
          )}
        </View>
      </View>

      <PerformanceDashboard engineKey={engineKey} />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Host styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
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
