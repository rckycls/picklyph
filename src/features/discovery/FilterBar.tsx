import type { CourtSurface } from '@picklyph/domain';
import { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { activeFilterCount } from './recovery';
import { NO_FILTERS, type DiscoveryFilters } from './searchClient';

export type DiscoveryView = 'map' | 'list';

function Chip({ label, checked, hint, role = 'togglebutton', accessibilityLabel, onPress }: {
  label: string; checked: boolean; hint?: string; role?: 'togglebutton' | 'radio'; accessibilityLabel?: string; onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={hint}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, checked && styles.checked, pressed && styles.pressed]}
    >
      <Text style={[styles.label, checked && styles.checkedLabel]}>{label}</Text>
    </Pressable>
  );
}

const settings: { value: boolean | null; label: string }[] = [
  { value: null, label: 'Any' },
  { value: true, label: 'Indoor' },
  { value: false, label: 'Outdoor' },
];

const surfaces: { value: CourtSurface | null; label: string }[] = [
  { value: null, label: 'Any' },
  { value: 'hard', label: 'Hard' },
  { value: 'synthetic', label: 'Synthetic' },
  { value: 'other', label: 'Other' },
];

/**
 * Map/List switch plus a Filters dropdown. Court filters apply to the same active court, matching
 * the T13 search contract, and each change searches straight away.
 */
export function FilterBar({ view, onViewChange, filters, onFiltersChange }: {
  view: DiscoveryView;
  onViewChange: (view: DiscoveryView) => void;
  filters: DiscoveryFilters;
  onFiltersChange: (filters: DiscoveryFilters) => void;
}) {
  const bar = useRef<View>(null);
  const [menuTop, setMenuTop] = useState<number | null>(null);
  const { width } = useWindowDimensions();
  const count = activeFilterCount(filters);
  const set = (patch: Partial<DiscoveryFilters>) => onFiltersChange({ ...filters, ...patch });
  const close = () => setMenuTop(null);
  // The menu opens in a modal (above the native map), placed just under this bar.
  const open = () => bar.current?.measureInWindow((_x, y, _width, height) => setMenuTop(y + height));

  return (
    <View ref={bar} collapsable={false} style={styles.bar}>
      <Chip label="Map" checked={view === 'map'} onPress={() => onViewChange('map')} />
      <Chip label="List" checked={view === 'list'} hint="Shows the venues found in the current map area." onPress={() => onViewChange('list')} />
      <View style={styles.spacer} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={count ? `Filters, ${count} on` : 'Filters'}
        accessibilityHint="Choose indoor or outdoor, covered courts and surface."
        accessibilityState={{ expanded: menuTop !== null }}
        onPress={open}
        style={({ pressed }) => [styles.chip, styles.trigger, count > 0 && styles.checked, pressed && styles.pressed]}
      >
        <Icon name="filter" color={count ? colors.onPrimary : colors.text} size={18} />
        <Text style={[styles.label, count > 0 && styles.checkedLabel]}>Filters</Text>
        {count > 0 && <View style={styles.count}><Text style={styles.countText}>{count}</Text></View>}
        <Icon name={menuTop !== null ? 'chevronUp' : 'chevronDown'} color={count ? colors.onPrimary : colors.textSecondary} size={16} />
      </Pressable>

      <Modal visible={menuTop !== null} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close filters" onPress={close} />
        <View accessibilityViewIsModal style={[styles.menu, { top: menuTop ?? 0, width: Math.min(width - 32, 380) }]}>
          <Text style={styles.heading}>Setting</Text>
          <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel="Setting">
            {settings.map((option) => (
              <Chip key={option.label} role="radio" label={option.label} accessibilityLabel={`Setting: ${option.label}`} checked={filters.indoor === option.value}
                onPress={() => set({ indoor: option.value })} />
            ))}
          </View>
          <Text style={styles.heading}>Surface</Text>
          <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel="Surface">
            {surfaces.map((option) => (
              <Chip key={option.label} role="radio" label={option.label} accessibilityLabel={`Surface: ${option.label}`} checked={filters.surface === option.value}
                onPress={() => set({ surface: option.value })} />
            ))}
          </View>
          <View style={styles.toggle}>
            <Text style={[styles.label, styles.grow]}>Covered courts only</Text>
            <Switch value={filters.covered === true} onValueChange={(on) => set({ covered: on ? true : null })} accessibilityLabel="Covered courts only"
              trackColor={{ true: colors.secondary, false: colors.border }} ios_backgroundColor={colors.border} />
          </View>
          <View style={styles.actions}>
            {count > 0 && <Button label="Clear" variant="secondary" style={styles.grow} onPress={() => onFiltersChange(NO_FILTERS)} />}
            <Button label="Done" style={styles.grow} onPress={close} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border,
  },
  spacer: { flexGrow: 1 },
  chip: {
    minHeight: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    paddingHorizontal: 16, justifyContent: 'center',
  },
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14 },
  checked: { backgroundColor: colors.primary, borderColor: colors.primary },
  pressed: { transform: [{ scale: 0.97 }] },
  label: { fontFamily: fonts.semibold, color: colors.text, fontSize: 14, lineHeight: 20 },
  checkedLabel: { color: colors.onPrimary },
  count: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  countText: { fontFamily: fonts.semibold, color: colors.onAccent, fontSize: 12, lineHeight: 16 },
  menu: {
    position: 'absolute', right: 16, marginTop: 6, padding: 16, gap: 10, borderRadius: 20,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    shadowColor: colors.text, shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  heading: { fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 12, lineHeight: 18, letterSpacing: 1.2, textTransform: 'uppercase' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 12 },
  grow: { flexGrow: 1 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
});
