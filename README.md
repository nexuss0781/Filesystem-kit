# FileSystem Kit

FileSystem Kit is a small, dependency-free Node.js filesystem API and CLI designed for coding agents, research tooling, and other automation that needs predictable local file operations.

## Install

```bash
npm install filesystem-kit
```

The package requires Node.js 20 or newer. The CLI is available as `fsk` after installation, or can be run directly with `node src/cli.js` from a checkout.

## API

```js
import { read, write, modify, remove, list, glob, grep } from 'filesystem-kit';

await write('notes/research.md', '# Findings\n\nDraft');
const section = await read('notes/research.md', { range: { start: 1, end: 2 } });
await modify('notes/research.md', {
  match: 'Draft',
  replacement: 'Final',
});
```

All paths are resolved from `options.cwd` when supplied, otherwise from the current working directory. Methods return absolute paths in their result objects. Read ranges are **1-based and inclusive**. `head` and `tail` operate on lines and cannot be combined with each other or with a range.

| Function | Purpose |
| --- | --- |
| `read(path, options)` | Read all content, a line range, or a line-based head/tail. |
| `write(path, content, options)` | Create or replace a file; parent directories are created by default. Supports `append` and line-range replacement. |
| `modify(path, options)` | Replace one exact matching occurrence, or rewrite a line range with `rewrite`. |
| `remove(path, options)` | Delete a file or, with `recursive: true`, a directory. |
| `list(directory, options)` | List immediate children with name, absolute path, and type. Hidden entries are excluded unless `all: true`. |
| `glob(pattern, options)` | Find paths with `*`, `?`, and `**` patterns relative to `cwd`. |
| `grep(pattern, options)` | Find matching text lines in a file or recursively in a directory. Returns path, line, and text. |

`modify` intentionally edits only one occurrence by default. Set `occurrence` to select a later exact match; this makes agent edits safer than an unrestricted replace-all.

## CLI

```bash
fsk read README.md --head 20
fsk write notes/todo.md "first item"
fsk modify notes/todo.md --match "first" --replacement "completed"
fsk modify notes/todo.md --rewrite "new line" --start 1 --end 1
fsk list . --all
fsk glob "src/*.js"
fsk grep "TODO" . --ignore-case
fsk delete build --recursive
```

CLI results are JSON except for `read`, which writes file content directly to stdout. Errors are sent to stderr with a non-zero exit code.

## HTTP server

The package also includes an Express server for coding agents and remote tooling:

```bash
FILESYSTEM_ROOT=/workspace PORT=3000 npm start
```

The server binds to `0.0.0.0` for deployment platforms. Every requested path is confined to `FILESYSTEM_ROOT` (which defaults to the current working directory); traversal outside that root is rejected with HTTP 403. The available endpoints are:

| Method | Endpoint | Body or query |
| --- | --- | --- |
| `GET` | `/health` | Service status and configured root. |
| `GET` | `/api/read` | `path`, optional `head`, `tail`, `start`, `end`. |
| `PUT` | `/api/write` | JSON: `path`, `content`, optional `append`, `range`. |
| `PATCH` | `/api/modify` | JSON: `path`, `match`, `replacement`, `occurrence`, or `rewrite` and `range`. |
| `DELETE` | `/api/delete` | `path`, optional `recursive`, `force`. |
| `GET` | `/api/list` | `path`, optional `all`. |
| `GET` | `/api/glob` | `pattern`, optional `cwd`, `all`. |
| `GET` | `/api/grep` | `pattern`, optional `path`, `ignoreCase`, `all`. |

The server returns JSON for mutations, listings, searches, health, and errors. `/api/read` returns the file content as `text/plain`.

### Wasmer Edge persistence

The repository includes [`app.yaml`](app.yaml) with a Wasmer persistent volume mounted at `/data`. The deployment sets `FILESYSTEM_ROOT=/data`, so files created through the API survive instance restarts, deployments, and scale-out. A plain deployment without this volume will have an ephemeral `/app` filesystem and cannot provide reliable multi-request file operations; this is the same limitation found on many serverless platforms, including Vercel functions.

Deploy with the Wasmer CLI from the repository root:

```bash
wasmer deploy
```

After deployment, verify `/health`, then exercise write/read/modify/grep/glob/list/delete as normal.

## Development

```bash
npm test
npm run lint
```

The project uses Node's built-in test runner and has no runtime dependencies.
