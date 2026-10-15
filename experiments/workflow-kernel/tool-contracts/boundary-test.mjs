import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {compileToolDefinition} from './compiler.mjs';
import {create,recover,appendCommand,repair,copy,hash} from '../compiled-finally/journal.mjs';
const source=fs.readFileSync(new URL('./tool.ts',import.meta.url),'utf8')
 .replace('.parameters(z.strictObject({}))', '.parameters(z.strictObject({ traveler: z.string() }))\n  .output(z.strictObject({ traveler: z.string() }))')
 .replace('return [selection, confirmation];','return { traveler: _input.traveler };');
const {artifact:a,schemas}=compileToolDefinition(source),registry={[a.id]:a};
let checks=0;
for(const input of [{},{traveler:4},{traveler:'Ada',extra:true}]){
 assert.throws(()=>create(a,'invalid',schemas,input),/input schema validation/);checks++;
}
let input={traveler:'Ada'},record=create(a,'boundary',schemas,input);input.traveler='Changed';
assert.deepEqual(record.events[0].input,{traveler:'Ada'});checks++;
for(const reply of [{action:'accept',content:{seat:'aisle'}},{action:'accept',content:{confirmed:true}}]){
 const ctx=recover(record,registry,schemas);
 record=appendCommand(record,registry,{id:`cmd-${record.events.length}`,requestId:ctx.pending.id,input:{reply},revision:record.events.length},schemas);
 const replay=copy(record);delete replay.checkpoint;
 const p=spawnSync(process.execPath,[new URL('./test.mjs',import.meta.url).pathname,'resume'],{input:JSON.stringify({source,record:replay}),encoding:'utf8',timeout:20000});
 assert.equal(p.status,0,p.stderr);
 const restarted=JSON.parse(p.stdout);
 assert.deepEqual(restarted,repair(record,registry,schemas));record=restarted;checks++;
}
assert.deepEqual(record.events.at(-1).outcome,{kind:'returned',value:{traveler:'Ada'}});checks++;
const brokenSource=source.replace('.output(z.strictObject({ traveler: z.string() }))', '.output(z.strictObject({ traveler: z.string().min(3) }))').replace('traveler: _input.traveler', 'traveler: "x"');
const broken=compileToolDefinition(brokenSource);
let bad=create(broken.artifact,'bad-output',broken.schemas,{traveler:'Ada'}),reg={[broken.artifact.id]:broken.artifact};
for(const reply of [{action:'cancel'},{action:'cancel'}]){
 const ctx=recover(bad,reg,broken.schemas);
 bad=appendCommand(bad,reg,{id:`cmd-${bad.events.length}`,requestId:ctx.pending.id,input:{reply},revision:bad.events.length},broken.schemas);
 if(bad.events.filter(e=>e.kind==='command').length===1)bad=repair(bad,reg,broken.schemas);
}
const before=JSON.stringify(bad);
const failed=repair(bad,reg,broken.schemas);
const expected={kind:'failed',code:'output_schema_invalid',schema:broken.artifact.boundary.output};
assert.deepEqual(failed.events.at(-1).outcome,expected);
assert.deepEqual(recover(failed,reg,broken.schemas).state.outcome,expected);
assert.equal(JSON.stringify(bad),before);checks++;
const replay=copy(bad);delete replay.checkpoint;
assert.deepEqual(repair(replay,reg,broken.schemas),failed);checks++;
// Resume across each publication/checkpoint crash window in another process.
const published=copy(failed);published.checkpoint=copy(bad.checkpoint);
const completedReplay=copy(failed);delete completedReplay.checkpoint;
for(const candidate of [bad,replay,published,completedReplay,failed]){
 const p=spawnSync(process.execPath,[new URL('./test.mjs',import.meta.url).pathname,'resume'],{input:JSON.stringify({source:brokenSource,record:candidate}),encoding:'utf8',timeout:20000});
 assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),failed);checks++;
}
assert.deepEqual(repair(failed,reg,broken.schemas),failed);checks++;
assert.equal(failed.events.filter(e=>e.kind==='done').length,1);checks++;
assert.throws(()=>appendCommand(failed,reg,{id:'too-late',requestId:'old',input:{cancel:true},revision:failed.events.length},broken.schemas),/Stale effect identity/);checks++;
// Completion failure also works when the program never suspends.
const immediateSource=brokenSource.replace(/    const selection =.*\n/, '').replace(/    const confirmation =.*\n/, '');
const immediate=compileToolDefinition(immediateSource);
const immediateRecord=create(immediate.artifact,'immediate',immediate.schemas,{traveler:'Ada'});
assert.equal(immediateRecord.events.at(-1).outcome.kind,'failed');
const immediateReplay=copy(immediateRecord);delete immediateReplay.checkpoint;
assert.deepEqual(repair(immediateReplay,{[immediate.artifact.id]:immediate.artifact},immediate.schemas),immediateRecord);checks++;
// Authored exceptions retain their own outcome; output schemas apply to returns.
const throwing=compileToolDefinition(immediateSource.replace('return { traveler: "x" };', 'throw "authored failure";'));
assert.deepEqual(create(throwing.artifact,'throwing',throwing.schemas,{traveler:'Ada'}).events.at(-1).outcome,{kind:'thrown',value:'authored failure'});checks++;
// A missing validator cannot be mistaken for an invalid authored result.
const missing={get:digest=>digest===broken.artifact.boundary.output?undefined:broken.schemas.get(digest)};
assert.throws(()=>repair(bad,reg,missing),/Missing pinned schema validator/);checks++;
// A broken validator remains retryable infrastructure failure, not a terminal rejection.
const brokenValidator={get(digest){
 const entry=broken.schemas.get(digest);
 if(digest!==broken.artifact.boundary.output)return entry;
 return {...entry,schema:{'~standard':{version:1,vendor:'test',validate(){throw Error('validator unavailable');}}}};
}};
assert.throws(()=>repair(bad,reg,brokenValidator),/output schema validation failed: schema-error/);
assert.equal(JSON.stringify(bad),before);checks++;
const cancelRecord=create(broken.artifact,'cancelled',broken.schemas,{traveler:'Ada'});
const cancelCtx=recover(cancelRecord,reg,broken.schemas);
const cancelled=repair(appendCommand(cancelRecord,reg,{id:'cancel',requestId:cancelCtx.pending.id,input:{cancel:true},revision:cancelRecord.events.length},broken.schemas),reg,broken.schemas);
assert.deepEqual(cancelled.events.at(-1).outcome,{kind:'cancelled'});checks++;
// A rehashed journal still cannot substitute a different completion during replay.
const forged=copy(failed);delete forged.checkpoint;
forged.events.at(-1).outcome={kind:'returned',value:{traveler:'forged'}};
let forgedPrevious=null;
for(const event of forged.events){event.previous=forgedPrevious;const {hash:_,...body}=event;event.hash=hash(body);forgedPrevious=event.hash;}
assert.throws(()=>recover(forged,reg,broken.schemas),/Replay completion mismatch/);checks++;
const changed=compileToolDefinition(source.replace('traveler: z.string()', 'traveler: z.string().min(1)'));
assert.notEqual(changed.artifact.id,a.id);assert.equal(changed.artifact.compiled.program.id,a.compiled.program.id);checks++;
const invalid=copy(record);delete invalid.checkpoint;invalid.events[0].input={traveler:7};
let previous=null;for(const event of invalid.events){event.previous=previous;const {hash:_,...body}=event;event.hash=hash(body);previous=event.hash;}
assert.throws(()=>recover(invalid,registry,schemas),/input schema validation/);checks++;
fs.writeFileSync(new URL('./boundary-results.json',import.meta.url),JSON.stringify({checks,input:a.boundary.input,output:a.boundary.output,outcome:record.events.at(-1).outcome,invalidOutput:'Recorded as output_schema_invalid; stable across fresh-process recovery'},null,2)+'\n');
console.log('PASS',checks,'input/output boundary checks');
