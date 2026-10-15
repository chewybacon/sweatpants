import assert from 'node:assert/strict';
import {compileWorkflow} from '../compiled-frames/compiler.mjs';
import {compile,start,run} from './engine.mjs';
const cases=[
 ['bounded stack',`let n=0;while(n<1000){n=n+1;}return n;`,1000],
 ['nested loops',`let total=0; let i=0;
 while(i<3){i=i+1;let j=0;while(j<3){j=j+1;try{if(j===1)continue;if(j===3)break;total=total+10;}finally{total=total+1;yield* ctx.elicit('cleanup');}}}
 return total;`,39],
 ['break inside outer finally',`let n=0;try{while(true){n=n+1;break;}}finally{yield* ctx.elicit('outer');}return n;`,1],
 ['return from loop',`while(true){try{return 7;}finally{yield* ctx.elicit('cleanup');}}return 0;`,7],
 ['continue replaced by break',`let n=0;while(n<4){try{n=n+1;continue;}finally{yield* ctx.elicit('cleanup');break;}}return n;`,1],
 ['cleanup error replaces break',`while(true){try{break;}finally{yield* ctx.elicit('cleanup');throw 'cleanup failed';}}return 0;`,'cleanup failed'],
];
let checks=0;
for(const [name,body,expected] of cases){
 const source=`function* workflow(ctx){"use workflow";${body}}`;
 const artifact=compileWorkflow(source,{compileScheme:compile,allowFinally:true});
 let state=start(artifact.program),output=run(artifact.program,state),events=[];
 while(state.status==='waiting'){
  events.push(output.effect);state=JSON.parse(JSON.stringify(state));output=run(artifact.program,state,{reply:'ack'});
 }
 // Trusted local fixture: execute the original generator for native/VM parity.
 // eslint-disable-next-line @typescript-eslint/no-implied-eval
 const native=Function(`${source};return workflow;`)()({elicit:function*(key){return yield ['elicit',key];}});
 const nativeEvents=[];let outcome;
 try{let step=native.next();while(!step.done){nativeEvents.push(step.value);step=native.next('ack');}outcome={kind:'returned',value:step.value};}
 catch(value){outcome={kind:'thrown',value};}
 assert.ok(state.maxFrames<=2,name);assert.deepEqual(state.outcome,outcome,name);assert.equal(outcome.value,expected,name);assert.deepEqual(events,nativeEvents,name);checks++;
}
console.log('PASS',checks,'nested loop/unwind parity cases');
