const assert=require('node:assert/strict');const {test}=require('node:test');
const {rental,ops,walkIns,desk}=require('./deskHelpers.cjs');
const play=require('../../openPlay/__tests__/helpers.cjs');
const {client:rentalClient,model:rentalModel,VENUE,COURT,ID,booking,response}=rental;
const GROUP='c3100000-0000-4000-8000-000000000001';const SESSION='c3100000-0000-4000-8000-000000000002';
const group=(delta={})=>({id:GROUP,session_id:SESSION,source:'player',status:'confirmed',payment_method:'arrival',payment_status:'unpaid',
  operations:{attendance:'none',attendance_at:null,payment:null},participants:['Ana','Ben'],spots:2,expires_at:null,
  created_at:'2026-10-10T01:00:00.123456+00:00',updated_at:'2026-10-10T01:00:00.123456+00:00',
  snapshot:{venue_id:VENUE,title:'Evening play',court_ids:[COURT],starts_at:'2026-10-10T10:00:00+00:00',ends_at:'2026-10-10T12:00:00+00:00',
    price_centavos:25000,spots:2,total_centavos:50000,currency:'PHP',timezone:'Asia/Manila',policy:{confirmation:'instant',payment:'arrival',merchant_active:false},
    policy_revision:'0',approval_hold_minutes:120,payment_hold_minutes:15,refund_cutoff_hours:24},...delta});
const venueCancelled={reason:'weather',cancelled_at:'2026-10-09T02:00:00.123456+00:00'};
const transports=fetch=>({rental:{...rental.transport(fetch),endpoint:'https://desk.test/rental-bookings'},group:{...rental.transport(fetch),endpoint:'https://desk.test/session-bookings'}});

test('booking reads carry a venue cancellation only on cancelled bookings; older servers omit it',()=>{
  const cancelled={...booking('cancelled'),venue_cancellation:venueCancelled};
  assert.deepEqual(JSON.parse(JSON.stringify(rentalClient.parseBooking(cancelled).venue_cancellation)),{reason:'weather',cancelled_at:'2026-10-09T02:00:00.123Z'});
  assert.equal(rentalClient.parseBooking(booking()).venue_cancellation,null);
  assert.equal(rentalClient.parseBooking({...booking('cancelled'),venue_cancellation:null}).venue_cancellation,null);
  for(const raw of [{...booking(),venue_cancellation:venueCancelled},{...cancelled,venue_cancellation:{...venueCancelled,reason:'rain'}},
    {...cancelled,venue_cancellation:{reason:'weather'}},{...cancelled,venue_cancellation:'weather'}]) assert.throws(()=>rentalClient.parseBooking(raw));
  assert.equal(walkIns.parseSessionBooking(group({status:'cancelled',venue_cancellation:{...venueCancelled,reason:'venue_closed'}})).venue_cancellation.reason,'venue_closed');
  assert.throws(()=>walkIns.parseSessionBooking(group({venue_cancellation:venueCancelled})));
});
test('the desk offers cancellation only for confirmed player bookings before play with no desk records',()=>{
  const none={attendance:'none',attendance_at:null,payment:null};
  assert.equal(ops.canVenueCancel({source:'player',status:'confirmed',operations:none},false),true);
  for(const [b,started] of [[{source:'player',status:'confirmed',operations:none},true],[{source:'owner',status:'confirmed',operations:none},false],
    [{source:'walk_in',status:'confirmed',operations:none},false],[{source:'player',status:'pending',operations:none},false],
    [{source:'player',status:'cancelled',operations:none},false],[{source:'player',status:'confirmed',operations:{...none,attendance:'checked_in',attendance_at:'x'}},false],
    [{source:'player',status:'confirmed',operations:{...none,payment:{method:'cash',amount_centavos:1,recorded_at:'x'}}},false]]) assert.equal(ops.canVenueCancel(b,started),false);
});
test('venue cancellation posts one exact body and needs a cancelled reply that carries the venue cancellation',async()=>{
  let reply;const sent=[];const t=transports(async(url,init)=>{sent.push([new URL(url).pathname,JSON.parse(init.body)]);return response(reply);});
  reply={outcome:'changed',booking:{...booking('cancelled'),venue_cancellation:venueCancelled}};
  const done=await desk.venueCancel(t,'rental',ID.toUpperCase(),'weather');assert.equal(done.ok,true);assert.equal(done.value.booking.booking.venue_cancellation.reason,'weather');
  reply={outcome:'existing',booking:group({status:'cancelled',venue_cancellation:{...venueCancelled,reason:'maintenance'}})};
  assert.equal((await desk.venueCancel(t,'group',GROUP,'other')).value.booking.booking.venue_cancellation.reason,'maintenance','the first reason stands');
  assert.deepEqual(sent,[['/rental-bookings',{kind:'venue_cancel',booking_id:ID,reason:'weather'}],['/session-bookings',{kind:'venue_cancel',booking_id:GROUP,reason:'other'}]]);
  // A cancellation without the venue record (for example the player's own), or the wrong outcome, stays uncertain.
  for(const bad of [{outcome:'changed',booking:booking('cancelled')},{outcome:'changed',booking:{...booking(),venue_cancellation:null}},
    {outcome:'created',booking:{...booking('cancelled'),venue_cancellation:venueCancelled}}]){
    reply=bad;assert.equal((await desk.venueCancel(t,'rental',ID,'weather')).failure.kind,'unavailable');
  }
  assert.throws(()=>desk.venueCancel(t,'rental',ID,'refund'));
  const refused=await desk.venueCancel(transports(async()=>response({error:'payment_collected'},409)),'rental',ID,'weather');
  assert.equal(refused.failure.reason,'payment_collected');assert.match(desk.deskFailureMessage(refused.failure),/can’t be cancelled here/);
});
test('players read who cancelled and why; their own cancellations read as before',()=>{
  const r=rentalClient.parseBooking({...booking('cancelled'),venue_cancellation:{...venueCancelled,reason:'maintenance'}});
  const status=rentalModel.bookingStatus(r);assert.equal(status.label,'Cancelled by the venue');assert.match(status.text,/for court maintenance on .+ Nothing was charged\./);
  assert.equal(rentalModel.bookingStatus(rentalClient.parseBooking(booking('cancelled'))).label,'Cancelled');
  const g=play.client.parseGroupBooking(group({status:'cancelled',venue_cancellation:{...venueCancelled,reason:'other'}}));
  const groupStatus=play.model.groupStatus(g);assert.equal(groupStatus.label,'Cancelled by the venue');assert.match(groupStatus.text,/^The venue cancelled this group booking on /);
});
