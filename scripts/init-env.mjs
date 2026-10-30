import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const file=path.join(root,'.env');
const rawNames=['ROLLOUT_DB_PASSWORD','ROLLOUT_DEMO_PASSWORD','ROLLOUT_STAGING_TOKEN','ROLLOUT_PRODUCTION_TOKEN','ROLLOUT_TEST_DB_PASSWORD'];
const values={};
if(fs.existsSync(file)) {
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if(match) values[match[1]]=match[2];
  }
} else {
  for(const name of rawNames) values[name]=process.env[name] || randomBytes(32).toString('hex');
  values.ROLLOUT_APP_ORIGIN=process.env.ROLLOUT_APP_ORIGIN || 'http://127.0.0.1:8098';
}
for(const name of rawNames) if(!/^[0-9a-f]{64}$/.test(values[name] || '')) throw new Error('Private setup requires five 64-character lowercase hex secrets. Values are not printed.');
for(const environment of ['STAGING','PRODUCTION']) {
  values[`ROLLOUT_${environment}_TOKEN_SHA256`]=createHash('sha256').update(values[`ROLLOUT_${environment}_TOKEN`],'utf8').digest('hex');
}
if(values.ROLLOUT_APP_ORIGIN!=='http://127.0.0.1:8098') throw new Error('This checkout expects http://127.0.0.1:8098; change the app origin and host port together.');
fs.writeFileSync(file,Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600});
fs.mkdirSync(path.join(root,'.local'),{recursive:true});
fs.writeFileSync(path.join(root,'.local/LOCAL-CREDENTIALS.txt'),[
  'RolloutDesk - LOCAL ONLY; do not commit or share this file.',
  'URL: http://127.0.0.1:8098',
  'Email: operator@rolloutdesk.test',
  `Password: ${values.ROLLOUT_DEMO_PASSWORD}`,
  '',
  'Client tokens stay on the server/CLI; never paste them into the frontend.',
  `Staging: ${values.ROLLOUT_STAGING_TOKEN}`,
  `Production: ${values.ROLLOUT_PRODUCTION_TOKEN}`,
  '',
  'Existing database accounts are not reset when this setup script runs.',
].join('\n')+'\n',{mode:0o600});
console.log('Private configuration ready. Read .local/LOCAL-CREDENTIALS.txt in this checkout.');
