import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read, write, modify, remove, list, glob, grep } from './index.js';

const app = express();
const root = path.resolve(process.env.FILESYSTEM_ROOT || process.cwd());
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '10mb' }));

function safePath(value, fallback = '.') {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('path must be a non-empty string');
  const resolved = path.resolve(root, value || fallback);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    const error = new Error('path must stay inside FILESYSTEM_ROOT');
    error.status = 403;
    throw error;
  }
  return resolved;
}

function rangeFrom(query) {
  if (query.start == null && query.end == null) return undefined;
  return { start: query.start == null ? undefined : Number(query.start), end: query.end == null ? undefined : Number(query.end) };
}

function bool(value) {
  return value === true || value === 'true' || value === '1';
}

function publicPath(filePath) {
  return path.relative(root, filePath) || '.';
}

function publicResult(result) {
  if (Array.isArray(result)) return result.map((item) => item.path ? { ...item, path: publicPath(item.path) } : item);
  return result && result.path ? { ...result, path: publicPath(result.path) } : result;
}

app.get('/health', (_request, response) => response.json({ status: 'ok', root: process.env.FILESYSTEM_ROOT || root, service: 'filesystem-kit' }));

app.get('/api/read', async (request, response, next) => {
  try {
    const filePath = safePath(request.query.path);
    const content = await read(filePath, { head: request.query.head == null ? undefined : Number(request.query.head), tail: request.query.tail == null ? undefined : Number(request.query.tail), range: rangeFrom(request.query) });
    response.type('text/plain').send(content);
  } catch (error) { next(error); }
});

app.put('/api/write', async (request, response, next) => {
  try {
    const body = request.body || {};
    const result = await write(safePath(body.path), body.content ?? '', { append: bool(body.append), range: body.range, createDirs: body.createDirs !== false });
    response.status(201).json(publicResult(result));
  } catch (error) { next(error); }
});

app.patch('/api/modify', async (request, response, next) => {
  try {
    const body = request.body || {};
    const result = await modify(safePath(body.path), { match: body.match, replacement: body.replacement, occurrence: body.occurrence, rewrite: body.rewrite, range: body.range });
    response.json(publicResult(result));
  } catch (error) { next(error); }
});

app.delete('/api/delete', async (request, response, next) => {
  try {
    const result = await remove(safePath(request.query.path), { recursive: bool(request.query.recursive), force: bool(request.query.force) });
    response.json(publicResult(result));
  } catch (error) { next(error); }
});

app.get('/api/list', async (request, response, next) => {
  try {
    const result = await list(safePath(request.query.path || '.'), { all: bool(request.query.all) });
    response.json(publicResult(result));
  } catch (error) { next(error); }
});

app.get('/api/glob', async (request, response, next) => {
  try {
    const cwd = safePath(request.query.cwd || '.');
    const result = await glob(String(request.query.pattern || ''), { cwd, all: bool(request.query.all) });
    response.json(result.map(publicPath));
  } catch (error) { next(error); }
});

app.get('/api/grep', async (request, response, next) => {
  try {
    const searchPath = safePath(request.query.path || '.');
    const result = await grep(String(request.query.pattern || ''), { path: searchPath, ignoreCase: bool(request.query.ignoreCase), all: bool(request.query.all) });
    response.json(publicResult(result));
  } catch (error) { next(error); }
});

app.use((_request, response) => response.status(404).json({ error: 'not_found', message: 'route not found' }));
app.use((error, _request, response, _next) => {
  const status = error.status || (error.code === 'ENOENT' ? 404 : error.code === 'EEXIST' ? 409 : error instanceof TypeError || error instanceof RangeError ? 400 : 500);
  response.status(status).json({ error: status >= 500 ? 'internal_error' : 'request_error', message: error.message });
});

export { app, root };

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  app.listen(port, '0.0.0.0', () => console.log(`FileSystem Kit listening on port ${port}; root=${root}`));
}
