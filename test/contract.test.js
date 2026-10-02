import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFilesystem } from '../src/index.js';

/**
 * One suite, run against every backend.
 *
 * The remote backend is pointed at a real server running in this process, so
 * these are genuine HTTP round trips rather than a mocked transport. If the two
 * machines ever disagree about a result, a line number, or an error code, this
 * is what notices.
 */
const root = await mkdtemp(path.join(os.tmpdir(), 'fsk-contract-'));
process.env.FSK_ROOT = root;
const { createServer } = await import('../src/server.js');
const server = createServer().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

const backends = [
  { label: 'local', prefix: () => '', make: (name) => createFilesystem({ cwd: path.join(root, name) }) },
  { label: 'remote', prefix: (name) => `${name}/`, make: () => createFilesystem({ baseUrl: origin }) },
];

for (const backend of backends) {
  const { label, prefix, make } = backend;

  async function setup(t) {
    const name = `case-${Math.random().toString(36).slice(2)}`;
    const fsx = make(name);
    // The local backend is already rooted in the case folder, while the remote
    // one shares the server's root with every other case and has to be told
    // where to stand. Both therefore end up in the same directory on disk.
    return {
      fsx,
      at: (file = '') => `${prefix(name)}${file}`,
      execOptions: { directory: label === 'local' ? undefined : name },
    };
  }

  test(`${label}: writes and reads back the same bytes`, async (t) => {
    const { fsx, at } = await setup(t);
    const written = await fsx.write(at('note.txt'), 'alpha\nbeta');
    assert.equal(written.bytes, 10);
    assert.ok(written.path.endsWith('note.txt'), `path should end in the file name, got ${written.path}`);
    assert.equal(await fsx.read(at('note.txt')), 'alpha\nbeta');
  });

  test(`${label}: head, tail and range select lines`, async (t) => {
    const { fsx, at } = await setup(t);
    await fsx.write(at('lines.txt'), 'one\ntwo\nthree\nfour');
    assert.equal(await fsx.read(at('lines.txt'), { head: 2 }), 'one\ntwo');
    assert.equal(await fsx.read(at('lines.txt'), { tail: 2 }), 'three\nfour');
    assert.equal(await fsx.read(at('lines.txt'), { range: { start: 2, end: 3 } }), 'two\nthree');
    await assert.rejects(() => fsx.read(at('lines.txt'), { head: 1, tail: 1 }), /only one of head, tail or range/);
  });

  test(`${label}: a tail keeps multi-byte characters intact`, async (t) => {
    const { fsx, at } = await setup(t);
    await fsx.write(at('utf8.txt'), 'héllo wörld ünïcode');
    assert.equal(await fsx.read(at('utf8.txt'), { tail: 1 }), 'héllo wörld ünïcode');
  });

  test(`${label}: modify replaces one occurrence and counts it`, async (t) => {
    const { fsx, at } = await setup(t);
    await fsx.write(at('code.txt'), 'x = 1\ny = 1');
    const result = await fsx.modify(at('code.txt'), { match: 'y = 1', replacement: 'y = 2' });
    assert.equal(result.replacements, 1);
    assert.equal(await fsx.read(at('code.txt')), 'x = 1\ny = 2');
    await assert.rejects(() => fsx.modify(at('code.txt'), { rewrite: 'a', match: 'b', replacement: 'c' }), /either rewrite or match/);
  });

  test(`${label}: list sorts entries and hides dotfiles unless asked`, async (t) => {
    const { fsx, at } = await setup(t);
    await fsx.write(at('.hidden'), 'secret');
    await fsx.write(at('b.txt'), 'b');
    await fsx.write(at('a.txt'), 'a');
    await fsx.write(at('dir/inner.txt'), 'inner');

    const visible = await fsx.list(at('.'));
    assert.deepEqual(visible.map((entry) => entry.name), ['a.txt', 'b.txt', 'dir']);
    assert.equal(visible.find((entry) => entry.name === 'dir').type, 'directory');
    assert.ok(visible.every((entry) => entry.path.endsWith(entry.name)));

    const all = await fsx.list(at('.'), { all: true });
    assert.ok(all.some((entry) => entry.name === '.hidden'));
  });

  test(`${label}: glob spans zero or more folders`, async (t) => {
    const { fsx, at } = await setup(t);
    await fsx.write(at('top.js'), '');
    await fsx.write(at('deep/inner.js'), '');
    await fsx.write(at('deep/deeper/leaf.js'), '');
    await fsx.write(at('deep/inner.md'), '');

    const found = await fsx.glob(at('**/*.js'));
    assert.deepEqual(found.map((entry) => entry.split('/').pop()).sort(), ['inner.js', 'leaf.js', 'top.js']);
  });

  test(`${label}: grep reports the line number and text`, async (t) => {
    const { fsx, at } = await setup(t);
    await fsx.write(at('log.txt'), 'first\nsecond hit\nthird');
    const matches = await fsx.grep('hit', { path: at('.') });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].line, 2);
    assert.equal(matches[0].text, 'second hit');
  });

  test(`${label}: remove deletes a file and a tree`, async (t) => {
    const { fsx, at } = await setup(t);
    await fsx.write(at('gone.txt'), 'bye');
    const removed = await fsx.remove(at('gone.txt'));
    assert.equal(removed.removed, true);
    await assert.rejects(() => fsx.read(at('gone.txt')), (error) => error.code === 'ENOENT');

    await fsx.write(at('tree/leaf.txt'), 'leaf');
    await fsx.remove(at('tree'), { recursive: true });
    await assert.rejects(() => fsx.read(at('tree/leaf.txt')), (error) => error.code === 'ENOENT');
  });

  test(`${label}: a missing file reports ENOENT, not a message`, async (t) => {
    const { fsx, at } = await setup(t);
    await assert.rejects(() => fsx.read(at('absent.txt')), (error) => {
      assert.equal(error.code, 'ENOENT');
      return true;
    });
  });

  test(`${label}: append grows a file and refuses to combine with a range`, async (t) => {
    const { fsx, at } = await setup(t);
    await fsx.write(at('log.txt'), 'one\n');
    await fsx.write(at('log.txt'), 'two\n', { append: true });
    assert.equal(await fsx.read(at('log.txt')), 'one\ntwo\n');
    await assert.rejects(
      () => fsx.write(at('log.txt'), 'three', { append: true, range: { start: 1, end: 1 } }),
      /append and range cannot be used together/,
    );
  });

  test(`${label}: a path outside the root is refused as EOUTSIDE`, async (t) => {
    const { fsx } = await setup(t);
    await assert.rejects(() => fsx.read('../escape.txt'), (error) => {
      assert.equal(error.code, 'EOUTSIDE');
      assert.equal(error.name, 'OutsideRootError');
      return true;
    });
  });

  test(`${label}: a reported path can be handed straight back`, async (t) => {
    const { fsx, at } = await setup(t);
    await fsx.write(at('round/trip.txt'), 'value');
    const [entry] = await fsx.list(at('round'));
    assert.equal(entry.path, `/${at('round')}/trip.txt`);
    assert.equal(await fsx.read(entry.path), 'value');
    await fsx.remove(entry.path);
    await assert.rejects(() => fsx.read(entry.path), (error) => error.code === 'ENOENT');
  });

  test(`${label}: describe reports which machine is in use`, async (t) => {
    const { fsx } = await setup(t);
    const described = await fsx.describe();
    assert.equal(described.status, 'ok');
    assert.equal(typeof described.root, 'string');
    assert.ok(described.root.length > 0);
  });
}

for (const backend of backends) {
  const { label, make } = backend;

  test(`${label}: runs a command and reports its output, streams and exit code`, async (t) => {
    const name = `case-${Math.random().toString(36).slice(2)}`;
    const fsx = make(name);
    const execOptions = { directory: label === 'local' ? undefined : name };
    const result = await fsx.exec('echo one | tr a-z A-Z && echo $(echo nested); exit 2', execOptions);
    assert.equal(result.stdout, 'ONE\nnested\n');
    assert.equal(result.stderr, '');
    assert.equal(result.code, 2);
    assert.equal(result.timedOut, false);
  });

  test(`${label}: a command writes into the same place the file tools read`, async (t) => {
    const name = `case-${Math.random().toString(36).slice(2)}`;
    const fsx = make(name);
    const at = (file) => `${backend.prefix(name)}${file}`;
    const execOptions = { directory: label === 'local' ? undefined : name };
    await fsx.exec('echo from-the-shell > shell.txt', execOptions);
    assert.equal(await fsx.read(at('shell.txt')), 'from-the-shell\n');
    await fsx.exec('printf "appended\n" >> shell.txt', execOptions);
    assert.equal(await fsx.read(at('shell.txt')), 'from-the-shell\nappended\n');
  });

  test(`${label}: a command is bound by the same timeout and output cap`, async (t) => {
    const name = `case-${Math.random().toString(36).slice(2)}`;
    const fsx = make(name);
    const execOptions = { directory: label === 'local' ? undefined : name };
    const slow = await fsx.exec('while true; do echo noise; done', { ...execOptions, timeoutMs: 500 });
    assert.equal(slow.timedOut, true);
    const loud = await fsx.exec('for i in $(seq 1 400); do echo 0123456789; done', { ...execOptions, maxOutputBytes: 128 });
    assert.equal(loud.truncated, true);
    assert.ok(loud.stdout.length <= 128, `expected at most 128 bytes, got ${loud.stdout.length}`);
  });

  test(`${label}: a command cannot stand outside the root`, async (t) => {
    const name = `case-${Math.random().toString(36).slice(2)}`;
    const fsx = make(name);
    await assert.rejects(() => fsx.exec('pwd', { directory: '../..' }), (error) => {
      assert.equal(error.code, 'EOUTSIDE');
      return true;
    });
  });
}

test('a command produces the same result on either machine', async () => {
  await mkdir(path.join(root, 'same'), { recursive: true });
  const local = createFilesystem({ cwd: path.join(root, 'same') });
  const remote = createFilesystem({ baseUrl: origin });
  const command = 'echo machine | tr a-z A-Z && node -e "console.log(6*7)"';
  const here = await local.exec(command);
  const there = await remote.exec(command, { directory: 'same' });
  assert.equal(here.stdout, there.stdout);
  assert.equal(here.code, there.code);
});

test('a RegExp cannot be sent to a remote machine, and says so', async () => {
  const remote = createFilesystem({ baseUrl: origin });
  await assert.rejects(() => remote.grep(/hit/, {}), /RegExp cannot be sent/);
});

test('an unreachable machine fails with E_UNREACHABLE rather than hanging', async () => {
  const offline = createFilesystem({ baseUrl: 'http://127.0.0.1:1', retries: 0 });
  await assert.rejects(() => offline.list('.'), (error) => {
    assert.equal(error.code, 'E_UNREACHABLE');
    return true;
  });
});

const liveUrl = process.env.FSK_LIVE_URL;
test('the live cloud instance behaves like a local machine', { skip: liveUrl ? false : 'set FSK_LIVE_URL to run' }, async (t) => {
  const cloud = createFilesystem({ baseUrl: liveUrl, token: process.env.FSK_TOKEN });
  const name = `contract-${Date.now()}.txt`;
  const content = 'over the wire';
  const written = await cloud.write(name, content);
  assert.equal(written.bytes, Buffer.byteLength(content));
  assert.equal(await cloud.read(name), content);
  assert.equal((await cloud.grep('wire', { path: name }))[0].line, 1);
  await cloud.remove(name);
  await assert.rejects(() => cloud.read(name), (error) => error.code === 'ENOENT');
  const described = await cloud.describe();
  assert.ok(described.root.length > 0);
  await t.diagnostic(`cloud root: ${described.root}`);
});
