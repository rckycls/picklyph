import { formatManilaDateTime, formatPhpCentavos, type SessionBooking } from '@picklyph/domain';
import { router } from 'expo-router';
import { useCallback } from 'react';
import { Text, View } from 'react-native';
import { PicklyMascot } from '@/components/mascot/PicklyMascot';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { mergeHistory } from '../rental/model';
import { useRetryWait } from '../rental/useRetryWait';
import { loadGroupHistory } from './client';
import { groupStatus } from './model';
import { GroupRecovery, useGroupAttempt } from './Recovery';
import { GroupError } from './ui';
import { usePages } from './usePages';

/** Body of the Bookings tab's open-play view: the caller's own player groups, newest first within loaded pages. */
export function GroupHistory({ actor }: { actor: string }) {
  const recovery = useGroupAttempt(actor);
  const load = useCallback((after: string | null, signal: AbortSignal) => loadGroupHistory(recovery.transport, after, signal), [recovery.transport]);
  const pages = usePages(load, mergeHistory<SessionBooking>);
  const wait = useRetryWait(pages.failure); const rows = pages.rows;
  return <>
    <GroupRecovery recovery={recovery} />
    <Button label={wait ? `Refresh in ${wait}s` : pages.busy ? 'Checking groups…' : 'Refresh groups'} variant="secondary" loading={pages.busy} disabled={wait > 0} onPress={pages.refresh} />
    {pages.failure && <GroupError failure={pages.failure} />}
    {pages.failure && rows.length > 0 && <Text style={screenText.body}>The list below shows the last received records. Refresh to check current statuses.</Text>}
    {pages.loaded && rows.length === 0 && !pages.busy && !pages.failure && <Card><View style={{ alignItems: 'center' }}><PicklyMascot size={160} /></View>
      <Text style={screenText.title}>Bring your crew.</Text>
      <Text style={screenText.body}>Your open-play groups will appear here. Open a verified venue in Discover to see its upcoming sessions.</Text></Card>}
    {rows.map((b) => { const status = groupStatus(b); return <Card key={b.id}>
      <StatusBadge label={status.label} tone={status.tone} />
      <Text style={screenText.title}>{b.snapshot.title}</Text>
      <Text style={screenText.body}>{formatManilaDateTime(b.snapshot.starts_at)}
        {'\n'}{b.spots} {b.spots === 1 ? 'person' : 'people'} · {formatPhpCentavos(b.snapshot.total_centavos)} · arrival payment
        {'\n'}Reference {b.id.slice(0, 8)}</Text>
      <Button label="View group" accessibilityLabel={`View ${status.label.toLowerCase()} group for ${b.snapshot.title} on ${formatManilaDateTime(b.snapshot.starts_at)}`}
        onPress={() => router.push({ pathname: '/play/booking/[id]', params: { id: b.id } })} />
    </Card>; })}
    {pages.cursor && <Button label={rows.length >= 200 ? 'Refresh to check new groups' : 'Load more groups'} variant="secondary" disabled={pages.busy || wait > 0}
      onPress={() => { if (rows.length >= 200) pages.refresh(); else pages.more(); }} />}
    {rows.length > 0 && <Text style={screenText.body}>Showing {rows.length} loaded groups, newest first. Refresh starts from page one to find new requests.</Text>}
  </>;
}
