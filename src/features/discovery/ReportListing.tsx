import { MAX_REPORT_DETAILS, REPORT_REASONS, REPORT_REASON_LABELS, type ReportReason, type VenueReportRequest } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/features/auth/AuthProvider';
import { SignInForm } from '@/features/auth/SignInForm';
import { Choice } from '@/features/owner/FormControls';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { colors } from '@/theme/colors';

import { loadLiveVenueDetail } from './liveDirectory';
import { reportDraft, reportFailureMessage, submitReport } from './reportClient';
import { reportTransport } from './reportLive';
import type { VenueDetail } from './venueDetail';

type Listing = { status: 'loading' } | { status: 'ready'; venue: VenueDetail } | { status: 'missing' } | { status: 'error' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameReport = (a: VenueReportRequest, b: VenueReportRequest) => a.venue_id === b.venue_id && a.reason === b.reason && a.details === b.details;

/** Report a published listing (T46). Signed-in players only; reviewers decide, nothing changes on Discover until then. */
export function ReportListing({ id }: { id: string | undefined }) {
  const auth = useAuth();
  const venueId = typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
  if (auth.status === 'restoring') return <OwnerScreen><ActivityIndicator color={colors.primary} accessibilityLabel="Restoring sign-in" /></OwnerScreen>;
  if (auth.status !== 'ready' || !auth.session) return <OwnerScreen><Text accessibilityRole="header" style={screenText.title}>Sign in to report a listing.</Text>
    <Text style={screenText.body}>Reports come from signed-in players, so reviewers can follow up on them.</Text><SignInForm /></OwnerScreen>;
  return <ReportForm key={`${auth.session.user.id}:${venueId}`} actor={auth.session.user.id} venueId={venueId} />;
}

function ReportForm({ actor, venueId }: { actor: string; venueId: string | null }) {
  const [listing, setListing] = useState<Listing>(venueId ? { status: 'loading' } : { status: 'missing' });
  const [attempt, setAttempt] = useState(0);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // One key per report: a retry after a lost reply returns the original instead of a second report.
  // Changing the reason or details after a failure starts a new report.
  const key = useRef(randomUUID());
  const lastSent = useRef<VenueReportRequest | null>(null);

  useEffect(() => {
    if (!venueId) return;
    const abort = new AbortController();
    loadLiveVenueDetail(venueId, abort.signal).then((venue) => {
      if (!abort.signal.aborted) setListing(venue ? { status: 'ready', venue } : { status: 'missing' });
    }, () => { if (!abort.signal.aborted) setListing({ status: 'error' }); });
    return () => abort.abort();
  }, [venueId, attempt]);

  const submit = async () => {
    if (!venueId || !reason) { setMessage('Choose what’s wrong with this listing.'); return; }
    let body: VenueReportRequest;
    try {
      body = reportDraft({ requestId: key.current, venueId, reason, details });
      if (lastSent.current && !sameReport(lastSent.current, body)) {
        key.current = randomUUID();
        body = { ...body, request_id: key.current };
      }
    } catch { setMessage(`Keep the details under ${MAX_REPORT_DETAILS} characters, with no special characters.`); return; }
    lastSent.current = body;
    setBusy(true); setMessage(null);
    const outcome = await submitReport(reportTransport(actor), body);
    setBusy(false);
    if (outcome.ok) setDone(true);
    else setMessage(reportFailureMessage(outcome.failure));
  };

  if (done) {
    return (
      <OwnerScreen>
        <Card tone="highlight">
          <StatusBadge label="Report sent" tone="pending" />
          <Text accessibilityRole="header" style={screenText.title}>Thanks for telling us.</Text>
          <Text accessibilityLiveRegion="polite" style={screenText.body}>
            A pickly reviewer will check this listing. The venue never sees who sent a report.
          </Text>
          <Button label="Back to Discover" onPress={() => router.back()} />
        </Card>
      </OwnerScreen>
    );
  }
  return (
    <OwnerScreen>
      {listing.status === 'loading' && (
        <View accessibilityLiveRegion="polite" style={styles.row}>
          <ActivityIndicator color={colors.primary} accessible={false} />
          <Text style={screenText.body}>Loading the listing…</Text>
        </View>
      )}
      {listing.status === 'error' && (
        <Card>
          <Text accessibilityRole="alert" style={screenText.body}>Couldn’t load this listing. Check your connection and try again.</Text>
          <Button label="Try again" variant="secondary" onPress={() => { setListing({ status: 'loading' }); setAttempt((value) => value + 1); }} />
        </Card>
      )}
      {listing.status === 'missing' && (
        <Card>
          <StatusBadge label="No longer listed" tone="error" />
          <Text style={screenText.body}>This venue isn’t on Discover any more, so there’s nothing to report.</Text>
        </Card>
      )}
      {listing.status === 'ready' && (
        <>
          <Card>
            <Text accessibilityRole="header" style={screenText.title}>{listing.venue.name}</Text>
            <Text style={screenText.body}>{listing.venue.address_line}, {listing.venue.city}, {listing.venue.province}</Text>
          </Card>
          <Card>
            <Text style={screenText.label}>What’s wrong?</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="What’s wrong with this listing" style={styles.reasons}>
              {REPORT_REASONS.map((value) => <Choice key={value} label={REPORT_REASON_LABELS[value]} selected={reason === value} disabled={busy}
                onPress={() => setReason(value)} />)}
            </View>
            <Field label="Details (optional)" value={details} onChangeText={setDetails} multiline maxLength={MAX_REPORT_DETAILS}
              hint="What should reviewers check? Don’t include anyone’s personal information." style={styles.details} editable={!busy} />
            <Text style={screenText.body}>pickly reviewers see your account name with the report. The venue doesn’t.</Text>
            {message && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>}
            <Button label="Send report" loading={busy} disabled={!reason} onPress={() => void submit()} />
          </Card>
        </>
      )}
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  reasons: { gap: 8 },
  details: { minHeight: 96, textAlignVertical: 'top' },
  error: { color: colors.error, fontSize: 15, lineHeight: 22 },
});
