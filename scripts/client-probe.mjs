import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..');
const origin='http://127.0.0.1:8098';
let values={};
try {
  for(const line of (await readFile(path.join(root,'.env'),'utf8')).split(/\r?\n/)) {
    const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if(match) values[match[1]]=match[2];
  }
} catch { throw new Error('Run scripts/Init.ps1 or node scripts/init-env.mjs first.'); }
async function evaluate(environment,token,flagKey='checkout-redesign',subjectId='demo-customer-001') {
  const response=await fetch(`${origin}/client/v1/evaluate/${environment}`,{
    method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({flagKey,subjectId}),
  });
  return {status:response.status,body:await response.json()};
}
const missing=await evaluate('staging',null);
assert.equal(missing.status,401);
const wrongProduction=await evaluate('production',values.ROLLOUT_STAGING_TOKEN);
const wrongStaging=await evaluate('staging',values.ROLLOUT_PRODUCTION_TOKEN);
assert.equal(wrongProduction.status,401);
assert.equal(wrongStaging.status,401);
const vectors=JSON.parse(await readFile(path.join(root,'docs/BUCKET-VECTORS.json'),'utf8')).vectors;
const results=[];
for(const vector of vectors) {
  const token=values[`ROLLOUT_${vector.environment.toUpperCase()}_TOKEN`];
  const result=await evaluate(vector.environment,token,vector.flagKey,vector.subjectId);
  assert.equal(result.status,200);
  assert.equal(result.body.bucket,vector.bucket);
  assert.equal(result.body.algorithm,'sha256-u32be-mod10000-v1');
  results.push({flagKey:vector.flagKey,environment:vector.environment,bucket:result.body.bucket,revision:result.body.revision,value:result.body.value,reason:result.body.reason});
}
const unknown=await evaluate('staging',values.ROLLOUT_STAGING_TOKEN,'unknown-demo-flag');
assert.equal(unknown.status,200);
assert.equal(unknown.body.value,false);
assert.equal(unknown.body.reason,'FLAG_NOT_FOUND');
assert.equal(unknown.body.bucket,null);
assert.equal(unknown.body.revision,null);
const report={checkedAt:new Date().toISOString(),missingTokenStatus:missing.status,wrongEnvironmentStatuses:[wrongProduction.status,wrongStaging.status],vectors:results,unknownFlagSafeFalse:true};
await mkdir(path.join(root,'.local'),{recursive:true});
await writeFile(path.join(root,'.local/client-probe.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
