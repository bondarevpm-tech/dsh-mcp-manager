/**
 * RFC 8707 `resource` on the Kontrcheck topology, plus the browser-facing origin
 * and callback safety around it.
 *
 * The stub plays Kontrcheck: the MCP endpoint 401s with a resource_metadata
 * pointer, the protected-resource document names both the authorization server
 * and the resource, the AS advertises registration, the token endpoint refuses a
 * request without the resource, and refresh tokens are single-use.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-resource-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

mkdirSync(join(scratchHome, '.dsh'), { recursive: true });
const statePath = join(scratchHome, '.dsh', 'mcp-manager.json');
const fixture = fileURLToPath(new URL('../test-fixtures/restart-connect.mjs', import.meta.url));

const { apply } = await import('../lib/index.js');

function makeCtx() {
  const routes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    get: () => undefined,
    on: () => () => {},
    inject: (names, callback) => {
      if (typeof callback === 'function' && names.includes('webServer')) {
        callback({
          webServer: ctx.webServer,
          get: () => undefined,
          effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
        });
      }
      return { dispose: () => {} };
    },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  apply(ctx);
  return { routes, handler: routes[0]?.handler };
}

async function request(handler, method, path, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk; },
  };
  const res = {
    code: 0,
    body: '',
    writeHead(code) { this.code = code; },
    end(chunk) { this.body = chunk ?? ''; },
  };
  await handler(req, res);
  let json;
  try { json = res.body ? JSON.parse(res.body) : undefined; } catch {}
  return { code: res.code, json, text: String(res.body) };
}

const state = () => JSON.parse(readFileSync(statePath, 'utf8'));

/**
 * A stub that behaves like the Kontrcheck connector: resource-bound tokens,
 * single-use refresh rotation, and an MCP endpoint that only accepts the live
 * access token.
 */
function startStub({ publishResource = true } = {}) {
  const seen = [];
  const tokenForms = [];
  const registerBodies = [];
  let issued = 0;
  const validAccess = new Set();
  let currentRefresh = '';

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push(`${req.method} ${req.url}`);
      const base = `http://127.0.0.1:${server.address().port}`;
      const resource = `${base}/mcp`;
      const send = (code, body, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      if (req.url === '/mcp') {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch {}
        const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!validAccess.has(token)) {
          return send(401, { error: 'unauthorized' }, {
            'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          });
        }
        const result = payload.method === 'initialize'
          ? { protocolVersion: payload.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } }
          : payload.method === 'tools/list' ? { tools: [] } : {};
        if (payload.id === undefined) { res.writeHead(202); return res.end(); }
        return send(200, { jsonrpc: '2.0', id: payload.id, result });
      }
      if (req.url === '/.well-known/oauth-protected-resource/mcp') {
        const doc = { authorization_servers: [base] };
        if (publishResource) doc.resource = `${base}/mcp`;
        return send(200, doc);
      }
      if (req.url === '/.well-known/oauth-protected-resource') return send(404, { error: 'not found' });
      if (req.url === '/.well-known/oauth-authorization-server') {
        return send(200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/register`,
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (req.url === '/register') {
        try { registerBodies.push(JSON.parse(raw || '{}')); } catch { registerBodies.push({}); }
        return send(201, { client_id: 'dcr-client' });
      }
      if (req.url === '/oauth/token') {
        const form = new URLSearchParams(raw);
        tokenForms.push(form);
        if (form.get('resource') !== resource) return send(400, { error: 'invalid_target' });
        if (form.get('grant_type') === 'authorization_code') {
          issued += 1;
          const access = `access-${issued}`;
          const refresh = `refresh-${issued}`;
          validAccess.add(access);
          currentRefresh = refresh;
          return send(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 28800 });
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (form.get('refresh_token') !== currentRefresh) return send(400, { error: 'invalid_grant' });
          issued += 1;
          const access = `access-${issued}`;
          const refresh = `refresh-${issued}`;
          validAccess.add(access);
          currentRefresh = refresh;
          return send(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 28800 });
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      return send(404, { error: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        mcpUrl: `${base}/mcp`,
        resource: `${base}/mcp`,
        seen,
        tokenForms,
        registerBodies,
        invalidate() { validAccess.clear(); },
        currentRefresh: () => currentRefresh,
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

async function authorize(handler, id) {
  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);
  return new URL(auth.json.authorizeUrl);
}

async function complete(handler, id, authorizeUrl) {
  const flowState = new URL(authorizeUrl).searchParams.get('state');
  const callback = await request(handler, 'GET', `/mcp-manager/callback/${id}?code=stub-code&state=${flowState}`);
  assert.match(callback.text, /Authorized/, callback.text);
  return callback;
}

it('sends the RFC 8707 resource from the protected-resource document at every step', async () => {
  const stub = await startStub();
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', {
    name: 'kontrcheck', type: 'http', url: stub.mcpUrl, authMode: 'oauth', scope: 'kontrcheck.read offline_access',
  });
  assert.equal(created.code, 201);
  const id = created.json.server.id;

  const authorizeUrl = await authorize(handler, id);
  assert.equal(authorizeUrl.searchParams.get('resource'), stub.resource, 'authorize must carry the discovered resource');
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), `http://127.0.0.1:3080/mcp-manager/callback/${id}`);
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(stub.registerBodies[0].redirect_uris, [`http://127.0.0.1:3080/mcp-manager/callback/${id}`]);

  assert.equal(stub.tokenForms.length, 0, 'registration alone issues no token');
  await complete(handler, id, authorizeUrl);
  assert.equal(stub.tokenForms.length, 1);
  assert.equal(stub.tokenForms[0].get('grant_type'), 'authorization_code');
  assert.equal(stub.tokenForms[0].get('resource'), stub.resource, 'token exchange must carry the resource');

  const persisted = state().servers.find((s) => s.name === 'kontrcheck');
  assert.equal(persisted.oauth.resource, stub.resource, 'the resource must survive a restart');
  assert.equal(persisted.oauth.tokens.access_token, 'access-1');
  assert.equal(persisted.oauth.tokens.refresh_token, 'refresh-1');

  await stub.close();
});

it('refreshes with the resource, rotates the refresh token, and reuses the rotated one', async () => {
  const stub = await startStub();
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'kc2', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));

  stub.invalidate();
  const first = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(first.code, 200, first.text);
  const refreshOne = stub.tokenForms.filter((form) => form.get('grant_type') === 'refresh_token');
  assert.equal(refreshOne.length, 1);
  assert.equal(refreshOne[0].get('resource'), stub.resource, 'refresh must carry the resource');
  assert.equal(refreshOne[0].get('refresh_token'), 'refresh-1');

  const afterFirst = state().servers.find((s) => s.name === 'kc2');
  assert.equal(afterFirst.oauth.tokens.refresh_token, 'refresh-2', 'the rotated token must replace the old one');
  assert.equal(afterFirst.oauth.tokens.access_token, 'access-2');

  stub.invalidate();
  const second = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(second.code, 200, second.text);
  const refreshTwo = stub.tokenForms.filter((form) => form.get('grant_type') === 'refresh_token');
  assert.equal(refreshTwo[1].get('refresh_token'), 'refresh-2', 'only the rotated token may be replayed');
  assert.equal(state().servers.find((s) => s.name === 'kc2').oauth.tokens.refresh_token, 'refresh-3');

  // A replayed old token is refused by the stub — rotation really happened.
  const replay = await fetch(`${stub.base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'dcr-client', resource: stub.resource }),
  });
  assert.equal(replay.status, 400);

  await stub.close();
});

it('restores a connection in a fresh process without re-registering or losing the resource', async () => {
  const stub = await startStub();
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'kc3', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));
  assert.equal(stub.registerBodies.length, 1);

  stub.invalidate();
  const registrationsBefore = stub.registerBodies.length;
  // The stub lives in this process, so the child must run asynchronously: a
  // spawnSync would block the event loop and deadlock the child's HTTP calls.
  let running = null;
  let child;
  try {
    child = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [fixture, id], {
        env: { ...process.env, HOME: scratchHome, USERPROFILE: scratchHome, DSH_HOME: join(scratchHome, '.dsh') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      running = proc;
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk; });
      proc.stderr.on('data', (chunk) => { stderr += chunk; });
      proc.on('error', reject);
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`restart probe timed out: ${stderr}`)); }, 30_000);
      proc.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
    });
  } finally {
    // A failed assertion must not leave the stub listening (it would keep the
    // test process alive) nor the probe running.
    if (running && running.exitCode === null) running.kill('SIGKILL');
    if (child === undefined) await stub.close();
  }
  assert.equal(child.status, 0, child.stderr);
  const verdict = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(verdict.code, 200, verdict.body);
  assert.equal(stub.registerBodies.length, registrationsBefore, 'a restart must reuse the registered client');
  const refresh = stub.tokenForms.filter((form) => form.get('grant_type') === 'refresh_token');
  assert.equal(refresh.at(-1).get('resource'), stub.resource, 'the resource must come back from the state file');
  assert.equal(state().servers.find((s) => s.name === 'kc3').oauth.tokens.refresh_token, 'refresh-2');

  await stub.close();
});

it('leaves the flow unchanged when the resource document publishes none', async () => {
  const stub = await startStub({ publishResource: false });
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'nores', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  const authorizeUrl = await authorize(handler, id);
  assert.equal(authorizeUrl.searchParams.get('resource'), null, 'nothing is invented without metadata');
  assert.equal(state().servers.find((s) => s.name === 'nores').oauth.resource, undefined);
  await stub.close();
});

it('uses the reverse proxy scheme for the callback and rejects a malformed forwarded host', async () => {
  const stub = await startStub();
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'proxy', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'harness.example.com',
  });
  assert.equal(auth.code, 200, auth.text);
  assert.equal(new URL(auth.json.authorizeUrl).searchParams.get('redirect_uri'), `https://harness.example.com/mcp-manager/callback/${id}`);

  const spoofed = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'evil.example.com/path',
  });
  assert.equal(spoofed.code, 400, spoofed.text);
  assert.match(spoofed.json.error, /invalid request host/);
  await stub.close();
});

it('escapes server-supplied text on the callback page', async () => {
  const stub = await startStub();
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'xss', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;

  // The authorization server answers with an OAuth error, and that text is what
  // the page prints — it must never be parsed as markup on the GUI origin.
  const callback = await request(handler, 'GET', `/mcp-manager/callback/${id}?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E`);
  assert.ok(!callback.text.includes('<img'), 'markup from the query string must not reach the page');
  assert.match(callback.text, /&lt;img/);
  assert.match(callback.text, /Authorization failed/);
  await stub.close();
});
