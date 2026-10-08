const assert=require('node:assert/strict'); const {test}=require('node:test');
const {readSessionCreate,readSessionCommand,readSessionQuery}=require('../src/session.ts');
const id='c5000000-0000-4000-8000-000000000001';const other='c5000000-0000-4000-8000-000000000002';
const input=()=>({venue_id:id,request_id:id,court_ids:[other,id],title:' Open play ',starts_at:'2026-10-09T18:00:00+08:00',ends_at:'2026-10-10T00:00:00+08:00',capacity:12,group_limit:4,price_centavos:25000});
test('sessions canonicalize court order, exact centavos and offset instants without accepting caller authority',()=>{
  const saved=readSessionCreate(input());assert.deepEqual(saved.court_ids,[id,other]);assert.equal(saved.title,'Open play');assert.equal(saved.ends_at,'2026-10-09T16:00:00.000Z');
  assert.deepEqual(readSessionCommand({kind:'create',...input()}),{kind:'create',command:saved});
  for(const delta of [{actor_user_id:id},{policy:{}},{capacity:201},{capacity:0},{group_limit:13},{group_limit:0},{price_centavos:0.5},{price_centavos:-1},
    {price_centavos:Number.MAX_SAFE_INTEGER},{court_ids:[id,id.toUpperCase()]},{court_ids:[]},{starts_at:'2026-10-09T18:15:00+08:00'},{starts_at:'2026-10-09T18:00:00'},
    {ends_at:'2026-10-11T00:00:00+08:00'},{title:'\nOpen play'}]) assert.throws(()=>readSessionCreate({...input(),...delta}));
  assert.equal(readSessionCreate({...input(),capacity:1,group_limit:1,price_centavos:Number.MAX_SAFE_INTEGER}).price_centavos,Number.MAX_SAFE_INTEGER);
  assert.equal(readSessionCreate({...input(),price_centavos:0}).price_centavos,0);
  assert.deepEqual(readSessionQuery(new URLSearchParams({venue_id:id})),{venue_id:id,after_id:null});
  for(const params of [`venue_id=${id}&venue_id=${id}`,`venue_id=${id}&limit=100`,`venue_id=${id}&after_id=bad`]) assert.throws(()=>readSessionQuery(new URLSearchParams(params)));
});
