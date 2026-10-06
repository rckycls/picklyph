import type { ExpoConfig } from 'expo/config';

const iosMapsKey = process.env.GOOGLE_MAPS_IOS_API_KEY?.trim();
const mapsConfigured = Boolean(iosMapsKey && !/REPLACE_WITH_|YOUR_/i.test(iosMapsKey));
const easProjectId = process.env.EAS_PROJECT_ID?.trim() || 'c856cbf6-f323-41b7-9e1a-76ef6f5f2146';

// Source checks work without credentials; an iPhone binary must include Google Maps.
if (process.env.EAS_BUILD_PLATFORM === 'ios' && !mapsConfigured) {
  throw new Error('Set GOOGLE_MAPS_IOS_API_KEY in the selected EAS environment before building iOS.');
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
  backgroundColor: '#F6F8FB',
  plugins: [
    'expo-router',
    'expo-dev-client',
    'expo-apple-authentication',
    ['expo-secure-store', { faceIDPermission: false }],
    ['react-native-maps', mapsConfigured ? { iosGoogleMapsApiKey: iosMapsKey } : {}],
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
    maps: { iosGoogleMapsConfigured: mapsConfigured },
    eas: { projectId: easProjectId },
  },
  experiments: {
    typedRoutes: true,
  },
  ios: {
    bundleIdentifier: process.env.IOS_BUNDLE_IDENTIFIER?.trim() || 'com.rckycls.picklyph',
    supportsTablet: true,
    usesAppleSignIn: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
};

export default config;
