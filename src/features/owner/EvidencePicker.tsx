import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';

import type { EvidenceFile } from './ownerClient';
import { evidenceProblem } from './ownerForm';

/** One private photo. The system photo picker needs no library permission; nothing is uploaded until submit. */
export function EvidencePicker({ value, onChange, disabled }: { value: EvidenceFile | null; onChange: (file: EvidenceFile | null) => void; disabled?: boolean }) {
  const [problem, setProblem] = useState<string | null>(null);
  const pick = async () => {
    setProblem(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], allowsMultipleSelection: false, allowsEditing: false, quality: 0.8, exif: false, base64: false,
        // HEIC library photos are delivered as JPEG.
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      const checked = evidenceProblem(asset);
      if ('problem' in checked) { setProblem(checked.problem); return; }
      onChange({ uri: asset.uri, name: checked.type === 'image/png' ? 'evidence.png' : 'evidence.jpg', type: checked.type, size: asset.fileSize ?? null });
    } catch {
      setProblem('Couldn’t open your photos. Try again.');
    }
  };
  return (
    <View style={styles.group}>
      <Text style={screenText.label}>Proof you own or manage the venue</Text>
      <Text style={screenText.body}>
        A business permit, DTI/SEC registration, lease, or a photo of you at the venue with its signage. JPEG or PNG, up to 5 MB.
      </Text>
      <StatusBadge label="Private: only pickly reviewers see it" tone="neutral" />
      {value && (
        <Image source={{ uri: value.uri }} style={styles.preview} resizeMode="cover" accessible accessibilityLabel="Selected proof photo" />
      )}
      {problem && <Text accessibilityRole="alert" style={styles.error}>{problem}</Text>}
      <View style={styles.actions}>
        <Button label={value ? 'Choose a different photo' : 'Choose photo'} variant="secondary" style={styles.action} disabled={disabled} onPress={() => void pick()} />
        {value && <Button label="Remove photo" variant="secondary" style={styles.action} disabled={disabled} onPress={() => onChange(null)} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 10 },
  preview: { width: '100%', height: 180, borderRadius: 14, backgroundColor: colors.selectedBackground },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flexGrow: 1, flexBasis: 150 },
  error: { color: colors.error, fontSize: 14, lineHeight: 21 },
});
