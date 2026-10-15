import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {artifact,create,accept,recover,compatibility,migrate,repair,copy,hash} from './durable.mjs';
const reports=[];
function test(name,fn){fn();reports.push(name);console.log('PASS',name);}
const source='(let ((prefix "Hello, ")) (let ((name (yield-at "name" "Your name?"))) (string-append prefix name)))';
const a=artifact(source,{name:{type:'string'}});
const b=artifact(source.replace('(string-append prefix name)','(string-append suffix name)'),{name:{type:'string'}});
const registry={[a.id]:a,[b.id]:b};
const original=create(a,'invocation-1');
const id=original.checkpoint.pending.id;
const plan={revision:0,from:a.id,to:b.id,addBindings:[{frame:0,name:'suffix',value:'Welcome, ',schema:{type:'string'}}]};
if(process.argv[2]==='child'){
 const {r,registry:reg}=JSON.parse(fs.readFileSync(process.argv[3]));
 const ctx=recover(r,reg);const next=accept(r,reg,{revision:r.revision,id:ctx.pending.id,reply:'Ryan'});console.log(JSON.stringify(next));process.exit(0);
}
test('comments and whitespace retain artifact identity',()=>assert.equal(artifact('; comment\n'+source,{name:{type:'string'}}).id,a.id));
test('same artifact resumes directly',()=>assert.equal(compatibility(original,registry,a).status,'direct'));
test('changed binding needs explicit migration',()=>assert.equal(compatibility(original,registry,b).status,'explicit-migration'));
test('missing lexical binding rejects migration',()=>assert.throws(()=>migrate(original,registry,b,{...plan,addBindings:[]}),/lexical/));
let migrated;
test('add checked state field while waiting',()=>{migrated=migrate(original,registry,b,plan);assert.equal(migrated.checkpoint.pending.id,id);assert.equal(migrated.checkpoint.pending.request,'Your name?');assert.equal(original.revision,0);});
test('fresh process restores migrated checkpoint',()=>{fs.writeFileSync('migration-fixture.json',JSON.stringify({r:migrated,registry}));const child=spawnSync(process.execPath,[new URL(import.meta.url).pathname,'child','migration-fixture.json'],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);const r=JSON.parse(child.stdout);assert.equal(r.checkpoint.state.result,'Welcome, Ryan');assert.equal(r.events.filter(e=>e.kind==='request').length,1);});
const finished=accept(migrated,registry,{revision:1,id,reply:'Ryan'});
test('duplicate accepted reply is a no-op even with old revision',()=>assert.deepEqual(accept(finished,registry,{revision:1,id,reply:'Ryan'}),finished));
test('conflicting duplicate reply rejected',()=>assert.throws(()=>accept(finished,registry,{revision:2,id,reply:'Other'}),/Conflicting/));
test('reply schema enforced',()=>assert.throws(()=>accept(original,registry,{revision:0,id,reply:42}),/contract/));
test('stale effect identity rejected',()=>assert.throws(()=>accept(original,registry,{revision:0,id:'wrong',reply:'Ryan'}),/identity/));
test('concurrent stale revision rejected',()=>assert.throws(()=>accept(migrated,registry,{revision:0,id,reply:'Ryan'}),/Revision/));
test('invalid migration preserves original record',()=>{const before=copy(original);assert.throws(()=>migrate(original,registry,b,{...plan,addBindings:[{...plan.addBindings[0],value:1}]}),/schema/);assert.deepEqual(original,before);});
test('migration cannot overwrite existing binding',()=>assert.throws(()=>migrate(original,registry,b,{...plan,addBindings:[{...plan.addBindings[0],name:'prefix'}]}),/overwrite/));
test('migration version is pinned',()=>assert.throws(()=>migrate(original,registry,b,{...plan,from:'wrong'}),/version/));
test('changed pending reply contract retains original',()=>{const c=artifact(source,{name:{type:'integer'}});assert.equal(compatibility(original,registry,c).status,'retain-original');});
test('removed yield retains original',()=>{const c=artifact('42',{});assert.equal(compatibility(original,registry,c).status,'retain-original');});
test('changed caller continuation rejected',()=>{const c=artifact('(string-append "!" '+source+')',{name:{type:'string'}});assert.equal(compatibility(original,registry,c).status,'retain-original');});
test('same layout behavior change never auto-approved',()=>{const c=artifact(source.replace('Hello, ','Goodbye, '),{name:{type:'string'}});assert.equal(compatibility(original,registry,c).status,'explicit-migration');});
test('checkpoint corruption rejected',()=>{const r=copy(original);r.checkpoint.state.frames[0].ip++;assert.throws(()=>recover(r,registry),/integrity/);});
test('journal corruption rejected',()=>{const r=copy(finished);r.events[0].request='tampered';assert.throws(()=>recover(r,registry),/integrity/);});
test('artifact corruption rejected',()=>{const reg=copy(registry);reg[a.id].program.functions[0].code[0]=['const',4];assert.throws(()=>recover(original,reg),/integrity/);});
test('missing pinned artifact rejected',()=>assert.throws(()=>recover(original,{}),/Missing/));
test('checkpoint removal replays pinned old version',()=>{const r=copy(original);delete r.checkpoint;const ctx=recover(r,registry);assert.equal(ctx.pending.id,id);assert.equal(ctx.a.id,a.id);});
test('checkpoint removal replays across migration anchor',()=>{const r=copy(finished);delete r.checkpoint;const ctx=recover(r,registry);assert.equal(ctx.state.result,'Welcome, Ryan');});
test('stale checkpoint catches up through migration and reply',()=>{const r=copy(finished);r.checkpoint=original.checkpoint;assert.equal(recover(r,registry).state.result,'Welcome, Ryan');});
test('crash after accepted reply recovers without re-acceptance',()=>{const r=copy(finished);r.events.pop();r.checkpoint=migrated.checkpoint;const repaired=repair(r,registry);assert.equal(repaired.checkpoint.state.result,'Welcome, Ryan');assert.equal(repaired.events.filter(e=>e.kind==='accepted').length,1);});
test('repeated recovery has no external dispatch',()=>{for(let i=0;i<30;i++){const r=copy(finished);delete r.checkpoint;assert.equal(recover(r,registry).state.result,'Welcome, Ryan');}assert.equal(finished.events.filter(e=>e.kind==='request').length,1);});
test('duplicate stable labels rejected',()=>assert.throws(()=>artifact('(yield-at "x" 1) (yield-at "x" 2)',{x:{type:'integer'}}),/Duplicate/));
test('retry accepted reply after interrupted commit repairs completion',()=>{const r=copy(finished);r.events.pop();r.checkpoint=migrated.checkpoint;const repaired=accept(r,registry,{revision:1,id,reply:'Ryan'});assert.equal(repaired.checkpoint.state.result,'Welcome, Ryan');assert.equal(repaired.events.filter(e=>e.kind==='accepted').length,1);});
test('crash after migration append restores anchor',()=>{const r=copy(migrated);r.checkpoint=original.checkpoint;const ctx=recover(r,registry);assert.equal(ctx.a.id,b.id);assert.equal(ctx.pending.id,id);assert.equal(accept(r,registry,{revision:1,id,reply:'Ryan'}).checkpoint.state.result,'Welcome, Ryan');});
test('invalid migration frame rejected',()=>assert.throws(()=>migrate(original,registry,b,{...plan,addBindings:[{...plan.addBindings[0],frame:99}]}),/frame/));
test('every journal prefix and cached checkpoint recovers consistently',()=>{
 const loopSource='(define (loop n total) (if (= n 0) total (loop (- n 1) (+ total (yield-at "turn" n))))) (loop 12 0)';
 const p=artifact(loopSource,{turn:{type:'integer'}}),reg={[p.id]:p};let r=create(p,'crash-loop');const snapshots=[copy(r.checkpoint)];
 for(let i=1;i<=12;i++){r=accept(r,reg,{revision:r.revision,id:r.checkpoint.pending.id,reply:i});snapshots.push(copy(r.checkpoint));}
 assert.equal(r.checkpoint.state.result,78);
 for(let end=1;end<=r.events.length;end++){
  const truncated={...copy(r),events:copy(r.events.slice(0,end))};delete truncated.checkpoint;
  const expected=repair(truncated,reg);
  for(const cached of snapshots.filter(c=>c.cursor<=end)){
   const recovered=repair({...copy(truncated),checkpoint:copy(cached)},reg);
   assert.deepEqual(recovered.events,expected.events);assert.deepEqual(recovered.checkpoint.state,expected.checkpoint.state);
  }
 }
});
test('a stored closure and caller both survive checkpoint replay',()=>{
 const p=artifact('(let ((prefix "Hi ")) (let ((greet (lambda (name) (string-append prefix name)))) (greet (yield-at "greet" "Name?"))))',{greet:{type:'string'}}),reg={[p.id]:p};const r=create(p,'closure');delete r.checkpoint;const ctx=recover(r,reg);assert.equal(accept(r,reg,{revision:0,id:ctx.pending.id,reply:'Ryan'}).checkpoint.state.result,'Hi Ryan');
});
test('failed execution leaves accepted input and journal unchanged',()=>{
 const p=artifact('(begin (yield-at "x" 1) (missing 3))',{x:{type:'integer'}}),reg={[p.id]:p};const r=create(p,'failure'),before=copy(r);assert.throws(()=>accept(r,reg,{revision:0,id:r.checkpoint.pending.id,reply:1}),/Unbound/);assert.deepEqual(r,before);
});
test('an artifact for another evaluator is not silently reinterpreted',()=>{const altered=copy(a);delete altered.id;altered.engine='old-runtime';altered.id=hash(altered);const r=copy(original);delete r.checkpoint;r.initialArtifact=altered.id;assert.throws(()=>recover(r,{[altered.id]:altered}),/evaluator/);});
test('a migration binding in an unrelated scope is insufficient',()=>{
 // Heap contains suffix, but the suspended computation cannot reach that environment.
 const r=copy(original);r.checkpoint.state.heap.push({parent:null,bindings:{suffix:'hidden'}});const {checksum,...body}=r.checkpoint;r.checkpoint.checksum=hash(body);
 assert.throws(()=>migrate(r,registry,b,{...plan,addBindings:[]}),/lexical/);
});
test('changed prompt does not replace the already-issued request',()=>{
 const target=artifact(source.replace('Your name?','New prompt?'),{name:{type:'string'}}),reg={...registry,[target.id]:target};
 const r=migrate(original,reg,target,{revision:0,from:a.id,to:target.id});assert.equal(r.checkpoint.pending.request,'Your name?');assert.equal(r.events.filter(e=>e.kind==='request').length,1);
});
test('function reordering requires a migration strategy we do not yet support',()=>{
 const target=artifact('(define (extra) 0) '+source,{name:{type:'string'}});assert.equal(compatibility(original,registry,target).status,'retain-original');
});
test('128 generated reply sequences agree with a direct mathematical oracle',()=>{
 for(let seed=0;seed<128;seed++){
  const p=artifact('(define (loop n sum) (if (= n 0) sum (loop (- n 1) (+ sum (yield-at "turn" n))))) (loop 7 0)',{turn:{type:'integer'}}),reg={[p.id]:p};let r=create(p,'generated-'+seed),sum=0;
  for(let bit=0;bit<7;bit++){const value=(seed>>bit)&1;sum+=value;delete r.checkpoint;const c=recover(r,reg);r=accept(r,reg,{revision:r.revision,id:c.pending.id,reply:value});}
  assert.equal(r.checkpoint.state.result,sum);assert.equal(r.events.filter(e=>e.kind==='accepted').length,7);
 }
});
fs.writeFileSync('migration-results.json',JSON.stringify({passed:reports.length,tests:reports,checkpointBytes:Buffer.byteLength(JSON.stringify(migrated.checkpoint)),limitations:['Trusted-input JavaScript prototype; not Wasm or Sweatpants integration','Function and instruction layout must stay stable; changed layouts are rejected','Schema checking is limited to scalar replies and added fields','Hash checks detect corruption, not authenticated tampering','Journal and checkpoint transaction persistence is simulated, not a storage adapter','No external exactly-once guarantee; effect idempotency remains required','Migration anchors are durable data, not disposable checkpoint caches']},null,2)+'\n');
