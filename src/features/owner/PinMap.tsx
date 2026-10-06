import { StyleSheet, Text, View } from 'react-native';

import { screenText } from '@/components/ui/Screen';
import type { MapRegion } from '@/features/discovery/mapTypes';
import { colors } from '@/theme/colors';

import type { Pin } from './ownerForm';

export type PinMapProps = { pin: Pin | null; focus: MapRegion; onPinChange: (pin: Pin) => void };

/** Browser fallback. Metro selects PinMap.native.tsx for an iPhone build. */
export default function PinMap(_props: PinMapProps) {
  return (
    <View style={styles.placeholder}>
      <Text style={screenText.body}>Pin placement uses the PicklyPH iPhone build. Search an address or use your location to place the pin.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { height: 160, justifyContent: 'center', padding: 20, borderRadius: 18, backgroundColor: colors.selectedBackground },
});
