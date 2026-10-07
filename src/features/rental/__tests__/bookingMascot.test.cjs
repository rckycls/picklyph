const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { load, booking } = require('./helpers.cjs');
const hookDriver = require('../../../components/mascot/__tests__/hookDriver.cjs');
const here = path.dirname(module.filename);

function mascot() {
  const d = hookDriver(); const apps = new Set(); let focused = true;
  const store = load(path.join(here, '../celebration.ts')).createCelebrations();
  const imports = {
    react: d.react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    'expo-router': { useIsFocused: () => focused },
    'react-native': { View: 'view', AppState: { currentState: 'active', addEventListener: (_, fn) => {
      apps.add(fn); return { remove: () => apps.delete(fn) }; } } },
    '@/components/mascot/PicklyMascot': { PicklyMascot: 'mascot' }, './celebration': { rentalCelebrations: store },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(here, '../BookingMascot.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Promise, require: name => imports[name] });
  let record = booking(); let fresh = true;
  d.start(() => module.exports.BookingMascot({ actor: 'player', booking: record, fresh }));
  return { ...d, store, apps,
    pose: () => d.flush()?.props.children.props.pose,
    update(value, current = true) { record = value; fresh = current; return d.rerender(); },
    focus(value) { focused = value; return d.rerender(); },
  };
}

test('rendered cheer ends on uncertainty and cannot replay when a refresh succeeds', async () => {
  const d = mascot();
  try {
    d.store.requested('player', booking()); await d.settle(); assert.equal(d.pose(), 'cheer');
    d.update(booking(), false); assert.equal(d.pose(), 'idle'); await d.settle();
    d.update(booking(), true); await d.settle(); assert.equal(d.pose(), 'idle');
    d.focus(false); d.focus(true); await d.settle(); assert.equal(d.pose(), 'idle');
    d.store.requested('player', booking()); d.update(booking()); await d.settle(); assert.equal(d.pose(), 'idle');
  } finally { d.close(); }
  assert.equal(d.apps.size, 0);
});

test('pending stays neutral, confirmation waits for focus, and cancelled records remove the mascot', async () => {
  const d = mascot();
  try {
    d.update(booking('pending')); await d.settle(); assert.equal(d.pose(), 'idle');
    d.focus(false); d.update(booking()); await d.settle(); assert.equal(d.pose(), 'idle');
    d.focus(true); await d.settle(); assert.equal(d.pose(), 'cheer');
    d.update(booking('cancelled')); assert.equal(d.flush(), null); await d.settle(); assert.equal(d.flush(), null);
  } finally { d.close(); }
});
