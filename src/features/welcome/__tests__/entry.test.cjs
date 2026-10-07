const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const load = require('../../../../supabase/tests/load-ts.cjs');
const hookDriver = require('../../../components/mascot/__tests__/hookDriver.cjs');
const here = path.dirname(module.filename);
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };

function entry({ url = null, storage, initialFocused = true } = {}) {
  const d = hookDriver(); const listeners = new Set(); const navigation = []; let focused = initialFocused;
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react: d.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage ?? { getItem: async () => null, setItem: async () => {} } },
    'expo-router': { Redirect: 'redirect', router: { replace: value => navigation.push(value) }, useIsFocused: () => focused },
    'react-native': { ActivityIndicator: 'spinner', View: 'view', StyleSheet: { create: styles => styles }, Linking: {
      getInitialURL: async () => url, addEventListener: (_, fn) => { listeners.add(fn); return { remove: () => listeners.delete(fn) }; },
    } },
    'react-native-safe-area-context': {}, '@/components/mascot/PicklyMascot': {}, '@/components/ui/Button': {},
    '@/theme/colors': { colors: {} }, '@/theme/typography': { fonts: {} }, './state': load(path.join(here, '../state.ts')),
  };
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(here, '../FirstLaunchWelcome.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, Promise, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected import ${name}`); return imports[name];
  } });
  const api = module.exports;
  d.start(() => api.FirstLaunchWelcome({ children: 'discover' }));
  return { ...d, navigation, listeners,
    link() { for (const fn of listeners) fn({ url: 'picklyph://rental/booking/test' }); return d.flush(); },
    blur() { focused = false; return d.rerender(); },
    focus() { focused = true; return d.rerender(); },
    choose(choice) { api.WelcomeRoute().props.onChoose(choice); },
  };
}

test('ordinary launch redirects to a root welcome screen; both buttons continue immediately despite failed persistence', async () => {
  for (const choice of ['player', 'owner']) {
    const d = entry({ storage: { getItem: async () => null, setItem: async () => { throw new Error('offline'); } } });
    try {
      assert.equal(d.flush().type, 'view'); await d.settle(); assert.equal(d.flush().type, 'redirect');
      assert.equal(d.flush().props.href, '/welcome'); d.choose(choice);
      const target = d.navigation[0];
      if (choice === 'player') assert.equal(target, '/');
      else { assert.equal(target.pathname, '/account'); assert.equal(target.params.welcome, 'owner'); }
      await d.settle();
    } finally { d.close(); }
    assert.equal(d.listeners.size, 0);
  }
});

test('a deep link arriving during storage read or visible welcome dismisses the gate without redirecting', async () => {
  const reading = deferred();
  const d = entry({ storage: { getItem: () => reading.promise, setItem: async () => {} } });
  try {
    await d.settle(); assert.equal(d.link(), 'discover'); reading.resolve(null); await d.settle();
    assert.equal(d.flush(), 'discover'); assert.equal(d.navigation.length, 0);
  } finally { d.close(); }
  const visible = entry();
  try { await visible.settle(); assert.equal(visible.flush().type, 'redirect'); assert.equal(visible.link(), 'discover'); }
  finally { visible.close(); }
});

test('cold deep links, completed installs and background-mounted Discover never interrupt their destination', async () => {
  const linked = entry({ url: 'picklyph://rental/booking/test' });
  try { await linked.settle(); assert.equal(linked.flush(), 'discover'); } finally { linked.close(); }
  const returning = entry({ storage: { getItem: async () => 'done', setItem: async () => {} } });
  try { await returning.settle(); assert.equal(returning.flush(), 'discover'); } finally { returning.close(); }
  const reading = deferred(); const background = entry({ storage: { getItem: () => reading.promise, setItem: async () => {} } });
  try {
    background.blur(); reading.resolve(null); await background.settle();
    assert.equal(background.flush(), 'discover'); assert.equal(background.focus(), 'discover');
  } finally { background.close(); }
});
