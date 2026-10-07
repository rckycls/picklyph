import type { Session } from '@supabase/supabase-js';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/features/auth/AuthProvider';
import { useOwnerMode } from '@/features/owner/OwnerMode';
import { submissionBadge } from '@/features/owner/ownerForm';
import { useMySubmissions } from '@/features/owner/useMySubmissions';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { EditNameSheet } from './EditNameSheet';
import { MenuGroup, MenuRow } from './Menu';
import { ModeSwitch } from './ModeSwitch';
import { initials, memberSince, profileName, signInMethod } from './profile';
import { loadDisplayName, saveDisplayName } from './profileClient';
import { ProfileHero, type HeroChip, type HeroStat } from './ProfileHero';

const badgeTones = { pending: 'lime', success: 'green', error: 'red' } as const;

/**
 * Key this by user id so names, counts and submissions never carry across accounts. Adding, claiming
 * and submissions live in Owner mode only; `startInOwnerMode` comes from the welcome screen's owner choice.
 */
export function SignedInProfile({ session, startInOwnerMode = false }: { session: Session; startInOwnerMode?: boolean }) {
  const auth = useAuth();
  const user = session.user;
  const { count, mode, error: accessError, refresh, setMode } = useOwnerMode();
  const ownerMode = mode === 'owner';
  const { submissions, reload } = useMySubmissions(ownerMode ? user.id : null);
  const startedOwner = useRef(false);
  useEffect(() => {
    if (!startInOwnerMode || startedOwner.current || count === null) return;
    startedOwner.current = true;
    setMode('owner');
  }, [startInOwnerMode, count, setMode]);
  const [displayName, setDisplayName] = useState<{ loaded: boolean; value: string | null }>({ loaded: false, value: null });
  const [editing, setEditing] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  // Access is re-checked on every navigation; keep the last answer so the page doesn't jump.
  const [venues, setVenues] = useState<number | null>(count);
  if (count !== null && count !== venues) setVenues(count);

  useEffect(() => {
    let active = true;
    void loadDisplayName(user.id).then((value) => { if (active) setDisplayName({ loaded: true, value: value ?? null }); });
    return () => { active = false; };
  }, [user.id]);

  const name = profileName(displayName.value, user.email);
  const owner = venues !== null && venues > 0;
  const joined = memberSince(user.created_at);
  const chips: HeroChip[] = [
    { label: 'Player', tone: 'accent' },
    ...(owner ? [{ label: 'Court owner', tone: 'veil' } as const] : []),
    ...(joined ? [{ label: `Joined ${joined}`, tone: 'veil' } as const] : []),
  ];
  const submitted = submissions.status === 'ready' ? submissions.items : null;
  // Owner stats only in Owner mode; players get a clean identity card instead of a row of zeros.
  const stats: HeroStat[] = ownerMode && (owner || (submitted && submitted.length > 0)) ? [
    { label: venues === 1 ? 'Venue' : 'Venues', value: venues === null ? '—' : String(venues) },
    { label: 'Submitted', value: submitted ? String(submitted.length) : '—' },
    { label: 'In review', value: submitted ? String(submitted.filter((item) => item.status === 'pending').length) : '—' },
  ] : [];
  const method = signInMethod(user.app_metadata?.provider);

  return (
    <>
      <ProfileHero
        name={displayName.loaded ? name : null}
        initials={displayName.loaded ? initials(name) : ''}
        detail={user.email ?? 'Signed in with Apple'}
        detailIsEmail={Boolean(user.email)}
        chips={chips}
        stats={stats}
        action={displayName.loaded ? {
          label: 'Edit',
          accessibilityLabel: displayName.value ? 'Edit your name' : 'Add your name',
          onPress: () => setEditing(true),
        } : undefined}
      />

      <ModeSwitch />
      {accessError && (
        <MenuGroup>
          <MenuRow icon="retry" tone="lime" title="Couldn’t check your venue access" subtitle="Tap to try again" onPress={refresh} />
        </MenuGroup>
      )}

      {ownerMode && (
        <MenuGroup title="Your venues">
          {owner && (
            <MenuRow icon="venue" title={venues > 1 ? `Manage your ${venues} venues` : 'Manage your venue'}
              subtitle="Hours, photos, policies and calendar" onPress={() => router.push('/owner')} />
          )}
          <MenuRow icon="plus" tone="green" title="Add your venue" subtitle="Set up your courts; it goes live once pickly approves"
            onPress={() => router.push('/owner/submit')} />
          <MenuRow icon="flag" tone="lime" title="Claim your listing" subtitle="Open your venue on Discover, then tap Claim"
            onPress={() => router.navigate('/(tabs)')} />
        </MenuGroup>
      )}

      {ownerMode && submissions.status === 'loading' && (
        <MenuGroup title="Your submissions">
          <MenuRow icon="venue" title="Loading your submissions…" loading />
        </MenuGroup>
      )}
      {ownerMode && submissions.status === 'error' && (
        <MenuGroup title="Your submissions">
          <MenuRow icon="retry" tone="red" title={submissions.message} subtitle="Tap to try again" onPress={reload} />
        </MenuGroup>
      )}
      {ownerMode && submissions.status === 'ready' && submissions.items.length > 0 && (
        <MenuGroup title="Your submissions">
          {submissions.items.map((submission) => {
            const badge = submissionBadge(submission);
            const kind = submission.kind === 'claim' ? 'Ownership claim' : 'New venue';
            return (
              <MenuRow key={submission.id} icon={submission.kind === 'claim' ? 'flag' : 'venue'} tone={badgeTones[badge.tone]}
                title={submission.name} subtitle={`${kind} · ${submission.city}`}
                accessibilityLabel={`${submission.name}, ${submission.city}. ${kind}. ${badge.label}.`}>
                <View style={styles.badge}><StatusBadge label={badge.label} tone={badge.tone} /></View>
              </MenuRow>
            );
          })}
        </MenuGroup>
      )}

      <MenuGroup title="Account">
        {user.email && <MenuRow icon="mail" overline="Email" title={user.email} />}
        {method && <MenuRow icon="lock" overline="Signed in with" title={method} />}
      </MenuGroup>

      <View style={styles.signOut}>
        <MenuGroup>
          <MenuRow icon="leave" destructive title="Sign out of this phone" loading={auth.busy} onPress={() => {
            setSignOutError(null);
            void auth.signOut().catch(() => setSignOutError('We couldn’t sign out. Please try again.'));
          }} />
        </MenuGroup>
        {signOutError && <Text accessibilityRole="alert" style={styles.error}>{signOutError}</Text>}
      </View>

      <EditNameSheet visible={editing} current={displayName.value} email={user.email} onClose={() => setEditing(false)}
        onSave={async (value) => { setDisplayName({ loaded: true, value: await saveDisplayName(user.id, value) }); }} />
    </>
  );
}

const styles = StyleSheet.create({
  badge: { marginTop: 6 },
  signOut: { gap: 8 },
  error: { fontFamily: fonts.medium, color: colors.error, fontSize: 14, lineHeight: 21, marginLeft: 6 },
});
