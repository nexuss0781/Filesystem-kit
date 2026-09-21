import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { app } from '../src/server.js';

let server;
let base;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
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

  response = await request(`/api/glob?cwd=http&pattern=*.txt`);
  assert.deepEqual(await response.json(), ['http/sample.txt']);

  response = await request('/api/list?path=http');
  assert.equal((await response.json())[0].name, 'sample.txt');

  response = await request(`/api/delete?path=${encodeURIComponent(file)}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
});

test('rejects traversal outside the configured root', async () => {
  const response = await request('/api/read?path=../../etc/passwd');
  assert.equal(response.status, 403);
  assert.equal((await response.json()).message, 'path must stay inside FILESYSTEM_ROOT');
});

test('returns JSON errors for missing files and routes', async () => {
  let response = await request('/api/read?path=missing.txt');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'request_error');
  response = await request('/missing-route');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
});
