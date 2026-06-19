import { useEffect } from 'react';
import { Text, TouchableOpacity, View } from 'rill/guest';
import { track } from 'host:analytics';
import { openProfile } from 'host:navigation';
import { onThemeChanged } from 'host:theme';

export async function refresh(input: { reason: string }) {
  await track({ name: 'guest_refresh', props: { reason: input.reason } });
}

export default function HostModulesGuest() {
  useEffect(() => {
    const unsubscribe = onThemeChanged(({ theme }) => {
      console.log('theme changed', theme);
    });

    return unsubscribe;
  }, []);

  return (
    <View>
      <Text>Host modules guest</Text>
      <TouchableOpacity
        onPress={async () => {
          await track({ name: 'profile_opened' });
          await openProfile({ userId: '42' });
        }}
      >
        <Text>Open profile</Text>
      </TouchableOpacity>
    </View>
  );
}
