import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';

import { screenText } from '@/components/ui/Screen';
import type { MapRegion } from '@/features/discovery/mapTypes';
import { PHILIPPINES_REGION } from '@/features/discovery/region';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import type { Pin } from './ownerForm';

export type PinMapProps = { pin: Pin | null; focus: MapRegion; onPinChange: (pin: Pin) => void };

/** Tap to drop the venue pin, then drag it onto the courts. Address search and location are the non-visual alternatives. */
export default function PinMap({ pin, focus, onPinChange }: PinMapProps) {
  const map = useRef<MapView>(null);
  const [ready, setReady] = useState(false);
  const available = Platform.OS === 'ios' && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient
    && Constants.expoConfig?.extra?.maps?.iosGoogleMapsConfigured === true;

  useEffect(() => {
    if (ready) map.current?.animateToRegion(focus, 400);
  }, [focus, ready]);

  if (!available) {
    return (
      <View style={[styles.frame, styles.placeholder]}>
        <Text style={screenText.body}>The map isn’t available on this device. Search an address or use your location to place the pin.</Text>
      </View>
    );
  }
  return (
    <View style={styles.frame}>
      <MapView
        ref={map}
        provider={PROVIDER_GOOGLE}
        initialRegion={PHILIPPINES_REGION}
        style={StyleSheet.absoluteFill}
        accessibilityLabel="Map for placing your venue pin. You can also search an address or use your location."
        onMapReady={() => setReady(true)}
        onPress={(event) => onPinChange(event.nativeEvent.coordinate)}
        showsPointsOfInterests={false}
        toolbarEnabled={false}
      >
        {pin && (
          <Marker
            coordinate={pin}
            draggable
            onDragEnd={(event) => onPinChange(event.nativeEvent.coordinate)}
            image={require('../../../assets/brand/court-pin-selected.png')}
            anchor={{ x: 0.5, y: 1 }}
            accessibilityLabel="Your venue pin. Drag it onto the courts."
          />
        )}
      </MapView>
      {!pin && ready && (
        <View pointerEvents="none" style={styles.hint}>
          <Text style={styles.hintText}>Tap the map where the courts are</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: 300, borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.selectedBackground },
  placeholder: { justifyContent: 'center', padding: 20 },
  hint: { position: 'absolute', top: 12, left: 12, right: 12, borderRadius: 12, backgroundColor: colors.surface, padding: 10 },
  hintText: { fontFamily: fonts.semibold, color: colors.text, fontSize: 14, textAlign: 'center' },
});
