import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { read, write, modify, remove, list, glob, grep } from '../src/index.js';

let root;
test.beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'filesystem-kit-')); });
test.afterEach(async () => { await rm(root, { recursive: true, force: true }); });

 test('writes, reads, and creates parent directories', async () => {
  const file = path.join(root, 'nested', 'file.txt');
  await write(file, 'one\ntwo\nthree');
  assert.equal(await read(file), 'one\ntwo\nthree');
  assert.equal(await read(file, { range: { start: 2, end: 3 } }), 'two\nthree');
  assert.equal(await read(file, { head: 1 }), 'one');
  assert.equal(await read(file, { tail: 1 }), 'three');
  assert.equal(await read(file, { tail: 0 }), '');
 });

test('writes only a selected line range', async () => {
  const file = path.join(root, 'file.txt');
  await write(file, 'one\ntwo\nthree');
  await write(file, 'TWO\nTHREE', { range: { start: 2, end: 3 } });
  assert.equal(await read(file), 'one\nTWO\nTHREE');
});

test('modifies one exact occurrence or rewrites a range', async () => {
  const file = path.join(root, 'file.txt');
  await write(file, 'a\nneedle\nneedle');
  await modify(file, { match: 'needle', replacement: 'found', occurrence: 2 });
  assert.equal(await read(file), 'a\nneedle\nfound');
  await modify(file, { rewrite: 'replacement', range: { start: 2, end: 2 } });
  assert.equal(await read(file), 'a\nreplacement\nfound');
  await assert.rejects(() => modify(file, { match: 'missing', replacement: 'x' }), /match not found/);
});

test('lists, globs, greps, and deletes', async () => {
  await write(path.join(root, 'src', 'a.js'), 'const apple = 1;');
  await write(path.join(root, 'src', 'b.txt'), 'banana');
  assert.deepEqual((await list(path.join(root, 'src'))).map((entry) => entry.name), ['a.js', 'b.txt']);
  assert.deepEqual((await glob('src/*.js', { cwd: root })).map((p) => path.relative(root, p)), ['src/a.js']);
  assert.equal((await grep(/apple/g, { path: root }))[0].line, 1);
  await remove(path.join(root, 'src'), { recursive: true });
  await assert.rejects(() => list(path.join(root, 'src')));
});

test('rejects ambiguous or invalid read options', async () => {
  const file = path.join(root, 'file.txt');
  await write(file, 'content');
  await assert.rejects(() => read(file, { head: 1, tail: 1 }), /cannot be used together/);
  await assert.rejects(() => read(file, { range: { start: 3, end: 1 } }), /valid/);
});
