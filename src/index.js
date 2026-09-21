import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_ENCODING = 'utf8';

function normalizePath(filePath, cwd = process.cwd()) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('path must be a non-empty string');
  return path.resolve(cwd, filePath);
}

function linesOf(content) {
  return content.split('\n');
}

function applyLineRange(content, range) {
  if (!range) return content;
  const lines = linesOf(content);
  const start = Math.max(1, Number(range.start ?? 1));
  const end = Math.min(lines.length, Number(range.end ?? lines.length));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw new RangeError('range must contain valid 1-based start/end lines');
  return lines.slice(start - 1, end).join('\n');
}

async function read(filePath, options = {}) {
  const fullPath = normalizePath(filePath, options.cwd);
  const content = await fs.readFile(fullPath, { encoding: options.encoding ?? DEFAULT_ENCODING });
  if (options.head != null && options.tail != null) throw new Error('head and tail cannot be used together');
  if (options.head != null || options.tail != null) {
    const lines = linesOf(content);
    const count = Number(options.head ?? options.tail);
    if (!Number.isInteger(count) || count < 0) throw new RangeError('head/tail must be a non-negative integer');
    return (options.head != null ? lines.slice(0, count) : count === 0 ? [] : lines.slice(-count)).join('\n');
  }
  return applyLineRange(content, options.range);
}

async function write(filePath, content, options = {}) {
  const fullPath = normalizePath(filePath, options.cwd);
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new TypeError('content must be a string or Buffer');
  if (options.range) {
    let existing = await fs.readFile(fullPath, { encoding: options.encoding ?? DEFAULT_ENCODING });
    const lines = linesOf(existing);
    const start = Number(options.range.start ?? 1);
    const end = Number(options.range.end ?? start);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) throw new RangeError('write range must be within the existing file');
    const replacement = String(content).split('\n');
    existing = [...lines.slice(0, start - 1), ...replacement, ...lines.slice(end)].join('\n');
    content = existing;
  }
  if (options.createDirs !== false) await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, { encoding: options.encoding ?? DEFAULT_ENCODING, flag: options.append ? 'a' : 'w' });
  return { path: fullPath, bytes: Buffer.byteLength(content) };
}

async function modify(filePath, options = {}) {
  const fullPath = normalizePath(filePath, options.cwd);
  if (options.rewrite !== undefined && options.match !== undefined) throw new Error('use either rewrite or match/replacement');
  if (options.rewrite !== undefined) return write(fullPath, options.rewrite, { ...options, range: options.range });
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
  const fullPath = normalizePath(filePath, options.cwd);
  const stat = await fs.lstat(fullPath);
  if (stat.isDirectory()) await fs.rm(fullPath, { recursive: options.recursive ?? false, force: options.force ?? false });
  else await fs.unlink(fullPath);
  return { path: fullPath, removed: true };
}

async function list(directory = '.', options = {}) {
  const root = normalizePath(directory, options.cwd);
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

function globToRegExp(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') { if (pattern[i + 1] === '*') { source += '.*'; i += 1; } else source += '[^/]*'; }
    else if (c === '?') source += '[^/]';
    else source += /[\\^$+.()|{}[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`${source}$`);
}

async function glob(pattern, options = {}) {
  const root = normalizePath(options.cwd ?? '.', options.cwd);
  const files = await walk(root, options.all);
  const relativePattern = pattern.replaceAll(path.sep, '/').replace(/^\.\//, '');
  const matcher = globToRegExp(relativePattern);
  return files.filter((entry) => matcher.test(path.relative(root, entry).replaceAll(path.sep, '/'))).sort();
}

async function grep(pattern, options = {}) {
  const root = normalizePath(options.path ?? '.', options.cwd);
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

export { read, write, modify, remove, list, glob, grep };
export default { read, write, modify, remove, list, glob, grep };
