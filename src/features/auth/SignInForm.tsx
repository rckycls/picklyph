import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { colors } from '@/theme/colors';

import { normalizeEmail, validCode, validEmail } from './actions';
import { AppleSignInButton } from './AppleSignInButton';
import { useAuth } from './AuthProvider';

export function SignInForm() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setMessage(null);
    try { await action(); }
    catch (error) {
      if (alive.current) setMessage(error instanceof Error ? error.message : 'Sign-in didn’t complete. Please try again.');
    }
  };
  const send = () => run(async () => {
    const target = sentTo ?? normalizeEmail(email);
    await auth.requestCode(target);
    if (alive.current) {
      setSentTo(target);
      setCode('');
      setResendAt(Date.now() + 60000);
      setNow(Date.now());
    }
  });
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));

  if (auth.status === 'restoring') return <Card>
    <ActivityIndicator color={colors.primary} />
    <Text style={screenText.body} accessibilityLiveRegion="polite">Restoring your sign-in…</Text>
  </Card>;
  if (auth.status === 'error') return <Card>
    <Text style={screenText.body} accessibilityLiveRegion="polite">{auth.message}</Text>
    {message && <Text style={styles.error} accessibilityRole="alert">{message}</Text>}
    <Button label="Retry sign-in" onPress={auth.retry} disabled={auth.busy} />
    {auth.canClear && <>
      <Button label="Clear saved sign-in" variant="secondary" loading={auth.busy} onPress={() => void run(auth.clearSaved)} />
      <Text style={screenText.body}>Clearing removes this phone’s saved sign-in. Your account stays available.</Text>
    </>}
  </Card>;

  return <Card>
    <Text accessibilityRole="header" style={screenText.title}>Sign in to play.</Text>
    <Text style={screenText.body}>Use Apple or an email verification code. The same account works for players and court owners.</Text>
    {!sentTo && <AppleSignInButton disabled={auth.busy} onPress={() => void run(auth.signInApple)} />}
    {!sentTo ? <>
      <Field label="Email address" value={email} onChangeText={setEmail}
        autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
        autoComplete="email" textContentType="emailAddress" editable={!auth.busy}
        placeholder="you@example.com" returnKeyType="send" onSubmitEditing={() => { if (validEmail(normalizeEmail(email)) && !auth.busy) void send(); }} />
      <Button label="Send verification code" loading={auth.busy} disabled={!validEmail(normalizeEmail(email))} onPress={() => void send()} />
    </> : <>
      <Text style={screenText.body}>Check {sentTo} for your verification code.</Text>
      <Field label="Verification code" value={code} onChangeText={setCode}
        keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code"
        autoCapitalize="none" autoCorrect={false} editable={!auth.busy} maxLength={10}
        hint="Enter the code from your email. Codes expire; you can request another." />
      <Button label="Verify and sign in" loading={auth.busy} disabled={!validCode(code)}
        onPress={() => void run(() => auth.verifyCode(sentTo, code))} />
      <Button label={remaining ? `Resend code in ${remaining}s` : 'Resend code'} variant="secondary"
        disabled={auth.busy || remaining > 0} onPress={() => void send()} />
      <Button label="Use a different email" variant="secondary" disabled={auth.busy}
        onPress={() => { setSentTo(null); setCode(''); setMessage(null); }} />
    </>}
    {message && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{message}</Text>}
    <Text style={screenText.body}>You can keep browsing courts without signing in.</Text>
  </Card>;
}
const styles = StyleSheet.create({ error: { color: colors.error, fontSize: 15, lineHeight: 24 } });
