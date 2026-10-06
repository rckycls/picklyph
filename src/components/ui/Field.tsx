import { useId, useState } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

export type FieldProps = Omit<TextInputProps, 'accessibilityState'> & {
  label: string;
  hint?: string;
  error?: string;
};

export function Field({
  label,
  hint,
  error,
  editable = true,
  style,
  accessibilityLabel,
  accessibilityHint,
  nativeID,
  onFocus,
  onBlur,
  ...props
}: FieldProps) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const message = error || hint;

  return (
    <View style={styles.container}>
      <Text nativeID={`${id}-label`} style={styles.label}>{label}</Text>
      <TextInput
        {...props}
        nativeID={nativeID ?? `${id}-input`}
        editable={editable}
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={error ? `Error: ${error}` : accessibilityHint ?? hint}
        accessibilityState={{ disabled: !editable }}
        aria-invalid={Boolean(error)}
        placeholderTextColor={colors.textSecondary}
        selectionColor={colors.primary}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          styles.input,
          style,
          !editable && styles.disabled,
          focused && styles.focused,
          Boolean(error) && styles.invalid,
        ]}
      />
      {message && (
        <Text accessibilityLiveRegion={error ? 'polite' : 'none'} style={[styles.hint, Boolean(error) && styles.error]}>
          {error ? `Error: ${error}` : message}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  label: { fontFamily: fonts.semibold, color: colors.text, fontSize: 14, lineHeight: 21 },
  input: {
    minHeight: 52,
    borderWidth: 2,
    borderColor: colors.textSecondary,
    borderRadius: 14,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  disabled: { backgroundColor: colors.background, borderStyle: 'dashed' },
  focused: { borderColor: colors.primary },
  invalid: { borderColor: colors.error },
  hint: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  error: { color: colors.error },
});
