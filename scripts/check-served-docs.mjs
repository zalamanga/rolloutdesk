import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = process.env.ROLLOUT_BASE_URL || 'http://127.0.0.1:8098';
const files = [
  ['/openapi.json', '../docs/openapi.json'],
  ['/postman.collection.json', '../docs/postman/RolloutDesk.postman_collection.json'],
  ['/postman.environment.example.json', '../docs/postman/RolloutDesk.local.postman_environment.example.json'],
];
for (const [route, source] of files) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `${route}: HTTP 200`);
  assert.match(response.headers.get('content-type') || '', /^application\/json\b/i, `${route}: JSON content type`);
  const body = await response.text();
  JSON.parse(body);
  assert.equal(body, await readFile(new URL(source, import.meta.url), 'utf8'), `${route}: served bytes match source`);
}
console.log('Three public JSON documentation routes: HTTP status, content type and source equality PASS.');
