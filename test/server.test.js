import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.js';

let server;
let base;

test.before(async () => {
  server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(path.join(process.cwd(), 'http'), { recursive: true, force: true }); });

async function request(url, options) {
  return fetch(`${base}${url}`, { ...options, headers: { 'content-type': 'application/json', ...(options?.headers || {}) } });
}

test('reports health', async () => {
  const response = await request('/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('writes, reads, modifies, lists, greps, globs, and deletes over HTTP', async () => {
  const file = 'http/sample.txt';
  let response = await request('/api/write', { method: 'PUT', body: JSON.stringify({ path: file, content: 'alpha\nbeta\ngamma' }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).path, file);

  response = await request(`/api/read?path=${encodeURIComponent(file)}&tail=1`);
  assert.equal(await response.text(), 'gamma');

  response = await request('/api/modify', { method: 'PATCH', body: JSON.stringify({ path: file, match: 'beta', replacement: 'BETA' }) });
  assert.equal(response.status, 200);

  response = await request(`/api/grep?path=http&pattern=BETA`);
  assert.equal((await response.json())[0].line, 2);

  response = await request(`/api/glob?path=http&pattern=*.txt`);
  assert.deepEqual(await response.json(), ['http/sample.txt']);

  response = await request('/api/list?path=http');
  assert.equal((await response.json())[0].name, 'sample.txt');

  response = await request(`/api/delete?path=${encodeURIComponent(file)}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
});

test('rejects traversal outside the configured root', async () => {
  const response = await request('/api/read?path=../../etc/passwd');
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, 'request_error');
  assert.match(body.message, /outside the root/);
  const write = await request('/api/write', { method: 'PUT', body: JSON.stringify({ path: '../escape.txt', content: 'nope' }) });
  assert.equal(write.status, 403);
});

test('returns JSON errors for missing files and routes', async () => {
  let response = await request('/api/read?path=missing.txt');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'request_error');
  response = await request('/missing-route');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
});

test('FSK_ROOT wins over FILESYSTEM_ROOT, which platforms may hijack', async () => {
  const previousFsk = process.env.FSK_ROOT;
  const previousLegacy = process.env.FILESYSTEM_ROOT;
  const sandbox = path.join(process.cwd(), 'root-precedence');
  process.env.FSK_ROOT = sandbox;
  process.env.FILESYSTEM_ROOT = '/a/path/the/platform-made-up';

  try {
    const { createServer: createIsolated } = await import('../src/server.js?root-precedence');
    const isolated = createIsolated().listen(0, '127.0.0.1');
    await new Promise((resolve) => isolated.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${isolated.address().port}/health`);
    assert.equal((await response.json()).root, sandbox);
    await new Promise((resolve) => isolated.close(resolve));
  } finally {
    if (previousFsk === undefined) delete process.env.FSK_ROOT; else process.env.FSK_ROOT = previousFsk;
    if (previousLegacy === undefined) delete process.env.FILESYSTEM_ROOT; else process.env.FILESYSTEM_ROOT = previousLegacy;
    await rm(sandbox, { recursive: true, force: true });
  }
});
