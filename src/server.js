import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read, write, modify, remove, list, glob, grep } from './index.js';

/**
 * Wasmer Edge injects its own FILESYSTEM_ROOT pointing at a scratch directory
 * that is not the mounted volume, so FILESYSTEM_ROOT cannot be trusted there.
 * FSK_ROOT is authoritative and is never set by the platform.
 */
function resolveRoot() {
  const configured = process.env.FSK_ROOT || process.env.FILESYSTEM_ROOT;
  return configured ? path.resolve(configured) : process.cwd();
}

const root = resolveRoot();
const port = Number(process.env.PORT || 3000);
const bodyLimit = Number(process.env.JSON_BODY_LIMIT || 10 * 1024 * 1024);

/**
 * The HTTP layer is Node's built-in server, so the whole package installs
 * nothing. That matters here: a server with a dependency cannot be deployed
 * from this repository alone, because the build will not install it.
 */

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function sendText(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function requirePath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('path must be a non-empty string');
  return value;
}

function optionalPath(value, fallback = '.') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new TypeError('path must be a string');
  return value;
}

function bool(value) {
  return value === true || value === 'true' || value === '1';
}

function rangeFrom(source) {
  if (source.start == null && source.end == null) return undefined;
  return { start: source.start == null ? undefined : Number(source.start), end: source.end == null ? undefined : Number(source.end) };
}

function publicPath(filePath) {
  return path.relative(root, filePath) || '.';
}

function publicResult(result) {
  if (Array.isArray(result)) return result.map((item) => (item.path ? { ...item, path: publicPath(item.path) } : item));
  return result && result.path ? { ...result, path: publicPath(result.path) } : result;
}

function statusFor(error) {
  if (error.status) return error.status;
  if (error.code === 'ENOENT') return 404;
  if (error.code === 'EEXIST') return 409;
  if (error.code === 'ERR_FS_EISDIR') return 400;
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  return 500;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > bodyLimit) {
        const error = new Error('request body too large');
        error.status = 413;
        request.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('request body must be valid JSON');
        error.status = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

const routes = {
  'GET /health': async () => ({ status: 200, json: { status: 'ok', root, service: 'filesystem-kit' } }),

  'GET /': async () => ({
    status: 200,
    json: { service: 'filesystem-kit', root, routes: ['/health', '/api/read', '/api/write', '/api/modify', '/api/delete', '/api/list', '/api/glob', '/api/grep'] },
  }),

  'GET /api/read': async (query) => {
    const content = await read(requirePath(query.path), {
      cwd: root,
      head: query.head == null ? undefined : Number(query.head),
      tail: query.tail == null ? undefined : Number(query.tail),
      range: rangeFrom(query),
    });
    return { status: 200, text: content };
  },

  'PUT /api/write': async (_query, body) => {
    const result = await write(requirePath(body.path), body.content ?? '', { cwd: root, append: bool(body.append), range: body.range, createDirs: body.createDirs !== false });
    return { status: 201, json: publicResult(result) };
  },

  'PATCH /api/modify': async (_query, body) => {
    const result = await modify(requirePath(body.path), { cwd: root, match: body.match, replacement: body.replacement, occurrence: body.occurrence, rewrite: body.rewrite, range: body.range });
    return { status: 200, json: publicResult(result) };
  },

  'DELETE /api/delete': async (query) => {
    const result = await remove(requirePath(query.path), { cwd: root, recursive: bool(query.recursive), force: bool(query.force) });
    return { status: 200, json: publicResult(result) };
  },

  'GET /api/list': async (query) => ({ status: 200, json: publicResult(await list(optionalPath(query.path), { cwd: root, all: bool(query.all) })) }),

  'GET /api/glob': async (query) => ({ status: 200, json: (await glob(String(query.pattern || ''), { cwd: root, path: optionalPath(query.path), all: bool(query.all) })).map(publicPath) }),

  'GET /api/grep': async (query) => ({ status: 200, json: publicResult(await grep(String(query.pattern || ''), { cwd: root, path: optionalPath(query.path), ignoreCase: bool(query.ignoreCase), all: bool(query.all) })) }),
};

export function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const route = routes[`${request.method} ${url.pathname}`];
    if (!route) return sendJson(response, 404, { error: 'not_found', message: 'route not found' });
    try {
      const query = Object.fromEntries(url.searchParams);
      const body = request.method === 'PUT' || request.method === 'PATCH' ? await readBody(request) : {};
      const result = await route(query, body);
      if (result.text !== undefined) return sendText(response, result.status, result.text);
      return sendJson(response, result.status, result.json);
    } catch (error) {
      const status = statusFor(error);
      return sendJson(response, status, { error: status >= 500 ? 'internal_error' : 'request_error', message: error.message });
    }
  });
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  createServer().listen(port, '0.0.0.0', () => console.log(`FileSystem Kit listening on port ${port}; root=${root}`));
}
