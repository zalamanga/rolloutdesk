import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { generatedFiles } from './generate-api-docs.mjs';

const root = new URL('../', import.meta.url);
for (const [name, expected] of generatedFiles) assert.equal(readFileSync(new URL(name, root), 'utf8'), expected, `${name} must match generator output`);
const requireFrontend = createRequire(new URL('frontend/package.json', root));
const SwaggerParser = requireFrontend('@apidevtools/swagger-parser');
const spec = await SwaggerParser.validate(fileURLToPath(new URL('docs/openapi.json', root)), { resolve: { external: false } });
assert.equal(spec.openapi, '3.0.3');
const source = readFileSync(new URL('backend/src/api.rs', root), 'utf8');
const routes = [...source.matchAll(/\.route\("([^"]+)", (get|post|put)\(/g)].map((m) => `${m[2]} ${m[1]}`).sort();
const documented = Object.entries(spec.paths).flatMap(([route, operations]) => Object.keys(operations).filter((m) => ['get', 'post', 'put'].includes(m)).map((m) => `${m} ${route}`)).sort();
assert.equal(routes.length, 12);
assert.deepEqual(documented, routes, 'OpenAPI paths must match actual Rust methods and routes');
assert.equal(spec.components.schemas.NullablePublication.type, 'object');
assert.equal(spec.components.schemas.NullablePublication.nullable, true);
assert.ok(!spec.components.schemas.NullablePublication.allOf, 'An allOf ref would incorrectly reject the null active state');
assert.equal(spec.components.schemas.Decision.properties.bucket.nullable, true);
assert.equal(spec.components.schemas.Decision.properties.revision.nullable, true);
for (const schema of ['LoginInput', 'DraftInput', 'PublishInput', 'RollbackInput', 'PreviewInput', 'EvaluateInput', 'Config']) assert.equal(spec.components.schemas[schema].additionalProperties, false);
const collection = JSON.parse(readFileSync(new URL('docs/postman/RolloutDesk.postman_collection.json', root), 'utf8'));
const environment = JSON.parse(readFileSync(new URL('docs/postman/RolloutDesk.local.postman_environment.example.json', root), 'utf8'));
assert.equal(collection.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
assert.equal(collection.item.length, 16);
for (const key of ['operatorPassword', 'stagingToken', 'productionToken']) assert.equal(environment.values.find((v) => v.key === key).value, '', `${key} must not ship a credential`);
const variableSet = new Set([...environment.values, ...collection.variable].map((v) => v.key));
for (const item of collection.item) {
  for (const match of JSON.stringify(item.request).matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g)) assert.ok(variableSet.has(match[1]), `Undeclared Postman variable ${match[1]}`);
  for (const event of item.event) new Function(event.script.exec.join('\n'));
}
assert.ok(collection.item.find((item) => item.name.startsWith('15 ')).event[0].script.exec[0].includes('401'));
console.log('OpenAPI 3.0.3 validated; 12 Rust routes match; generated files, nullable models, strict requests and 16 Postman request scripts checked.');
