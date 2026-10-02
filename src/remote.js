import { errorFromRemote } from './errors.js';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 1;

/**
 * A backend that speaks to a FileSystem Kit server instead of the local disk.
 *
 * The signatures are deliberately identical to the local functions, so the same
 * calling code runs against either. Three things cannot cross the wire and are
 * refused here rather than silently mistranslated:
 *
 * - A `RegExp` for `grep`. JSON carries a string, not a pattern object.
 * - A `Buffer` for `write`. The protocol is UTF-8 text.
 * - `encoding` other than UTF-8, for the same reason.
 *
 * `path` in results is the path on the *remote* machine, always starting with a
 * slash, so `/src/app.js` means the same thing here as it does locally.
 */
/** The server already reports machine-relative paths; never double the slash. */
function reported(value) {
  const text = String(value ?? '');
  return text.startsWith('/') ? text : `/${text}`;
}

function createRemoteFilesystem(options = {}) {
  const { baseUrl, url, token, timeout = DEFAULT_TIMEOUT, retries = DEFAULT_RETRIES, fetch: fetchImpl = globalThis.fetch } = options;
  const target = baseUrl ?? url;
  if (typeof target !== 'string' || target.length === 0) throw new TypeError('baseUrl is required');
  const origin = target.replace(/\/+$/, '');
  const bearer = token ?? process.env.FSK_TOKEN;
  let root;

  async function send(method, pathname, { query, body } = {}) {
    const url = new URL(`${origin}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null && value !== false) url.searchParams.set(key, String(value));
    }
    let lastFailure;
    for (let attempt = 0; attempt <= (method === 'GET' ? retries : 0); attempt += 1) {
      try {
        const headers = {};
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        if (body !== undefined) headers['content-type'] = 'application/json';
        const response = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        return response;
      } catch (cause) {
        // Only a transport failure is worth retrying; an HTTP status is an answer.
        lastFailure = cause;
      }
    }
    const error = new Error(`cannot reach ${origin}: ${lastFailure?.message ?? 'request failed'}`);
    error.code = 'E_UNREACHABLE';
    error.cause = lastFailure;
    throw error;
  }

  async function json(response, requested) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw errorFromRemote(payload, response.status, requested, root);
    return payload;
  }

  async function text(response, requested) {
    const payload = response.ok ? await response.text() : null;
    if (!response.ok) throw errorFromRemote(await response.json().catch(() => null), response.status, requested, root);
    return payload;
  }

  function requireText(value, label) {
    if (typeof value !== 'string') throw new TypeError(`${label} must be a string; the remote protocol is UTF-8 text`);
    return value;
  }

  const backend = {
    kind: 'remote',
    origin,
    get root() { return root; },

    /** Resolves the remote machine's root by asking it, so callers know what they are on. */
    async describe() {
      const payload = await json(await send('GET', '/health'), '/health');
      root = payload.root;
      return payload;
    },

    async read(filePath, readOptions = {}) {
      const selectors = ['head', 'tail', 'range'].filter((key) => readOptions[key] != null);
      if (selectors.length > 1) throw new Error(`use only one of head, tail or range (received ${selectors.join(', ')})`);
      if (readOptions.encoding != null && readOptions.encoding !== 'utf8') throw new TypeError('remote reads are UTF-8 text');
      const range = readOptions.range;
      return text(await send('GET', '/api/read', {
        query: {
          path: filePath,
          head: readOptions.head,
          tail: readOptions.tail,
          start: range?.start,
          end: range?.end,
        },
      }), filePath);
    },

    async write(filePath, content, writeOptions = {}) {
      requireText(content, 'content');
      if (writeOptions.append && writeOptions.range) throw new Error('append and range cannot be used together');
      const payload = await json(await send('PUT', '/api/write', {
        body: {
          path: filePath,
          content,
          append: writeOptions.append === true,
          createDirs: writeOptions.createDirs,
          range: writeOptions.range,
        },
      }), filePath);
      return { path: reported(payload.path), bytes: payload.bytes };
    },

    async modify(filePath, modifyOptions = {}) {
      if (modifyOptions.rewrite !== undefined && modifyOptions.match !== undefined) throw new Error('use either rewrite or match/replacement');
      if (modifyOptions.rewrite === undefined && (typeof modifyOptions.match !== 'string' || typeof modifyOptions.replacement !== 'string')) {
        throw new TypeError('match and replacement must be strings');
      }
      const payload = await json(await send('PATCH', '/api/modify', {
        body: {
          path: filePath,
          match: modifyOptions.match,
          replacement: modifyOptions.replacement,
          occurrence: modifyOptions.occurrence,
          rewrite: modifyOptions.rewrite,
          range: modifyOptions.range,
        },
      }), filePath);
      return { path: reported(payload.path), replacements: payload.replacements };
    },

    async remove(filePath, removeOptions = {}) {
      const payload = await json(await send('DELETE', '/api/delete', {
        query: { path: filePath, recursive: removeOptions.recursive === true, force: removeOptions.force === true },
      }), filePath);
      return { path: reported(payload.path), removed: payload.removed };
    },

    async list(directory = '.', listOptions = {}) {
      const entries = await json(await send('GET', '/api/list', {
        query: { path: directory, all: listOptions.all === true },
      }), directory);
      return entries.map((entry) => ({ ...entry, path: reported(entry.path) }));
    },

    async glob(pattern, globOptions = {}) {
      const matches = await json(await send('GET', '/api/glob', {
        query: { pattern: String(pattern), path: globOptions.path ?? '.', all: globOptions.all === true },
      }), String(pattern));
      return matches.map(reported);
    },

    async grep(pattern, grepOptions = {}) {
      if (pattern instanceof RegExp) throw new TypeError('a RegExp cannot be sent to a remote machine; pass the pattern as a string');
      const matches = await json(await send('GET', '/api/grep', {
        query: {
          pattern: String(pattern),
          path: grepOptions.path ?? '.',
          ignoreCase: grepOptions.ignoreCase === true,
          all: grepOptions.all === true,
        },
      }), String(pattern));
      return matches.map((match) => ({ ...match, path: reported(match.path) }));
    },
  };

  return backend;
}

export { createRemoteFilesystem };
export default createRemoteFilesystem;
