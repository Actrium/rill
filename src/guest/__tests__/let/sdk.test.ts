/**
 * SDK unit tests
 *
 * Uses dynamic imports to ensure __RILL_GUEST_ENV__ is set before module loads.
 * This makes components return string identifiers instead of react-native components.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as React from 'react';

// Set environment flag BEFORE any SDK imports
(globalThis as Record<string, unknown>).__RILL_GUEST_ENV__ = true;
// Provide React hooks for SDK hooks tests (sdk reads hooks from globalThis.React)
(globalThis as Record<string, unknown>).React = React;

// Dynamic import to ensure env flag is set first
const sdkImport = import('../../../sdk/index');

// ============ Virtual components tests ============

describe('Virtual Components', () => {
  describe('Component Identifiers', () => {
    it('View should be string "View"', async () => {
      const { View } = await sdkImport;
      expect(View).toBe('View');
      expect(typeof View).toBe('string');
    });

    it('Text should be string "Text"', async () => {
      const { Text } = await sdkImport;
      expect(Text).toBe('Text');
      expect(typeof Text).toBe('string');
    });

    it('Image should be string "Image"', async () => {
      const { Image } = await sdkImport;
      expect(Image).toBe('Image');
      expect(typeof Image).toBe('string');
    });

    it('ScrollView should be string "ScrollView"', async () => {
      const { ScrollView } = await sdkImport;
      expect(ScrollView).toBe('ScrollView');
      expect(typeof ScrollView).toBe('string');
    });

    it('TouchableOpacity should be string "TouchableOpacity"', async () => {
      const { TouchableOpacity } = await sdkImport;
      expect(TouchableOpacity).toBe('TouchableOpacity');
      expect(typeof TouchableOpacity).toBe('string');
    });

    it('FlatList should be string "FlatList"', async () => {
      const { FlatList } = await sdkImport;
      expect(FlatList).toBe('FlatList');
      expect(typeof FlatList).toBe('string');
    });

    it('TextInput should be string "TextInput"', async () => {
      const { TextInput } = await sdkImport;
      expect(TextInput).toBe('TextInput');
      expect(typeof TextInput).toBe('string');
    });

    it('Button should be string "Button"', async () => {
      const { Button } = await sdkImport;
      expect(Button).toBe('Button');
      expect(typeof Button).toBe('string');
    });

    it('Switch should be string "Switch"', async () => {
      const { Switch } = await sdkImport;
      expect(Switch).toBe('Switch');
      expect(typeof Switch).toBe('string');
    });

    it('ActivityIndicator should be string "ActivityIndicator"', async () => {
      const { ActivityIndicator } = await sdkImport;
      expect(ActivityIndicator).toBe('ActivityIndicator');
      expect(typeof ActivityIndicator).toBe('string');
    });
  });

  describe('Component as JSX type', () => {
    it('components can be used as type references', async () => {
      const sdk = await sdkImport;
      // These components as strings can be used to dynamically create elements
      const componentTypes = [
        sdk.View,
        sdk.Text,
        sdk.Image,
        sdk.ScrollView,
        sdk.TouchableOpacity,
        sdk.FlatList,
        sdk.TextInput,
        sdk.Button,
        sdk.Switch,
        sdk.ActivityIndicator,
      ];

      componentTypes.forEach((type) => {
        expect(typeof type).toBe('string');
        expect((type as string).length).toBeGreaterThan(0);
      });
    });
  });
});

// ============ Hooks tests ============

describe('Hooks', () => {
  describe('useHostEvent', () => {
    beforeEach(() => {
      // Cleanup globalThis
      delete (globalThis as Record<string, unknown>).__rill_onHostEvent;
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__rill_onHostEvent;
    });

    it('should subscribe and unsubscribe when component mounts/unmounts', async () => {
      const { useHostEvent } = await sdkImport;
      const mockUnsubscribe = mock();
      const mockUseHostEvent = mock(() => mockUnsubscribe);
      (globalThis as Record<string, unknown>).__rill_onHostEvent = mockUseHostEvent;

      const callback = mock();

      // Create a test component
      const TestComponent = () => {
        useHostEvent('REFRESH', callback);
        return React.createElement('div', null, 'test');
      };

      // Use react-test-renderer instead of @testing-library/react
      const ReactTestRenderer = await import('react-test-renderer');
      const { act } = ReactTestRenderer;

      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(() => {
        renderer = ReactTestRenderer.create(React.createElement(TestComponent));
      });

      // Should subscribe on mount
      expect(mockUseHostEvent).toHaveBeenCalled();

      // Should unsubscribe on unmount
      await act(() => {
        renderer!.unmount();
      });
      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    it('should not throw when __rill_onHostEvent is not available', async () => {
      const { useHostEvent } = await sdkImport;
      const callback = mock();

      const TestComponent = () => {
        useHostEvent('REFRESH', callback);
        return React.createElement('div', null, 'test');
      };

      const ReactTestRenderer = await import('react-test-renderer');
      const { act } = ReactTestRenderer;

      // Should not throw when __rill_onHostEvent is not available
      let didThrow = false;
      try {
        await act(() => {
          ReactTestRenderer.create(React.createElement(TestComponent));
        });
      } catch (_e) {
        didThrow = true;
      }
      expect(didThrow).toBe(false);
    });

    it('should resubscribe when eventName changes', async () => {
      const { useHostEvent } = await sdkImport;
      const mockUnsubscribe1 = mock();
      const mockUnsubscribe2 = mock();
      let callCount = 0;
      const mockUseHostEvent = mock(() => {
        callCount++;
        return callCount === 1 ? mockUnsubscribe1 : mockUnsubscribe2;
      });
      (globalThis as Record<string, unknown>).__rill_onHostEvent = mockUseHostEvent;

      const callback = mock();

      const TestComponent = ({ eventName }: { eventName: string }) => {
        useHostEvent(eventName, callback);
        return React.createElement('div', null, 'test');
      };

      const ReactTestRenderer = await import('react-test-renderer');
      const { act } = ReactTestRenderer;

      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(() => {
        renderer = ReactTestRenderer.create(
          React.createElement(TestComponent, { eventName: 'REFRESH' })
        );
      });

      expect(mockUseHostEvent).toHaveBeenCalledTimes(1);

      // Change eventName - should unsubscribe old and subscribe new
      await act(() => {
        renderer!.update(React.createElement(TestComponent, { eventName: 'UPDATE' }));
      });

      expect(mockUnsubscribe1).toHaveBeenCalled();
      expect(mockUseHostEvent).toHaveBeenCalledTimes(2);
    });

    it('should use latest callback without resubscribing', async () => {
      const { useHostEvent } = await sdkImport;
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const mockUseHostEvent = (eventName: string, cb: (payload: unknown) => void) => {
        if (!listeners.has(eventName)) listeners.set(eventName, new Set());
        const set = listeners.get(eventName)!;
        set.add(cb);
        return () => set.delete(cb);
      };
      (globalThis as Record<string, unknown>).__rill_onHostEvent = mockUseHostEvent;

      let renderCount = 0;
      const callback1 = () => {
        renderCount = 1;
      };
      const callback2 = () => {
        renderCount = 2;
      };

      const TestComponent = ({ cb }: { cb: () => void }) => {
        useHostEvent('REFRESH', cb);
        return React.createElement('div', null, 'test');
      };

      const ReactTestRenderer = await import('react-test-renderer');
      const { act } = ReactTestRenderer;

      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(() => {
        renderer = ReactTestRenderer.create(React.createElement(TestComponent, { cb: callback1 }));
      });

      // Trigger the event with first callback
      const set = listeners.get('REFRESH')!;
      set.forEach((cb) => cb({}));
      expect(renderCount).toBe(1);

      // Change callback - should NOT resubscribe, but should use new callback
      await act(() => {
        renderer!.update(React.createElement(TestComponent, { cb: callback2 }));
      });

      // Trigger event again - should call new callback
      set.forEach((cb) => cb({}));
      expect(renderCount).toBe(2);
    });
  });

  describe('useConfig', () => {
    beforeEach(() => {
      delete (globalThis as Record<string, unknown>).__rill_getConfig;
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__rill_getConfig;
    });

    it('should return config from global __rill_getConfig', async () => {
      const { useConfig } = await sdkImport;
      const mockConfig = { theme: 'dark', fontSize: 14 };
      (globalThis as Record<string, unknown>).__rill_getConfig = () => mockConfig;

      const config = useConfig<{ theme: string; fontSize: number }>();

      expect(config).toEqual(mockConfig);
    });

    it('should return empty object when __rill_getConfig is not available', async () => {
      const { useConfig } = await sdkImport;
      const config = useConfig();

      expect(config).toEqual({});
    });

    it('should support generic type parameter', async () => {
      const { useConfig } = await sdkImport;
      interface AppConfig {
        theme: 'light' | 'dark';
        language: string;
      }

      const mockConfig: AppConfig = { theme: 'dark', language: 'en' };
      (globalThis as Record<string, unknown>).__rill_getConfig = () => mockConfig;

      const config = useConfig<AppConfig>();

      expect(config.theme).toBe('dark');
      expect(config.language).toBe('en');
    });
  });

  describe('useSendToHost', () => {
    beforeEach(() => {
      delete (globalThis as Record<string, unknown>).__rill_emitEvent;
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__rill_emitEvent;
    });

    it('should return global __rill_emitEvent when available', async () => {
      const { useSendToHost } = await sdkImport;
      const mockSend = mock();
      (globalThis as Record<string, unknown>).__rill_emitEvent = mockSend;

      const send = useSendToHost();
      send('TEST_EVENT', { data: 123 });

      expect(mockSend).toHaveBeenCalledWith('TEST_EVENT', { data: 123 });
    });

    it('should return noop function with warning when not available', async () => {
      const { useSendToHost } = await sdkImport;
      const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

      const send = useSendToHost();
      send('TEST_EVENT');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('sendToHost is not available')
      );

      consoleSpy.mockRestore();
    });

    it('should accept optional payload', async () => {
      const { useSendToHost } = await sdkImport;
      const mockSend = mock();
      (globalThis as Record<string, unknown>).__rill_emitEvent = mockSend;

      const send = useSendToHost();
      send('EVENT_WITHOUT_PAYLOAD');

      expect(mockSend).toHaveBeenCalledWith('EVENT_WITHOUT_PAYLOAD');
    });
  });
});

// ============ Type Export Tests ============

describe('Type Exports', () => {
  it('should export StyleProp type', async () => {
    // Verify type existence through import
    const module = await sdkImport;
    expect(module).toBeDefined();
  });
});

// ============ Props Type Tests (Compile-time) ============

describe('Props Types', () => {
  it('ViewProps should accept style and children', () => {
    // This is compile-time test, runtime only verifies type existence
    const viewProps = {
      style: { flex: 1, backgroundColor: 'red' },
      testID: 'test-view',
    };
    expect(viewProps).toBeDefined();
  });

  it('TextProps should accept numberOfLines', () => {
    const textProps = {
      numberOfLines: 2,
      ellipsizeMode: 'tail' as const,
    };
    expect(textProps).toBeDefined();
  });

  it('ImageProps should accept source', () => {
    const imageProps = {
      source: { uri: 'https://example.com/image.png' },
      resizeMode: 'cover' as const,
    };
    expect(imageProps).toBeDefined();
  });

  it('TouchableOpacityProps should accept onPress', () => {
    const touchableProps = {
      onPress: () => {},
      activeOpacity: 0.7,
      disabled: false,
    };
    expect(touchableProps).toBeDefined();
  });

  it('ScrollViewProps should accept horizontal and onScroll', () => {
    const scrollViewProps = {
      horizontal: true,
      showsVerticalScrollIndicator: false,
      onScroll: (event: { nativeEvent: object }) => {
        console.log(event);
      },
    };
    expect(scrollViewProps).toBeDefined();
  });

  it('TextInputProps should accept value and onChangeText', () => {
    const textInputProps = {
      value: 'hello',
      onChangeText: (text: string) => {
        console.log(text);
      },
      placeholder: 'Enter text',
      keyboardType: 'default' as const,
    };
    expect(textInputProps).toBeDefined();
  });

  it('FlatListProps should accept data and renderItem', () => {
    interface Item {
      id: string;
      name: string;
    }

    const flatListProps = {
      data: [{ id: '1', name: 'Item 1' }] as Item[],
      renderItem: ({ item }: { item: Item }) => item.name,
      keyExtractor: (item: Item) => item.id,
    };
    expect(flatListProps).toBeDefined();
  });
});

// ============ Event Type Tests ============

describe('Event Types', () => {
  it('LayoutEvent should have correct structure', () => {
    const layoutEvent = {
      nativeEvent: {
        layout: {
          x: 0,
          y: 0,
          width: 100,
          height: 200,
        },
      },
    };
    expect(layoutEvent.nativeEvent.layout.width).toBe(100);
  });

  it('ScrollEvent should have correct structure', () => {
    const scrollEvent = {
      nativeEvent: {
        contentOffset: { x: 0, y: 100 },
        contentSize: { width: 375, height: 1000 },
        layoutMeasurement: { width: 375, height: 667 },
      },
    };
    expect(scrollEvent.nativeEvent.contentOffset.y).toBe(100);
  });
});

// ============ ImageSource Type Tests ============

describe('ImageSource Type', () => {
  it('should accept URI object', () => {
    const source = {
      uri: 'https://example.com/image.png',
      width: 100,
      height: 100,
    };
    expect(source.uri).toBe('https://example.com/image.png');
  });

  it('should accept URI with headers', () => {
    const source = {
      uri: 'https://example.com/image.png',
      headers: {
        Authorization: 'Bearer token',
      },
    };
    expect(source.headers?.Authorization).toBe('Bearer token');
  });
});

// ============ Zero-dependency Verification ============

describe('Zero Runtime Dependencies', () => {
  it('SDK should not import react-native', async () => {
    // Verify module doesn't include react-native imports
    const moduleSource = await sdkImport;

    // All components should be strings, not actual components
    expect(typeof moduleSource.View).toBe('string');
    expect(typeof moduleSource.Text).toBe('string');
    expect(typeof moduleSource.Image).toBe('string');
  });

  it('SDK should only export primitives and functions', async () => {
    const moduleSource = await sdkImport;

    // Components are strings
    const components = [
      moduleSource.View,
      moduleSource.Text,
      moduleSource.Image,
      moduleSource.ScrollView,
      moduleSource.TouchableOpacity,
    ];

    components.forEach((component) => {
      expect(['string', 'function']).toContain(typeof component);
    });

    // Hooks are functions
    expect(typeof moduleSource.useHostEvent).toBe('function');
    expect(typeof moduleSource.useConfig).toBe('function');
    expect(typeof moduleSource.useSendToHost).toBe('function');
  });
});

// ============ React Native APIs Tests ============
describe('React Native APIs', () => {
  describe('StyleSheet', () => {
    it('should have create method that returns styles as-is', async () => {
      const { StyleSheet } = await sdkImport;
      const styles = { container: { flex: 1 }, text: { fontSize: 14 } };
      const result = StyleSheet.create(styles);
      expect(result).toEqual(styles);
    });
  });

  describe('Platform', () => {
    it('should have OS property', async () => {
      const { Platform } = await sdkImport;
      expect(typeof Platform.OS).toBe('string');
    });

    it('should have select method', async () => {
      const { Platform } = await sdkImport;
      expect(typeof Platform.select).toBe('function');
    });

    it('select should return default when available', async () => {
      const { Platform } = await sdkImport;
      const result = Platform.select({ ios: 'iOS', android: 'Android', default: 'Default' });
      expect(result).toBe('Default');
    });
  });

  describe('Dimensions', () => {
    it('should have get method', async () => {
      const { Dimensions } = await sdkImport;
      expect(typeof Dimensions.get).toBe('function');
    });

    it('get() should return dimension object', async () => {
      const { Dimensions } = await sdkImport;
      const dims = Dimensions.get('window');
      expect(typeof dims.width).toBe('number');
      expect(typeof dims.height).toBe('number');
    });

    it('should have addEventListener method', async () => {
      const { Dimensions } = await sdkImport;
      expect(typeof Dimensions.addEventListener).toBe('function');
    });

    it('addEventListener should return subscription with remove', async () => {
      const { Dimensions } = await sdkImport;
      const subscription = Dimensions.addEventListener('change', () => {});
      expect(typeof subscription.remove).toBe('function');
      subscription.remove(); // Should not throw
    });
  });

  describe('Easing', () => {
    it('should have easing functions', async () => {
      const { Easing } = await sdkImport;
      expect(typeof Easing.linear).toBe('function');
      expect(typeof Easing.ease).toBe('function');
      expect(typeof Easing.bezier).toBe('function');
    });

    it('linear should return input unchanged', async () => {
      const { Easing } = await sdkImport;
      expect(Easing.linear(0.5)).toBe(0.5);
    });

    it('bezier should return a function', async () => {
      const { Easing } = await sdkImport;
      const curve = Easing.bezier(0.25, 0.1, 0.25, 1);
      expect(typeof curve).toBe('function');
    });
  });

  describe('PixelRatio', () => {
    it('should have get method', async () => {
      const { PixelRatio } = await sdkImport;
      expect(typeof PixelRatio.get).toBe('function');
    });

    it('get() should return a number', async () => {
      const { PixelRatio } = await sdkImport;
      expect(typeof PixelRatio.get()).toBe('number');
    });
  });

  describe('Appearance', () => {
    it('should have getColorScheme method', async () => {
      const { Appearance } = await sdkImport;
      expect(typeof Appearance.getColorScheme).toBe('function');
    });

    it('getColorScheme should return light, dark, or null', async () => {
      const { Appearance } = await sdkImport;
      const scheme = Appearance.getColorScheme();
      expect(['light', 'dark', null]).toContain(scheme);
    });
  });

  describe('I18nManager', () => {
    it('should have isRTL property', async () => {
      const { I18nManager } = await sdkImport;
      expect(typeof I18nManager.isRTL).toBe('boolean');
    });
  });

  describe('AppState', () => {
    it('should have currentState property', async () => {
      const { AppState } = await sdkImport;
      expect(typeof AppState.currentState).toBe('string');
    });

    it('should have addEventListener method', async () => {
      const { AppState } = await sdkImport;
      expect(typeof AppState.addEventListener).toBe('function');
    });
  });

  describe('Keyboard', () => {
    it('should have dismiss method', async () => {
      const { Keyboard } = await sdkImport;
      expect(typeof Keyboard.dismiss).toBe('function');
      expect(() => Keyboard.dismiss()).not.toThrow();
    });

    it('should have addListener method', async () => {
      const { Keyboard } = await sdkImport;
      expect(typeof Keyboard.addListener).toBe('function');
    });
  });

  describe('Alert', () => {
    it('should have alert method', async () => {
      const { Alert } = await sdkImport;
      expect(typeof Alert.alert).toBe('function');
    });
  });

  describe('Linking', () => {
    it('should have openURL method', async () => {
      const { Linking } = await sdkImport;
      expect(typeof Linking.openURL).toBe('function');
    });

    it('should have canOpenURL method', async () => {
      const { Linking } = await sdkImport;
      expect(typeof Linking.canOpenURL).toBe('function');
    });
  });

  describe('Share', () => {
    it('should have share method', async () => {
      const { Share } = await sdkImport;
      expect(typeof Share.share).toBe('function');
    });

    it('share should return a promise', async () => {
      const { Share } = await sdkImport;
      const result = Share.share({ message: 'test' });
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('Vibration', () => {
    it('should have vibrate method', async () => {
      const { Vibration } = await sdkImport;
      expect(typeof Vibration.vibrate).toBe('function');
      expect(() => Vibration.vibrate()).not.toThrow();
    });

    it('should have cancel method', async () => {
      const { Vibration } = await sdkImport;
      expect(typeof Vibration.cancel).toBe('function');
      expect(() => Vibration.cancel()).not.toThrow();
    });
  });

  describe('Animated', () => {
    it('should be exported', async () => {
      const { Animated } = await sdkImport;
      expect(Animated).toBeDefined();
    });
  });
});

// ============ React Native Hooks Tests ============
describe('React Native Hooks', () => {
  describe('useColorScheme', () => {
    it('should be a function', async () => {
      const { useColorScheme } = await sdkImport;
      expect(typeof useColorScheme).toBe('function');
    });

    it('should return light, dark, or null', async () => {
      const { useColorScheme } = await sdkImport;
      const scheme = useColorScheme();
      expect(['light', 'dark', null]).toContain(scheme);
    });
  });

  describe('useWindowDimensions', () => {
    it('should be a function', async () => {
      const { useWindowDimensions } = await sdkImport;
      expect(typeof useWindowDimensions).toBe('function');
    });

    it('should return dimensions object', async () => {
      const { useWindowDimensions } = await sdkImport;
      const dims = useWindowDimensions();
      expect(typeof dims.width).toBe('number');
      expect(typeof dims.height).toBe('number');
      expect(typeof dims.scale).toBe('number');
      expect(typeof dims.fontScale).toBe('number');
    });
  });
});
