import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import type { DiscoveryView } from '@/features/discovery/FilterBar';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { loadDiscoverView, saveDiscoverView } from '@/features/preferences/discoverView';
import { locationAccessLabel, useLocationPermission } from '@/features/preferences/useLocationPermission';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

const VIEWS: readonly { value: DiscoveryView; label: string }[] = [{ value: 'map', label: 'Map' }, { value: 'list', label: 'List' }];

/** Device preferences. Stored on this phone only; nothing here is sent to pickly. */
export default function PreferencesScreen() {
  const [view, setView] = useState<DiscoveryView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const location = useLocationPermission();
  useEffect(() => {
    let active = true;
    void loadDiscoverView().then((saved) => { if (active) setView(saved); });
    return () => { active = false; };
  }, []);
  const chooseView = (next: DiscoveryView) => {
    setView(next);
    setMessage(null);
    void saveDiscoverView(next).catch(() => setMessage('Couldn’t save this preference on your phone. Try again.'));
  };

  return (
    <OwnerScreen>
      <Card>
        <Text accessibilityRole="header" style={styles.heading}>Discover</Text>
        <Text style={screenText.body}>Choose whether pickly opens on the map or the list of courts.</Text>
        {view && <SegmentedControl options={VIEWS} value={view} onChange={chooseView} accessibilityLabel="Open Discover in" />}
        {message && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>}
        <Text style={styles.note}>Takes effect the next time you open pickly.</Text>
      </Card>
      <Card>
        <Text accessibilityRole="header" style={styles.heading}>Location</Text>
        <Text style={screenText.body} accessibilityLiveRegion="polite">{locationAccessLabel(location)}</Text>
        <Text style={styles.note}>pickly uses your location only when you tap Use my location on Discover. It isn’t stored.</Text>
        <Button label="Open iPhone Settings" variant="secondary" onPress={() => void Linking.openSettings().catch(() => undefined)} />
      </Card>
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  heading: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 19, lineHeight: 25 },
  note: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  error: { fontFamily: fonts.medium, color: colors.error, fontSize: 14, lineHeight: 21 },
});
