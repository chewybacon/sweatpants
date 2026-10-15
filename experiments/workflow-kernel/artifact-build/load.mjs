// Runtime entry: no authored module, Babel, TypeScript or compiler import.
import {readFileSync} from 'node:fs';
import {hash} from '../compiled-finally/journal.mjs';
import {createDurableSchemaRegistry} from '../compiled-finally/schemas.mjs';
import {decodeSchema,ZOD_VERSION} from './validators.mjs';
export function runtimeId(){
 return hash({zod:ZOD_VERSION,files:Object.fromEntries(['../compiled-finally/engine.mjs','../compiled-finally/journal.mjs','../compiled-finally/schemas.mjs','./validators.mjs','./load.mjs','./pull-adapter.mjs','./program-driver.mjs'].map(path=>[path,readFileSync(new URL(path,import.meta.url),'utf8')]))});
}
export function loadBundle(bundle){
 const {id,...body}=bundle;
 if(hash(body)!==id)throw Error('Bundle integrity failure');
 if(bundle.format!==1||bundle.runtime!==runtimeId())throw Error('Bundle runtime unavailable');
 const {id:artifactId,...artifactBody}=bundle.artifact;
 if(hash(artifactBody)!==artifactId)throw Error('Artifact integrity failure');
 if(bundle.artifact.bundleContract!==hash({runtime:bundle.runtime,validators:bundle.validators}))throw Error('Validator bundle identity mismatch');
 const builtins=createDurableSchemaRegistry([]),entries=[];
 const descriptors=bundle.artifact.schemaDescriptors;
 if(Object.keys(bundle.validators).length!==Object.keys(descriptors).length)throw Error('Validator coverage mismatch');
 for(const [digest,descriptor] of Object.entries(descriptors)){
  const recipe=bundle.validators[digest];if(!recipe)throw Error('Missing bundled validator');
  if(recipe.builtin){
   const entry=builtins.get(digest);
   if(recipe.builtin!==digest||!entry||hash(entry.descriptor)!==hash(descriptor))throw Error('Unknown builtin validator');
  }else entries.push({descriptor,schema:decodeSchema(recipe)});
 }
 return {artifact:bundle.artifact,schemas:createDurableSchemaRegistry(entries)};
}
