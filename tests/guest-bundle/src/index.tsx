/**
 * Example Guest
 *
 * Basic usage examples for the Rill SDK.
 */

import { useState } from 'react';
import {
  ScrollView,
  Text,
  TouchableOpacity,
  useConfig,
  useHostEvent,
  useSendToHost,
  View,
} from 'rill/guest';

interface Config {
  title?: string;
  theme?: 'light' | 'dark';
}

/** Counter component */
function Counter() {
  const [count, setCount] = useState(0);
  const sendToHost = useSendToHost();

  const handleIncrement = () => {
    const newCount = count + 1;
    setCount(newCount);
    sendToHost('COUNTER_CHANGED', { count: newCount });
  };

  const handleDecrement = () => {
    const newCount = count - 1;
    setCount(newCount);
    sendToHost('COUNTER_CHANGED', { count: newCount });
  };

  return (
    <View style={{ alignItems: 'center', padding: 20 }}>
      <Text style={{ fontSize: 48, fontWeight: 'bold' }}>{count}</Text>
      <View style={{ flexDirection: 'row', marginTop: 20 }}>
        <TouchableOpacity
          style={{
            backgroundColor: '#FF3B30',
            paddingHorizontal: 24,
            paddingVertical: 12,
            borderRadius: 8,
            marginRight: 12,
          }}
          onPress={handleDecrement}
        >
          <Text style={{ color: 'white', fontSize: 20 }}>-</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={{
            backgroundColor: '#34C759',
            paddingHorizontal: 24,
            paddingVertical: 12,
            borderRadius: 8,
          }}
          onPress={handleIncrement}
        >
          <Text style={{ color: 'white', fontSize: 20 }}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** List item component */
function ListItem({ title, index }: { title: string; index: number }) {
  return (
    <TouchableOpacity
      style={{
        backgroundColor: 'white',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#E5E5EA',
      }}
      onPress={() => console.log(`Pressed item ${index}`)}
    >
      <Text style={{ fontSize: 16 }}>{title}</Text>
    </TouchableOpacity>
  );
}

/**
 * Main guest component
 */
export default function Guest() {
  const config = useConfig<Config>();
  const [refreshCount, setRefreshCount] = useState(0);

  // Listen for host refresh events.
  useHostEvent('REFRESH', () => {
    console.log('Host requested refresh');
    setRefreshCount((c) => c + 1);
  });

  // Listen for host theme updates.
  useHostEvent<{ theme: 'light' | 'dark' }>('THEME_CHANGE', (payload) => {
    console.log('Theme changed to:', payload.theme);
  });

  const isDark = config.theme === 'dark';
  const backgroundColor = isDark ? '#1C1C1E' : '#F2F2F7';
  const textColor = isDark ? '#FFFFFF' : '#000000';

  return (
    <ScrollView style={{ flex: 1, backgroundColor }} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Header */}
      <View
        style={{
          padding: 20,
          backgroundColor: isDark ? '#2C2C2E' : '#FFFFFF',
          borderBottomWidth: 1,
          borderBottomColor: isDark ? '#38383A' : '#E5E5EA',
        }}
      >
        <Text
          style={{
            fontSize: 28,
            fontWeight: 'bold',
            color: textColor,
          }}
        >
          {config.title || 'Rill Guest'}
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: isDark ? '#8E8E93' : '#6C6C70',
            marginTop: 4,
          }}
        >
          Refresh count: {refreshCount}
        </Text>
      </View>

      {/* Counter Section */}
      <View style={{ marginTop: 20 }}>
        <Text
          style={{
            fontSize: 13,
            color: isDark ? '#8E8E93' : '#6C6C70',
            paddingHorizontal: 20,
            marginBottom: 8,
          }}
        >
          COUNTER
        </Text>
        <View style={{ backgroundColor: isDark ? '#2C2C2E' : '#FFFFFF' }}>
          <Counter />
        </View>
      </View>

      {/* List Section */}
      <View style={{ marginTop: 20 }}>
        <Text
          style={{
            fontSize: 13,
            color: isDark ? '#8E8E93' : '#6C6C70',
            paddingHorizontal: 20,
            marginBottom: 8,
          }}
        >
          ITEMS
        </Text>
        <View style={{ backgroundColor: isDark ? '#2C2C2E' : '#FFFFFF' }}>
          {['First Item', 'Second Item', 'Third Item', 'Fourth Item'].map((item, index) => (
            <ListItem key={index} title={item} index={index} />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
