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
  await write('nested/deep/file.txt', 'one\ntwo\nthree', { cwd: root });
  assert.equal(await read('nested/deep/file.txt', { cwd: root }), 'one\ntwo\nthree');
  assert.equal(await read('nested/deep/file.txt', { cwd: root, range: { start: 2, end: 3 } }), 'two\nthree');
  assert.equal(await read('nested/deep/file.txt', { cwd: root, head: 1 }), 'one');
  assert.equal(await read('nested/deep/file.txt', { cwd: root, tail: 1 }), 'three');
  assert.equal(await read('nested/deep/file.txt', { cwd: root, tail: 0 }), '');
});

test('appends without rewriting the file', async () => {
  await write('log.txt', 'first\n', { cwd: root });
  await write('log.txt', 'second\n', { cwd: root, append: true });
  assert.equal(await read('log.txt', { cwd: root }), 'first\nsecond\n');
});

test('writes only a selected line range', async () => {
  await write('file.txt', 'one\ntwo\nthree', { cwd: root });
  await write('file.txt', 'TWO\nTHREE', { cwd: root, range: { start: 2, end: 3 } });
  assert.equal(await read('file.txt', { cwd: root }), 'one\nTWO\nTHREE');
});

test('refuses to append and replace a range at once', async () => {
  await write('file.txt', 'one\ntwo', { cwd: root });
  await assert.rejects(() => write('file.txt', 'x', { cwd: root, append: true, range: { start: 1, end: 1 } }), /cannot be used together/);
  assert.equal(await read('file.txt', { cwd: root }), 'one\ntwo');
});

test('modifies one exact occurrence or rewrites a range', async () => {
  await write('file.txt', 'a\nneedle\nneedle', { cwd: root });
  await modify('file.txt', { cwd: root, match: 'needle', replacement: 'found', occurrence: 2 });
  assert.equal(await read('file.txt', { cwd: root }), 'a\nneedle\nfound');
  await modify('file.txt', { cwd: root, rewrite: 'replacement', range: { start: 2, end: 2 } });
  assert.equal(await read('file.txt', { cwd: root }), 'a\nreplacement\nfound');
  await assert.rejects(() => modify('file.txt', { cwd: root, match: 'missing', replacement: 'x' }), /match not found/);
});

test('treats a trailing newline as the end of the last line', async () => {
  await write('log.txt', 'alpha\nbeta\n', { cwd: root });
  assert.equal(await read('log.txt', { cwd: root, head: 5 }), 'alpha\nbeta');
  assert.equal(await read('log.txt', { cwd: root, tail: 1 }), 'beta');
  assert.equal(await read('log.txt', { cwd: root, range: { start: 2, end: 9 } }), 'beta');
});

test('lists, globs, greps, and deletes', async () => {
  await write('src/a.js', 'const apple = 1;', { cwd: root });
  await write('src/b.txt', 'banana', { cwd: root });
  assert.deepEqual((await list('src', { cwd: root })).map((entry) => entry.name), ['a.js', 'b.txt']);
  assert.deepEqual(await glob('src/*.js', { cwd: root }), ['/src/a.js']);
  assert.deepEqual(await glob('*.js', { cwd: root, path: 'src' }), ['/src/a.js']);
  assert.equal((await grep(/apple/g, { cwd: root, path: '.' }))[0].line, 1);
  await remove('src', { cwd: root, recursive: true });
  await assert.rejects(() => list('src', { cwd: root }));
});

test('the root is the machine: nothing resolves outside it', async () => {
  await assert.rejects(() => write('../escaped.txt', 'nope', { cwd: root }), /outside the root/);
  await assert.rejects(() => read('../escaped.txt', { cwd: root }), /outside the root/);
  await assert.rejects(() => read('../escaped.txt', { cwd: root, head: 1 }), /outside the root/);
  await assert.rejects(() => modify('../escaped.txt', { cwd: root, match: 'a', replacement: 'b' }), /outside the root/);
  await assert.rejects(() => remove('../escaped.txt', { cwd: root }), /outside the root/);
  await assert.rejects(() => list('..', { cwd: root }), /outside the root/);
  await assert.rejects(() => glob('*', { cwd: root, path: '..' }), /outside the root/);
  await assert.rejects(() => grep('x', { cwd: root, path: '..' }), /outside the root/);
  await assert.rejects(() => write('src/../../escaped.txt', 'nope', { cwd: root }), /outside the root/);
});

test('an absolute host path is read as a path on this machine', async () => {
  await write('dir/inside.txt', 'kept', { cwd: root });
  await assert.rejects(() => read(path.join(root, 'dir', 'inside.txt'), { cwd: root }), /ENOENT/);
  assert.equal(await read('/dir/inside.txt', { cwd: root }), 'kept');
});

test('a leading slash names the root of the machine', async () => {
  await write('/src/app.js', 'const mode = 1;', { cwd: root });
  assert.equal(await read('/src/app.js', { cwd: root }), 'const mode = 1;');
  assert.equal(await read('src/app.js', { cwd: root }), 'const mode = 1;');
  assert.equal((await list('/', { cwd: root }))[0].name, 'src');
  assert.deepEqual(await glob('/src/*.js', { cwd: root }), ['/src/app.js']);
  await modify('/src/app.js', { cwd: root, match: 'mode', replacement: 'setting' });
  assert.equal(await read('/src/app.js', { cwd: root }), 'const setting = 1;');
  await remove('/src', { cwd: root, recursive: true });
  assert.deepEqual(await list('/', { cwd: root }), []);
});

test('a nested root narrows the machine further', async () => {
  const inner = path.join(root, 'inner');
  await write('file.txt', 'kept', { cwd: inner });
  await assert.rejects(() => read('file.txt', { cwd: root }), /ENOENT/);
  assert.equal(await read('file.txt', { cwd: inner }), 'kept');
  assert.equal(await read('inner/file.txt', { cwd: root }), 'kept');
});

test('reads a slice of a large file', async () => {
  const lines = Array.from({ length: 200000 }, (_, index) => `line ${index + 1}`);
  await write('big.log', `${lines.join('\n')}\n`, { cwd: root });
  assert.equal(await read('big.log', { cwd: root, head: 2 }), 'line 1\nline 2');
  assert.equal(await read('big.log', { cwd: root, tail: 2 }), 'line 199999\nline 200000');
  assert.equal(await read('big.log', { cwd: root, range: { start: 150000, end: 150001 } }), 'line 150000\nline 150001');
  assert.equal(await read('big.log', { cwd: root, range: { start: 199999, end: 200000 } }), 'line 199999\nline 200000');
});

test('tailing a file larger than one chunk keeps multibyte characters intact', async () => {
  const padding = 'x'.repeat(200000);
  await write('wide.log', `${padding}\n€ euro\nlast line\n`, { cwd: root });
  assert.equal(await read('wide.log', { cwd: root, tail: 2 }), '€ euro\nlast line');
  assert.equal(await read('wide.log', { cwd: root, tail: 1 }), 'last line');
});

test('glob spans zero or more folders', async () => {
  await write('src/a.js', 'a', { cwd: root });
  await write('src/deep/b.js', 'b', { cwd: root });
  await write('src/deep/deeper/c.js', 'c', { cwd: root });
  await write('src/notes.md', 'n', { cwd: root });
  const rel = (found) => found.map((p) => p.slice(1));
  assert.deepEqual(rel(await glob('src/*.js', { cwd: root })), ['src/a.js']);
  assert.deepEqual(rel(await glob('src/**/*.js', { cwd: root })), ['src/a.js', 'src/deep/b.js', 'src/deep/deeper/c.js']);
  assert.deepEqual(rel(await glob('**/*.js', { cwd: root })), ['src/a.js', 'src/deep/b.js', 'src/deep/deeper/c.js']);
  assert.deepEqual(rel(await glob('src/**', { cwd: root })), ['src/a.js', 'src/deep', 'src/deep/b.js', 'src/deep/deeper', 'src/deep/deeper/c.js', 'src/notes.md']);
  assert.deepEqual(rel(await glob('src/?.js', { cwd: root })), ['src/a.js']);
});

test('rejects ambiguous or invalid read options', async () => {
  await write('file.txt', 'content', { cwd: root });
  await assert.rejects(() => read('file.txt', { cwd: root, head: 1, tail: 1 }), /only one of head, tail or range/);
  await assert.rejects(() => read('file.txt', { cwd: root, head: 1, range: { start: 1, end: 1 } }), /only one of head, tail or range/);
  await assert.rejects(() => read('file.txt', { cwd: root, tail: 1, range: { start: 1, end: 1 } }), /only one of head, tail or range/);
  await assert.rejects(() => read('file.txt', { cwd: root, range: { start: 3, end: 1 } }), /valid/);
  await assert.rejects(() => read('file.txt', { cwd: root, head: -1 }), /non-negative/);
  await assert.rejects(() => read('', { cwd: root }), /non-empty/);
});
