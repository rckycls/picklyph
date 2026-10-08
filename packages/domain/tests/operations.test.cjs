const assert=require('node:assert/strict');const {test}=require('node:test');
const {readBookingOperation,readGuestName,readOperationsDate,readOperationsDayQuery}=require('../src/operations.ts');
const {readRentalCommand,readRentalQuery}=require('../src/rentalBooking.ts');
const {readSessionBookingCommand,readSessionBookingQuery}=require('../src/sessionBooking.ts');
const id='C9000000-0000-4000-8000-000000000001';const lower=id.toLowerCase();
test('front-desk commands: fixed attendance kinds, one exact arrival payment, no caller authority',()=>{
  for(const kind of ['check_in','no_show','complete']) assert.deepEqual(readBookingOperation({kind,booking_id:id}),{kind,booking_id:lower});
  assert.deepEqual(readBookingOperation({kind:'record_payment',booking_id:id,method:'bank_transfer',amount_centavos:0}),
    {kind:'record_payment',booking_id:lower,method:'bank_transfer',amount_centavos:0});
  for(const bad of [{kind:'arrive',booking_id:id},{kind:'check_in',booking_id:id,actor_user_id:id},{kind:'check_in',booking_id:'x'},
    {kind:'record_payment',booking_id:id,method:'cash'},{kind:'record_payment',booking_id:id,method:'gcash',amount_centavos:1},
    {kind:'record_payment',booking_id:id,method:'cash',amount_centavos:-1},{kind:'record_payment',booking_id:id,method:'cash',amount_centavos:1.5},
    {kind:'record_payment',booking_id:id,method:'cash',amount_centavos:2**53},null,[]]) assert.throws(()=>readBookingOperation(bad));
  assert.deepEqual(readSessionBookingCommand({kind:'complete',booking_id:id}),{kind:'complete',booking_id:lower});
  assert.deepEqual(readRentalCommand({kind:'no_show',booking_id:id}),{kind:'no_show',booking_id:lower});
});
test('outside rentals reuse the reviewed request shape plus a trimmed 1–60 character guest label',()=>{
  const body={kind:'owner_entry',court_id:id,request_id:id,starts_at:'2026-10-09T08:00:00+08:00',ends_at:'2026-10-09T09:30:00+08:00',guest_name:' Wei Li ',
    expected_quote:{total_centavos:60000,schedule_revision:'1',court_hours_revision:null,policy_revision:'0'}};
  const parsed=readRentalCommand(body);assert.equal(parsed.kind,'owner_entry');assert.equal(parsed.guest_name,'Wei Li');assert.equal(parsed.court_id,lower);
  assert.equal(readGuestName('é'.repeat(60)),'é'.repeat(60));
  for(const guest of ['',' ','x'.repeat(61),'A\nB',7]) assert.throws(()=>readRentalCommand({...body,guest_name:guest}));
  const {guest_name:_,...missing}=body;assert.throws(()=>readRentalCommand(missing));
  assert.throws(()=>readRentalCommand({...body,kind:'request'}));
});
test('day queries name a venue and a real 2000–2099 date',()=>{
  assert.deepEqual(readOperationsDayQuery({section:'day',venue_id:id,date:'2028-02-29'}),{section:'day',venue_id:lower,date:'2028-02-29',after_id:null});
  assert.deepEqual(readRentalQuery(new URLSearchParams(`section=day&venue_id=${id}&date=2026-10-09&after_id=${id}`)),{section:'day',venue_id:lower,date:'2026-10-09',after_id:lower});
  assert.deepEqual(readSessionBookingQuery(new URLSearchParams(`section=day&venue_id=${id}&date=2026-10-09`)),{section:'day',venue_id:lower,date:'2026-10-09',after_id:null});
  for(const date of ['2027-02-29','1999-12-31','2100-01-01','2026-1-09','2026-10-09T00:00']) assert.throws(()=>readOperationsDate(date));
  for(const tail of [`section=day&venue_id=${id}`,`section=day&date=2026-10-09`,`section=day&venue_id=${id}&date=2026-10-09&date=2026-10-10`])
    assert.throws(()=>readRentalQuery(new URLSearchParams(tail)));
});
