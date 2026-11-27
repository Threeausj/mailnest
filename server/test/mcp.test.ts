import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/security.js';

const origin = 'http://localhost:5173';
const endpoint = '/api/v1/mcp';
const password = 'mailnest synthetic test password';
let dir: string;
let project: Awaited<ReturnType<typeof buildApp>>;
let session: string;
let token: string;
let tokenId: string;
let apiToken: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailnest-mcp-'));
  project = await buildApp({ ...loadConfig({
    APP_URL: origin, DATA_DIR: dir, ADMIN_EMAIL: 'mcp@example.test',
    ADMIN_PASSWORD: password, ENCRYPTION_KEY: 'e'.repeat(64),
  }), background: false });
  const { app, store } = project;
  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin },
    payload: { email: 'mcp@example.test', password },
  });
  assert.equal(login.statusCode, 200);
  session = login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const created = await app.inject({
    method: 'POST', url: '/api/v1/tokens', headers: { origin, cookie: session },
    payload: { name: 'MCP client', scope: 'mcp-read' },
  });
  assert.equal(created.statusCode, 201);
  ({ token, id: tokenId } = created.json());
  const ownerId = login.json().user.id;
  // Existing API token format remains valid after the scope migration.
  apiToken = 'mn_existing_fixture';
  store.db.prepare('INSERT INTO api_tokens(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,?)')
    .run('api-fixture', ownerId, 'API client', hashToken(apiToken), new Date().toISOString());
  store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('other', 'other@example.test', 'Other', 'unused');
  const insertAccount = store.db.prepare(`INSERT INTO accounts (
    id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,
    smtp_host,smtp_port,smtp_secure,credentials
  ) VALUES(?,?,?,?,?,'imap','fixture','fixture','imap.example.test',993,1,'smtp.example.test',465,1,'fixture-secret')`);
  const insertMessage = store.db.prepare(`INSERT INTO messages (
    id,account_id,folder,uid,uid_validity,summary,unread,starred,date,detail,detail_cached_at
  ) VALUES(?,?,'INBOX',1,'1',?,1,1,?,?,?)`);
  const date = new Date().toISOString();
  for (const [id, user] of [['mine', ownerId], ['foreign', 'other']]) {
    insertAccount.run(id, user, id, `${id}@example.test`, '#2563eb');
    store.db.prepare("INSERT INTO folders(account_id,path,name) VALUES(?,'INBOX','Inbox')").run(id);
    insertMessage.run(`message-${id}`, id,
      JSON.stringify({ subject: 'Status 100%', from: { address: 'team@example.test' }, date }),
      date,
      JSON.stringify({ cacheVersion: 2, text: '甲📨乙', html: '<p>Hidden HTML</p>', attachments: [] }),
      Date.now());
  }
});

after(async () => {
  await project?.app.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function rpc(method: string, params: unknown, extra: Record<string, string> = {}, id: number | undefined = 1) {
  return project.app.inject({
    method: 'POST', url: endpoint,
    headers: { host: 'localhost:5173', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...extra },
    payload: { jsonrpc: '2.0', id, method, params },
  });
}

function rpcResponse(response: Awaited<ReturnType<typeof rpc>>) {
  if (response.headers['content-type']?.toString().includes('text/event-stream')) {
    const events = response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    return events.find(event => event.id === 1);
  }
  return response.json();
}

function call(name: string, args: Record<string, unknown> = {}) {
  return rpc('tools/call', { name, arguments: args });
}

test('MCP bearer credentials are isolated from API tokens and cookie sessions', async () => {
  assert.equal((await rpc('tools/list', {}, { authorization: '', cookie: session })).statusCode, 401);
  const invalid = await rpc('tools/list', {}, { authorization: 'Bearer wrong' });
  assert.equal(invalid.statusCode, 401);
  assert.match(String(invalid.headers['www-authenticate']), /^Bearer /);
  assert.equal(invalid.headers['cache-control'], 'no-store');
  assert.equal((await rpc('tools/list', {}, { authorization: `Bearer ${apiToken}` })).statusCode, 401);
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await project.app.inject({ url: '/api/v1/accounts', headers })).statusCode, 401);
  assert.equal((await project.app.inject({ method: 'POST', url: '/api/v1/messages/send', headers, payload: {} })).statusCode, 401);
  assert.equal((await project.app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${apiToken}` } })).statusCode, 200);
  for (const extra of [{ origin: 'https://foreign.example.test' }, { host: 'foreign.example.test' }]) {
    assert.equal((await rpc('tools/list', {}, extra)).statusCode, 403);
  }
  for (const method of ['GET', 'DELETE'] as const) {
    assert.equal((await project.app.inject({ method, url: endpoint, headers: { ...headers, host: 'localhost:5173' } })).statusCode, 405);
  }
});

test('MCP initialization and tools only expose the authenticated mailbox and page through plain text', async () => {
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mailnest-test', version: '1.0.0' } });
  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.headers['cache-control'], 'no-store');
  assert.equal(rpcResponse(initialized).result.serverInfo.name, 'mailnest');
  assert.equal(initialized.headers['mcp-session-id'], undefined);
  const protocol = { 'mcp-protocol-version': '2025-11-25' };
  const ready = await project.app.inject({
    method: 'POST', url: endpoint,
    headers: { ...protocol, host: 'localhost:5173', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(ready.statusCode, 202);
  const listed = rpcResponse(await rpc('tools/list', {}, protocol)).result.tools;
  assert.deepEqual(listed.map((tool: { name: string }) => tool.name).sort(), ['list_accounts', 'list_folders', 'read_message', 'search_messages']);
  assert.ok(listed.every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint));
  const accounts = rpcResponse(await call('list_accounts')).result.structuredContent.accounts;
  assert.deepEqual(accounts.map((account: { id: string }) => account.id), ['mine']);
  assert.equal(accounts[0].credentials, undefined);
  assert.equal(rpcResponse(await call('list_folders', { accountId: 'mine' })).result.structuredContent.folders[0].path, 'INBOX');
  const messages = rpcResponse(await call('search_messages', { q: '100%', filter: 'starred' })).result.structuredContent;
  assert.equal(messages.total, 1);
  assert.equal(messages.messages[0].id, 'message-mine');
  assert.equal(rpcResponse(await call('search_messages', { q: '%_' })).result.structuredContent.total, 0);
  const first = rpcResponse(await call('read_message', { messageId: 'message-mine', limit: 2 })).result.structuredContent;
  assert.equal(first.message.text, '甲📨');
  assert.equal(first.message.html, undefined);
  assert.equal(first.nextOffset, 2);
  const rest = rpcResponse(await call('read_message', { messageId: 'message-mine', offset: first.nextOffset })).result.structuredContent;
  assert.equal(rest.message.text, '乙');
  assert.equal(rest.nextOffset, null);
  assert.equal(rest.message.unread, true);
  for (const [name, args] of [
    ['list_folders', { accountId: 'foreign' }],
    ['search_messages', { accountId: 'foreign' }],
    ['read_message', { messageId: 'message-foreign' }],
  ] as const) {
    const { result } = rpcResponse(await call(name, args));
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'NOT_FOUND');
  }
});

test('MCP tokens are revocable using existing token controls', async () => {
  const { app } = project;
  const headers = { cookie: session, origin };
  const listed = await app.inject({ url: '/api/v1/tokens', headers });
  const tokens = listed.json().tokens;
  assert.equal(tokens.find((row: { id: string }) => row.id === tokenId).scope, 'mcp-read');
  assert.equal(tokens.find((row: { id: string }) => row.id === 'api-fixture').scope, 'api');
  assert.ok(!listed.body.includes(token));
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/tokens/${tokenId}`, headers })).statusCode, 200);
  assert.equal((await rpc('tools/list', {})).statusCode, 401);
});
