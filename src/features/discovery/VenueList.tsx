import type { VenueSearchItem } from '@picklyph/domain';
import type { ReactNode } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { courtCount, failureMessage, listingNotice, resultsSummary } from './listing';
import { retryLabel, type Recovery } from './recovery';
import type { ResultsState } from './resultsState';

type ResultsProps = {
  results: ResultsState;
  recovery: Recovery | null;
  onLoadMore: () => void;
  onRetry: () => void;
  /** Present only when clearing filters or zooming out would change an empty or rejected search. */
  onClearFilters?: () => void;
  onZoomOut?: () => void;
};

/** Status, retry and paging controls shared by the map and list views. */
function ResultsStatus({ results, recovery, onLoadMore, onRetry, onClearFilters, onZoomOut, extra, paging = true }: ResultsProps & { extra?: ReactNode; paging?: boolean }) {
  const moreFailed = results.status === 'ready' && results.failure !== null;
  const waiting = Boolean(recovery && recovery.waitSeconds > 0);
  return (
    <View style={styles.status}>
      <View style={styles.row} accessibilityLiveRegion="polite">
        {results.status === 'loading' && <ActivityIndicator color={colors.primary} accessible={false} />}
        <Text style={[styles.summary, results.status === 'error' && styles.error]}>{resultsSummary(results)}</Text>
      </View>
      {moreFailed && results.failure && <Text accessibilityLiveRegion="polite" style={[styles.summary, styles.error]}>{failureMessage(results.failure)}</Text>}
      {recovery?.automatic && waiting && <Text style={styles.summary}>pickly will search again when the wait ends.</Text>}
      <View style={styles.actions}>
        {recovery?.retryable && (
          <Button
            label={retryLabel(recovery)}
            accessibilityLabel={waiting ? 'Try again, available shortly' : 'Try again'}
            variant="accent"
            style={styles.action}
            disabled={waiting}
            onPress={onRetry}
          />
        )}
        {onClearFilters && <Button label="Clear filters" variant="secondary" style={styles.action} onPress={onClearFilters} />}
        {onZoomOut && <Button label="Show all of the Philippines" variant="secondary" style={styles.action} onPress={onZoomOut} />}
        {paging && <LoadMore results={results} onLoadMore={onLoadMore} />}
        {extra}
      </View>
    </View>
  );
}

function LoadMore({ results, onLoadMore }: Pick<ResultsProps, 'results' | 'onLoadMore'>) {
  if (results.status !== 'ready' || !results.nextCursor || results.failure) return null;
  return <Button label="Load more venues" variant="secondary" style={styles.action} loading={results.loadingMore} onPress={onLoadMore} />;
}

export function ResultsBar(props: ResultsProps & { onShowList: () => void }) {
  return (
    <View style={styles.bar}>
      <ResultsStatus
        {...props}
        extra={props.results.venues.length > 0 && <Button label="Show list" variant="secondary" style={styles.action} onPress={props.onShowList} />}
      />
    </View>
  );
}

function VenueRow({ venue, selected, onPress }: { venue: VenueSearchItem; selected: boolean; onPress: () => void }) {
  const notice = listingNotice(venue.claim_status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${venue.name}, ${venue.city}. ${courtCount(venue.active_court_count)}. ${notice.badge}. Not bookable in pickly.`}
      accessibilityHint="Shows current venue details and directions."
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.item, selected && styles.selected, pressed && styles.pressed]}
    >
      <Text style={styles.name}>{venue.name}</Text>
      <Text style={styles.meta}>{venue.city}, {venue.province} · {courtCount(venue.active_court_count)}</Text>
      <StatusBadge label={notice.badge} tone={notice.tone} />
    </Pressable>
  );
}

export function VenueList({ selectedId, onSelect, ...status }: ResultsProps & {
  selectedId?: string;
  onSelect: (venue: VenueSearchItem) => void;
}) {
  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={status.results.venues}
      keyExtractor={(venue) => venue.id}
      renderItem={({ item }) => <VenueRow venue={item} selected={item.id === selectedId} onPress={() => onSelect(item)} />}
      ListHeaderComponent={<ResultsStatus {...status} paging={false} />}
      ListFooterComponent={<LoadMore results={status.results} onLoadMore={status.onLoadMore} />}
      keyboardShouldPersistTaps="handled"
    />
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 16, paddingVertical: 12 },
  status: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  summary: { flexShrink: 1, fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
  error: { color: colors.error },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flexGrow: 1, flexBasis: 150, minHeight: 44, paddingVertical: 10 },
  list: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 10 },
  item: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 18, padding: 16, gap: 6 },
  selected: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.selectedBackground },
  pressed: { transform: [{ scale: 0.99 }] },
  name: { fontFamily: fonts.semibold, color: colors.text, fontSize: 16, lineHeight: 23 },
  meta: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
});
