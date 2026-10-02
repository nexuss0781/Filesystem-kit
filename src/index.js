import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_ENCODING = 'utf8';
const TAIL_CHUNK = 64 * 1024;

/** Thrown when a path resolves outside the root. Carries a 403 status for the HTTP layer. */
class OutsideRootError extends Error {
  constructor(requested, root) {
    super(`path is outside the root: ${requested} (root: ${root})`);
    this.name = 'OutsideRootError';
    this.code = 'EOUTSIDE';
    this.status = 403;
    this.requested = requested;
    this.root = root;
  }
}

function rootOf(options = {}) {
  return path.resolve(options.cwd ?? process.cwd());
}

/**
 * The root is the machine.
 *
 * Paths are read as paths *on this machine*, so a leading slash names the root
 * of the machine rather than the host filesystem: `/src/app.js` is
 * `<root>/src/app.js`. `..` still resolves normally and the result must land
 * inside the root, so there is no traversal out and no absolute host path to
 * reach for. Every path is settled before any disk access happens.
 */
function resolveInRoot(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('path must be a non-empty string');
  const root = rootOf(options);
  const onThisMachine = filePath.replace(/^\/+/, '');
  const resolved = path.resolve(root, onThisMachine);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new OutsideRootError(filePath, root);
  return resolved;
}

function linesOf(content) {
  return content.split('\n');
}

function parseRange(range) {
  const start = Math.max(1, Number(range.start ?? 1));
  const end = range.end == null ? Infinity : Number(range.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw new RangeError('range must contain valid 1-based start/end lines');
  return { start, end };
}

function parseCount(value, label) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`${label} must be a non-negative integer`);
  return count;
}

/**
 * Splits into lines and drops the empty final element produced by a trailing
 * newline, so 'alpha\nbeta\n' is two lines, not three. Every line-oriented read
 * agrees on this, which is what makes line numbers mean the same thing in
 * `read`, in `write` ranges, and in a report that cites line 12.
 */
function contentLines(content) {
  const lines = linesOf(content);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

async function readHead(content, count) {
  return contentLines(content).slice(0, count).join('\n');
}

async function readRange(content, range) {
  const { start, end } = parseRange(range);
  const lines = contentLines(content);
  const last = Math.min(lines.length, end);
  if (start > last) return '';
  return lines.slice(start - 1, last).join('\n');
}

/**
 * Walks backwards in chunks so a tail never loads the whole file.
 *
 * Each chunk is decoded on its own. A chunk that begins mid-character decodes
 * with a replacement character, but it always lands in the first line of the
 * text, and the loop only stops once that line is excluded by the final slice.
 * If the whole file was needed, position reached 0 and nothing was cut.
 */
async function readTail(filePath, count, encoding) {
  if (count === 0) return '';
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    let position = size;
    let text = '';
    while (position > 0) {
      const length = Math.min(TAIL_CHUNK, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      text = buffer.toString(encoding) + text;
      if (text.split('\n').length > count) break;
    }
    return contentLines(text).slice(-count).join('\n');
  } finally {
    await handle.close();
  }
}

async function read(filePath, options = {}) {
  const selectors = ['head', 'tail', 'range'].filter((key) => options[key] != null);
  if (selectors.length > 1) throw new Error(`use only one of head, tail or range (received ${selectors.join(', ')})`);
  const fullPath = resolveInRoot(filePath, options);
  const encoding = options.encoding ?? DEFAULT_ENCODING;
  if (options.tail != null) return readTail(fullPath, parseCount(options.tail, 'tail'), encoding);
  if (options.head == null && options.range == null) return fs.readFile(fullPath, { encoding });
  const content = await fs.readFile(fullPath, { encoding });
  if (options.head != null) return readHead(content, parseCount(options.head, 'head'));
  return readRange(content, options.range);
}

async function writeResolved(fullPath, content, options = {}) {
  if (options.range) {
    const encoding = options.encoding ?? DEFAULT_ENCODING;
    const existing = await fs.readFile(fullPath, { encoding });
    const lines = contentLines(existing);
    const start = Number(options.range.start ?? 1);
    const end = Number(options.range.end ?? start);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) throw new RangeError('write range must be within the existing file');
    const replacement = String(content).split('\n');
    content = [...lines.slice(0, start - 1), ...replacement, ...lines.slice(end)].join('\n');
  }
  if (options.createDirs !== false) await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, { encoding: options.encoding ?? DEFAULT_ENCODING, flag: options.append ? 'a' : 'w' });
  return { path: fullPath, bytes: Buffer.byteLength(content) };
}

async function write(filePath, content, options = {}) {
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new TypeError('content must be a string or Buffer');
  if (options.append && options.range) throw new Error('append and range cannot be used together');
  return writeResolved(resolveInRoot(filePath, options), content, options);
}

async function modify(filePath, options = {}) {
  if (options.rewrite !== undefined && options.match !== undefined) throw new Error('use either rewrite or match/replacement');
  const fullPath = resolveInRoot(filePath, options);
  if (options.rewrite !== undefined) return writeResolved(fullPath, options.rewrite, { ...options, append: false });
  if (typeof options.match !== 'string' || typeof options.replacement !== 'string') throw new TypeError('match and replacement must be strings');
  const original = await fs.readFile(fullPath, 'utf8');
  const occurrence = options.occurrence == null ? 1 : Number(options.occurrence);
  if (!Number.isInteger(occurrence) || occurrence < 1) throw new RangeError('occurrence must be a positive integer');
  let seen = 0;
  let found = false;
  const updated = original.replaceAll(options.match, (value) => {
    seen += 1;
    if (seen === occurrence) { found = true; return options.replacement; }
    return value;
  });
  if (!found) throw new Error(`match not found: ${options.match}`);
  await fs.writeFile(fullPath, updated, 'utf8');
  return { path: fullPath, replacements: 1 };
}

async function remove(filePath, options = {}) {
  const fullPath = resolveInRoot(filePath, options);
  const stat = await fs.lstat(fullPath);
  if (stat.isDirectory()) await fs.rm(fullPath, { recursive: options.recursive ?? false, force: options.force ?? false });
  else await fs.unlink(fullPath);
  return { path: fullPath, removed: true };
}

async function list(directory = '.', options = {}) {
  const root = resolveInRoot(directory, options);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!options.all && entry.name.startsWith('.')) continue;
    result.push({ name: entry.name, path: path.join(root, entry.name), type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
  }
  return result;
}

async function walk(root, includeHidden = false) {
  const output = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      output.push(full);
      if (entry.isDirectory()) await visit(full);
    }
  }
  await visit(root);
  return output;
}

/**
 * A double star followed by a slash spans zero or more folders, so the pattern
 * `src` + double star + `.js` finds both `src/a.js` and `src/deep/b.js`. A
 * double star that is not followed by a slash spans everything remaining.
 */
function globToRegExp(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { source += '(?:.*/)?'; i += 2; }
        else { source += '.*'; i += 1; }
      } else source += '[^/]*';
    } else if (c === '?') source += '[^/]';
    else source += /[\\^$+.()|{}[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`${source}$`);
}

/** `path` is the subtree to search. It is resolved inside the root like everything else. */
async function glob(pattern, options = {}) {
  const root = resolveInRoot(options.path ?? '.', options);
  const files = await walk(root, options.all);
  const relativePattern = pattern.replace(/^\/+/, '').replaceAll(path.sep, '/').replace(/^\.\//, '');
  const matcher = globToRegExp(relativePattern);
  return files.filter((entry) => matcher.test(path.relative(root, entry).replaceAll(path.sep, '/'))).sort();
}

/** `path` is the file or subtree to search. It is resolved inside the root like everything else. */
async function grep(pattern, options = {}) {
  const root = resolveInRoot(options.path ?? '.', options);
  const stat = await fs.lstat(root);
  const files = stat.isDirectory() ? await walk(root, options.all) : [root];
  const sourceMatcher = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), options.ignoreCase ? 'i' : '');
  const results = [];
  for (const file of files) {
    const fileStat = await fs.lstat(file);
    if (!fileStat.isFile()) continue;
    const content = await fs.readFile(file, 'utf8').catch(() => null);
    if (content == null || content.includes('\u0000')) continue;
    content.split('\n').forEach((line, index) => {
      sourceMatcher.lastIndex = 0;
      if (sourceMatcher.test(line)) results.push({ path: file, line: index + 1, text: line });
    });
  }
  return results;
}

export { read, write, modify, remove, list, glob, grep, OutsideRootError };
export default { read, write, modify, remove, list, glob, grep };
