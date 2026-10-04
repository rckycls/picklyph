import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors } from '@/theme/colors';

type ButtonVariant = 'primary' | 'accent' | 'secondary';

export type ButtonProps = Omit<
  PressableProps,
  'children' | 'style' | 'accessibilityRole' | 'accessibilityState'
> & {
  label: string;
  variant?: ButtonVariant;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
};

const variants = {
  primary: { backgroundColor: colors.primary, color: colors.onPrimary },
  accent: { backgroundColor: colors.accent, color: colors.onAccent },
  secondary: { backgroundColor: colors.selectedBackground, color: colors.selectedText },
} satisfies Record<ButtonVariant, { backgroundColor: string; color: string }>;

export function Button({
  label,
  variant = 'primary',
  loading = false,
  disabled = false,
  style,
  accessibilityLabel,
  onFocus,
  onBlur,
  ...props
}: ButtonProps) {
  const [focused, setFocused] = useState(false);
  const blocked = disabled || loading;
  const appearance = variants[variant];

  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: blocked, busy: loading }}
      disabled={blocked}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: appearance.backgroundColor },
        style,
        focused && styles.focused,
        pressed && !blocked && styles.pressed,
        blocked && styles.disabled,
      ]}
    >
      {loading && <ActivityIndicator color={appearance.color} accessible={false} />}
      <Text style={[styles.label, { color: appearance.color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'transparent',
    paddingHorizontal: 20,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  label: { fontSize: 15, lineHeight: 22, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  focused: { borderColor: colors.text },
  pressed: { transform: [{ scale: 0.98 }] },
  disabled: { borderStyle: 'dashed', borderColor: colors.textSecondary },
});
