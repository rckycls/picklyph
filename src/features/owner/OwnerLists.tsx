import type { OwnerDuplicate, OwnerSubmission } from '@picklyph/domain';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { listingNotice } from '@/features/discovery/listing';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { distanceLabel, submissionBadge } from './ownerForm';

/** Approved listings near the proposed pin; claiming one is usually the right path. */
export function DuplicateList({ duplicates, onClaim }: { duplicates: readonly OwnerDuplicate[]; onClaim: (id: string) => void }) {
  return (
    <View style={styles.list}>
      {duplicates.map((venue) => {
        const notice = listingNotice(venue.claim_status);
        return (
          <View key={venue.id} style={styles.item}>
            <Text style={styles.name}>{venue.name}</Text>
            <Text style={styles.meta}>{venue.address_line}, {venue.city} · {distanceLabel(venue.distance_m)}</Text>
            <StatusBadge label={notice.badge} tone={notice.tone} />
            {venue.claim_status === 'verified'
              ? <Text style={styles.meta}>This listing already has a verified owner.</Text>
              : <Button label="Claim this listing" variant="secondary" accessibilityLabel={`Claim ${venue.name}`} onPress={() => onClaim(venue.id)} />}
          </View>
        );
      })}
    </View>
  );
}

export function SubmissionList({ submissions }: { submissions: readonly OwnerSubmission[] }) {
  return (
    <View style={styles.list}>
      {submissions.map((submission) => {
        const badge = submissionBadge(submission);
        return (
          <View key={submission.id} style={styles.item} accessible
            accessibilityLabel={`${submission.name}, ${submission.city}. ${submission.kind === 'claim' ? 'Ownership claim' : 'New venue'}. ${badge.label}.`}>
            <Text style={styles.name}>{submission.name}</Text>
            <Text style={styles.meta}>{submission.kind === 'claim' ? 'Ownership claim' : 'New venue'} · {submission.city}</Text>
            <StatusBadge label={badge.label} tone={badge.tone} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  item: { borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 14, gap: 6, backgroundColor: colors.surface },
  name: { fontFamily: fonts.semibold, color: colors.text, fontSize: 16, lineHeight: 23 },
  meta: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
});
