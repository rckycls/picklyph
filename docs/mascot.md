# Pickly mascot

The four supplied mascot ZIP exports are design references. The app adapts their
SVG geometry and CSS keyframes into native SVG/Reanimated components; it does
not ship the HTML design runtime, vendored React, remote fonts or a WebView.
The existing Concept C palette and local Bricolage Grotesque fonts are reused.

## Component and motion

`PicklyMascot` accepts `pose`, `size` (height in logical pixels, default 160),
and `playback` (`loop`, `once`, `static`). Width is 90% of height, matching the
180 × 200 SVG viewBox. All ten reference poses are available: idle, wave, tip,
cheer, wink, thinking, surprised, oops, sleepy and star-struck.

Groups animate with numeric SVG matrices on the UI thread. The reference
timings/amplitudes are retained: 2.4-second bob/shadow, 4-second blink,
0.7-second wave, 1.1-second jump and the individual emotion/effect timings.
Once-playback cheer runs three jump cycles (3.3 seconds), then changes to a
resting idle pose. Looping animations pause without advancing time on blur or
background. Reduce Motion, including live setting changes, presents static
artwork with visible effects. Mascots ignore touches and are hidden from
screen-reader traversal; surrounding status text and actions remain accessible.

## Welcome and contextual behavior

- Discover's first-launch gate opens the root `/welcome` route, outside the
  tabs. Player continues to guest-capable Discover. Owner opens Account with
  an introduction and the existing sign-in/add-or-claim actions. It does not
  set owner context or grant access.
- AsyncStorage saves only `pickly.welcome.v1 = done`, once a choice is made.
  Completion is installation-local, not account-specific. Read errors still
  show welcome; write errors never delay navigation and suppress welcome for
  the rest of the current app session. Incoming application links bypass the
  gate without consuming first launch. Expo development-client launch URLs
  are treated as ordinary launches. URL events during startup dismiss the gate.
- Discovery shows thinking only after an empty initial search exceeds 600 ms;
  successful empty results show idle, errors show oops. Loaded/paginated results
  receive no mascot. The list uses 160 pixels; the map's results panel uses 64.
  Retry, throttling, filter clearing and widening controls retain their behavior.
- Empty successful booking history uses idle. Booking details show idle for
  pending requests, alongside the existing explicit pending/hold-end text.
- New successful reservation/recovery replies mark an in-memory celebration
  candidate. Details must receive a fresh server-confirmed record before
  consuming it. A freshly observed pending → confirmed transition also qualifies.
  Actor/booking keys prevent replay on refresh, navigation and recovery retries;
  existing confirmations on first read do not celebrate. Refresh failures,
  cancellation uncertainty and ended statuses do not celebrate. State is
  presentation-only and resets when the app process restarts.

Edge slide-ins, a persistent companion and the admin console are outside this
release. No backend or booking-authority changes are required.

## Checks and iPhone acceptance

Run `npm run test:mascot`, `npm run typecheck`, `npm run lint` and
`npm run bundle:ios`. Discovery, auth, account, owner and rental regression
suites remain relevant. Hook tests exercise shipped startup, loading-delay and
animation lifecycle code with deterministic ports; they are not native visual
evidence.

SVG 15.15.4 and AsyncStorage 2.2.0 are compatible with the installed Expo SDK
57 and require a new development binary. The [completed iPhone development build](https://expo.dev/accounts/rckycls/projects/picklyph/builds/5bbcd770-e262-449c-bac5-334bbf1d182c)
includes both modules. Install it on the already registered iPhone, then connect
to Metro with `npm start`. An ordinary first
launch will show welcome because previous versions did not save this key.

On the physical iPhone:

1. Check welcome with the smallest supported display and large Dynamic Type:
   speech, mascot and both buttons must fit or scroll; the tab bar is absent.
   Choose Player, confirm guest browsing, then relaunch: welcome stays dismissed.
   `/welcome` can be opened explicitly to review the owner branch; it does not
   clear completed onboarding. Sign in and verify add/claim actions remain the
   existing reviewer-checked flow.
2. On a fresh installation, cold-open a booking/account/owner deep link and
   confirm its destination is preserved. During startup, open another deep
   link and ensure no welcome redirect replaces it.
3. Compare the rendered geometry and motion to the supplied references.
   Existing mascot component props can be inspected/edited in React Native
   DevTools to review all ten poses on the phone without adding preview routes.
4. Exercise empty results, loading over 600 ms, errors, clear filters and
   widening; pan the map and verify controls/pins remain usable. Pagination
   failure with retained rows must not show an empty-state mascot.
5. Check empty booking history. Using a backend with the rental endpoints,
   create an instant-confirmed booking: three cheers, then idle. Refresh and
   reopen: no repeat cheer. Approval requests stay neutral; a fresh accepted
   status may cheer once. Failed/uncertain replies, cancellation and expiry
   must preserve accurate status and recovery controls. Hosted rental rollout
   remains a separate prerequisite; bundling does not verify it.
6. Switch tabs and background/foreground the app; motion pauses/resumes.
   Toggle Reduce Motion both before launch and while visible. Enable VoiceOver:
   no decorative duplicate announcements, and all buttons/statuses remain usable.

No web/localhost UI previews are used, per the existing project decision.
