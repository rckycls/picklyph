import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

type Props = { disabled: boolean; onPress: () => void };
export function AppleSignInButton({ disabled, onPress }: Props) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void AppleAuthentication.isAvailableAsync().then((value) => { if (active) setAvailable(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!available) return null;
  return <View pointerEvents={disabled ? 'none' : 'auto'}>
    <AppleAuthentication.AppleAuthenticationButton
      buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
      cornerRadius={12}
      style={styles.button}
      accessibilityLabel="Sign in with Apple"
      accessibilityState={{ disabled }}
      onPress={() => { if (!disabled) onPress(); }}
    />
  </View>;
}
const styles = StyleSheet.create({ button: { width: '100%', height: 52 } });
