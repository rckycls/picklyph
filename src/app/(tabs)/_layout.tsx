import { Tabs } from 'expo-router';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TabIcon } from '@/components/ui/TabIcon';
import { colors } from '@/theme/colors';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();

  return (
    <Tabs
      initialRouteName="index"
      backBehavior="initialRoute"
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.selectedText,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarActiveBackgroundColor: colors.selectedBackground,
        tabBarHideOnKeyboard: true,
        tabBarLabelPosition: 'below-icon',
        tabBarLabelStyle: styles.label,
        tabBarItemStyle: styles.item,
        tabBarStyle: [styles.bar, { minHeight: Math.max(68, 48 + 20 * fontScale) + insets.bottom }],
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Discover',
          tabBarAccessibilityLabel: 'Discover courts',
          tabBarIcon: ({ color }) => <TabIcon name="discover" color={color} />,
        }}
      />
      <Tabs.Screen
        name="bookings"
        options={{
          title: 'Bookings',
          tabBarAccessibilityLabel: 'Your bookings',
          tabBarIcon: ({ color }) => <TabIcon name="bookings" color={color} />,
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarAccessibilityLabel: 'Your account',
          tabBarIcon: ({ color }) => <TabIcon name="account" color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.surface, borderTopColor: colors.border, borderTopWidth: 1, paddingTop: 6 },
  item: { marginHorizontal: 6, borderRadius: 14, paddingVertical: 5, minHeight: 54 },
  label: { fontSize: 12, fontWeight: '600', marginTop: 3 },
});
