import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { OutsideRootError } from './errors.js';

const SHELL = '/bin/bash';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;

/**
 * The only environment the shell is given.
 *
 * PATH is inherited, because the binaries on a machine live wherever that
 * machine's PATH says and hardcoding one would break the tools that do exist.
 * Nothing else is. A shell that can read `env` would otherwise hand out the
 * server's own FSK_TOKEN -- the very secret guarding the API -- to whoever
 * asked it to run a command, so the environment is built from scratch rather
 * than copied and pruned.
 */
function shellEnv(overrides = {}) {
  const base = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    TMPDIR: process.env.TMPDIR || '/tmp',
    LANG: 'C.UTF-8',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) base[key] = String(value);
  }
  return base;
}

/**
 * Collects stream chunks up to a byte ceiling, then stops keeping them but keeps
 * listening. A command that prints forever must not be able to exhaust the
 * server's memory just because nobody is reading the response yet; the cap
 * makes the worst case a bounded number of bytes per stream.
 */
function collector(maxBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length))));
        return;
      }
      chunks.push(chunk);
    },
    get truncated() { return truncated; },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

/**
 * Runs a shell command and reports what it did.
 *
 * The shell starts inside the root, so relative paths mean what they mean
 * everywhere else in this package and a command that writes a file writes it to
 * the persisted volume. Unlike the file operations, a command is not confined by
 * path checking: it is a real shell and can reach the rest of the machine. That
 * is the difference between reading a file and running a program, and callers
 * who need the guarantee should use the file API.
 *
 * stdin is closed immediately, so this is command execution and not an
 * interactive session: there is nothing to type at and no way to wait on one.
 */
function exec(command, options = {}) {
  return new Promise((resolve, reject) => {
    if (typeof command !== 'string' || command.trim() === '') {
      reject(new TypeError('command must be a non-empty string'));
      return;
    }

    const root = options.cwd;
    if (!root) {
      reject(new Error('exec needs a root: pass cwd when calling it directly'));
      return;
    }

    let workingDirectory = root;
    if (options.directory) {
      const requested = path.resolve(root, options.directory);
      if (requested !== root && !requested.startsWith(root + path.sep)) {
        reject(new OutsideRootError(options.directory, root));
        return;
      }
      workingDirectory = requested;
    }

    // Settled before spawning. Without this, a directory that does not exist
    // surfaces as `spawn /bin/bash ENOENT`, which reads as though bash is
    // missing and sends you looking in the wrong place.
    prepare().then(start, reject);

    /**
     * Makes sure there is somewhere to stand before running anything.
     *
     * A command cannot start in a folder that is not there, and `mkdir` is not
     * available to create one from inside the command that would need it. Since
     * `write` already creates the folders a path requires, exec does the same
     * here: naming a folder that does not exist yet creates it. Pass
     * `createDir: false` for the stricter reading, where a missing folder is an
     * error rather than an instruction.
     */
    async function prepare() {
      try {
        const info = await stat(workingDirectory);
        if (!info.isDirectory()) throw Object.assign(new Error(`not a directory: ${workingDirectory}`), { code: 'ENOTDIR' });
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (options.createDir === false) throw Object.assign(new Error(`no such directory: ${workingDirectory}`), { code: 'ENOENT' });
      await mkdir(workingDirectory, { recursive: true });
    }

    function start() {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const startedAt = Date.now();

    let child;
    try {
      child = spawn(SHELL, ['-c', command], {
        cwd: workingDirectory,
        env: shellEnv(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = collector(maxOutput);
    const stderr = collector(maxOutput);
    child.stdout.on('data', stdout.push);
    child.stderr.on('data', stderr.push);
    // Nothing is written to stdin, and ending it stops a command that reads it
    // from hanging until the timeout.
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd: workingDirectory,
        code: timedOut ? null : code,
        signal: signal ?? null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt,
      });
    });
    }
  });
}

export { exec, SHELL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT };
export default exec;
