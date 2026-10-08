import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { avatarProblem, displayNameInput, formatPhone, initials, personNameInput, phoneInput, profileName } from './profile';
import type { DetailsPatch, ProfileDetails } from './profileClient';
import { Avatar } from './ProfileHero';

type EditProfileSheetProps = {
  visible: boolean;
  profile: ProfileDetails;
  email: string | null | undefined;
  photoUri: string | null;
  onSave: (patch: DetailsPatch) => Promise<void>;
  onPhoto: (file: { uri: string; type: 'image/jpeg' | 'image/png' }) => Promise<void>;
  onRemovePhoto: () => Promise<void>;
  onClose: () => void;
};

export function EditProfileSheet({ visible, ...props }: EditProfileSheetProps) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      {/* Remount per opening so the draft starts from the saved details. */}
      {visible && <Editor {...props} />}
    </Modal>
  );
}

function Editor({ profile, email, photoUri, onSave, onPhoto, onRemovePhoto, onClose }: Omit<EditProfileSheetProps, 'visible'>) {
  const [first, setFirst] = useState(profile.first_name ?? '');
  const [last, setLast] = useState(profile.last_name ?? '');
  const [display, setDisplay] = useState(profile.display_name ?? '');
  const [phone, setPhone] = useState(profile.phone ? formatPhone(profile.phone) : '');
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const firstName = personNameInput(first);
  const lastName = personNameInput(last);
  const displayName = displayNameInput(display);
  const mobile = phoneInput(phone);
  const valid = firstName.ok && lastName.ok && displayName.ok && mobile.ok;
  const preview = profileName(displayName.ok ? displayName.value : display, email,
    firstName.ok ? firstName.value : first, lastName.ok ? lastName.value : last);
  const busy = saving || photoBusy;

  const save = async () => {
    if (!firstName.ok || !lastName.ok || !displayName.ok || !mobile.ok || busy) return;
    setSaving(true);
    setMessage(null);
    try {
      await onSave({ first_name: firstName.value, last_name: lastName.value, display_name: displayName.value, phone: mobile.value });
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'We couldn’t save your details. Please try again.');
      setSaving(false);
    }
  };
  // Photo changes apply straight away; the system picker needs no photo-library permission.
  const pickPhoto = async () => {
    setMessage(null);
    let asset: ImagePicker.ImagePickerAsset | undefined;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], allowsMultipleSelection: false, allowsEditing: true, aspect: [1, 1], quality: 0.7, exif: false, base64: false,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      asset = result.canceled ? undefined : result.assets[0];
    } catch {
      setMessage('Couldn’t open your photos. Try again.');
      return;
    }
    if (!asset) return;
    const checked = avatarProblem(asset);
    if ('problem' in checked) { setMessage(checked.problem); return; }
    const file = { uri: asset.uri, type: checked.type };
    await runPhoto(() => onPhoto(file));
  };
  const runPhoto = async (change: () => Promise<void>) => {
    setPhotoBusy(true);
    setMessage(null);
    try { await change(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'We couldn’t update your photo. Please try again.'); }
    finally { setPhotoBusy(false); }
  };

  return (
    <KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.bar}>
        <TextButton label="Cancel" onPress={onClose} disabled={saving} />
        <Text accessibilityRole="header" style={styles.heading}>Edit profile</Text>
        {saving ? <ActivityIndicator color={colors.primary} accessibilityLabel="Saving" />
          : <TextButton label="Save" strong onPress={() => void save()} disabled={!valid || photoBusy} />}
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.preview}>
          <View>
            <Avatar photoUri={photoUri} initials={initials(preview)} size={88} />
            {photoBusy && <View style={styles.photoBusy}><ActivityIndicator color={colors.onPrimary} accessibilityLabel="Updating your photo" /></View>}
          </View>
          <Text style={styles.previewName}>{preview}</Text>
          <View style={styles.photoActions}>
            <Button label={photoUri ? 'Change photo' : 'Add a photo'} variant="secondary" style={styles.photoAction} disabled={busy}
              onPress={() => void pickPhoto()} />
            {photoUri && <Button label="Remove photo" variant="secondary" style={styles.photoAction} disabled={busy}
              onPress={() => void runPhoto(onRemovePhoto)} />}
          </View>
          <Text style={styles.note}>Only you can see your photo and personal details.</Text>
        </View>
        <Field label="First name" value={first} onChangeText={setFirst} editable={!saving} autoCapitalize="words"
          autoComplete="given-name" textContentType="givenName" maxLength={60} error={firstName.ok ? undefined : firstName.message} />
        <Field label="Last name" value={last} onChangeText={setLast} editable={!saving} autoCapitalize="words"
          autoComplete="family-name" textContentType="familyName" maxLength={60} error={lastName.ok ? undefined : lastName.message} />
        <Field label="Display name (optional)" value={display} onChangeText={setDisplay} editable={!saving}
          autoCapitalize="words" autoComplete="nickname" textContentType="nickname" maxLength={120}
          error={displayName.ok ? undefined : displayName.message}
          hint="How pickly greets you. Leave it empty to use your first and last name." />
        <Field label="Mobile number (optional)" value={phone} onChangeText={setPhone} editable={!saving}
          keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" maxLength={20} returnKeyType="done"
          onSubmitEditing={() => void save()} error={mobile.ok ? undefined : mobile.message}
          hint="A Philippine mobile number, like 0917 123 4567." />
        {message && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{message}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function TextButton({ label, strong, disabled, onPress }: { label: string; strong?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={10}
      style={({ pressed }) => [styles.textButton, pressed && { opacity: 0.6 }]}>
      <Text style={[styles.textButtonLabel, strong && styles.strong, disabled && styles.muted]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, paddingHorizontal: 20, paddingTop: 20 },
  content: { padding: 20, gap: 20, paddingBottom: 40 },
  heading: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 17, lineHeight: 24 },
  textButton: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
  textButtonLabel: { fontFamily: fonts.medium, color: colors.link, fontSize: 16, lineHeight: 22 },
  strong: { fontFamily: fonts.extrabold, textAlign: 'right' },
  muted: { color: colors.textSecondary },
  preview: { alignItems: 'center', gap: 12 },
  photoBusy: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primaryOverlay },
  previewName: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 22, lineHeight: 28, letterSpacing: -0.4, textAlign: 'center' },
  photoActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, alignSelf: 'stretch' },
  photoAction: { flexGrow: 1, flexBasis: 140 },
  note: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  error: { fontFamily: fonts.medium, color: colors.error, fontSize: 15, lineHeight: 24 },
});
