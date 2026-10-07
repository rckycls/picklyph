import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Field } from '@/components/ui/Field';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { displayNameInput, initials, profileName } from './profile';
import { BallAvatar } from './ProfileHero';

type EditNameSheetProps = {
  visible: boolean;
  current: string | null;
  email: string | null | undefined;
  onSave: (value: string | null) => Promise<void>;
  onClose: () => void;
};

export function EditNameSheet({ visible, current, email, onSave, onClose }: EditNameSheetProps) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {/* Remount per opening so the draft starts from the saved name. */}
      {visible && <Editor current={current} email={email} onSave={onSave} onClose={onClose} />}
    </Modal>
  );
}

function Editor({ current, email, onSave, onClose }: Omit<EditNameSheetProps, 'visible'>) {
  const [draft, setDraft] = useState(current ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const parsed = displayNameInput(draft);
  const preview = profileName(parsed.ok ? parsed.value : draft, email);
  const save = async () => {
    if (!parsed.ok || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await onSave(parsed.value);
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'We couldn’t save your name. Please try again.');
      setSaving(false);
    }
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.bar}>
        <TextButton label="Cancel" onPress={onClose} disabled={saving} />
        <Text accessibilityRole="header" style={styles.heading}>Edit profile</Text>
        {saving ? <ActivityIndicator color={colors.primary} accessibilityLabel="Saving" />
          : <TextButton label="Save" strong onPress={() => void save()} disabled={!parsed.ok} />}
      </View>
      <View style={styles.preview}>
        <BallAvatar initials={initials(preview)} size={76} />
        <Text style={styles.previewName}>{preview}</Text>
      </View>
      <Field label="Display name" value={draft} onChangeText={setDraft} autoFocus editable={!saving}
        autoCapitalize="words" autoComplete="name" textContentType="name" returnKeyType="done" maxLength={120}
        onSubmitEditing={() => void save()} error={parsed.ok ? undefined : parsed.message}
        hint="How pickly greets you. Leave it empty to use your email instead." />
      {message && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{message}</Text>}
    </View>
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
  sheet: { flex: 1, backgroundColor: colors.background, padding: 20, gap: 24 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  heading: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 17, lineHeight: 24 },
  textButton: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
  textButtonLabel: { fontFamily: fonts.medium, color: colors.link, fontSize: 16, lineHeight: 22 },
  strong: { fontFamily: fonts.extrabold, textAlign: 'right' },
  muted: { color: colors.textSecondary },
  preview: { alignItems: 'center', gap: 12 },
  previewName: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 22, lineHeight: 28, letterSpacing: -0.4, textAlign: 'center' },
  error: { fontFamily: fonts.medium, color: colors.error, fontSize: 15, lineHeight: 24 },
});
