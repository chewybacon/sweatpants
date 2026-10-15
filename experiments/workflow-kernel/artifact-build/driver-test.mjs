import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {buildBundle} from './build.mjs';
import {createCompiledPullTool} from './pull-adapter.mjs';
import {createCompiledProgramDriver} from './program-driver.mjs';
import {canonicalDigest} from '../../../packages/foundation/dist/index.js';
import {copy} from '../compiled-finally/journal.mjs';
const {run}=createRequire(new URL('../../../package.json',import.meta.url))('effection');
const bundle=buildBundle(fs.readFileSync(new URL('../tool-contracts/iteration-scope.ts',import.meta.url),'utf8'));
const tool=createCompiledPullTool(bundle);
const request={sessionId:'s',taskId:'t',program:{id:tool.manifest.programId,version:tool.manifest.version,digest:tool.manifest.digest},input:{count:1},route:{driverKind:'compiled-spike'},executionEpoch:1};
const outcome={status:'ok',value:{action:'accept',content:{id:'hold-1'}}};
const command={type:'resume',actionIndex:0,outcome,receipt:{sessionId:'s',taskId:'t',pullId:'p',resolutionOffset:'1',outcomeDigest:canonicalDigest(outcome),status:'accepted'},replayed:true};
let checks=0;const check=fn=>{fn();checks++;};
await run(function*(){
 for(const reason of ['parked','transport_lost','scope_exit','cancelled']){
  const cache=new Map(),events=[],driver=createCompiledProgramDriver(bundle,{cache,observe:e=>events.push(e)});
  const attachment=yield* driver.attach(request);
  yield* driver.step(attachment,{type:'start',input:request.input});
  const release=yield* driver.step(attachment,command);
  check(()=>assert.equal(release.descriptor.key,'release'));
  const before=JSON.stringify([...cache]);
  yield* driver.shutdown(attachment,reason);
  check(()=>assert.equal(JSON.stringify([...cache]),before));
  check(()=>assert.equal(events.filter(x=>x.type==='logical-cancel').length,0));
  let rejected=false;try{yield* driver.step(attachment,command);}catch{rejected=true;}
  check(()=>assert.equal(rejected,true));
 }
 for(const mutate of [
  c=>c.actionIndex=1,
  c=>c.receipt.taskId='other',
  c=>c.receipt.sessionId='other',
  c=>c.receipt.outcomeDigest='wrong',
  c=>c.receipt.status='rejected',
 ]){
  const cache=new Map(),driver=createCompiledProgramDriver(bundle,{cache});
  const attachment=yield* driver.attach(request);
  yield* driver.step(attachment,{type:'start',input:request.input});
  const bad=copy(command);mutate(bad);
  let rejected=false;try{yield* driver.step(attachment,bad);}catch{rejected=true;}
  check(()=>assert.equal(rejected,true));
  check(()=>assert.equal(cache.size,0));
  const release=yield* driver.step(attachment,command);
  check(()=>assert.equal(release.descriptor.key,'release'));
  yield* driver.shutdown(attachment,'parked');
 }
 // A live cancellation followed by cleanup completion cannot cache a state
 // under the ordinary reply prefix, which lacks the cancellation decision.
 const cache=new Map(),driver=createCompiledProgramDriver(bundle,{cache});
 const attachment=yield* driver.attach(request);
 yield* driver.step(attachment,{type:'start',input:request.input});
 yield* driver.step(attachment,command);
 const before=JSON.stringify([...cache]);
 const release=yield* driver.step(attachment,{type:'cancel'});
 check(()=>assert.equal(release.descriptor.key,'release'));
 const finish={status:'ok',value:{action:'accept',content:'released'}};
 const final=yield* driver.step(attachment,{...command,actionIndex:1,outcome:finish,receipt:{...command.receipt,pullId:'release',resolutionOffset:'2',outcomeDigest:canonicalDigest(finish)}});
 check(()=>assert.equal(final.error.code,'program_cancelled'));
 check(()=>assert.equal(JSON.stringify([...cache]),before));
 yield* driver.shutdown(attachment,'cancelled');
});
console.log('PASS',checks,'driver lifecycle and receipt fence checks');
