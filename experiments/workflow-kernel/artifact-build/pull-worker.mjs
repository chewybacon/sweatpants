import fs from 'node:fs';
import {createPullMachine} from './pull-adapter.mjs';
const {bundlePath,input,snapshot,reply}=JSON.parse(fs.readFileSync(0,'utf8'));
const bundle=JSON.parse(fs.readFileSync(bundlePath,'utf8'));
const machine=createPullMachine(bundle,input,snapshot);
const frontier=reply===undefined?machine.frontier():machine.resume(reply);
console.log(JSON.stringify({frontier,snapshot:machine.capture(),pid:process.pid}));
