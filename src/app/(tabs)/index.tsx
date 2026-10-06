import { useCallback, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/Button';
import { BrandLockup } from '@/components/ui/BrandLockup';
import { StatusBadge } from '@/components/ui/StatusBadge';
import CourtMap from '@/features/discovery/CourtMap';
import { getDemoVenues, PHILIPPINES_REGION, type DemoVenue } from '@/features/discovery/demoVenues';
import type { MapRegion } from '@/features/discovery/mapTypes';
import { useDeviceLocation } from '@/features/discovery/useDeviceLocation';
import { VenueSheet } from '@/features/discovery/VenueSheet';
import type { LocationResult } from '@/lib/location';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

const venues = getDemoVenues(__DEV__);

export default function DiscoverScreen() {
  const [selected, setSelected] = useState<DemoVenue | null>(null);
  const [focusRegion, setFocusRegion] = useState<MapRegion>(PHILIPPINES_REGION);
  const [mapReady, setMapReady] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const applyLocation = useCallback((result: LocationResult) => {
    setSelected(null);
    setFocusRegion(result.status === 'granted'
      ? { ...result.coordinates, latitudeDelta: 0.08, longitudeDelta: 0.08 }
      : { ...PHILIPPINES_REGION });
  }, []);
  const { location, request } = useDeviceLocation(applyLocation);
  const settingsNeeded = location.status === 'disabled' || (location.status === 'denied' && !location.canAskAgain);

  const selectVenue = (venue: DemoVenue) => {
    setSelected(venue);
    setFocusRegion({ ...venue.coordinates, latitudeDelta: 0.04, longitudeDelta: 0.04 });
  };

  const message = settingsError ? 'Couldn’t open Settings. You can keep browsing the Philippines.'
    : location.status === 'denied' ? 'Location access is off. You can still explore the Philippines.'
      : location.status === 'disabled' ? 'Location services are off. You can still browse the map.'
        : location.status === 'unavailable' ? 'Couldn’t find your location. Try again or explore the Philippines.'
          : location.status === 'requesting' ? 'Finding your location…'
            : location.status === 'granted' ? 'Location enabled. Move the map to explore.'
              : 'Explore the Philippines. Location access is optional.';

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <BrandLockup tagline />
          <StatusBadge label={__DEV__ ? 'Demo map' : 'Philippines'} tone={__DEV__ ? 'pending' : 'neutral'} />
        </View>
        <View style={styles.actions}>
          <Button
            label={settingsNeeded ? 'Open settings' : 'Use my location'}
            variant="accent"
            style={styles.action}
            disabled={!mapReady}
            loading={location.status === 'requesting'}
            accessibilityHint={mapReady ? 'Location is optional. You can explore without sharing it.' : 'Available when the Google map is ready.'}
            onPress={() => {
              setSettingsError(false);
              if (settingsNeeded) void Linking.openSettings().catch(() => setSettingsError(true));
              else void request();
            }}
          />
          <Button label="View Philippines" variant="secondary" style={styles.action} disabled={!mapReady} onPress={() => {
            setSelected(null);
            setFocusRegion({ ...PHILIPPINES_REGION });
          }} />
        </View>
        <Text accessibilityLiveRegion="polite" style={styles.note}>{message}</Text>
      </View>
      <View style={styles.map}>
        <CourtMap
          venues={venues}
          selectedId={selected?.id}
          focusRegion={focusRegion}
          showUserLocation={location.status === 'granted'}
          onSelect={selectVenue}
          onReadyChange={setMapReady}
        />
      </View>
      {selected ? <VenueSheet venue={selected} onClose={() => setSelected(null)} /> : (
        <View style={styles.directory}>
          <Text style={styles.directoryTitle}>{__DEV__ ? 'Sample locations · not real listings' : 'Court directory coming soon'}</Text>
          {venues.length > 0 ? (
            <ScrollView horizontal contentContainerStyle={styles.locations} showsHorizontalScrollIndicator={false}>
              {venues.map((venue) => <Button key={venue.id} label={venue.name} variant="secondary" onPress={() => selectVenue(venue)} />)}
            </ScrollView>
          ) : <Text style={styles.note}>Approved venues will appear here when the directory opens.</Text>}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { padding: 16, gap: 12, backgroundColor: colors.surface },
  brandRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flex: 1, flexBasis: 140, paddingHorizontal: 10 },
  note: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  map: { flex: 1, minHeight: 0, overflow: 'hidden' },
  directory: { backgroundColor: colors.surface, paddingVertical: 16, gap: 12, borderTopWidth: 1, borderTopColor: colors.border },
  directoryTitle: { fontFamily: fonts.semibold, color: colors.text, fontSize: 13, lineHeight: 20, paddingHorizontal: 16 },
  locations: { paddingHorizontal: 16, gap: 10 },
});
