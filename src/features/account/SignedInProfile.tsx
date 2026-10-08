import type { Session } from '@supabase/supabase-js';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/features/auth/AuthProvider';
import { useOwnerMode } from '@/features/owner/OwnerMode';
import { submissionBadge } from '@/features/owner/ownerForm';
import { useMySubmissions } from '@/features/owner/useMySubmissions';
import { locationAccessLabel, useLocationPermission } from '@/features/preferences/useLocationPermission';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { EditProfileSheet } from './EditProfileSheet';
import { MenuGroup, MenuRow, RevealButton } from './Menu';
import { ModeSwitch } from './ModeSwitch';
import { formatPhone, initials, maskEmail, maskPhone, memberSince, profileName } from './profile';
import { avatarUrl, loadProfile, removeAvatar, saveProfile, uploadAvatar, type ProfileDetails } from './profileClient';
import { ProfileHero, type HeroChip, type HeroStat } from './ProfileHero';

const badgeTones = { pending: 'lime', success: 'green', error: 'red' } as const;
const EMPTY: ProfileDetails = { display_name: null, first_name: null, last_name: null, phone: null, avatar_path: null };

/**
 * Key this by user id so names, details and submissions never carry across accounts. Adding, claiming
 * and submissions live in Owner mode only; `startInOwnerMode` comes from the welcome screen's owner choice.
 */
export function SignedInProfile({ session, startInOwnerMode = false }: { session: Session; startInOwnerMode?: boolean }) {
  const auth = useAuth();
  const user = session.user;
  const { count, mode, error: accessError, refresh, setMode } = useOwnerMode();
  const ownerMode = mode === 'owner';
  const { submissions, reload } = useMySubmissions(ownerMode ? user.id : null);
  const location = useLocationPermission();
  const startedOwner = useRef(false);
  useEffect(() => {
    if (!startInOwnerMode || startedOwner.current || count === null) return;
    startedOwner.current = true;
    setMode('owner');
  }, [startInOwnerMode, count, setMode]);
  const [profile, setProfile] = useState<{ loaded: boolean; value: ProfileDetails }>({ loaded: false, value: EMPTY });
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [emailShown, setEmailShown] = useState(false);
  const [phoneShown, setPhoneShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  // Access is re-checked on every navigation; keep the last answer so the page doesn't jump.
  const [venues, setVenues] = useState<number | null>(count);
  if (count !== null && count !== venues) setVenues(count);

  // A just-picked photo shows from the device straight away; otherwise sign a short-lived link.
  const applyProfile = useCallback((next: ProfileDetails, localPhoto?: string) => {
    setProfile({ loaded: true, value: next });
    if (localPhoto) { setPhotoUri(localPhoto); return; }
    if (!next.avatar_path) { setPhotoUri(null); return; }
    void avatarUrl(next.avatar_path).then(setPhotoUri);
  }, []);
  useEffect(() => {
    let active = true;
    void loadProfile(user.id).then((value) => { if (active) applyProfile(value ?? EMPTY); });
    return () => { active = false; };
  }, [user.id, applyProfile]);

  const details = profile.value;
  const name = profileName(details.display_name, user.email, details.first_name, details.last_name);
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
  const email = user.email ? (emailShown ? user.email : maskEmail(user.email)) : undefined;
  const edit = () => setEditing(true);

  return (
    <>
      <ProfileHero
        name={profile.loaded ? name : null}
        initials={profile.loaded ? initials(name) : ''}
        photoUri={photoUri}
        detail={email}
        detailIsEmail={Boolean(user.email)}
        chips={chips}
        stats={stats}
        action={profile.loaded ? { label: 'Edit', accessibilityLabel: 'Edit your profile', onPress: edit } : undefined}
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

      <MenuGroup title="Personal details">
        <MenuRow icon="user" overline="First name" title={details.first_name ?? 'Add your first name'} onPress={edit} />
        <MenuRow icon="user" overline="Last name" title={details.last_name ?? 'Add your last name'} onPress={edit} />
        <MenuRow icon="phone" overline="Mobile number" onPress={edit}
          title={details.phone ? (phoneShown ? formatPhone(details.phone) : maskPhone(details.phone)) : 'Add your mobile number'}
          accessibilityLabel={details.phone ? `Mobile number, ${phoneShown ? formatPhone(details.phone) : 'hidden'}` : 'Add your mobile number'}
          accessory={details.phone ? <RevealButton shown={phoneShown} label="mobile number" onToggle={() => setPhoneShown((value) => !value)} /> : undefined} />
        {user.email && (
          <MenuRow icon="mail" overline="Email" title={email ?? ''} accessibilityLabel={`Email, ${emailShown ? user.email : 'hidden'}`}
            accessory={<RevealButton shown={emailShown} label="email" onToggle={() => setEmailShown((value) => !value)} />} />
        )}
      </MenuGroup>

      <MenuGroup title="Settings">
        <MenuRow icon="settings" title="Preferences" subtitle="How Discover opens" onPress={() => router.push('/preferences')} />
        <MenuRow icon="location" tone="green" title="Location access" subtitle={locationAccessLabel(location)}
          onPress={() => void Linking.openSettings().catch(() => undefined)} />
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

      <EditProfileSheet visible={editing} profile={details} email={user.email} photoUri={photoUri} onClose={() => setEditing(false)}
        onSave={async (patch) => { applyProfile(await saveProfile(user.id, patch)); }}
        onPhoto={async (file) => { applyProfile(await uploadAvatar(user.id, file, details.avatar_path), file.uri); }}
        onRemovePhoto={async () => { applyProfile(await removeAvatar(user.id, details.avatar_path)); }} />
    </>
  );
}

const styles = StyleSheet.create({
  badge: { marginTop: 6 },
  signOut: { gap: 8 },
  error: { fontFamily: fonts.medium, color: colors.error, fontSize: 14, lineHeight: 21, marginLeft: 6 },
});
