import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { screenText } from '@/components/ui/Screen';
import { colors } from '@/theme/colors';

/**
 * The end of one tab or form that saves on its own: the last save's result, then Discard beside
 * Save. After a version conflict, Save waits until the owner reloads or edits again.
 */
export function SaveFooter({ dirty, label, saving, disabled = false, message, onSave, onDiscard, onReload }: {
  dirty: boolean; label: string; saving: boolean; disabled?: boolean; message: { text: string; conflict: boolean } | null;
  onSave: () => void; onDiscard: () => void; onReload: () => void;
}) {
  return (
    <View style={styles.footer}>
      {message && (
        <Text accessibilityRole={message.conflict ? 'alert' : undefined} accessibilityLiveRegion="polite"
          style={[screenText.body, message.conflict && styles.error]}>{message.text}</Text>
      )}
      {message?.conflict && <Button label="Reload latest" variant="secondary" onPress={onReload} />}
      <View style={styles.actions}>
        {dirty && <Button label="Discard" variant="secondary" disabled={disabled || saving} style={styles.grow} onPress={onDiscard} />}
        <Button label={dirty ? label : 'No unsaved changes'} loading={saving} disabled={!dirty || disabled || saving || message?.conflict}
          style={styles.grow} onPress={onSave} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: { gap: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  grow: { flexGrow: 1 },
  error: { color: colors.error },
});
