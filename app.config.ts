import type { ExpoConfig } from 'expo/config';
import environments from './release/environments.json';
import { checkMobileEnvironment } from './scripts/release/environment.cjs';

const iosMapsKey = process.env.GOOGLE_MAPS_IOS_API_KEY?.trim();
const mapsConfigured = Boolean(iosMapsKey && !/REPLACE_WITH_|YOUR_/i.test(iosMapsKey));
const easProjectId = process.env.EAS_PROJECT_ID?.trim() || 'c856cbf6-f323-41b7-9e1a-76ef6f5f2146';
// EAS build profiles set APP_VARIANT (eas.json); Metro and source checks default to development.
const appVariant = process.env.APP_VARIANT?.trim() || 'development';

// Source checks work without credentials; an iPhone binary must include Google Maps.
if (process.env.EAS_BUILD_PLATFORM === 'ios' && !mapsConfigured) {
  throw new Error('Set GOOGLE_MAPS_IOS_API_KEY in the selected EAS environment before building iOS.');
}
// Preview and production binaries embed their JavaScript, so the build worker refuses the other
// environment's backend or a server key before anything ships (T50b, docs/release.md).
if (process.env.EAS_BUILD_PLATFORM) {
  const { problems } = checkMobileEnvironment({ variant: appVariant, env: process.env, environments });
  if (problems.length) throw new Error(`The ${appVariant} build environment is not releasable:\n- ${problems.join('\n- ')}`);
}

const config: ExpoConfig = {
  name: 'PicklyPH',
  owner: 'rckycls',
  slug: 'picklyph',
  version: '0.1.0',
  scheme: 'picklyph',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  platforms: ['ios', 'android'],
  backgroundColor: '#F4F6FA',
  icon: './assets/brand/app-icon.png',
  plugins: [
    'expo-router',
    'expo-dev-client',
    'expo-apple-authentication',
    ['expo-secure-store', { faceIDPermission: false }],
    ['react-native-maps', mapsConfigured ? { iosGoogleMapsApiKey: iosMapsKey } : {}],
    // Owners pick one proof photo through the system picker; no camera or microphone use.
    ['expo-image-picker', {
      photosPermission: 'PicklyPH uses only the photo you choose as private proof that you own or manage a venue.',
      cameraPermission: false,
      microphonePermission: false,
    }],
    // Booking alerts (T43): adds the iOS push entitlement, so the next EAS build needs the push capability.
    // Ad hoc (preview) and App Store builds receive pushes through Apple's production gateway.
    ['expo-notifications', { mode: appVariant === 'development' ? 'development' : 'production' }],
    ['expo-location', {
      locationWhenInUsePermission: 'Allow PicklyPH to use your location to center the court map near you.',
      locationAlwaysPermission: false,
      locationAlwaysAndWhenInUsePermission: false,
      motionUsagePermission: false,
      isIosBackgroundLocationEnabled: false,
      isAndroidBackgroundLocationEnabled: false,
      isAndroidForegroundServiceEnabled: false,
    }],
  ],
  extra: {
    // Crash reports (T51d) say which build they came from; only preview and production builds alert.
    variant: appVariant,
    maps: { iosGoogleMapsConfigured: mapsConfigured },
    eas: { projectId: easProjectId },
  },
  experiments: {
    typedRoutes: true,
  },
  ios: {
    bundleIdentifier: process.env.IOS_BUNDLE_IDENTIFIER?.trim() || environments.iosBundleIdentifier,
    supportsTablet: true,
    usesAppleSignIn: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
};

export default config;
