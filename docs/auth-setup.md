# Mobile authentication (T07)

PicklyPH uses native Sign in with Apple and email verification codes through
Supabase Auth. Discover stays public. Bookings requires a restored session;
signed-out users see the sign-in screen. Booking records and owner permissions
are later tasks. Client display metadata never grants an owner/admin role.

## Staging setup

The app reads the hosted staging URL and publishable key from ignored
`.env.local` and EAS development. Local Docker settings below do **not** change
hosted Auth. Never put a secret/service-role key or SMTP password in Expo env.

### Apple

1. In staging Supabase's Authentication → Sign In / Providers, enable Apple.
2. Add `com.rckycls.picklyph` to Apple's Client IDs / accepted audiences and save.
   If you deliberately changed the bundle identifier, use that exact value in
   Supabase and `IOS_BUNDLE_IDENTIFIER` before rebuilding.
3. Ensure the Apple Developer App ID has Sign in with Apple enabled. The source
   sets `ios.usesAppleSignIn` and the Expo Apple plugin; native introspection
   produces `com.apple.developer.applesignin: ["Default"]`. EAS can synchronize
   the capability during interactive signing setup. Regenerate the development
   provisioning profile if it predates the entitlement.
4. Install a **new development build** of this app on the registered iPhone.
   The T04 binary lacks the new native dependencies. Use that build rather than
   Expo Go for audience, provisioning and persistence acceptance.

This flow exchanges the native Apple ID token with Supabase. Native-only Apple
sign-in does not require an OAuth Services ID or its periodically rotated client
secret. Those are needed if web/OAuth sign-in is added later. The app passes a
SHA-256 nonce to Apple's native request and its original value to Supabase.
Apple supplies the name only at first authorization; the app saves it as optional
display metadata. Apple's private relay email is supported.
See [Supabase native Apple setup](https://supabase.com/docs/guides/auth/social-login/auth-apple)
and [Expo Apple authentication](https://docs.expo.dev/versions/v57.0.0/sdk/apple-authentication/).

### Email codes

1. Keep Email enabled and email confirmation required; permit new signups for
   the staging trial.
2. In Authentication → Email Templates, copy
   [`supabase/templates/email-code.html`](../supabase/templates/email-code.html)
   into **both Confirm signup and Magic link**, with subject
   `Your PicklyPH sign-in code`. The body must include `{{ .Token }}`.
   New and returning users should both receive a code they enter in the app.
3. Set Email OTP length to **6 digits**, expiry to **600 seconds**, and the
   minimum resend interval to **60 seconds**, matching local config. The input
   tolerates 6–10 digits if an existing hosted project has a longer code.
4. For initial testing with Supabase's default sender, use an organization team
   member's email. For other tester/player addresses, configure custom SMTP in
   Supabase with a verified sending domain. Keep SMTP credentials in provider
   configuration. Default delivery is restricted to team addresses and currently
   capped at two messages/hour, so a 60-second UI cooldown does not override the
   project's overall delivery limits.

The app requests `signInWithOtp` with `shouldCreateUser: true` and verifies with
`verifyOtp({ type: 'email' })`; it requires a returned session. This code flow
does not use emailed deep links or make redirects proof of authentication.
See [Supabase email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless)
and [SMTP requirements](https://supabase.com/docs/guides/auth/auth-smtp).

## Session behavior

- Native sessions use Expo SecureStore with device-only, unlocked Keychain
  access. A serialized adapter chunks Unicode payloads below 2KB and commits a
  manifest after all chunks are stored. Failed writes preserve the previous
  session; removing the manifest first prevents partial cleanup restoring it.
  Corrupt persistence offers retry/clear after the SDK read finishes.
- The Supabase singleton restores before private routes open. Auth events take
  precedence over an older restoration read. Refresh runs in the foreground and
  stops in the background; subscriptions are cleaned up on provider unmount.
- Requests have a 15-second deadline; a 12-second restoration notice lets the
  user retry while Discover remains accessible. The clear action is withheld
  while the original SDK read is still pending.
- Local sign-out clears this device's session. Other devices remain signed in.
  An offline revocation error is treated as success only when the SDK confirms
  this device no longer has a session.
- SDK 2.117.2 uses its default lockless coordination and session commit guards.
  Deprecated custom `processLock` is deliberately omitted. The web fallback
  uses memory only; persistent web authentication is outside this iOS task.

See [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/),
[Supabase SDK coordination migration](https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/migrations/lockless-coordination.md),
and [Expo Router protected routes](https://docs.expo.dev/router/advanced/protected/).
Router guards are UI navigation controls; future database operations must also
enforce verified user access with RLS/server authorization (T08 onward).

## Verification

```powershell
npm run test:auth
npm run test:directory
npm run typecheck
npm run lint
npx expo-doctor
npm run bundle:ios
```

For a disposable local stack with Docker running:

```powershell
npx supabase start
npm run test:auth:local
```

The local test reads CLI credentials in memory, enforces loopback ports, sends
only to Mailpit, and exercises new/returning users, wrong codes, verification,
secure-adapter restoration, real token refresh and persistent sign-out. It
removes its own users/messages. It never reads the mobile environment or sends
hosted emails. Native Keychain, Apple credentials and actual UI rendering still
need the device checks below. Local credentials printed by the CLI are private;
do not copy its full status/start output into chat.

Build after native dependency/config changes:

```powershell
npx eas-cli@latest build --platform ios --profile development
npx expo start --dev-client
```

If EAS requests Apple login/capability/profile setup, complete it interactively
in your terminal. No Apple passwords, certificates or tokens belong in chat.

## H05: iPhone acceptance

Record pass/fail and concise reproduction steps; do not share email codes or
tokens. Automated bundle/config tests alone do not satisfy this checklist.

1. Signed out: app opens Discover; map browsing works. Bookings prompts sign-in;
   opening `picklyph://bookings` cannot show private booking content. Account
   offers Apple/email. Missing Supabase configuration still allows discovery.
2. Email: request a code, enter a wrong code, recover with the correct code.
   Test an expired code separately; resend after the cooldown and verify the
   newly received code. Changing email returns to entry. Test new and existing
   accounts using the appropriate hosted templates.
3. Apple: cancel once, then sign in successfully. Exercise Hide My Email if
   available; Account shows the signed-in identity and Bookings opens.
4. Force-close/relaunch after each provider: the same account restores without
   exposing private content during restoration. Background/foreground the app;
   verify refresh across an expired access token using a staging-only short
   token lifetime if needed, then restore the normal server setting.
5. Sign out, force-close/relaunch, and reopen a booking deep link: it requires
   sign-in again. Also try sign-out offline and confirm no local session returns.
6. Check keyboard/scrolling, large text, VoiceOver labels/error announcements
   and the Apple button on the physical device. T02 navigation acceptance is
   still pending until reported.

At implementation time, hosted Auth health responded successfully, Email was
enabled and Apple was disabled. No hosted provider/template changes or iPhone
auth acceptance have been claimed. T07 stays open until H05 passes.
