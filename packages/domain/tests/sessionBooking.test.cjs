const assert=require('node:assert/strict'); const {test}=require('node:test');
const {readSessionBookingCommand,readSessionBookingQuery,readParticipantNames,sessionGroupTotal}=require('../src/sessionBooking.ts');
const id='c6000000-0000-4000-8000-000000000001';
const request=()=>({kind:'request',session_id:id.toUpperCase(),request_id:id,participants:[' Ana ','Ben'],expected_total_centavos:50000});
test('group requests trim ordered names, normalize IDs and reject caller authority, duplicates and unsafe totals',()=>{
  assert.deepEqual(readSessionBookingCommand(request()),{kind:'request',session_id:id,request_id:id,participants:['Ana','Ben'],expected_total_centavos:50000});
  for(const kind of ['accept','decline','cancel']) assert.deepEqual(readSessionBookingCommand({kind,booking_id:id}),{kind,booking_id:id});
  assert.equal(readParticipantNames(['Ñino 李',`${'a'.repeat(60)}`]).length,2);
  assert.equal(readParticipantNames(Array.from({length:200},(_,i)=>`P${i}`)).length,200);
  for(const delta of [{actor_user_id:id},{policy:{}},{price_centavos:25000},{spots:2},{participants:[]},{participants:['Ana','ana']},
    {participants:['  ']},{participants:['a'.repeat(61)]},{participants:['Ana\nBen']},{participants:[1]},{participants:'Ana'},
    {participants:Array.from({length:201},(_,i)=>`P${i}`)},{expected_total_centavos:0.5},{expected_total_centavos:-1},
    {expected_total_centavos:'50000'},{expected_total_centavos:Number.MAX_SAFE_INTEGER+1},{session_id:'nope'}])
    assert.throws(()=>readSessionBookingCommand({...request(),...delta}));
  for(const body of [{kind:'accept',booking_id:id,actor_user_id:id},{kind:'expire',booking_id:id},{kind:'walk_in',booking_id:id},[]])
    assert.throws(()=>readSessionBookingCommand(body));
  assert.equal(sessionGroupTotal(25000,4),100000);assert.equal(sessionGroupTotal(0,3),0);
  for(const [price,spots] of [[Number.MAX_SAFE_INTEGER,2],[0.5,1],[100,0]]) assert.throws(()=>sessionGroupTotal(price,spots));
});
test('session booking reads are bounded to offers, one session, own history, owner requests or one booking',()=>{
  const query=text=>readSessionBookingQuery(new URLSearchParams(text));
  assert.deepEqual(query(`section=sessions&venue_id=${id}`),{section:'sessions',venue_id:id,after_id:null});
  assert.deepEqual(query(`section=requests&venue_id=${id}&after_id=${id}`),{section:'requests',venue_id:id,after_id:id});
  assert.deepEqual(query('section=history'),{section:'history',after_id:null});
  assert.deepEqual(query(`section=session&session_id=${id}`),{section:'session',session_id:id});
  assert.deepEqual(query(`section=booking&booking_id=${id}`),{section:'booking',booking_id:id});
  for(const text of ['section=history&actor_user_id='+id,'section=history&section=history','section=sessions',`section=session&session_id=${id}&after_id=${id}`,
    `section=booking&booking_id=${id}&venue_id=${id}`,'section=history&after_id=','section=roster&session_id='+id,'']) assert.throws(()=>query(text));
});
