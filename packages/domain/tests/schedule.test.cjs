/* global __dirname */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { readVenueSchedule, resolveVenueSchedule, readScheduleSave, readScheduleQuery } = require('../src/schedule.ts');
const window = (a,b,c=25000) => ({ start_minute:a,end_minute:b,rates:[{start_minute:a,end_minute:b,hourly_centavos:c}] });
const blank = () => ({weekly:Array.from({length:7},()=>[]),exceptions:[]});
const interval = (a,b,c=25000) => ({starts_at:a,ends_at:b,hourly_centavos:c});

test('same-day rate bands, closed days and exact safe centavos resolve to half-open UTC intervals', () => {
  const s=blank(); s.weekly[1]=[window(480,600)]; s.weekly[1][0].rates=[
    {start_minute:480,end_minute:540,hourly_centavos:0}, {start_minute:540,end_minute:600,hourly_centavos:Number.MAX_SAFE_INTEGER}];
  assert.deepEqual(resolveVenueSchedule(s,'2026-10-05',2),[
    interval('2026-10-05T00:00:00.000Z','2026-10-05T01:00:00.000Z',0),
    interval('2026-10-05T01:00:00.000Z','2026-10-05T02:00:00.000Z',Number.MAX_SAFE_INTEGER)]);
});
test('overnight Saturday/Sunday and year/leap boundaries include previous-day spill and clip the query range', () => {
  const s=blank(); s.weekly[6]=[window(1320,1560)];
  assert.deepEqual(resolveVenueSchedule(s,'2026-10-04',1),[interval('2026-10-03T16:00:00.000Z','2026-10-03T18:00:00.000Z')]);
  s.exceptions=[{date:'2026-12-31',windows:[window(1410,1470)]},{date:'2024-02-28',windows:[window(1410,1470)]}];
  assert.equal(resolveVenueSchedule(s,'2027-01-01',1)[0].ends_at,'2026-12-31T16:30:00.000Z');
  assert.equal(resolveVenueSchedule(s,'2024-02-29',1)[0].ends_at,'2024-02-28T16:30:00.000Z');
});
test('closure suppresses spill-in; special hours replace the entire civil date at their own rate', () => {
  const s=blank(); s.weekly[1]=[window(1320,1560)];
  s.exceptions=[{date:'2026-10-06',windows:[]}];
  assert.deepEqual(resolveVenueSchedule(s,'2026-10-06',1),[]);
  s.exceptions[0].windows=[window(60,180,30000)];
  assert.deepEqual(resolveVenueSchedule(s,'2026-10-06',1),[interval('2026-10-05T17:00:00.000Z','2026-10-05T19:00:00.000Z',30000)]);
});
test('overnight overlaps, exception spill collisions, rate gaps and malformed rules fail', () => {
  const cases=[];
  const cyclic=blank(); cyclic.weekly[6]=[window(1320,1560)]; cyclic.weekly[0]=[window(60,180)]; cases.push(cyclic);
  const special=blank(); special.weekly[3]=[window(60,180)]; special.exceptions=[{date:'2026-10-06',windows:[window(1320,1560)]}]; cases.push(special);
  for(const mutate of [
    s=>s.weekly.pop(), s=>s.weekly[1].push(window(480,500)), s=>s.weekly[1].push(window(480,480)),
    s=>s.weekly[1].push(window(480,1950)), s=>s.weekly[1].push(window(1440,1500)),
    s=>s.weekly[1].push(window(480,600,-1)), s=>s.weekly[1].push(window(480,600,0.5)),
    s=>s.weekly[1].push(window(480,600,Number.MAX_SAFE_INTEGER+1)),
    s=>{s.weekly[1]=[window(480,600)];s.weekly[1][0].rates[0].end_minute=570;},
    s=>{s.weekly[1]=[window(480,600)];s.weekly[1][0].rates[0].start_minute=510;},
    s=>s.weekly[1].push(window(480,600),window(570,630)),
    s=>s.exceptions.push({date:'2026-02-29',windows:[]}),
    s=>s.exceptions.push({date:'2026-10-06',windows:[]},{date:'2026-10-06',windows:[]}),
    s=>s.weekly[1].push({...window(480,600),actor_user_id:'spoof'}),
  ]){const s=blank();mutate(s);cases.push(s);}
  for(const s of cases)assert.throws(()=>readVenueSchedule(s));
});
test('strict commands/queries preserve string revisions and bound dates/day counts', () => {
  const id='62000000-0000-4000-8000-000000000001'; const s=blank();
  assert.equal(readScheduleSave({venue_id:id,expected_revision:'123',schedule:s}).expected_revision,'123');
  assert.throws(()=>readScheduleSave({venue_id:id,expected_revision:123,schedule:s}));
  assert.throws(()=>readScheduleSave({venue_id:id,expected_revision:null,schedule:s,actor_user_id:id}));
  assert.equal(readScheduleQuery(new URLSearchParams({venue_id:id,start_date:'2026-10-05',days:'31'})).days,31);
  for(const [date,days] of [['2026-02-30',1],['1999-12-31',1],['2099-12-31',2],['2026-10-05',32],['2026-10-05',0]])
    assert.throws(()=>resolveVenueSchedule(s,date,days));
});
test('resolver is independent of host timezone', () => {
  const code=`const {resolveVenueSchedule}=require('./packages/domain/src/schedule.ts'); const s=${JSON.stringify({...blank(),weekly:[[],[window(1320,1560)],[],[],[],[],[]]})}; process.stdout.write(JSON.stringify(resolveVenueSchedule(s,'2026-10-05',2)));`;
  const outputs=['UTC','America/New_York','Asia/Tokyo'].map(TZ=>execFileSync(process.execPath,['-e',code],{cwd:require('node:path').resolve(__dirname,'../../..'),env:{...process.env,TZ},encoding:'utf8'}));
  assert.equal(outputs[0],outputs[1]); assert.equal(outputs[0],outputs[2]);
});
