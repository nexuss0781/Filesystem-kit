import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { read, write, modify, remove, list, glob, grep, exec } from '../src/index.js';

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

test('every source file is published, so a deploy cannot be missing one', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const sources = (await readdir(new URL('../src', import.meta.url))).filter((name) => name.endsWith('.js'));
  const published = pkg.files.filter((entry) => entry.startsWith('src/'));
  const missing = sources.filter((name) => !published.includes(`src/${name}`));
  assert.deepEqual(missing, [], `not listed in package.json files: ${missing.join(', ')}`);
});

test('runs a command with pipes, chains and substitution, and reports the exit code', async () => {
  const result = await exec('echo one | tr a-z A-Z && echo "code=$?" && echo $(echo nested)', { cwd: root });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'ONE\ncode=0\nnested\n');
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, false);
});

test('reports a failing command without throwing', async () => {
  const result = await exec('echo before; exit 3', { cwd: root });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'before\n');
});

test('captures stderr separately from stdout', async () => {
  const result = await exec('echo out; echo err 1>&2', { cwd: root });
  assert.equal(result.stdout, 'out\n');
  assert.equal(result.stderr, 'err\n');
});

test('starts in the root, so a relative write lands on the machine', async () => {
  const result = await exec('echo persisted > written.txt', { cwd: root });
  assert.equal(result.code, 0);
  assert.equal(await readFile(path.join(root, 'written.txt'), 'utf8'), 'persisted\n');
});

test('can run in a directory inside the root', async () => {
  await mkdir(path.join(root, 'inner'), { recursive: true });
  const result = await exec('pwd', { cwd: root, directory: 'inner' });
  assert.equal(result.cwd, path.join(root, 'inner'));
  assert.ok(result.stdout.includes('inner'));
});

test('refuses a directory outside the root', async () => {
  await assert.rejects(() => exec('pwd', { cwd: root, directory: '../elsewhere' }), (error) => {
    assert.equal(error.name, 'OutsideRootError');
    assert.equal(error.code, 'EOUTSIDE');
    return true;
  });
});

test('kills a command that runs past its timeout instead of waiting forever', async () => {
  const result = await exec('while true; do echo noise; done', { cwd: root, timeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
});

test('stops keeping output past the cap but still reports the command finished', async () => {
  const result = await exec('for i in $(seq 1 500); do echo 0123456789; done', { cwd: root, maxOutputBytes: 256 });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 256, `expected at most 256 bytes, got ${result.stdout.length}`);
  assert.equal(result.code, 0);
});

test('never hands the shell the environment of the process running it', async () => {
  process.env.FSK_TOKEN_TEST_SECRET = 'do-not-leak';
  try {
    const result = await exec('echo "[$FSK_TOKEN_TEST_SECRET][$FSK_TOKEN]"', { cwd: root });
    assert.equal(result.stdout, '[][]\n');
  } finally {
    delete process.env.FSK_TOKEN_TEST_SECRET;
  }
});

test('passes through only the environment the caller asked for', async () => {
  const result = await exec('echo "[$GREETING]"', { cwd: root, env: { GREETING: 'hello' } });
  assert.equal(result.stdout, '[hello]\n');
});

test('creates the working directory when it is missing, and can be told not to', async () => {
  const result = await exec('echo made-in-a-new-folder > f.txt && ls', { cwd: root, directory: 'fresh' });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), 'f.txt');
  assert.equal(await readFile(path.join(root, 'fresh', 'f.txt'), 'utf8'), 'made-in-a-new-folder\n');
  await assert.rejects(() => exec('pwd', { cwd: root, directory: 'never-made', createDir: false }), (error) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});

test('says plainly when the directory does not exist, instead of blaming bash', async () => {
  await assert.rejects(() => exec('pwd', { cwd: root, directory: 'not-here', createDir: false }), (error) => {
    assert.equal(error.code, 'ENOENT');
    assert.match(error.message, /no such directory/);
    assert.doesNotMatch(error.message, /bash/);
    return true;
  });
  await write('a-file.txt', 'x', { cwd: root });
  await assert.rejects(() => exec('pwd', { cwd: root, directory: 'a-file.txt' }), (error) => {
    assert.equal(error.code, 'ENOTDIR');
    return true;
  });
});

test('rejects an empty command and a missing root', async () => {
  await assert.rejects(() => exec('   ', { cwd: root }), TypeError);
  await assert.rejects(() => exec('pwd', {}), /needs a root/);
});
