import fs from 'node:fs';
import assert from 'node:assert/strict';
import {compileToolDefinition} from './compiler.mjs';
import {checkToolDefinition} from './typecheck.mjs';
const source=fs.readFileSync(new URL('./tool.ts',import.meta.url),'utf8')
 .replace('.parameters(z.strictObject({}))','.parameters(z.strictObject({ traveler: z.string() }))\n  .output(z.strictObject({ traveler: z.string() }))')
 .replace('return [selection, confirmation];','return { traveler: _input.traveler };');
let checks=0;
assert.ok(compileToolDefinition(source).artifact);checks++;
for(const [label,bad] of [
 ['incompatible return',source.replace('traveler: _input.traveler','traveler: 42')],
 ['missing input property',source.replace('_input.traveler','_input.missing')],
 ['undeclared exchange',source.replace("ctx.elicit('pickSeat'","ctx.elicit('unknown'")],
 ['invalid branch',source.replace('return { traveler: _input.traveler };','if (_input.traveler) return { traveler: _input.traveler }; return 42;')],
 ['missing return',source.replace('return { traveler: _input.traveler };','if (_input.traveler) return { traveler: _input.traveler };')],
]){
 assert.throws(()=>compileToolDefinition(bad),error=>{
  assert.equal(error.code,'workflow_typecheck_failed',label);
  assert.ok(error.diagnostics.some(d=>d.file==='workflow.ts'&&d.line>0&&d.column>0));
  return true;
 });checks++;
}
// This would throw during trusted module evaluation if checking happened too late.
assert.throws(()=>compileToolDefinition('throw new Error("module evaluated");\n'+source.replace('traveler: _input.traveler','traveler: 42')),e=>e.code==='workflow_typecheck_failed');checks++;
// Valid TypeScript still has to satisfy the smaller workflow language.
assert.throws(()=>compileToolDefinition(source.replace('traveler: _input.traveler','traveler: _input.traveler.toUpperCase()')),/Unsupported/);checks++;
// No explicit output: use the real SDK's inferred branch/delegation result type.
const inferred=`import {createDurableTool} from '@sweatpants/agent-sdk';
import {z} from 'zod';
function* choose(yes: boolean) {
 if (yes) return {status: 'yes' as const, count: 1};
 return {status: 'no' as const, reason: 'declined'};
}
export const tool=createDurableTool('inferred',{version:'1'}).description('infer')
.parameters(z.object({yes:z.boolean()})).execute(function* (input) { return yield* choose(input.yes); });`;
checkToolDefinition(inferred);checks++;
// String length remains a runtime schema constraint, even with static checking.
assert.ok(compileToolDefinition(source.replace('.output(z.strictObject({ traveler: z.string() }))','.output(z.strictObject({ traveler: z.string().min(3) }))').replace('traveler: _input.traveler','traveler: "x"')).artifact);checks++;
fs.writeFileSync(new URL('./typecheck-results.json',import.meta.url),JSON.stringify({checks,sdkTypes:'workspace source via development condition',limitations:['Trusted build-time module evaluation','TypeScript escape hatches such as any can bypass static checks','Runtime schema validation remains required','TypeScript-valid programs must also satisfy the compiler subset']},null,2)+'\n');
console.log('PASS',checks,'compiler type-checking cases');
