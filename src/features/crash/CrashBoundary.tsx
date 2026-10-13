import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/Button';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { recordCrash } from './crashLive';

type Props = { children: ReactNode };
type State = { failed: boolean };

/**
 * Root boundary (T51d): a screen that fails to render is reported with its component stack and replaced by a way back,
 * instead of a blank app. Try again remounts everything below it, so saved sign-ins and recovery journals reload.
 */
export class CrashBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void recordCrash(error, 'render', info.componentStack ?? null);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.content} accessibilityRole="alert">
          <Text accessibilityRole="header" style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            This screen stopped working. A report without your details is on its way to us so we can fix it.
            Try again, and if it keeps happening, close and reopen the app.
          </Text>
          <Button label="Try again" onPress={() => this.setState({ failed: false })} />
        </View>
      </SafeAreaView>
    );
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, justifyContent: 'center' },
  content: { paddingHorizontal: 24, gap: 16, maxWidth: 520, width: '100%', alignSelf: 'center' },
  title: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 22, lineHeight: 29, letterSpacing: -0.4 },
  body: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 15, lineHeight: 24 },
});
