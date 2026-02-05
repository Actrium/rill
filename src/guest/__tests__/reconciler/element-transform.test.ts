/**
 * Element Transform Tests
 *
 * Tests for Guest → Host element transformation and component wrapping
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  registerComponentType,
  transformGuestElement,
  unregisterComponentTypes,
} from '../../runtime/reconciler/element-transform';

describe('element-transform', () => {
  describe('registerComponentType()', () => {
    afterEach(() => {
      // Cleanup after each test
      unregisterComponentTypes('test-owner');
    });

    test('should register a function component', () => {
      const Component = () => null;
      const typeId = registerComponentType(Component, 'test-owner');

      expect(typeId).toBeTruthy();
      expect(typeof typeId).toBe('string');
      expect(typeId).toMatch(/^cmp_/);
    });

    test('should return same typeId for already registered component', () => {
      const Component = () => null;
      const id1 = registerComponentType(Component, 'test-owner');
      const id2 = registerComponentType(Component, 'test-owner');

      expect(id1).toBe(id2);
    });

    test('should handle null input', () => {
      const result = registerComponentType(null, 'test-owner');
      expect(result).toBe(null);
    });

    test('should handle undefined input', () => {
      const result = registerComponentType(undefined, 'test-owner');
      expect(result).toBe(null);
    });

    test('should handle non-function input', () => {
      const result = registerComponentType('not-a-function', 'test-owner');
      expect(result).toBe(null);
    });

    test('should handle object input', () => {
      const result = registerComponentType({ foo: 'bar' }, 'test-owner');
      expect(result).toBe(null);
    });

    test('should handle number input', () => {
      const result = registerComponentType(123, 'test-owner');
      expect(result).toBe(null);
    });

    test('should use global owner by default', () => {
      const Component = () => null;
      const typeId = registerComponentType(Component);

      expect(typeId).toBeTruthy();
      expect(typeof typeId).toBe('string');
    });

    test('should register multiple components with different owners', () => {
      const Comp1 = () => null;
      const Comp2 = () => null;

      const id1 = registerComponentType(Comp1, 'owner1');
      const id2 = registerComponentType(Comp2, 'owner2');

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);

      unregisterComponentTypes('owner1');
      unregisterComponentTypes('owner2');
    });
  });

  describe('unregisterComponentTypes()', () => {
    test('should unregister components by owner', () => {
      const Comp1 = () => null;
      const Comp2 = () => null;

      const id1 = registerComponentType(Comp1, 'owner1');
      const id2 = registerComponentType(Comp2, 'owner2');

      unregisterComponentTypes('owner1');

      // After unregister, registering again should give a new ID
      const id1New = registerComponentType(Comp1, 'owner1');
      expect(id1New).not.toBe(id1);

      // owner2 should still have same ID
      const id2Same = registerComponentType(Comp2, 'owner2');
      expect(id2Same).toBe(id2);

      unregisterComponentTypes('owner1');
      unregisterComponentTypes('owner2');
    });

    test('should handle unregistering non-existent owner', () => {
      expect(() => {
        unregisterComponentTypes('non-existent-owner');
      }).not.toThrow();
    });

    test('should handle empty owner string', () => {
      expect(() => {
        unregisterComponentTypes('');
      }).not.toThrow();
    });
  });

  describe('transformGuestElement()', () => {
    test('should return null for null input', () => {
      const result = transformGuestElement(null as never);
      expect(result).toBe(null);
    });

    test('should return null for undefined input', () => {
      const result = transformGuestElement(undefined as never);
      expect(result).toBe(null);
    });

    test('should pass through primitive strings', () => {
      const result = transformGuestElement('hello' as never);
      expect(result).toBe('hello');
    });

    test('should pass through primitive numbers', () => {
      const result = transformGuestElement(123 as never);
      expect(result).toBe(123);
    });

    test('should pass through primitive booleans', () => {
      const result = transformGuestElement(true as never);
      expect(result).toBe(true);
    });

    test('should handle empty array', () => {
      const result = transformGuestElement([] as never);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    test('should transform array of primitives', () => {
      const result = transformGuestElement(['a', 'b', 'c'] as never);
      expect(Array.isArray(result)).toBe(true);
    });

    test('should handle array with null elements', () => {
      const result = transformGuestElement([null, 'text', null] as never);
      expect(Array.isArray(result)).toBe(true);
    });

    test('should return as-is for non-React-element objects', () => {
      const plainObj = { foo: 'bar' };
      const result = transformGuestElement(plainObj as never);
      expect(result).toBe(plainObj);
    });

    test('should handle nested arrays', () => {
      const nested = [
        ['a', 'b'],
        ['c', 'd'],
      ];
      const result = transformGuestElement(nested as never);
      expect(Array.isArray(result)).toBe(true);
    });

    test('should handle debug mode without per-transform logging (removed for perf)', () => {
      // Per-transform __TRANSFORM_LOG_COUNT was removed for performance:
      // In XPC ViewBridge + JSC sandbox, console calls in render hot path
      // cost 100-500ms due to circular ref traversal (see PERF comment in source).
      // Debug mode is now only used in reconciler-manager.ts render() entry point.
      const globalState = globalThis as Record<string, unknown>;
      const originalDebug = globalState.__RILL_RECONCILER_DEBUG__;

      try {
        globalState.__RILL_RECONCILER_DEBUG__ = true;

        const mockElement = {
          $$typeof: Symbol.for('react.element'),
          type: 'div',
          props: { children: 'test' },
          __rillTypeMarker: 'string',
        };

        // Should not throw even with debug enabled
        expect(() => {
          transformGuestElement(mockElement as never);
        }).not.toThrow();
      } finally {
        globalState.__RILL_RECONCILER_DEBUG__ = originalDebug;
      }
    });

    test('should handle logging failures gracefully', () => {
      const globalState = globalThis as Record<string, unknown>;
      const originalDebug = globalState.__RILL_RECONCILER_DEBUG__;

      try {
        globalState.__RILL_RECONCILER_DEBUG__ = true;

        // Create element with props that might cause logging errors
        const mockElement = {
          $$typeof: Symbol.for('react.element'),
          type: 'div',
          props: null, // This might cause issues in logging
          __rillTypeMarker: 'string',
        };

        // Should not throw
        expect(() => {
          transformGuestElement(mockElement as never);
        }).not.toThrow();
      } finally {
        globalState.__RILL_RECONCILER_DEBUG__ = originalDebug;
      }
    });

    test('should handle elements with auto-key', () => {
      const mockElement = {
        $$typeof: Symbol.for('react.element'),
        type: 'div',
        props: { children: 'test' },
        __rillTypeMarker: 'string',
      };

      const result = transformGuestElement(mockElement as never, 'auto-key-123');
      expect(result).toBeDefined();
    });

    test('should handle elements without props', () => {
      const mockElement = {
        $$typeof: Symbol.for('react.element'),
        type: 'div',
        __rillTypeMarker: 'string',
      };

      const result = transformGuestElement(mockElement as never);
      expect(result).toBeDefined();
    });

    test('should handle complex nested structures', () => {
      const complex = {
        $$typeof: Symbol.for('react.element'),
        type: 'div',
        props: {
          children: [
            'text',
            {
              $$typeof: Symbol.for('react.element'),
              type: 'span',
              props: { children: 'nested' },
              __rillTypeMarker: 'string',
            },
            null,
          ],
        },
        __rillTypeMarker: 'string',
      };

      expect(() => {
        transformGuestElement(complex as never);
      }).not.toThrow();
    });
  });

  describe('Fragment Handling', () => {
    test('should transform Fragment with __rillFragmentType marker', () => {
      const fragmentElement = {
        __rillTypeMarker: '__rill_react_element__',
        __rillFragmentType: '__rill_react_fragment__',
        type: 'fragment-placeholder',
        props: {
          children: ['child1', 'child2'],
        },
      };

      const result = transformGuestElement(fragmentElement as never);

      expect(result).toBeDefined();
      expect(result).not.toBe(null);
      // Should be transformed to React.Fragment
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result as any).type).toBe(Symbol.for('react.fragment'));
    });

    test('should transform Fragment with Symbol type', () => {
      const fragmentSymbol = Symbol.for('react.fragment');
      const fragmentElement = {
        __rillTypeMarker: '__rill_react_element__',
        type: fragmentSymbol,
        props: {
          children: ['text'],
        },
      };

      const result = transformGuestElement(fragmentElement as never);

      expect(result).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result as any).type).toBe(Symbol.for('react.fragment'));
    });

    test('should preserve Fragment children', () => {
      const fragmentElement = {
        __rillTypeMarker: '__rill_react_element__',
        __rillFragmentType: '__rill_react_fragment__',
        type: 'fragment',
        props: {
          children: [
            'text1',
            {
              __rillTypeMarker: '__rill_react_element__',
              type: 'div',
              props: { id: 'nested' },
            },
            'text2',
          ],
        },
      };

      const result = transformGuestElement(fragmentElement as never);

      expect(result).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result as any).props.children).toBeDefined();
    });

    test('should handle Fragment with key', () => {
      const fragmentElement = {
        __rillTypeMarker: '__rill_react_element__',
        __rillFragmentType: '__rill_react_fragment__',
        type: 'fragment',
        key: 'fragment-key',
        props: {
          children: ['child'],
        },
      };

      const result = transformGuestElement(fragmentElement as never);

      expect(result).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result as any).key).toBe('fragment-key');
    });
  });

  describe('Component Type Resolution', () => {
    afterEach(() => {
      unregisterComponentTypes('test-type-resolution');
    });

    test('should resolve component type reference', () => {
      const Component = () => null;
      const typeId = registerComponentType(Component, 'test-type-resolution');

      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: {
          __rillComponentId: typeId,
          displayName: 'TestComponent',
        },
        props: { foo: 'bar' },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect(typeof (result as any).type).toBe('function');
    });

    test('should wrap function component type', () => {
      const Component = () => null;

      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: Component,
        props: { testProp: 'value' },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect(typeof (result as any).type).toBe('function');
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result as any).type).toHaveProperty('__rillSandboxWrapper', true);
    });

    test('should cache wrapped components', () => {
      const Component = () => null;

      const element1 = {
        __rillTypeMarker: '__rill_react_element__',
        type: Component,
        props: {},
      };

      const element2 = {
        __rillTypeMarker: '__rill_react_element__',
        type: Component,
        props: {},
      };

      const result1 = transformGuestElement(element1 as never);
      const result2 = transformGuestElement(element2 as never);

      // Should use same wrapped component
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result1 as any).type).toBe(
        // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
        (result2 as any).type
      );
    });

    test('should fallback to Fragment when component type ref not found', () => {
      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: {
          __rillComponentId: 'cmp_missing_999',
        },
        props: {
          children: 'test',
        },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      // Should fallback to Fragment to preserve children
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result as any).type).toBe(Symbol.for('react.fragment'));
    });

    test('should handle component with displayName', () => {
      const Component = () => null;
      const typeId = registerComponentType(Component, 'test-type-resolution');

      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: {
          __rillComponentId: typeId,
          displayName: 'MyCustomComponent',
        },
        props: {},
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result as any).type.displayName).toBe('MyCustomComponent');
    });

    test('should handle object type with nested type field', () => {
      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: {
          type: 'div',
        },
        props: {
          children: 'test',
        },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      // Should extract nested type
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result as any).type).toBe('div');
    });

    test('should handle object type with render field', () => {
      const RenderComponent = () => null;
      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: {
          render: RenderComponent,
        },
        props: {},
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect(typeof (result as any).type).toBe('function');
    });

    test('should handle object type with default field', () => {
      const DefaultComponent = () => null;
      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: {
          default: DefaultComponent,
        },
        props: {},
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect(typeof (result as any).type).toBe('function');
    });

    test('should fallback to Fragment for unresolvable object type', () => {
      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: {
          someRandomField: 'value',
        },
        props: {
          children: 'preserve me',
        },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      // Should fallback to Fragment to preserve children
      // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
      expect((result as any).type).toBe(Symbol.for('react.fragment'));
    });
  });

  describe('Props Serialization', () => {
    test('should serialize function props for sandbox components', () => {
      const Component = () => null;
      const onPress = () => 'clicked';

      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: Component,
        props: {
          onPress,
          text: 'Button',
        },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      // Props should be serialized (functions converted to { __type: 'function', __fnId })
      const props = // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
        (result as any).props;
      expect(props.text).toBe('Button');
      expect(props.onPress).toBeDefined();
    });

    test('should preserve children for sandbox components', () => {
      const Component = () => null;

      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: Component,
        props: {
          children: 'child text',
          onPress: () => {},
        },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      const props = // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
        (result as any).props;
      expect(props.children).toBe('child text');
    });

    test('should handle nested function props', () => {
      const Component = () => null;

      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: Component,
        props: {
          handlers: {
            onSubmit: () => 'submit',
            onCancel: () => 'cancel',
          },
        },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      const props = // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
        (result as any).props;
      expect(props.handlers).toBeDefined();
    });
  });

  describe('Children Transformation', () => {
    test('should transform children for non-sandbox components', () => {
      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: 'div',
        props: {
          children: [
            {
              __rillTypeMarker: '__rill_react_element__',
              type: 'span',
              props: { children: 'text' },
            },
          ],
        },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      const children = // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
        (result as any).props.children;
      expect(Array.isArray(children)).toBe(true);
    });

    test('should preserve children for sandbox components', () => {
      const Component = () => null;

      const element = {
        __rillTypeMarker: '__rill_react_element__',
        type: Component,
        props: {
          children: {
            __rillTypeMarker: '__rill_react_element__',
            type: 'div',
            props: {},
          },
        },
      };

      const result = transformGuestElement(element as never);

      expect(result).toBeDefined();
      const children = // biome-ignore lint/suspicious/noExplicitAny: Test needs to access React element properties
        (result as any).props.children;
      expect(children).toBeDefined();
    });
  });

  describe('edge cases', () => {
    test('should handle rapid register/unregister cycles', () => {
      for (let i = 0; i < 100; i++) {
        const Component = () => null;
        registerComponentType(Component, `owner-${i}`);
        unregisterComponentTypes(`owner-${i}`);
      }

      expect(true).toBe(true); // Should not crash
    });

    test('should handle concurrent registrations', () => {
      const components = Array.from({ length: 50 }, () => () => null);
      const ids = components.map((comp, idx) => registerComponentType(comp, `owner-${idx}`));

      // All IDs should be unique
      const uniqueIds = new Set(ids.filter((id) => id !== null));
      expect(uniqueIds.size).toBe(50);

      // Cleanup
      for (let i = 0; i < 50; i++) {
        unregisterComponentTypes(`owner-${i}`);
      }
    });

    test('should handle transform with circular references in debug mode', () => {
      const globalState = globalThis as Record<string, unknown>;
      const originalDebug = globalState.__RILL_RECONCILER_DEBUG__;

      try {
        globalState.__RILL_RECONCILER_DEBUG__ = true;
        globalState.__TRANSFORM_LOG_COUNT = 0;

        const circular: Record<string, unknown> = {
          $$typeof: Symbol.for('react.element'),
          type: 'div',
          __rillTypeMarker: 'string',
        };
        circular.props = { self: circular };

        // Should handle gracefully even with circular ref
        expect(() => {
          transformGuestElement(circular as never);
        }).not.toThrow();
      } finally {
        globalState.__RILL_RECONCILER_DEBUG__ = originalDebug;
      }
    });
  });
});
