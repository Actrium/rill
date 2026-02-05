/**
 * Rill macOS E2E Test App (Bridgeless Mode)
 * Runs sandbox tests in real React Native runtime
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { registerRillSandboxTests, SandboxTarget } from './src/tests/rill-sandbox-tests';
import { getTests, runTests, TestResult } from './src/runner/registry';
import { nativeLog } from './src/native-logger';

// Test result markers for CLI parsing
const MARKER_START = '>>>RILL_TEST_START<<<';
const MARKER_END = '>>>RILL_TEST_END<<<';
const MARKER_RESULT = '>>>RILL_TEST_RESULT<<<';

function normalizeTarget(v: unknown): SandboxTarget {
  if (v === 'quickjs' || v === 'jsc' || v === 'hermes' || v === 'auto') return v;
  return 'auto'; // Default to auto-detect injected JSI module
}

export default function App(props: { rillSandbox?: string; rillXpc?: boolean } = {}) {
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const sandboxTarget = normalizeTarget(props.rillSandbox);
  const enableXpc = Boolean(props.rillXpc);

  const executeTests = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setFinished(false);
    setResults([]);

    // Log start marker for CLI parsing
    nativeLog(MARKER_START);
    nativeLog(`Platform: ${Platform.OS}`);
    nativeLog(`Mode: Bridgeless`);
    nativeLog(`Target: ${sandboxTarget}`);

    // Register tests
    registerRillSandboxTests(sandboxTarget, { enableXpc });
    const allTests = getTests();
    nativeLog(`Total tests: ${allTests.length}`);

    // Run tests
    const testResults = await runTests({
      onUpdate: (result) => {
        setResults((prev) => {
          const existing = prev.findIndex((r) => r.id === result.id);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = result;
            return updated;
          }
          return [...prev, result];
        });

        // Log result for CLI parsing
        nativeLog(
          `${MARKER_RESULT} ${JSON.stringify({
            id: result.id,
            name: result.name,
            status: result.status,
            durationMs: result.durationMs,
            error: result.error?.message,
          })}`
        );
      },
    });

    // Summary
    const passed = testResults.filter((r) => r.status === 'passed').length;
    const failed = testResults.filter((r) => r.status === 'failed').length;

    nativeLog(`\nSummary: ${passed} passed, ${failed} failed`);
    nativeLog(MARKER_END);

    // Exit with appropriate code for CI
    if (failed > 0) {
      nativeLog('EXIT_CODE:1');
    } else {
      nativeLog('EXIT_CODE:0');
    }

    setRunning(false);
    setFinished(true);
  }, [sandboxTarget, running]);

  // Auto-run tests on mount
  useEffect(() => {
    // Delay to ensure React Native is fully initialized
    const timer = setTimeout(executeTests, 500);
    return () => clearTimeout(timer);
  }, []);

  const passedCount = results.filter((r) => r.status === 'passed').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Rill macOS E2E Tests</Text>
        <Text style={styles.subtitle}>
          Platform: {Platform.OS} | Mode: Bridgeless | Target: {sandboxTarget}
        </Text>
      </View>

      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          {running ? 'Running...' : finished ? 'Completed' : 'Waiting'}
        </Text>
        <Text style={[styles.summaryText, styles.passedText]}>
          Passed: {passedCount}
        </Text>
        <Text style={[styles.summaryText, styles.failedText]}>
          Failed: {failedCount}
        </Text>
      </View>

      <ScrollView style={styles.results}>
        {results.map((result) => (
          <View
            key={result.id}
            style={[
              styles.resultItem,
              result.status === 'passed' && styles.resultPassed,
              result.status === 'failed' && styles.resultFailed,
              result.status === 'running' && styles.resultRunning,
            ]}
          >
            <Text style={styles.resultName}>{result.name}</Text>
            <Text style={styles.resultStatus}>
              {result.status === 'passed' && '✓'}
              {result.status === 'failed' && '✗'}
              {result.status === 'running' && '...'}
              {result.durationMs !== undefined && ` (${result.durationMs}ms)`}
            </Text>
            {result.error && (
              <Text style={styles.errorText}>{result.error.message}</Text>
            )}
          </View>
        ))}
      </ScrollView>

      <TouchableOpacity
        style={[styles.button, running && styles.buttonDisabled]}
        onPress={executeTests}
        disabled={running}
      >
        <Text style={styles.buttonText}>
          {running ? 'Running...' : 'Run Tests Again'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    padding: 20,
  },
  header: {
    marginBottom: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginTop: 4,
  },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: '#16213e',
    padding: 15,
    borderRadius: 8,
    marginBottom: 20,
  },
  summaryText: {
    fontSize: 16,
    color: '#fff',
  },
  passedText: {
    color: '#4ade80',
  },
  failedText: {
    color: '#f87171',
  },
  results: {
    flex: 1,
  },
  resultItem: {
    padding: 12,
    borderRadius: 6,
    marginBottom: 8,
    backgroundColor: '#16213e',
  },
  resultPassed: {
    borderLeftWidth: 4,
    borderLeftColor: '#4ade80',
  },
  resultFailed: {
    borderLeftWidth: 4,
    borderLeftColor: '#f87171',
  },
  resultRunning: {
    borderLeftWidth: 4,
    borderLeftColor: '#fbbf24',
  },
  resultName: {
    fontSize: 14,
    color: '#fff',
  },
  resultStatus: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
  },
  errorText: {
    fontSize: 12,
    color: '#f87171',
    marginTop: 8,
    fontFamily: Platform.OS === 'macos' ? 'Menlo' : 'monospace',
  },
  button: {
    backgroundColor: '#3b82f6',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 20,
  },
  buttonDisabled: {
    backgroundColor: '#555',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
