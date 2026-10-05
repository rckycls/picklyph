import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';

import { Button } from '@/components/ui/Button';
import { screenText } from '@/components/ui/Screen';
import { colors } from '@/theme/colors';

import { PHILIPPINES_REGION } from './demoVenues';
import type { CourtMapProps } from './mapTypes';

export default function CourtMap({ venues, selectedId, focusRegion, showUserLocation, onSelect, onReadyChange }: CourtMapProps) {
  const map = useRef<MapView>(null);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mapsConfigured = Constants.expoConfig?.extra?.maps?.iosGoogleMapsConfigured === true;
  const setupMessage = Platform.OS !== 'ios'
    ? 'This court map preview is set up for iPhone.'
    : Constants.executionEnvironment === ExecutionEnvironment.StoreClient
      ? 'Open your PicklyPH development build to use the Google court map.'
      : !mapsConfigured ? 'Finish the iPhone Maps configuration, then rebuild PicklyPH.' : null;

  useEffect(() => {
    if (setupMessage || ready) return;
    const timer = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(timer);
  }, [setupMessage, ready, attempt]);

  useEffect(() => {
    onReadyChange(ready && !setupMessage);
    return () => onReadyChange(false);
  }, [ready, setupMessage, onReadyChange]);

  useEffect(() => {
    if (ready && !setupMessage) map.current?.animateToRegion(focusRegion, 450);
  }, [focusRegion, ready, setupMessage]);

  if (setupMessage) {
    return (
      <View style={styles.placeholder}>
        <Text accessibilityRole="header" style={screenText.title}>Your court map is next.</Text>
        <Text style={screenText.body}>{__DEV__ ? setupMessage : 'The court map is unavailable on this device.'}</Text>
        {venues.length > 0 && <Text style={screenText.body}>You can still explore the labeled sample locations below.</Text>}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        key={attempt}
        ref={map}
        provider={PROVIDER_GOOGLE}
        initialRegion={PHILIPPINES_REGION}
        style={StyleSheet.absoluteFill}
        accessibilityLabel="Google court map. Sample locations are also available in the list below."
        onMapReady={() => { setReady(true); setSlow(false); }}
        showsUserLocation={showUserLocation}
        showsMyLocationButton={false}
        showsCompass
        showsPointsOfInterests={false}
        toolbarEnabled={false}
        moveOnMarkerPress={false}
      >
        {venues.map((venue) => (
          <Marker
            key={venue.id}
            identifier={venue.id}
            coordinate={venue.coordinates}
            title={venue.name}
            description="Sample location only. Not a verified court."
            accessibilityLabel={`${venue.name}. Sample location, not bookable.`}
            pinColor={venue.id === selectedId ? colors.mapSelectedPin : colors.mapCourtPin}
            onPress={() => onSelect(venue)}
          />
        ))}
      </MapView>
      {!ready && (
        <View style={styles.loading}>
          {slow ? (
            <>
              <Text style={screenText.body}>The map is taking longer to load. Check your connection and try again.</Text>
              <Button label="Retry map" onPress={() => { setReady(false); setSlow(false); setAttempt((value) => value + 1); }} />
            </>
          ) : (
            <><ActivityIndicator color={colors.primary} /><Text style={screenText.body}>Loading court map…</Text></>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.selectedBackground },
  placeholder: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: colors.selectedBackground },
  loading: { position: 'absolute', top: 18, left: 18, right: 18, borderRadius: 18, backgroundColor: colors.surface, padding: 16, gap: 12, alignItems: 'center' },
});
