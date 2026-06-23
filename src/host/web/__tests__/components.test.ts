/**
 * Thin-DOM web preset component tests (issue #19, L2).
 *
 * Uses react-test-renderer (no real DOM needed) to assert each rill primitive maps to the
 * right host element with the expected props/handlers — View→div (flex column), Text→span,
 * Pressable/Button→button (onPress→onClick), TextInput→input/textarea (onChange→onChangeText),
 * ScrollView→overflow div.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: react-test-renderer JSON node is loosely typed
type Json = any;

describe('rill/host/web thin-DOM components', () => {
  let React: typeof import('react');
  let TestRenderer: typeof import('react-test-renderer');
  let act: typeof import('react-test-renderer').act;
  let C: typeof import('../components');

  beforeAll(() => {
    const ReactCjs = require('../../../../node_modules/react/index.js') as typeof import('react');
    mock.module('react', () => ({ ...ReactCjs, default: ReactCjs }));
    React = ReactCjs;
    // biome-ignore lint/suspicious/noExplicitAny: test renderer module interop
    const trm = require('react-test-renderer') as any;
    TestRenderer = trm.default ?? trm;
    act = TestRenderer.act;
    C = require('../components') as typeof import('../components');
  });

  // biome-ignore lint/suspicious/noExplicitAny: element + JSON are loosely typed in tests
  const render = (el: any): Json => {
    let r: import('react-test-renderer').ReactTestRenderer | undefined;
    act(() => {
      r = TestRenderer.create(el);
    });
    return r?.toJSON() as Json;
  };

  it('View → div with flex-column default and testID → data-testid', () => {
    const t = render(React.createElement(C.View, { testID: 'v', style: { padding: 8 } }, 'x'));
    expect(t.type).toBe('div');
    expect(t.props['data-testid']).toBe('v');
    expect(t.props.style.display).toBe('flex');
    expect(t.props.style.flexDirection).toBe('column');
    expect(t.props.style.padding).toBe(8);
  });

  it('View flattens an array style and drops falsy entries', () => {
    const t = render(
      React.createElement(C.View, { style: [{ padding: 4 }, false, { margin: 2 }] })
    );
    expect(t.props.style.padding).toBe(4);
    expect(t.props.style.margin).toBe(2);
  });

  it('Text → span', () => {
    const t = render(React.createElement(C.Text, null, 'hi'));
    expect(t.type).toBe('span');
    expect(t.children).toEqual(['hi']);
  });

  it('Pressable → button and maps onPress → onClick', () => {
    const onPress = mock();
    const t = render(React.createElement(C.Pressable, { onPress, testID: 'btn' }, 'tap'));
    expect(t.type).toBe('button');
    expect(t.props['data-testid']).toBe('btn');
    t.props.onClick();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('Button → button, renders title and maps onPress → onClick', () => {
    const onPress = mock();
    const t = render(React.createElement(C.Button, { title: 'OK', onPress }));
    expect(t.type).toBe('button');
    expect(t.children).toEqual(['OK']);
    t.props.onClick();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('TextInput → input and maps onChange → onChangeText', () => {
    const onChangeText = mock();
    const t = render(React.createElement(C.TextInput, { onChangeText, placeholder: 'name' }));
    expect(t.type).toBe('input');
    expect(t.props.placeholder).toBe('name');
    expect(t.props.type).toBe('text');
    t.props.onChange({ target: { value: 'abc' } });
    expect(onChangeText).toHaveBeenCalledWith('abc');
  });

  it('TextInput secureTextEntry → password; multiline → textarea', () => {
    expect(render(React.createElement(C.TextInput, { secureTextEntry: true })).props.type).toBe(
      'password'
    );
    expect(render(React.createElement(C.TextInput, { multiline: true })).type).toBe('textarea');
  });

  it('ScrollView → overflow:auto div', () => {
    const t = render(React.createElement(C.ScrollView, { testID: 's' }, 'content'));
    expect(t.type).toBe('div');
    expect(t.props.style.overflowY).toBe('auto');
  });

  it('WebComponents registry exposes the expected names', () => {
    expect(Object.keys(C.WebComponents).sort()).toEqual([
      'ActivityIndicator',
      'Button',
      'Pressable',
      'ScrollView',
      'Text',
      'TextInput',
      'TouchableOpacity',
      'View',
    ]);
  });
});
