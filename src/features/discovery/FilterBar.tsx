import type { CourtSurface } from '@picklyph/domain';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import type { DiscoveryFilters } from './searchClient';

export type DiscoveryView = 'map' | 'list';

function Chip({ label, checked, hint, onPress }: { label: string; checked: boolean; hint?: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="togglebutton"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, checked && styles.checked, pressed && styles.pressed]}
    >
      <Text style={[styles.label, checked && styles.checkedLabel]}>{label}</Text>
    </Pressable>
  );
}

const surfaces: { value: CourtSurface; label: string }[] = [
  { value: 'hard', label: 'Hard' },
  { value: 'synthetic', label: 'Synthetic' },
  { value: 'other', label: 'Other surface' },
];

/** Court filters apply to the same active court, matching the T13 search contract. */
export function FilterBar({ view, onViewChange, filters, onFiltersChange }: {
  view: DiscoveryView;
  onViewChange: (view: DiscoveryView) => void;
  filters: DiscoveryFilters;
  onFiltersChange: (filters: DiscoveryFilters) => void;
}) {
  const toggle = (patch: Partial<DiscoveryFilters>) => onFiltersChange({ ...filters, ...patch });
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bar} style={styles.container}>
      <Chip label="Map" checked={view === 'map'} onPress={() => onViewChange('map')} />
      <Chip label="List" checked={view === 'list'} hint="Shows the venues found in the current map area." onPress={() => onViewChange('list')} />
      <View style={styles.divider} accessible={false} />
      <Chip label="Indoor" checked={filters.indoor === true} onPress={() => toggle({ indoor: filters.indoor === true ? null : true })} />
      <Chip label="Outdoor" checked={filters.indoor === false} onPress={() => toggle({ indoor: filters.indoor === false ? null : false })} />
      <Chip label="Covered" checked={filters.covered === true} onPress={() => toggle({ covered: filters.covered === true ? null : true })} />
      {surfaces.map((surface) => (
        <Chip
          key={surface.value}
          label={surface.label}
          checked={filters.surface === surface.value}
          onPress={() => toggle({ surface: filters.surface === surface.value ? null : surface.value })}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 0, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
  bar: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, alignItems: 'center' },
  chip: {
    minHeight: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    paddingHorizontal: 16, justifyContent: 'center',
  },
  checked: { backgroundColor: colors.primary, borderColor: colors.primary },
  pressed: { transform: [{ scale: 0.97 }] },
  label: { fontFamily: fonts.semibold, color: colors.text, fontSize: 14, lineHeight: 20 },
  checkedLabel: { color: colors.onPrimary },
  divider: { width: 1, alignSelf: 'stretch', marginVertical: 6, backgroundColor: colors.border },
});
