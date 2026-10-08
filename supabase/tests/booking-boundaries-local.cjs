// T33: local Docker only. Runs the rollback-only boundary suite and every boundary mutation on real PostgreSQL,
// then proves the frozen clock, mutations and fixtures all rolled back: function definitions and existing IDs are unchanged.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {execFileSync}=require('node:child_process');
const mutations=require('./booking-boundaries-mutations.cjs');
function main(){
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:120000});
  const context=run(['context','show']).trim();const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const args=['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'];
  const sql=query=>run(args,query).trim();
  // psql exits non-zero at the first error; ON_ERROR_STOP closes the session, so its transaction rolls back.
  const failure=input=>{try{run([...args,'-o','/dev/null'],input);return null;}catch(error){return String(error.stderr??error.message);}};
  const definitions=()=>sql(`select md5(string_agg(pg_get_functiondef(p.oid),'' order by p.oid)) from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f';`);
  const inventory=()=>sql(`select jsonb_build_object('venues',(select jsonb_agg(id order by id) from public.venues),
    'users',(select jsonb_agg(id order by id) from auth.users),'allocations',(select jsonb_agg(id order by id) from private.court_allocations),
    'rentals',(select jsonb_agg(id order by id) from private.rental_bookings),'rental_events',(select jsonb_agg(id order by id) from private.rental_events),
    'sessions',(select jsonb_agg(id order by id) from private.open_play_sessions),'groups',(select jsonb_agg(id order by id) from private.session_bookings),
    'group_events',(select jsonb_agg(id order by id) from private.session_booking_events),'operations',(select jsonb_agg(booking_id order by booking_id) from private.booking_operations),
    'audit',(select jsonb_agg(id order by id) from private.directory_audit_events),'schemas',(select jsonb_agg(nspname order by nspname) from pg_namespace where nspname='bound_test'));`);
  const real=definitions();const before=inventory();
  const suite=fs.readFileSync(path.join(__dirname,'booking-boundaries.sql'),'utf8');
  assert.equal(failure(suite),null,'Boundary suite passes');
  assert.equal(definitions(),real,'Frozen clock rolled back');
  console.log('PASS: Docker boundary SQL on a frozen clock: player cancellation open at start -1 ms and closed at start/+1 ms (rentals, groups, pending holds capped at the start, owner entries);'
    +' no-show and arrival payment refused at -1 ms and recorded at start/+1 ms (rentals, owner entries, groups, walk-ins); walk-in removal until end -1 ms;'
    +' 24-hour cutoff -1 ms/exact/+1 ms cancels all three, refund-eligible true/true/false from the locked snapshot, nothing collected; snapshots, totals and events unchanged after two policy and two rate edits.');
  for(const [fn,from,to,caught] of mutations){
    const def=sql(`select pg_get_functiondef('${fn}'::regprocedure);`);
    assert.equal(def.split(from).length,2,`${fn} contains the mutated text once`);
    const error=failure(`begin;\n${def.replace(from,to)};\n${suite}`);
    assert.ok(error,`Mutation not caught: ${fn}: ${to}`);assert.match(error,caught,`${fn}: ${to}`);
  }
  assert.equal(definitions(),real,'Mutations rolled back');
  console.log(`PASS: ${mutations.length} boundary mutations caught on Docker PostgreSQL (rental/group cancel at start, no-show at start, rental/group hold elapsing at start, uncapped rental/group holds).`);
  assert.equal(inventory(),before,'Pre-existing IDs preserved; no fixtures or test schema left');
  console.log('PASS: real function definitions restored; no fixtures, events, operations or test schema left; pre-existing IDs preserved; no hosted changes.');
}
try{main();}catch(error){console.error(`Local boundary check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations and Docker setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;}
