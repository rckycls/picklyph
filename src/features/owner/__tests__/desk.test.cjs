const assert=require('node:assert/strict');const {test}=require('node:test');
const {rental,domain,ops,walkIns,desk}=require('./deskHelpers.cjs');
const {client:rentalClient,VENUE,COURT,ID,booking,plain,response,memory}=rental;
const GROUP='c3100000-0000-4000-8000-000000000001';const SESSION='c3100000-0000-4000-8000-000000000002';
const group=(delta={})=>({id:GROUP,session_id:SESSION,source:'walk_in',status:'confirmed',payment_method:'arrival',payment_status:'unpaid',
  operations:{attendance:'none',attendance_at:null,payment:null},participants:['Ana','Ben'],spots:2,expires_at:null,
  created_at:'2026-10-10T01:00:00.123456+00:00',updated_at:'2026-10-10T01:00:00.123456+00:00',
  snapshot:{venue_id:VENUE,title:'Evening play',court_ids:[COURT],starts_at:'2026-10-10T10:00:00+00:00',ends_at:'2026-10-10T12:00:00+00:00',
    price_centavos:25000,spots:2,total_centavos:50000,currency:'PHP',timezone:'Asia/Manila',policy:{confirmation:'instant',payment:'arrival',merchant_active:false},
    policy_revision:'0',approval_hold_minutes:120,payment_hold_minutes:15,refund_cutoff_hours:24},...delta});
const paid={method:'cash',amount_centavos:70000,recorded_at:'2026-10-10T10:05:00.654321+00:00'};
const entry=()=>({...booking(),source:'owner',guest_name:'Wei'});
const transports=fetch=>({rental:{...rental.transport(fetch),endpoint:'https://desk.test/rental-bookings'},group:{...rental.transport(fetch),endpoint:'https://desk.test/session-bookings'}});
test('records parse strictly: payment equals the saved total and agrees with payment_status; owner entries carry a guest label',()=>{
  const b=rentalClient.parseBooking({...booking(),payment_status:'paid',operations:{attendance:'completed',attendance_at:'2026-10-10T11:00:00Z',payment:paid}});
  assert.equal(b.payment_status,'paid');assert.equal(b.operations.payment.recorded_at,'2026-10-10T10:05:00.654Z');assert.equal(b.operations.attendance,'completed');
  assert.equal(rentalClient.parseBooking(entry()).guest_name,'Wei');
  for(const raw of [{...booking(),payment_status:'paid'},{...booking(),operations:{attendance:'none',attendance_at:null,payment:paid}},
    {...booking(),payment_status:'paid',operations:{attendance:'none',attendance_at:null,payment:{...paid,amount_centavos:69999}}},
    {...booking(),payment_status:'paid',operations:{attendance:'none',attendance_at:null,payment:{...paid,method:'gcash'}}},
    {...booking(),operations:{attendance:'checked_in',attendance_at:null,payment:null}},{...booking(),operations:{attendance:'none',attendance_at:'2026-10-10T10:00:00Z',payment:null}},
    {...booking(),operations:undefined},{...booking(),guest_name:'Wei'},{...entry(),guest_name:null},{...entry(),guest_name:' Wei '},{...entry(),source:'admin'},
    {...booking('pending'),source:'owner',guest_name:'Wei'}]) assert.throws(()=>rentalClient.parseBooking(raw));
  assert.equal(walkIns.parseSessionBooking(group({payment_status:'paid',operations:{attendance:'none',attendance_at:null,payment:{...paid,amount_centavos:50000}}})).payment_status,'paid');
});
test('day reads keep confirmed bookings of that Manila date and venue; requests keep pending player bookings',async()=>{
  let reply;let url;const t=transports(async(u)=>{url=u;return response(reply);});
  reply={venue_id:VENUE,date:'2026-10-10',at:'2026-10-10T10:30:00.123456+00:00',bookings:[booking()],next_cursor:null};
  const day=await desk.loadDay(t,'rental',VENUE,'2026-10-10',null);assert.equal(day.ok,true);assert.equal(day.value.at,'2026-10-10T10:30:00.123Z');
  assert.equal(new URL(url).pathname,'/rental-bookings');assert.deepEqual(Object.fromEntries(new URL(url).searchParams),{section:'day',venue_id:VENUE,date:'2026-10-10'});
  for(const bad of [{...reply,date:'2026-10-11'},{...reply,bookings:[booking('cancelled')]},{...reply,venue_id:COURT},{...reply,at:'soon'},
    {...reply,bookings:[{...booking(),allocation:{...booking().allocation,venue_id:COURT},snapshot:{...booking().snapshot,venue_id:COURT}}]}]){
    reply=bad;assert.equal((await desk.loadDay(t,'rental',VENUE,'2026-10-10',null)).failure.kind,'unavailable');
  }
  reply={venue_id:VENUE,date:'2026-10-11',at:'2026-10-10T10:30:00Z',bookings:[booking()],next_cursor:null};
  assert.equal((await desk.loadDay(t,'rental',VENUE,'2026-10-11',null)).failure.kind,'unavailable');
  assert.throws(()=>desk.loadDay(t,'rental',VENUE,'2026-02-30',null));
  reply={venue_id:VENUE,date:'2026-10-10',at:'2026-10-10T10:30:00Z',bookings:[group()],next_cursor:null};
  assert.equal((await desk.loadDay(t,'group',VENUE,'2026-10-10',null)).value.bookings[0].kind,'group');assert.equal(new URL(url).pathname,'/session-bookings');
  reply={bookings:[booking('pending')],next_cursor:null};assert.equal((await desk.loadRequests(t,'rental',VENUE,null)).ok,true);
  reply={bookings:[booking()],next_cursor:null};assert.equal((await desk.loadRequests(t,'rental',VENUE,null)).failure.kind,'unavailable');
  reply={bookings:[group({source:'walk_in',status:'confirmed'})],next_cursor:null};assert.equal((await desk.loadRequests(t,'group',VENUE,null)).failure.kind,'unavailable');
});
test('decisions and records send only the command and accept only a matching result',async()=>{
  let reply;let sent;const t=transports(async(u,init)=>{sent=JSON.parse(init.body);return response(reply);});
  reply={outcome:'changed',booking:booking()};const accepted=await desk.decide(t,'rental',ID,'accept');assert.equal(accepted.ok,true);assert.deepEqual(sent,{kind:'accept',booking_id:ID});
  reply={outcome:'expired',booking:booking('expired')};assert.equal((await desk.decide(t,'rental',ID,'accept')).ok,true);
  reply={outcome:'changed',booking:booking()};assert.equal((await desk.decide(t,'rental',ID,'decline')).failure.kind,'unavailable');
  const pay={kind:'record_payment',booking_id:ID,method:'cash',amount_centavos:70000};
  reply={outcome:'changed',booking:{...booking(),payment_status:'paid',operations:{attendance:'none',attendance_at:null,payment:paid}}};
  assert.equal((await desk.operate(t,'rental',pay)).ok,true);assert.deepEqual(sent,pay);
  assert.equal((await desk.operate(t,'rental',{...pay,method:'card'})).failure.kind,'unavailable');
  reply={outcome:'existing',booking:{...booking(),operations:{attendance:'completed',attendance_at:'2026-10-10T11:00:00Z',payment:null}}};
  assert.equal((await desk.operate(t,'rental',{kind:'check_in',booking_id:ID})).ok,true);
  assert.equal((await desk.operate(t,'rental',{kind:'no_show',booking_id:ID})).failure.kind,'unavailable');
  assert.throws(()=>desk.operate(t,'rental',{...pay,amount_centavos:-1}));
  reply={error:'not_started'};const early=transports(async()=>response(reply,409));
  assert.deepEqual(plain((await desk.operate(early,'group',{kind:'check_in',booking_id:GROUP})).failure),{kind:'rejected',reason:'not_started',retryAfterSeconds:null});
  assert.match(desk.deskFailureMessage({kind:'rejected',reason:'not_started',retryAfterSeconds:null}),/start time/);
});
test('outside rentals are durable before dispatch and retried unchanged until a definitive reply',async()=>{
  const q=rental.quote();const store=memory();const journal=desk.createEntryJournal(store,'pickly.test.owner');
  const command=domain.readRentalCommand({kind:'owner_entry',court_id:COURT,starts_at:q.starts_at,ends_at:q.ends_at,request_id:rental.REQUEST,guest_name:' Wei ',expected_quote:q.expected_quote});
  let replies=[null,{outcome:'existing',booking:entry()}];const bodies=[];
  const t=transports(async(u,init)=>{bodies.push(init.body);const next=replies.shift();if(!next)throw new TypeError('offline');return response(next);});
  const lost=await journal.run(command,c=>desk.enterOutsideRental(t,c));assert.equal(lost.failure.kind,'network');
  assert.deepEqual(store.operations,['persist']);assert.deepEqual(plain(await journal.read()),plain(command));
  await assert.rejects(journal.run({...command,guest_name:'Mei'},c=>desk.enterOutsideRental(t,c)),/original outside booking/);
  const again=await journal.run(command,c=>desk.enterOutsideRental(t,c));assert.equal(again.ok,true);assert.equal(again.value.booking.source,'owner');
  assert.equal(bodies[0],bodies[1]);assert.equal(await journal.read(),null);
  replies=[{outcome:'created',booking:{...entry(),guest_name:'Mei'}}];assert.equal((await journal.run(command,c=>desk.enterOutsideRental(t,c))).failure.kind,'unavailable');
  assert.notEqual(await journal.read(),null);
  replies=[{outcome:'created',booking:booking()}];await store.remove('pickly.test.owner.owner-entry-attempt');
  assert.equal((await desk.enterOutsideRental(t,command)).failure.kind,'unavailable');
});
test('desk guidance: start-gated actions, date stepping and start-ordered merging',()=>{
  const none={attendance:'none',attendance_at:null,payment:null};
  assert.deepEqual(plain(ops.availableOperations(none,false)),{checkIn:false,noShow:false,complete:false,pay:false});
  assert.deepEqual(plain(ops.availableOperations(none,true)),{checkIn:true,noShow:true,complete:false,pay:true});
  assert.deepEqual(plain(ops.availableOperations({...none,payment:paid},true)),{checkIn:true,noShow:false,complete:false,pay:false});
  assert.deepEqual(plain(ops.availableOperations({attendance:'checked_in',attendance_at:'x',payment:null},true)),{checkIn:false,noShow:false,complete:true,pay:true});
  assert.deepEqual(plain(ops.availableOperations({attendance:'no_show',attendance_at:'x',payment:null},true)),{checkIn:false,noShow:false,complete:false,pay:false});
  assert.equal(desk.shiftDate('2028-02-28',1),'2028-02-29');assert.equal(desk.shiftDate('2026-01-01',-1),'2025-12-31');assert.throws(()=>desk.shiftDate('2099-12-31',1));
  const late={kind:'group',booking:walkIns.parseSessionBooking(group())};const early={kind:'rental',booking:rentalClient.parseBooking(booking())};
  const merged=desk.mergeDesk([late],{at:null,bookings:[early,late],next_cursor:null},'x');assert.deepEqual(plain(merged.map(b=>b.kind)),['rental','group']);
  assert.equal(desk.mergeDesk([late],{at:null,bookings:[],next_cursor:null},null).length,0);assert.equal(desk.shortReference(ID),ID.slice(0,8).toUpperCase());
});
