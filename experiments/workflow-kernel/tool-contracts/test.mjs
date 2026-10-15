import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileToolDefinition} from './compiler.mjs';
import {create,recover,appendCommand,repair} from '../compiled-finally/journal.mjs';
const dir=fileURLToPath(new URL('.',import.meta.url));
if(process.argv[2]==='resume'){
 const {source,record}=JSON.parse(fs.readFileSync(0,'utf8'));const compiled=compileToolDefinition(source),a=compiled.artifact;
 console.log(JSON.stringify(repair(record,{[a.id]:a},compiled.schemas)));
}else{
 const source=fs.readFileSync(dir+'tool.ts','utf8'),compiled=compileToolDefinition(source),a=compiled.artifact,registry={[a.id]:a};
 const {schemas,tool}=compiled;
 assert.equal(tool.execution,'crank_native');assert.equal(a.tool.interfaceDigest,tool.interfaceDigest);
 const fresh=record=>{const p=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'resume'],{input:JSON.stringify({source,record}),encoding:'utf8',timeout:10000});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
 const outcomes=[];let checks=2;
 for(const reply of [{action:'accept',content:{seat:'window'}},{action:'decline',reason:'No thanks'},{action:'cancel'}]){
  let record=create(a,'sdk-tool',schemas);
  const state=recover(record,registry,schemas);assert.equal(state.pending.request[1],'pickSeat');
  assert.deepEqual(state.pending.request[2],{message:'Choose a seat'});
  const snapshot=JSON.stringify(record);
  for(const invalid of [{seat:'window'},{action:'accept',content:{seat:'middle'}},{action:'accept',content:{}},{action:'cancel',content:{}},{action:'unknown'}]){
   assert.throws(()=>appendCommand(record,registry,{id:'bad',requestId:state.pending.id,input:{reply:invalid},revision:record.events.length},schemas),/reply schema validation/);
   assert.equal(JSON.stringify(record),snapshot);checks++;
  }
  const confirmation={action:'accept',content:{confirmed:true}};
  for(const [index,value] of [reply,confirmation].entries()){
   const ctx=recover(record,registry,schemas);
   const accepted=appendCommand(record,registry,{id:`reply-${index}`,requestId:ctx.pending.id,input:{reply:value},revision:record.events.length},schemas);
   record=fresh(accepted);checks++;
  }
  const result=recover(record,registry,schemas).state.outcome;
  assert.deepEqual(result,{kind:'returned',value:[reply,confirmation]});
  // Run the actual SDK program with a pull adapter and compare its wire request contracts/results.
  const iterator=tool.program({}, {pull:function*(request){return yield request;}});
  const first=iterator.next();assert.equal(first.value.key,'pickSeat');assert.equal(first.value.message,'Choose a seat');
  assert.equal(first.value.response.digest,a.tool.elicits['workflow/selection'].responseDigest);
  assert.equal(first.value.binding.id,a.tool.elicits['workflow/selection'].binding);
  const second=iterator.next(reply);assert.equal(second.value.key,'confirm');
  const native=iterator.next(confirmation);assert.equal(native.done,true);
  assert.deepEqual(JSON.parse(JSON.stringify(native.value)),result.value);checks++;
  outcomes.push(result);
 }
 assert.throws(()=>compileToolDefinition(source.replace("ctx.elicit('pickSeat'", "ctx.elicit('missing'")),/TS2345/);checks++;
 assert.throws(()=>compileToolDefinition(source.replace("ctx.elicit('pickSeat'", "ctx.elicit(selection")),/TS(2345|2448|2454)/);checks++;
 assert.ok(compileToolDefinition(source.replace('return [selection, confirmation];','return _input;')));checks++;
 assert.throws(()=>compileToolDefinition(source.replace('"use workflow";','')),/use workflow/);checks++;
 const next=compileToolDefinition(source.replace("['window', 'aisle']","['window', 'aisle', 'middle']"));
 assert.equal(next.artifact.compiled.program.id,a.compiled.program.id);assert.notEqual(next.artifact.id,a.id);checks++;
 assert.notEqual(next.artifact.contracts['workflow/selection'].reply,a.contracts['workflow/selection'].reply);checks++;
 fs.writeFileSync(dir+'artifact.json',JSON.stringify(a,null,2));
 fs.writeFileSync(dir+'results.json',JSON.stringify({checks,realSDK:true,tool:tool.name,generatedBindings:a.tool.elicits,outcomes,limitations:['One exported createDurableTool definition; Zod elicit declarations only','Only own JSON object field reads; no general JavaScript property semantics','Static elicit keys; no sample/effect declarations yet','Request context validation and SDK document slots are not integrated','Build-time module evaluation is trusted, not sandboxed','No production build plugin or deployment']},null,2)+'\n');
 console.log('PASS',checks,'real SDK contract checks');
}
