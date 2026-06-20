/**
 * PanelMarker Children Rendering Test
 *
 * Reproduces the issue where PanelMarker nodes have 0 children
 * when they should contain the wrapped component content.
 *
 * Expected behavior:
 * - Panel.Left/Right are function components that return <PanelMarker panelId="left/right">{children}</PanelMarker>
 * - PanelMarker should have its children as child nodes in the receiver
 *
 * Issue observed:
 * - nodeTypes: 1:PanelMarker(0), 2:PanelMarker(0), 3:View(2)
 * - PanelMarker has 0 children instead of containing ScrollView/Text etc.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type TestContext } from './00-setup.test';
import { findNodeByTestId, findNodesByType, waitFor, wait } from './helpers/test-utils';

/**
 * Test using askit Panel component pattern
 * This mimics the actual Panel.guest.tsx implementation:
 *
 * const PanelMarker = createGuestComponent<PanelMarkerProps>('PanelMarker');
 * function createPanel(side: PanelSide): React.FC<PanelProps> {
 *   const PanelSideComponent: React.FC<PanelProps> = ({ children }) => (
 *     <PanelMarker panelId={side}>{children}</PanelMarker>
 *   );
 *   return PanelSideComponent;
 * }
 */
describe('PanelMarker with askit Panel pattern', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should render Panel.Left/Right with children (askit pattern)', async () => {
    // This exactly mimics askit/src/ui/Panel/Panel.guest.tsx
    const guestCode = `
      var React = require('react');
      var render = require('rill/reconciler').render;

      // createGuestComponent returns the string type name
      // This is what askit's guest-factory.ts does
      function createGuestComponent(name) {
        return name;
      }

      var PanelMarker = createGuestComponent('PanelMarker');

      // Exact implementation from Panel.guest.tsx
      function createPanel(side) {
        var PanelSideComponent = function(props) {
          // This is: <PanelMarker panelId={side}>{children}</PanelMarker>
          // Which compiles to: React.createElement(PanelMarker, {panelId: side}, children)
          return React.createElement(PanelMarker, {
            panelId: side,
            testID: side + '-panel'
          }, props.children);
        };
        PanelSideComponent.displayName = 'Panel.' + (side === 'left' ? 'Left' : 'Right');
        return PanelSideComponent;
      }

      var Panel = {
        Left: createPanel('left'),
        Right: createPanel('right')
      };

      // Content components
      function LeftContent() {
        return React.createElement('ScrollView', { testID: 'left-scroll' },
          React.createElement('Text', { testID: 'left-text' }, 'Left Content')
        );
      }

      function RightContent() {
        return React.createElement('ScrollView', { testID: 'right-scroll' },
          React.createElement('Text', { testID: 'right-text' }, 'Right Content')
        );
      }

      // App using Panel.Left/Right
      function App() {
        return React.createElement('View', { testID: 'root', style: { flex: 1 } },
          React.createElement(Panel.Left, {},
            React.createElement(LeftContent)
          ),
          React.createElement(Panel.Right, {},
            React.createElement(RightContent)
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Print all nodes
    const allNodes = ctx.receiver.getNodes();
    console.log('\n=== askit Panel Test - All Nodes (count: ' + allNodes.length + ') ===');
    allNodes.forEach((node) => {
      console.log('  Node ' + node.id + ': type=' + node.type + ', children=[' + node.children.join(',') + ']');
    });

    // Find PanelMarker nodes
    const panelMarkers = findNodesByType(ctx.receiver, 'PanelMarker');
    console.log('PanelMarker count:', panelMarkers.length);

    expect(panelMarkers.length).toBe(2);

    // Check panels have children
    const leftPanel = ctx.receiver.findByTestId('left-panel');
    const rightPanel = ctx.receiver.findByTestId('right-panel');

    console.log('Left panel:', leftPanel?.id, 'children:', leftPanel?.children);
    console.log('Right panel:', rightPanel?.id, 'children:', rightPanel?.children);

    expect(leftPanel).toBeDefined();
    expect(leftPanel?.children.length).toBeGreaterThan(0);
    expect(rightPanel).toBeDefined();
    expect(rightPanel?.children.length).toBeGreaterThan(0);

    // Verify nested content exists
    expect(findNodeByTestId(ctx.receiver, 'left-scroll')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'right-scroll')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'left-text')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'right-text')).toBeDefined();
  });

  it('should render Panel with jsx() style (props.children pattern)', async () => {
    // This mimics the compiled JSX: jsx(PanelMarker, {panelId: side, children: children})
    const guestCode = `
      var React = require('react');
      var render = require('rill/reconciler').render;

      // jsx() passes children in props, not as rest args
      var jsx = function(type, props) {
        return React.createElement(type, props);
      };

      var PanelMarker = 'PanelMarker';

      function PanelLeft(props) {
        // jsx(PanelMarker, {panelId: 'left', children: props.children})
        return jsx(PanelMarker, { panelId: 'left', testID: 'left-panel', children: props.children });
      }

      function PanelRight(props) {
        return jsx(PanelMarker, { panelId: 'right', testID: 'right-panel', children: props.children });
      }

      function App() {
        return jsx('View', {
          testID: 'root',
          children: [
            jsx(PanelLeft, { children: jsx('Text', { testID: 'left-text', children: 'Left' }) }),
            jsx(PanelRight, { children: jsx('Text', { testID: 'right-text', children: 'Right' }) })
          ]
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const allNodes = ctx.receiver.getNodes();
    console.log('\n=== jsx() style Test - Nodes: ' + allNodes.length + ' ===');
    allNodes.forEach((node) => {
      console.log('  ' + node.id + ': ' + node.type + ' children=[' + node.children.join(',') + ']');
    });

    const panelMarkers = findNodesByType(ctx.receiver, 'PanelMarker');
    expect(panelMarkers.length).toBe(2);

    const leftPanel = ctx.receiver.findByTestId('left-panel');
    const rightPanel = ctx.receiver.findByTestId('right-panel');

    expect(leftPanel?.children.length).toBeGreaterThan(0);
    expect(rightPanel?.children.length).toBeGreaterThan(0);
  });
});

describe('PanelMarker Children Rendering', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('should render PanelMarker with children using props.children pattern', async () => {
    // This simulates the jsx() pattern where children are passed in props
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      // Simulating Panel.Left - a function component that wraps children in PanelMarker
      function PanelLeft({ children }) {
        // This is what jsx("PanelMarker", {panelId: "left", children: children}) produces
        return React.createElement('PanelMarker', { panelId: 'left', children: children });
      }

      function App() {
        return React.createElement(
          'View',
          { testID: 'root' },
          // jsx(PanelLeft, {children: jsx('Text', {testID: 'content'}, 'Hello')})
          React.createElement(
            PanelLeft,
            { children: React.createElement('Text', { testID: 'content' }, 'Hello Panel') }
          )
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Debug: Print all nodes
    const allNodes = ctx.receiver.getNodes();
    console.log('=== All Nodes ===');
    allNodes.forEach((node) => {
      console.log('Node ' + node.id + ': type=' + node.type + ', children=[' + node.children.join(',') + '], props=' + JSON.stringify(node.props));
    });

    // Find PanelMarker node
    const panelMarkers = findNodesByType(ctx.receiver, 'PanelMarker');
    console.log('PanelMarker nodes found:', panelMarkers.length);

    expect(panelMarkers.length).toBe(1);

    const panelMarker = panelMarkers[0];
    console.log('PanelMarker children:', panelMarker?.children);

    // CRITICAL: PanelMarker should have children
    expect(panelMarker?.children.length).toBeGreaterThan(0);

    // Verify the Text content exists somewhere in the tree
    const textNode = findNodeByTestId(ctx.receiver, 'content');
    expect(textNode).toBeDefined();
    expect(textNode?.type).toBe('Text');
  });

  it('should render nested function component returning PanelMarker', async () => {
    // More complex case: jsx(Panel.Left, {children: jsx(ScrollView, {...}, jsx(Text, ...))})
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      // Panel.Left implementation
      function PanelLeft({ children }) {
        return React.createElement('PanelMarker', { panelId: 'left', testID: 'left-panel', children });
      }

      // Panel.Right implementation
      function PanelRight({ children }) {
        return React.createElement('PanelMarker', { panelId: 'right', testID: 'right-panel', children });
      }

      // Content component (simulating O/S from counterapp)
      function LeftContent() {
        return React.createElement(
          'ScrollView',
          { testID: 'left-scroll' },
          React.createElement('Text', { testID: 'left-text' }, 'Left Panel Content')
        );
      }

      function RightContent() {
        return React.createElement(
          'ScrollView',
          { testID: 'right-scroll' },
          React.createElement('Text', { testID: 'right-text' }, 'Right Panel Content')
        );
      }

      function App() {
        return React.createElement(
          'View',
          { testID: 'root', style: { flex: 1 } },
          React.createElement(PanelLeft, {}, React.createElement(LeftContent)),
          React.createElement(PanelRight, {}, React.createElement(RightContent))
        );
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Debug: Print all nodes with hierarchy
    const allNodes = ctx.receiver.getNodes();
    console.log('\n=== All Nodes (count:', allNodes.length, ') ===');
    allNodes.forEach((node) => {
      console.log('  Node ' + node.id + ': type=' + node.type + ', children=[' + node.children.join(',') + ']');
    });

    // Find PanelMarker nodes
    const panelMarkers = findNodesByType(ctx.receiver, 'PanelMarker');
    console.log('\nPanelMarker nodes:', panelMarkers.length);

    expect(panelMarkers.length).toBe(2);

    // Both PanelMarkers should have children
    const leftPanel = ctx.receiver.findByTestId('left-panel');
    const rightPanel = ctx.receiver.findByTestId('right-panel');

    console.log('Left panel children:', leftPanel?.children);
    console.log('Right panel children:', rightPanel?.children);

    expect(leftPanel?.children.length).toBeGreaterThan(0);
    expect(rightPanel?.children.length).toBeGreaterThan(0);

    // Verify nested content exists
    expect(findNodeByTestId(ctx.receiver, 'left-scroll')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'right-scroll')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'left-text')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'right-text')).toBeDefined();
  });

  it('should handle children passed via props (jsx pattern)', async () => {
    // This is the exact pattern used by jsxs(): jsx(type, {children: [...], ...props})
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        // Simulating: jsxs('View', {style: {flex:1}, children: [child1, child2]})
        const child1 = React.createElement('Text', { testID: 'child1' }, 'First');
        const child2 = React.createElement('Text', { testID: 'child2' }, 'Second');

        // Pass children via props (like jsx/jsxs does)
        return React.createElement('View', {
          testID: 'container',
          style: { flex: 1 },
          children: [child1, child2]  // children in props, not as rest args
        });
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    const container = findNodeByTestId(ctx.receiver, 'container');
    console.log('Container children:', container?.children);

    expect(container).toBeDefined();
    expect(container?.children.length).toBe(2);

    expect(findNodeByTestId(ctx.receiver, 'child1')).toBeDefined();
    expect(findNodeByTestId(ctx.receiver, 'child2')).toBeDefined();
  });

  it('should handle PanelMarker with props.children (counterapp pattern)', async () => {
    // This is the exact pattern from counterapp:
    // jsx(PanelMarker, {panelId: "left", children: someElement})
    const guestCode = `
      const React = require('react');
      const { render } = require('rill/reconciler');

      function App() {
        // Simulating: f.jsx(d, {panelId: "left", children: z})
        // where d = "PanelMarker" and z = some element
        const content = React.createElement('ScrollView', { testID: 'scroll' },
          React.createElement('Text', { testID: 'text' }, 'Content')
        );

        // Children passed in props object (jsx pattern)
        const panelElement = React.createElement('PanelMarker', {
          panelId: 'left',
          testID: 'panel',
          children: content
        });

        return React.createElement('View', { testID: 'root' }, panelElement);
      }

      render(React.createElement(App), globalThis.__rill_sendBatch);
    `;

    await ctx.engine.loadBundle(guestCode);
    await waitFor(() => ctx.receiver.nodeCount > 0, 2000);

    // Debug output
    const allNodes = ctx.receiver.getNodes();
    console.log('\n=== Nodes ===');
    allNodes.forEach((node) => {
      console.log('  ' + node.id + ': ' + node.type + ' children=[' + node.children.join(',') + ']');
    });

    const panel = findNodeByTestId(ctx.receiver, 'panel');
    console.log('\nPanel node:', panel?.id, 'children:', panel?.children);

    expect(panel).toBeDefined();
    expect(panel?.type).toBe('PanelMarker');

    // CRITICAL: Panel should have children
    expect(panel?.children.length).toBeGreaterThan(0);

    // ScrollView should be a child of PanelMarker
    const scrollView = findNodeByTestId(ctx.receiver, 'scroll');
    expect(scrollView).toBeDefined();
  });
});
