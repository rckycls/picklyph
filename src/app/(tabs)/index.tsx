import type { MapBounds, VenueSearchItem } from '@picklyph/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/Button';
import { BrandLockup } from '@/components/ui/BrandLockup';
import { StatusBadge } from '@/components/ui/StatusBadge';
import CourtMap from '@/features/discovery/CourtMap';
import { FilterBar, type DiscoveryView } from '@/features/discovery/FilterBar';
import type { MapRegion } from '@/features/discovery/mapTypes';
import { PHILIPPINES_REGION, regionToBounds, sameBounds, venueRegion } from '@/features/discovery/region';
import { NO_FILTERS, type DiscoveryFilters } from '@/features/discovery/searchClient';
import { useDeviceLocation } from '@/features/discovery/useDeviceLocation';
import { useVenueSearch } from '@/features/discovery/useVenueSearch';
import { ResultsBar, VenueList } from '@/features/discovery/VenueList';
import { VenueSheet } from '@/features/discovery/VenueSheet';
import type { LocationResult } from '@/lib/location';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

const NATIONAL_BOUNDS = regionToBounds(PHILIPPINES_REGION) as MapBounds;
// Settled camera moves only; avoids a request per animation frame.
const REGION_DEBOUNCE_MS = 600;

export default function DiscoverScreen() {
  const [view, setView] = useState<DiscoveryView>('map');
  const [filters, setFilters] = useState<DiscoveryFilters>(NO_FILTERS);
  const [bounds, setBounds] = useState<MapBounds>(NATIONAL_BOUNDS);
  const [selected, setSelected] = useState<VenueSearchItem | null>(null);
  const [missingId, setMissingId] = useState<string | null>(null);
  const [focusRegion, setFocusRegion] = useState<MapRegion>(PHILIPPINES_REGION);
  const [mapReady, setMapReady] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const query = useMemo(() => ({ bounds, ...filters }), [bounds, filters]);
  const { results, loadMore, retry, remove } = useVenueSearch(query);
  const regionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const applyLocation = useCallback((result: LocationResult) => {
    setSelected(null);
    setFocusRegion(result.status === 'granted'
      ? { ...result.coordinates, latitudeDelta: 0.08, longitudeDelta: 0.08 }
      : { ...PHILIPPINES_REGION });
  }, []);
  const { location, request } = useDeviceLocation(applyLocation);
  const settingsNeeded = location.status === 'disabled' || (location.status === 'denied' && !location.canAskAgain);

  const handleRegion = useCallback((region: MapRegion) => {
    clearTimeout(regionTimer.current);
    regionTimer.current = setTimeout(() => {
      const next = regionToBounds(region);
      if (next) setBounds((current) => (sameBounds(current, next) ? current : next));
    }, REGION_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => clearTimeout(regionTimer.current), []);

  const handleMissing = useCallback((id: string) => {
    remove(id);
    setMissingId(id);
  }, [remove]);

  // List selection keeps the list stable; the map recenters on the selection when it is shown.
  const selectVenue = (venue: VenueSearchItem) => {
    setSelected(venue);
    if (view === 'map') setFocusRegion(venueRegion(venue));
  };
  const changeView = (next: DiscoveryView) => {
    setView(next);
    if (next === 'map' && selected && selected.id !== missingId) setFocusRegion(venueRegion(selected));
  };
  // Changed filters can exclude the selected venue, so selection restarts with the new results.
  const changeFilters = (next: DiscoveryFilters) => {
    setSelected(null);
    setFilters(next);
  };

  // A selected venue stays marked while panning, unless its current record is no longer listed.
  const mapVenues = selected && selected.id !== missingId && !results.venues.some((venue) => venue.id === selected.id)
    ? [...results.venues, selected]
    : results.venues;

  const message = settingsError ? 'Couldn’t open Settings. You can keep browsing the Philippines.'
    : location.status === 'denied' ? 'Location access is off. You can still explore the Philippines.'
      : location.status === 'disabled' ? 'Location services are off. You can still browse the map.'
        : location.status === 'unavailable' ? 'Couldn’t find your location. Try again or explore the Philippines.'
          : location.status === 'requesting' ? 'Finding your location…'
            : location.status === 'granted' ? 'Location enabled. Move the map to explore.'
              : 'Explore approved venues. Location access is optional.';

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <BrandLockup tagline />
          <StatusBadge label="Philippines" tone="neutral" />
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
      <FilterBar view={view} onViewChange={changeView} filters={filters} onFiltersChange={changeFilters} />
      <View style={styles.map}>
        <View
          style={styles.layer}
          accessibilityElementsHidden={view === 'list'}
          importantForAccessibility={view === 'list' ? 'no-hide-descendants' : 'auto'}
        >
          <CourtMap
            venues={mapVenues}
            selectedId={selected?.id}
            focusRegion={focusRegion}
            showUserLocation={location.status === 'granted'}
            onSelect={selectVenue}
            onRegionChange={handleRegion}
            onReadyChange={setMapReady}
          />
        </View>
        {view === 'list' && (
          <View style={styles.layer}>
            <VenueList results={results} selectedId={selected?.id} onSelect={selectVenue} onLoadMore={loadMore} onRetry={retry} />
          </View>
        )}
      </View>
      {selected ? <VenueSheet key={selected.id} venue={selected} onClose={() => setSelected(null)} onMissing={handleMissing} />
        : view === 'map' && <ResultsBar results={results} onLoadMore={loadMore} onRetry={retry} onShowList={() => changeView('list')} />}
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
  layer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
