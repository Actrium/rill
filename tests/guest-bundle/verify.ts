/**
 * Guest Bundle Verification
 *
 * Builds and headlessly verifies guest bundles using Engine + vm sandbox.
 * Checks: bundle size, load time, component tree, operations, event handling.
 *
 * Run with: ./run-tests.sh
 */

import React from 'react';
import { Engine } from '../../src/host/Engine';

// ============================================================================
// Mock Components
// ============================================================================

const createMockComponent = (name: string) => {
  // biome-ignore lint/suspicious/noExplicitAny: Mock component accepts any props for testing
  const component = (props: any) => React.createElement(name, props);
  Object.defineProperty(component, 'name', { value: `Mock${name}` });
  // biome-ignore lint/suspicious/noExplicitAny: Adding custom property to component for testing
  (component as any).__rillComponentName = name;
  return component;
};

// biome-ignore lint/suspicious/noExplicitAny: Mock components registry for testing
const MOCK_COMPONENTS: Record<string, any> = {
  ScrollView: createMockComponent('ScrollView'),
  View: createMockComponent('View'),
  Text: createMockComponent('Text'),
  TouchableOpacity: createMockComponent('TouchableOpacity'),
  Image: createMockComponent('Image'),
  ActivityIndicator: createMockComponent('ActivityIndicator'),
  Button: createMockComponent('Button'),
  TextInput: createMockComponent('TextInput'),
  FlatList: createMockComponent('FlatList'),
};

// ============================================================================
// Types
// ============================================================================

interface OperationRecord {
  op: string; // Operation type: CREATE, APPEND, UPDATE, REMOVE, etc.
  id?: number; // Node ID
  type?: string; // Component type: Text, View, etc.
  // biome-ignore lint/suspicious/noExplicitAny: Props can be any serializable value
  props?: Record<string, any>;
  parentId?: number; // For APPEND operations
  childId?: number; // For APPEND operations
}

interface StateChange {
  timestamp: number;
  renderCount: number;
  operationCount: number;
  treeDepth: number;
  nodeCount: number;
}

interface GuestMessage {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: Message payload can be any serializable value
  payload?: any;
}

interface ExpectedBehavior {
  name: string;
  path: string;

  // Bundle expectations
  bundle: {
    minSize: number;
    maxSize: number;
  };

  // Load expectations
  load: {
    shouldSucceed: boolean;
    maxLoadTime: number; // ms
  };

  // Component tree expectations
  tree: {
    rootComponent: string;
    minDepth: number;
    maxDepth: number;
    minNodes: number;
    maxNodes: number;
    requiredComponents: string[]; // Must contain these component types
  };

  // Operations expectations
  operations: {
    minInitialOps: number; // Operations during initial render
    maxInitialOps: number;
    expectedTypes: string[]; // Expected operation types
  };

  // Event handling expectations
  events: {
    hostEvents: string[]; // Events guest should respond to
    expectedMessages?: { event: string; messageType: string }[]; // Expected guest messages after events
  };

  // State change expectations (after interactions)
  stateChanges?: {
    afterEvent: string;
    expectRenderCountIncrease: boolean;
  }[];
}

interface CheckResult {
  category: string;
  label: string;
  expected: string;
  actual: string;
  match: boolean;
}

interface VerificationResult {
  name: string;
  passed: boolean;
  checks: CheckResult[];
  stateHistory: StateChange[];
  operations: OperationRecord[];
  messages: GuestMessage[];
}

// ============================================================================
// Expected Behaviors
// ============================================================================

const EXPECTED_BEHAVIORS: ExpectedBehavior[] = [
  {
    name: 'simple-guest',
    path: './dist/bundle.js',
    bundle: { minSize: 3, maxSize: 10 },
    load: { shouldSucceed: true, maxLoadTime: 1000 },
    tree: {
      rootComponent: 'ScrollView',
      minDepth: 3,
      maxDepth: 10,
      minNodes: 10,
      maxNodes: 100,
      requiredComponents: ['ScrollView', 'View', 'Text', 'TouchableOpacity'],
    },
    operations: {
      minInitialOps: 5,
      maxInitialOps: 200,
      expectedTypes: ['CREATE', 'APPEND'],
    },
    events: {
      hostEvents: ['REFRESH', 'THEME_CHANGE'],
      expectedMessages: [],
    },
    stateChanges: [
      { afterEvent: 'REFRESH', expectRenderCountIncrease: true },
      { afterEvent: 'THEME_CHANGE', expectRenderCountIncrease: false },
    ],
  },
];

// ============================================================================
// Tree Analysis Utilities
// ============================================================================

function analyzeTree(
  // biome-ignore lint/suspicious/noExplicitAny: React element can have various types
  element: any,
  depth = 0
): { depth: number; nodeCount: number; componentTypes: Set<string> } {
  if (!element) {
    return { depth: 0, nodeCount: 0, componentTypes: new Set() };
  }

  const componentTypes = new Set<string>();
  let maxChildDepth = 0;
  let totalNodes = 1;

  // Get component type
  let typeName = 'unknown';
  if (typeof element.type === 'function') {
    typeName = element.type.__rillComponentName || element.type.name || 'Function';
    if (typeName.startsWith('Mock')) typeName = typeName.substring(4);
  } else if (typeof element.type === 'string') {
    typeName = element.type;
  }
  componentTypes.add(typeName);

  // Analyze children
  const children = element.props?.children;
  if (children) {
    const childArray = Array.isArray(children) ? children : [children];
    for (const child of childArray) {
      if (child && typeof child === 'object') {
        const childAnalysis = analyzeTree(child, depth + 1);
        maxChildDepth = Math.max(maxChildDepth, childAnalysis.depth);
        totalNodes += childAnalysis.nodeCount;
        childAnalysis.componentTypes.forEach((t) => componentTypes.add(t));
      }
    }
  }

  return {
    depth: depth + 1 + maxChildDepth,
    nodeCount: totalNodes,
    componentTypes,
  };
}

// ============================================================================
// Verification Logic
// ============================================================================

async function verifyBundle(expected: ExpectedBehavior): Promise<VerificationResult> {
  const checks: CheckResult[] = [];
  const stateHistory: StateChange[] = [];
  const operations: OperationRecord[] = [];
  const messages: GuestMessage[] = [];
  let allPassed = true;

  function check(category: string, label: string, expectedVal: string, actualVal: string): boolean {
    const match = expectedVal === actualVal;
    checks.push({ category, label, expected: expectedVal, actual: actualVal, match });
    if (!match) allPassed = false;
    return match;
  }

  function checkRange(
    category: string,
    label: string,
    min: number,
    max: number,
    actual: number
  ): boolean {
    const match = actual >= min && actual <= max;
    checks.push({
      category,
      label,
      expected: `${min}-${max}`,
      actual: String(actual),
      match,
    });
    if (!match) allPassed = false;
    return match;
  }

  function checkContains(
    category: string,
    label: string,
    required: string[],
    actual: string[]
  ): boolean {
    const missing = required.filter((r) => !actual.includes(r));
    const match = missing.length === 0;
    checks.push({
      category,
      label,
      expected: required.join(', '),
      actual: match ? actual.join(', ') : `missing: ${missing.join(', ')}`,
      match,
    });
    if (!match) allPassed = false;
    return match;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Bundle checks
  // ─────────────────────────────────────────────────────────────────────────
  let code: string;
  let sizeKB: number;
  try {
    code = await Bun.file(expected.path).text();
    sizeKB = parseFloat((code.length / 1024).toFixed(2));
    checkRange('Bundle', 'Size (KB)', expected.bundle.minSize, expected.bundle.maxSize, sizeKB);
  } catch (_err) {
    check('Bundle', 'File exists', 'true', 'false');
    return { name: expected.name, passed: false, checks, stateHistory, operations, messages };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Create engine with operation tracking
  // ─────────────────────────────────────────────────────────────────────────
  const engine = new Engine({
    sandbox: 'vm',
    timeout: 3000,
    debug: false,
  });

  engine.register(MOCK_COMPONENTS);

  // Track messages from guest
  engine.on('message', (msg) => {
    messages.push({ type: msg.type, payload: msg.payload });
  });

  // Track operations - keep all fields for analysis
  engine.on('operation', (batch) => {
    if (batch?.operations) {
      for (const op of batch.operations) {
        operations.push({
          op: op.op,
          id: op.id,
          type: op.type,
          props: op.props,
          parentId: op.parentId,
          childId: op.childId,
        });
      }
    }
  });

  let renderCount = 0;
  // biome-ignore lint/suspicious/noExplicitAny: Rendered output can be any React element
  let lastRendered: any = null;

  engine.on('update', () => {
    renderCount++;
    const receiver = engine.getReceiver();
    if (receiver) {
      lastRendered = receiver.render();
    }
    stateHistory.push({
      timestamp: Date.now(),
      renderCount,
      operationCount: operations.length,
      treeDepth: lastRendered ? analyzeTree(lastRendered).depth : 0,
      nodeCount: lastRendered ? analyzeTree(lastRendered).nodeCount : 0,
    });
  });
  engine.createReceiver();

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Load and timing checks
  // ─────────────────────────────────────────────────────────────────────────
  const loadStart = Date.now();
  let loadSucceeded = false;

  try {
    await engine.loadBundle(code, { title: 'Test', theme: 'light' });
    loadSucceeded = true;
    // biome-ignore lint/suspicious/noExplicitAny: Catch-all for any error type
  } catch (_err: any) {
    loadSucceeded = false;
  }

  const loadTime = Date.now() - loadStart;

  // Wait for async rendering
  await new Promise((resolve) => setTimeout(resolve, 150));

  check('Load', 'Success', String(expected.load.shouldSucceed), String(loadSucceeded));
  checkRange('Load', 'Time (ms)', 0, expected.load.maxLoadTime, loadTime);

  if (!loadSucceeded) {
    engine.destroy();
    return { name: expected.name, passed: false, checks, stateHistory, operations, messages };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Component tree analysis (from operations)
  // ─────────────────────────────────────────────────────────────────────────

  // Analyze tree from CREATE operations
  const createOps = operations.filter((o) => o.op === 'CREATE' && o.type);
  const componentTypesFromOps = new Set(
    createOps.map((o) => o.type!).filter((t) => !t.startsWith('__'))
  );
  const nodeCount = createOps.filter((o) => !o.type!.startsWith('__')).length;

  // Find root component - it's the one appended to parentId=0
  // biome-ignore lint/suspicious/noExplicitAny: Operations have dynamic fields based on op type
  const appendOps = operations.filter((o: any) => o.op === 'APPEND');
  // biome-ignore lint/suspicious/noExplicitAny: Operations have dynamic fields based on op type
  const rootAppend = appendOps.find((o: any) => o.parentId === 0) as any;
  let rootType = 'N/A';
  if (rootAppend) {
    // Use id or childId (both should work, id=37 and childId=37)
    const rootId = rootAppend.childId || rootAppend.id;
    // biome-ignore lint/suspicious/noExplicitAny: Operations have dynamic fields based on op type
    const rootCreate = createOps.find((o: any) => o.id === rootId);
    rootType = rootCreate?.type || 'N/A';
  }

  // Estimate depth - since tree builds bottom-up, we count unique component depths
  // Simplified: count distinct non-text component types as proxy for depth
  const distinctComponents = [...componentTypesFromOps].filter((t) => !t.startsWith('__'));
  const _estimatedDepth = Math.min(distinctComponents.length, nodeCount);

  check('Tree', 'Root component', expected.tree.rootComponent, rootType);
  checkRange('Tree', 'Node count', expected.tree.minNodes, expected.tree.maxNodes, nodeCount);
  checkRange('Tree', 'Component variety', 3, 20, distinctComponents.length);
  checkContains(
    'Tree',
    'Required components',
    expected.tree.requiredComponents,
    Array.from(componentTypesFromOps)
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Operations analysis
  // ─────────────────────────────────────────────────────────────────────────
  const initialOpsCount = operations.length;
  checkRange(
    'Ops',
    'Initial count',
    expected.operations.minInitialOps,
    expected.operations.maxInitialOps,
    initialOpsCount
  );

  const opTypes = [...new Set(operations.map((o) => o.op).filter(Boolean))];
  checkContains('Ops', 'Op types', expected.operations.expectedTypes, opTypes);

  // Check component types created
  const componentTypes = [
    ...new Set(operations.filter((o) => o.op === 'CREATE' && o.type).map((o) => o.type!)),
  ];
  checkContains('Ops', 'Component types', expected.tree.requiredComponents, componentTypes);

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Event handling and state changes
  // ─────────────────────────────────────────────────────────────────────────
  const _renderCountBeforeEvents = renderCount;

  for (const eventName of expected.events.hostEvents) {
    const renderBefore = renderCount;
    engine.sendEvent(eventName, { theme: 'dark', data: 'test' });

    // Wait for state update
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Check if event was handled (might trigger re-render)
    const stateChange = expected.stateChanges?.find((s) => s.afterEvent === eventName);
    if (stateChange) {
      const renderIncreased = renderCount > renderBefore;
      check(
        'Events',
        `${eventName} triggers re-render`,
        String(stateChange.expectRenderCountIncrease),
        String(renderIncreased)
      );
    }
  }

  // Check expected messages
  if (expected.events.expectedMessages) {
    for (const em of expected.events.expectedMessages) {
      const found = messages.some((m) => m.type === em.messageType);
      check(
        'Events',
        `Message after ${em.event}`,
        em.messageType,
        found ? em.messageType : 'not received'
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7. State history analysis
  // ─────────────────────────────────────────────────────────────────────────
  if (stateHistory.length > 0) {
    const first = stateHistory[0];
    const last = stateHistory[stateHistory.length - 1];

    check('State', 'Has initial render', 'true', String(first.renderCount >= 1));
    checkRange('State', 'Total renders', 1, 50, last.renderCount);
  }

  engine.destroy();
  return { name: expected.name, passed: allPassed, checks, stateHistory, operations, messages };
}

// ============================================================================
// Output Formatting
// ============================================================================

function printResults(results: VerificationResult[]): boolean {
  console.log(`\n${'═'.repeat(90)}`);
  console.log('EXAMPLE VERIFICATION RESULTS');
  console.log('═'.repeat(90));

  for (const result of results) {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`\n${status} ${result.name}`);
    console.log('─'.repeat(90));

    // Group checks by category
    const categories = [...new Set(result.checks.map((c) => c.category))];

    for (const cat of categories) {
      console.log(`\n  [${cat}]`);
      console.log(`  ${'Check'.padEnd(30)}${'Expected'.padEnd(25)}${'Actual'.padEnd(25)}Result`);
      console.log(`  ${'─'.repeat(85)}`);

      const catChecks = result.checks.filter((c) => c.category === cat);
      for (const c of catChecks) {
        const matchStr = c.match ? '✓' : '✗';
        const actualDisplay = c.actual.length > 22 ? `${c.actual.substring(0, 22)}...` : c.actual;
        const expectedDisplay =
          c.expected.length > 22 ? `${c.expected.substring(0, 22)}...` : c.expected;
        console.log(
          '  ' +
            c.label.padEnd(30) +
            expectedDisplay.padEnd(25) +
            actualDisplay.padEnd(25) +
            matchStr
        );
      }
    }

    // State history summary
    if (result.stateHistory.length > 0) {
      console.log(`\n  [State History] (${result.stateHistory.length} snapshots)`);
      console.log(
        '  ' +
          'Snapshot'.padEnd(12) +
          'Renders'.padEnd(10) +
          'Ops'.padEnd(10) +
          'Depth'.padEnd(10) +
          'Nodes'
      );
      console.log(`  ${'─'.repeat(50)}`);
      result.stateHistory.slice(0, 5).forEach((s, i) => {
        console.log(
          '  ' +
            `#${i + 1}`.padEnd(12) +
            String(s.renderCount).padEnd(10) +
            String(s.operationCount).padEnd(10) +
            String(s.treeDepth).padEnd(10) +
            String(s.nodeCount)
        );
      });
      if (result.stateHistory.length > 5) {
        console.log(`  ... and ${result.stateHistory.length - 5} more snapshots`);
      }
    }

    // Operation types summary
    const opCounts: Record<string, number> = {};
    const componentCounts: Record<string, number> = {};
    result.operations.forEach((o) => {
      if (o.op) opCounts[o.op] = (opCounts[o.op] || 0) + 1;
      if (o.type) componentCounts[o.type] = (componentCounts[o.type] || 0) + 1;
    });
    if (Object.keys(opCounts).length > 0) {
      console.log(`\n  [Operations Summary] (${result.operations.length} total)`);
      console.log('    By operation type:');
      for (const [type, count] of Object.entries(opCounts)) {
        console.log(`      ${type}: ${count}`);
      }
      console.log('    By component type:');
      for (const [type, count] of Object.entries(componentCounts).slice(0, 10)) {
        console.log(`      ${type}: ${count}`);
      }
    }

    // Messages
    if (result.messages.length > 0) {
      console.log(`\n  [Guest Messages] (${result.messages.length} total)`);
      result.messages.slice(0, 5).forEach((m) => {
        console.log(`    ${m.type}: ${JSON.stringify(m.payload)}`);
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const totalChecks = results.reduce((sum, r) => sum + r.checks.length, 0);
  const passedChecks = results.reduce((sum, r) => sum + r.checks.filter((c) => c.match).length, 0);

  console.log(`\n${'═'.repeat(90)}`);
  console.log(
    `SUMMARY: ${passed}/${total} examples passed (${passedChecks}/${totalChecks} checks)`
  );
  console.log('═'.repeat(90));

  if (passed === total) {
    console.log('\n✅ All examples verified successfully!\n');
    return true;
  } else {
    console.log('\n❌ Some examples failed verification.\n');
    return false;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('🔍 Verifying example bundles (detailed mode)...');
  console.log('   Working directory:', process.cwd());

  const results: VerificationResult[] = [];

  for (const expected of EXPECTED_BEHAVIORS) {
    console.log(`   Checking ${expected.name}...`);
    const result = await verifyBundle(expected);
    results.push(result);
  }

  const allPassed = printResults(results);
  process.exit(allPassed ? 0 : 1);
}

main();
