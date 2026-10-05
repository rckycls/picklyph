const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(path.dirname(module.filename), '../../../..');
const source = fs.readFileSync(path.join(root, 'app.config.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function config(env) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, process: { env } });
  return module.exports.default;
}

test('iPhone cloud builds reject absent or placeholder Maps keys', () => {
  for (const key of ['', 'REPLACE_WITH_IOS_RESTRICTED_MAPS_KEY']) {
    assert.throws(() => config({ EAS_BUILD_PLATFORM: 'ios', GOOGLE_MAPS_IOS_API_KEY: key }), /Set GOOGLE_MAPS_IOS_API_KEY/);
  }
});

test('source checks work without credentials and expose only an unavailable-map flag', () => {
  const app = config({});
  assert.equal(app.extra.maps.iosGoogleMapsConfigured, false);
  assert.equal(app.ios.bundleIdentifier, 'com.rckycls.picklyph');
  const plugin = app.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'react-native-maps');
  assert.equal(Object.keys(plugin[1]).length, 0);
});

test('a build key reaches native Maps configuration without being copied into app extra', () => {
  const fixture = 'test-only-native-key-not-a-real-google-credential';
  const app = config({ EAS_BUILD_PLATFORM: 'ios', GOOGLE_MAPS_IOS_API_KEY: fixture });
  const plugin = app.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'react-native-maps');
  assert.equal(plugin[1].iosGoogleMapsApiKey, fixture);
  assert.equal(app.extra.maps.iosGoogleMapsConfigured, true);
  assert(!JSON.stringify(app.extra).includes(fixture));
});

test('location configuration requests foreground access without background or motion access', () => {
  const app = config({});
  const plugin = app.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-location');
  assert.equal(plugin[1].isIosBackgroundLocationEnabled, false);
  assert.equal(plugin[1].locationAlwaysAndWhenInUsePermission, false);
  assert.equal(plugin[1].locationAlwaysPermission, false);
  assert.equal(plugin[1].motionUsagePermission, false);
});

test('the development build profile targets a physical iPhone and its development environment', () => {
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8')).build.development;
  assert.equal(profile.developmentClient, true);
  assert.equal(profile.distribution, 'internal');
  assert.equal(profile.environment, 'development');
  assert.equal(profile.ios.simulator, false);
});
