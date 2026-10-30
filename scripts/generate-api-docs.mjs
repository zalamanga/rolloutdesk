import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties, extra = {}) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties, ...extra });
const integer = (minimum, maximum, extra = {}) => ({ type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }), ...extra });
const text = (extra = {}) => ({ type: 'string', ...extra });
const array = (items, extra = {}) => ({ type: 'array', items, ...extra });
const environment = text({ enum: ['staging', 'production'] });
const subject = text({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$', description: 'Case-sensitive ASCII subject. It is not stored by evaluation or preview.' });
const inputVersion = integer(1, 1_000_000_000);
const revision = integer(1, 100);
const note = text({ minLength: 10, description: 'Rust trims surrounding Unicode whitespace, then requires 10 to 500 Unicode scalar values. The untrimmed JSON string can be longer than 500 characters.', 'x-trimmedLength': { minimum: 10, maximum: 500 } });
const timestamp = text({ format: 'date-time' });
const uuid = text({ format: 'uuid' });
const publication = object({ revision, config: ref('Config'), kind: text({ enum: ['PUBLISH', 'ROLLBACK'] }), sourceRevision: { ...revision, nullable: true }, note: text({ minLength: 10, maxLength: 500 }), actor: text(), createdAt: timestamp });
const schemas = {
  Health: object({ status: text({ enum: ['ok'] }) }),
  Error: object({ code: text({ enum: ['INVALID_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'VERSION_CONFLICT', 'NO_CHANGE', 'REVISION_LIMIT', 'RATE_LIMITED', 'UNAVAILABLE', 'INTERNAL_ERROR'] }), message: text() }),
  User: object({ id: uuid, email: text(), name: text() }),
  Session: object({ user: ref('User'), csrfToken: text({ pattern: '^[a-f0-9]{64}$' }) }),
  Config: object({ enabled: { type: 'boolean' }, rolloutBasisPoints: integer(0, 10000), allowlist: array(subject, { maxItems: 20, uniqueItems: true, description: 'Canonical responses sort these exact case-sensitive IDs. Duplicate request IDs are invalid.' }) }),
  Publication: publication,
  NullablePublication: { ...publication, nullable: true, description: 'A full publication object, or null before the first publication. PUBLISH has a null sourceRevision; ROLLBACK references an existing revision.' },
  EnvironmentState: object({ environment, version: integer(1, undefined, { format: 'int64' }), draft: ref('Config'), active: ref('NullablePublication'), updatedAt: timestamp }),
  FlagIdentity: object({ key: text(), name: text(), description: text() }),
  Flag: object({ key: text(), name: text(), description: text(), states: array(ref('EnvironmentState'), { minItems: 2, maxItems: 2, description: 'Staging followed by production.' }) }),
  FlagDetail: object({ flag: ref('FlagIdentity'), state: ref('EnvironmentState'), history: array(ref('Publication'), { maxItems: 100, description: 'Newest revision first.' }) }),
  Decision: object({ flagKey: text(), environment, revision: { ...revision, nullable: true }, value: { type: 'boolean' }, reason: text({ enum: ['FLAG_NOT_FOUND', 'UNPUBLISHED', 'DISABLED', 'ALLOWLIST', 'ROLLOUT', 'OUTSIDE_ROLLOUT'] }), bucket: integer(0, 9999, { nullable: true }), algorithm: text({ enum: ['sha256-u32be-mod10000-v1'] }) }, { description: 'Unknown valid keys return false, FLAG_NOT_FOUND and null bucket/revision. Unpublished registered keys return false, UNPUBLISHED and a numeric bucket. Draft preview always has null revision.' }),
  Preview: object({ published: ref('Decision'), draft: ref('Decision') }),
  AuditItem: object({ id: uuid, createdAt: timestamp, actor: text(), action: text({ enum: ['DRAFT_SAVED', 'PUBLISHED', 'ROLLED_BACK'] }), flagKey: text(), environment, revision: { ...revision, nullable: true }, note: text() }),
  AuditPage: object({ items: array(ref('AuditItem'), { maxItems: 25 }), page: integer(0, 10000), pageSize: { type: 'integer', enum: [25] }, total: integer(0, undefined, { format: 'int64' }) }),
  LoginInput: object({ email: text({ maxLength: 254, description: 'At most 254 UTF-8 bytes before normalization. Trimmed and ASCII-lowercased for lookup; no registration endpoint exists.' }), password: text({ minLength: 1, maxLength: 72, format: 'password', description: 'At most 72 UTF-8 bytes. No password value is included in this specification.' }) }),
  DraftInput: object({ expectedVersion: inputVersion, config: ref('Config') }),
  PublishInput: object({ expectedVersion: inputVersion, note }),
  RollbackInput: object({ expectedVersion: inputVersion, targetRevision: revision, note }),
  PreviewInput: object({ subjectId: subject }),
  EvaluateInput: object({ flagKey: text({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9-]+$', description: 'A valid unregistered key is accepted and returns a safe false decision.' }), subjectId: subject }),
};
const content = (schema, examples) => ({ 'application/json': { schema, ...(examples ? { examples } : {}) } });
const response = (description, schema, extra = {}) => ({ description, ...(schema ? { content: content(schema) } : {}), ...extra });
const error = (description, codes) => response(description, ref('Error'), { 'x-error-codes': codes });
const errors = {
  400: error('Invalid JSON, unknown fields, wrong Content-Type, body over 16 KiB or invalid request values. These failures return 400 rather than 415 or 422.', ['INVALID_REQUEST']),
  401: error('Authentication is missing, expired, malformed or invalid; a bearer token may belong to the other environment.', ['UNAUTHORIZED']),
  403: error('Origin is not the configured exact origin, or the CSRF token does not match the session.', ['FORBIDDEN']),
  404: error('Operator flag, environment or rollback target does not exist.', ['NOT_FOUND']),
  405: error('The HTTP method is not supported for the requested route.', ['METHOD_NOT_ALLOWED']),
  409: error('The version is stale, the configuration already equals the active publication, or the pair has 100 publications. Refresh and review; do not automatically retry with a new version.', ['VERSION_CONFLICT', 'NO_CHANGE', 'REVISION_LIMIT']),
  429: error('Sign-in limit reached: 10 attempts, including successful attempts, per five-minute window. The local Nginx proxy shares a source address.', ['RATE_LIMITED']),
  500: error('An internal operation failed. The response does not disclose internal database details.', ['INTERNAL_ERROR']),
  503: error('The database or pool is unavailable.', ['UNAVAILABLE']),
};
const responses = (schema, statuses = [], description = 'Successful response.') => ({ 200: response(description, ref(schema)), ...Object.fromEntries([...new Set([...statuses, 405, 500, 503])].map((s) => [s, errors[s]])) });
const origin = { name: 'Origin', in: 'header', required: true, schema: text({ enum: ['http://127.0.0.1:8098'] }), description: 'Must exactly match ROLLOUT_APP_ORIGIN. Changing 127.0.0.1 to localhost is a different origin.' };
const key = { name: 'key', in: 'path', required: true, schema: text(), description: 'Registered keys: checkout-redesign, bulk-export and priority-support. Other keys return 404 for operator routes.' };
const env = { name: 'environment', in: 'path', required: true, schema: environment };
const params = [key, env];
const operator = [{ cookieSession: [] }];
const mutation = [{ cookieSession: [], csrfToken: [] }];
const body = (schema, example) => ({ required: true, description: 'Exactly one JSON object, at most 16 KiB. Integer values must not be fractional. Unknown fields are rejected.', content: content(ref(schema), example ? { demo: { value: example } } : undefined) });
const mutationOperation = (operationId, summary, requestSchema, resultSchema, example, description) => ({ operationId, summary, description, tags: ['Operator release workflow'], security: mutation, parameters: [...params, origin], requestBody: body(requestSchema, example), responses: responses(resultSchema, [400, 401, 403, 404, 409]) });
const spec = {
  openapi: '3.0.3',
  info: { title: 'RolloutDesk REST API', version: '1.0.0', description: 'Rust/axum feature-release lab. Operator APIs use an opaque HttpOnly cookie plus CSRF and exact Origin on writes. The client API accepts an environment-scoped bearer token and reads published configuration only. Handler responses use no-store; this specification contains no real credentials. Scope: three fixed flags, two environments, one local operator. No create/delete, OAuth, exposure collection or SDK is supplied.' },
  servers: [{ url: 'http://127.0.0.1:8098', description: 'Local Nginx entry point. Start the repository Compose stack first.' }],
  tags: [{ name: 'Health and session' }, { name: 'Operator release workflow' }, { name: 'Published client evaluation' }],
  paths: {
    '/api/health': { get: { operationId: 'getHealth', summary: 'Check API and database health', tags: ['Health and session'], security: [], responses: responses('Health') } },
    '/api/auth/login': { post: { operationId: 'login', summary: 'Create an operator cookie session', tags: ['Health and session'], security: [], parameters: [origin], requestBody: body('LoginInput'), responses: { ...responses('Session', [400, 401, 403, 429]), 200: response('Authenticated session and CSRF token. Postman stores the cookie in its cookie jar.', ref('Session'), { headers: { 'Set-Cookie': { description: 'rolloutdesk_session=<opaque>; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200. Secure is added when configured.', schema: text() } } }) } } },
    '/api/auth/session': { get: { operationId: 'getSession', summary: 'Read the current operator and CSRF token', tags: ['Health and session'], security: operator, responses: responses('Session', [401]) } },
    '/api/auth/logout': { post: { operationId: 'logout', summary: 'Invalidate the current session', tags: ['Health and session'], security: mutation, parameters: [origin], responses: { 204: response('Logged out. No response body; Set-Cookie expires the session.', undefined, { headers: { 'Set-Cookie': { schema: text(), description: 'Expires rolloutdesk_session with Max-Age=0.' } } }), ...Object.fromEntries([401, 403, 405, 500, 503].map((s) => [s, errors[s]])) } } },
    '/api/flags': { get: { operationId: 'listFlags', summary: 'List the three registered flags and both states', tags: ['Operator release workflow'], security: operator, responses: { ...responses('Flag', [401]), 200: response('Exactly three flags ordered by key; each contains staging then production state.', array(ref('Flag'), { minItems: 3, maxItems: 3 })) } } },
    '/api/flags/{key}/{environment}': { get: { operationId: 'getFlagDetail', summary: 'Read state, version and immutable history together', tags: ['Operator release workflow'], security: operator, parameters: params, responses: responses('FlagDetail', [401, 404]) } },
    '/api/flags/{key}/{environment}/draft': { put: mutationOperation('saveDraft', 'Save a draft without changing client behavior', 'DraftInput', 'EnvironmentState', { expectedVersion: 1, config: { enabled: true, rolloutBasisPoints: 2500, allowlist: ['demo-alice'] } }, 'Checks the explicit expectedVersion. Canonical identical drafts may return the unchanged version and create no audit record. A changed draft increments the state version atomically with its audit entry.') },
    '/api/flags/{key}/{environment}/publish': { post: mutationOperation('publish', 'Publish the current saved draft atomically', 'PublishInput', 'FlagDetail', { expectedVersion: 2, note: 'Release the staging demo cohort' }, 'Creates an immutable revision from the stored draft, switches the active pointer and appends audit in one transaction. State version increases. Draft remains unchanged. At most 100 publications per flag/environment pair.') },
    '/api/flags/{key}/{environment}/rollback': { post: mutationOperation('rollback', 'Append a revision copying an earlier publication', 'RollbackInput', 'FlagDetail', { expectedVersion: 5, targetRevision: 1, note: 'Restore the reviewed staging revision' }, 'Target must exist within the same pair. Creates a new ROLLBACK revision with sourceRevision, changes active and audit atomically, and preserves the current draft. Copying the active configuration is a NO_CHANGE conflict.') },
    '/api/flags/{key}/{environment}/preview': { post: { operationId: 'preview', summary: 'Compare saved draft and active decisions without writing data', description: 'Requires CSRF and Origin even though it is read-only. The draft decision has null revision. Subject/evaluation history is not stored.', tags: ['Operator release workflow'], security: mutation, parameters: [...params, origin], requestBody: body('PreviewInput', { subjectId: 'demo-alice' }), responses: responses('Preview', [400, 401, 403, 404]) } },
    '/api/audit': { get: { operationId: 'listAudit', summary: 'Read stable newest-first audit history', description: 'Only the optional single page query is supported. Duplicate page, additional query fields, signs and fractional/encoded forms are rejected. An absent query means page zero. Page size is fixed at 25.', tags: ['Operator release workflow'], security: operator, parameters: [{ name: 'page', in: 'query', required: false, schema: integer(0, 10000, { default: 0 }), description: 'A single ASCII decimal string of one through five digits, 0 to 10000. No other query parameters.' }], responses: responses('AuditPage', [400, 401]) } },
    '/client/v1/evaluate/{environment}': { post: { operationId: 'evaluatePublishedFlag', summary: 'Evaluate only published configuration with a scoped bearer token', description: 'A staging token cannot evaluate production and vice versa. No operator cookie, Origin or CSRF is required. Invalid environments fail authentication with 401. Unknown syntactically valid keys and unpublished flags safely return false with HTTP 200. Subjects and decisions are not persisted.', tags: ['Published client evaluation'], security: [{ clientBearer: [] }], parameters: [env], requestBody: body('EvaluateInput', { flagKey: 'checkout-redesign', subjectId: 'demo-alice' }), responses: responses('Decision', [400, 401]) } },
  },
  components: { schemas, securitySchemes: { cookieSession: { type: 'apiKey', in: 'cookie', name: 'rolloutdesk_session', description: 'Opaque HttpOnly cookie from login, expires after 12 hours. Not a JWT. Swagger browser consoles cannot manually set this cookie; use the same-origin UI or Postman cookie jar.' }, csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'csrfToken from the matching successful login/session response. Combine with the session cookie and exact Origin.' }, clientBearer: { type: 'http', scheme: 'bearer', bearerFormat: '64 hexadecimal characters', description: 'Private token scoped to the requested staging or production environment. This is not an OAuth/JWT token. Never put it in frontend code or a URL.' } } },
};

const event = (listen, lines) => ({ listen, script: { type: 'text/javascript', exec: lines } });
const statusScript = (status, extra = []) => [
  `pm.test('HTTP ${status}', () => pm.response.to.have.status(${status}));`,
  `if (pm.response.code === ${status}) {`,
  ...extra.map((line) => `  ${line}`),
  '} else { pm.execution.setNextRequest(null); }',
];
const captureVersion = ['const data = pm.response.json();', "pm.collectionVariables.set('expectedVersion', String(data.state ? data.state.version : data.version));"];
const savedDraft = (variable) => [...captureVersion, `pm.test('Saved draft matches intended config', () => pm.expect(data.draft).to.deep.equal(JSON.parse(pm.collectionVariables.get('${variable}'))));`];
const request = (name, method, route, { json, tests = statusScript(200), csrf = false, bearer, description = '', prerequest = [] } = {}) => ({ name, request: { method, header: [...(json === undefined ? [] : [{ key: 'Content-Type', value: 'application/json' }]), ...(csrf || route === '/api/auth/login' ? [{ key: 'Origin', value: '{{baseUrl}}' }] : []), ...(csrf ? [{ key: 'X-CSRF-Token', value: '{{csrfToken}}' }] : [])], auth: bearer ? { type: 'bearer', bearer: [{ key: 'token', value: `{{${bearer}}}`, type: 'string' }] } : { type: 'noauth' }, url: '{{baseUrl}}' + route, ...(json === undefined ? {} : { body: { mode: 'raw', raw: typeof json === 'string' ? json : JSON.stringify(json, null, 2), options: { raw: { language: 'json' } } } }), description }, event: [...(prerequest.length ? [event('prerequest', prerequest)] : []), event('test', tests)] });
const statePath = '/api/flags/{{flagKey}}/{{environment}}';
const collection = {
  info: { name: 'RolloutDesk REST workflow', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'Run in order against a disposable local staging lab. This collection changes one flag, adds three immutable publications per complete run, and preserves the second draft on rollback. It stops Collection Runner after an unexpected response and never retries a version conflict. Read docs/REST-CLIENT-GUIDE.md. All password/token environment defaults are blank.' },
  variable: [ ['flagKey', 'checkout-redesign'], ['environment', 'staging'], ['subjectId', 'demo-alice'], ['csrfToken', ''], ['expectedVersion', ''], ['targetRevision', ''], ['firstConfig', ''], ['secondConfig', ''] ].map(([key, value]) => ({ key, value, type: 'string' })),
  item: [
    request('01 Health', 'GET', '/api/health'),
    request('02 Login and retain cookie', 'POST', '/api/auth/login', { json: { email: '{{operatorEmail}}', password: '{{operatorPassword}}' }, prerequest: ["if (pm.environment.get('baseUrl') !== 'http://127.0.0.1:8098') { throw new Error('Use the exact local RolloutDesk origin.'); }", "for (const key of ['operatorPassword', 'stagingToken', 'productionToken']) { if (!pm.environment.get(key)) { throw new Error('Fill the private ' + key + ' in the selected local environment first.'); } }", "if (pm.collectionVariables.get('environment') !== 'staging') { throw new Error('This mutation walkthrough is restricted to staging.'); }"], tests: statusScript(200, ["const data = pm.response.json();", "pm.collectionVariables.set('csrfToken', data.csrfToken);"]) }),
    request('03 Read session', 'GET', '/api/auth/session', { tests: statusScript(200, ["pm.test('CSRF matches login', () => pm.expect(pm.response.json().csrfToken).to.eql(pm.collectionVariables.get('csrfToken')));"]) }),
    request('04 List flags', 'GET', '/api/flags', { tests: statusScript(200, ["pm.test('Three registered flags', () => pm.expect(pm.response.json()).to.have.length(3));"]) }),
    request('05 Read detail and choose distinct configurations', 'GET', statePath, { tests: statusScript(200, [...captureVersion, "const activeEnabled = data.state.active ? data.state.active.config.enabled : false;", "pm.collectionVariables.set('firstConfig', JSON.stringify({enabled: !activeEnabled, rolloutBasisPoints: 2500, allowlist: ['demo-alice']}));", "pm.collectionVariables.set('secondConfig', JSON.stringify({enabled: activeEnabled, rolloutBasisPoints: 7500, allowlist: []}));", "pm.test('Room for three new publications', () => pm.expect(data.history.length).to.be.at.most(97));", "if (data.history.length > 97) { pm.execution.setNextRequest(null); }"]) }),
    request('06 Save first draft', 'PUT', statePath + '/draft', { csrf: true, json: '{"expectedVersion": {{expectedVersion}}, "config": {{firstConfig}}}', tests: statusScript(200, savedDraft('firstConfig')) }),
    request('07 Publish first saved draft', 'POST', statePath + '/publish', { csrf: true, json: '{"expectedVersion": {{expectedVersion}}, "note":"Publish first REST walkthrough configuration"}', tests: statusScript(200, [...captureVersion, "pm.collectionVariables.set('targetRevision', String(data.state.active.revision));", "pm.test('First publication uses saved config', () => pm.expect(data.state.active.config).to.deep.equal(JSON.parse(pm.collectionVariables.get('firstConfig'))));"]) }),
    request('08 Save second draft', 'PUT', statePath + '/draft', { csrf: true, json: '{"expectedVersion": {{expectedVersion}}, "config": {{secondConfig}}}', tests: statusScript(200, savedDraft('secondConfig')) }),
    request('09 Publish second saved draft', 'POST', statePath + '/publish', { csrf: true, json: '{"expectedVersion": {{expectedVersion}}, "note":"Publish second REST walkthrough configuration"}', tests: statusScript(200, captureVersion) }),
    request('10 Roll back while retaining second draft', 'POST', statePath + '/rollback', { csrf: true, json: '{"expectedVersion": {{expectedVersion}}, "targetRevision": {{targetRevision}}, "note":"Restore the first REST walkthrough publication"}', tests: statusScript(200, [...captureVersion, "pm.test('Rollback references selected revision', () => pm.expect(data.state.active.sourceRevision).to.eql(Number(pm.collectionVariables.get('targetRevision'))));", "pm.test('Rollback restores first configuration', () => pm.expect(data.state.active.config).to.deep.equal(JSON.parse(pm.collectionVariables.get('firstConfig'))));", "pm.test('Second draft survives rollback', () => pm.expect(data.state.draft).to.deep.equal(JSON.parse(pm.collectionVariables.get('secondConfig'))));"]) }),
    request('11 Preview draft versus published', 'POST', statePath + '/preview', { csrf: true, json: { subjectId: '{{subjectId}}' }, tests: statusScript(200, ["const data = pm.response.json();", "pm.test('Draft has no published revision', () => pm.expect(data.draft.revision).to.eql(null));", "pm.test('Both decisions use the same cohort bucket', () => pm.expect(data.draft.bucket).to.eql(data.published.bucket));"]) }),
    request('12 Read audit', 'GET', '/api/audit?page=0', { tests: statusScript(200, ["pm.test('Fixed audit page size', () => pm.expect(pm.response.json().pageSize).to.eql(25));"]) }),
    request('13 Evaluate staging with staging token', 'POST', '/client/v1/evaluate/staging', { bearer: 'stagingToken', json: { flagKey: '{{flagKey}}', subjectId: '{{subjectId}}' } }),
    request('14 Evaluate production with production token', 'POST', '/client/v1/evaluate/production', { bearer: 'productionToken', json: { flagKey: '{{flagKey}}', subjectId: '{{subjectId}}' }, description: 'Production is read only in this walkthrough. UNPUBLISHED is a valid 200 response.' }),
    request('15 Reject staging token for production', 'POST', '/client/v1/evaluate/production', { bearer: 'stagingToken', json: { flagKey: '{{flagKey}}', subjectId: '{{subjectId}}' }, tests: statusScript(401, ["pm.test('Wrong environment is unauthorized', () => pm.expect(pm.response.json().code).to.eql('UNAUTHORIZED'));"]) }),
    request('16 Logout', 'POST', '/api/auth/logout', { csrf: true, tests: statusScript(204, ["pm.collectionVariables.unset('csrfToken');", "pm.collectionVariables.unset('expectedVersion');", "pm.collectionVariables.unset('targetRevision');"]) }),
  ],
};
const environmentExample = { name: 'RolloutDesk local example (fill secrets privately)', values: [
  { key: 'baseUrl', value: 'http://127.0.0.1:8098', type: 'default', enabled: true },
  { key: 'operatorEmail', value: 'operator@rolloutdesk.test', type: 'default', enabled: true },
  ...['operatorPassword', 'stagingToken', 'productionToken'].map((key) => ({ key, value: '', type: 'secret', enabled: true })),
], _postman_variable_scope: 'environment' };

export const generatedFiles = new Map([
  ['docs/openapi.json', spec],
  ['docs/postman/RolloutDesk.postman_collection.json', collection],
  ['docs/postman/RolloutDesk.local.postman_environment.example.json', environmentExample],
].map(([name, value]) => [name, JSON.stringify(value, null, 2) + '\n']));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  for (const [name, value] of generatedFiles) {
    const destination = path.join(root, name);
    if (check) {
      if (readFileSync(destination, 'utf8') !== value) throw new Error(`${name} differs from the source generator. Run node scripts/generate-api-docs.mjs.`);
    } else {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, value);
    }
  }
  console.log(`${check ? 'Checked' : 'Generated'} ${generatedFiles.size} public API documentation files. No private configuration was read.`);
}
