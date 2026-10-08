// T33: each mutation moves one arrival-booking boundary by one instant (or uncaps a hold). booking-boundaries.sql must fail on every one.
// [function, original text (present exactly once), mutated text, expected failure]
module.exports=[
  ['public.rental_booking_change(uuid,uuid,text)','or a.starts_at<=at_time or','or a.starts_at<at_time or',/Expected failure: select bound_test\.cancel\(3,'rc2'\)/],
  ['public.session_booking_change(uuid,uuid,text)','else s.starts_at end)<=at_time','else s.starts_at end)<at_time',/Expected failure: select bound_test\.cancel\(3,'gc2'\)/],
  ['public.booking_operation(uuid,text,uuid,text,text,bigint)','if starts>at_time then','if starts>=at_time then',/Booking not started/],
  ['public.rental_booking_change(uuid,uuid,text)',"(a.state='expired' or a.expires_at<=at_time)","(a.state='expired' or a.expires_at<at_time)",/Booking cannot change/],
  ['public.session_booking_change(uuid,uuid,text)',"if b.status='pending' and b.expires_at<=at_time then","if b.status='pending' and b.expires_at<at_time then",/Booking cannot change/],
  // T21 acquisition refuses a hold past the start before the table check would.
  ['public.rental_booking_request(uuid,uuid,uuid,timestamptz,timestamptz,jsonb)',"hold_until:=least(at_time+interval '2 hours',starts)","hold_until:=at_time+interval '2 hours'",/Invalid allocation/],
  ['public.session_booking_request(uuid,jsonb)',"hold:=least(at_time+make_interval(mins=>(s.snapshot->>'approval_hold_minutes')::integer),s.starts_at)",
    "hold:=at_time+make_interval(mins=>(s.snapshot->>'approval_hold_minutes')::integer)",/group hold capped at start gh1/],
];
