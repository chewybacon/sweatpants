import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {compileToolDefinition} from './compiler.mjs';
import {create,recover,appendCommand,repair} from '../compiled-finally/journal.mjs';
const source=fs.readFileSync(new URL('./capture.ts',import.meta.url),'utf8');
const {artifact:a,schemas,tool}=compileToolDefinition(source),registry={[a.id]:a};
let record=create(a,'sdk-capture',schemas,{count:3}),acquired=0;const trace=[];
while(recover(record,registry,schemas).pending){
 const ctx=recover(record,registry,schemas),request=ctx.pending.request;
 trace.push([request[1],request[2].message]);
 const reply=request[1]==='acquire'?{action:'accept',content:{id:`hold-${++acquired}`}}:{action:'accept',content:'released'};
 const accepted=appendCommand(record,registry,{id:`reply-${record.events.length}`,requestId:ctx.pending.id,input:{reply},revision:record.events.length},schemas);
 const child=spawnSync(process.execPath,[new URL('./test.mjs',import.meta.url).pathname,'resume'],{input:JSON.stringify({source,record:accepted}),encoding:'utf8',timeout:20000});
 assert.equal(child.status,0,child.stderr);record=JSON.parse(child.stdout);assert.deepEqual(record,repair(accepted,registry,schemas));
}
assert.deepEqual(trace.slice(3),[['release','hold-3'],['release','hold-2'],['release','hold-1']]);
assert.deepEqual(record.events.at(-1).outcome,{kind:'returned',value:0});
const {run}=createRequire(new URL('../../../package.json',import.meta.url))('effection');
const nativeTrace=[];let nativeAcquired=0;
const value=await run(()=>tool.program({count:3},{pull:function*(request){
 nativeTrace.push([request.key,request.message]);
 return request.key==='acquire'?{action:'accept',content:{id:`hold-${++nativeAcquired}`}}:{action:'accept',content:'released'};
}}));
assert.equal(value,0);assert.deepEqual(trace,nativeTrace);
fs.writeFileSync(new URL('./capture-results.json',import.meta.url),JSON.stringify({freshProcessBoundaries:trace.length,trace,outcome:record.events.at(-1).outcome},null,2)+'\n');
console.log('PASS typed SDK capture, native parity, and',trace.length,'fresh-process boundaries');
