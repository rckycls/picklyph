import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'PicklyPH',
  slug: 'picklyph',
  version: '0.1.0',
  scheme: 'picklyph',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  platforms: ['ios', 'android'],
  backgroundColor: '#F6F8FB',
  plugins: ['expo-router'],
  experiments: {
    typedRoutes: true,
  },
  ios: {
    supportsTablet: true,
  },
};

export default config;
