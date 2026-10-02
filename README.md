# FileSystem Kit

A filesystem API, CLI and HTTP service for coding agents. One configured root, a
small set of exact operations, and nothing that can reach outside it.

- No runtime dependencies. Node's built-ins only, server included.
- Works against this disk or a remote FileSystem Kit machine, chosen by one option.
- The root is enforced in code, so a path that would leave it fails before any
  disk access instead of relying on the caller to behave.
- Precise addressing: 1-based inclusive line ranges, single-occurrence edits,
  chunked tails, and one shared rule for what a line number means.
- Ships as a skill (`SKILL/`) so an agent can be given the machine correctly.

## Install

```bash
npm install filesystem-kit
```

Requires Node.js 20 or newer. The CLI is available as `fsk`.

## The root is the machine

Every function resolves paths against a root — `options.cwd`, defaulting to
`process.cwd()` — and refuses any path that lands outside it.

```js
import { read, write } from 'filesystem-kit';

await write('notes/research.md', '# Findings\n\nDraft', { cwd: '/work' });
await read('notes/research.md', { cwd: '/work' });
```

Paths are read as paths *on this machine*, so a leading slash names the root
rather than the host filesystem:

| Written | Resolves to |
| --- | --- |
| `src/app.js` | `<root>/src/app.js` |
| `/src/app.js` | `<root>/src/app.js` |
| `/` | `<root>` |
| `../secrets` | rejected — `outside the root` |
| `/etc/passwd` | `<root>/etc/passwd` — a machine path, not the host's |

`..` resolves the way it always does and the result must still be inside the
root, so there is no traversal and no host path to reach for. `OutsideRootError`
is thrown, carrying `code: 'EOUTSIDE'` and `status: 403` for the HTTP layer.

## API

```js
import { read, write, modify, remove, list, glob, grep } from 'filesystem-kit';
```

| Function | Returns |
| --- | --- |
| `read(path, options)` | the file's text as a **string** |
| `write(path, content, options)` | `{ path, bytes }` |
| `modify(path, options)` | `{ path, replacements: 1 }` |
| `remove(path, options)` | `{ path, removed: true }` |
| `list(directory, options)` | `[{ name, path, type }]`, sorted by name |
| `glob(pattern, options)` | absolute path strings, sorted |
| `grep(pattern, options)` | `[{ path, line, text }]`, one per matching line |

`type` is `file`, `directory` or `other`. Only `read` returns a bare string;
everything else returns objects carrying the absolute path it acted on.

### Options

Shared by every function:

| Option | Meaning |
| --- | --- |
| `cwd` | the root of the machine. Defaults to `process.cwd()`. |
| `all` | include dotfiles. Off by default. |

| Function | Options |
| --- | --- |
| `read` | `head`, `tail`, `range`, `encoding` |
| `write` | `append`, `range`, `createDirs`, `encoding` |
| `modify` | `match` + `replacement` + `occurrence`, or `rewrite` + `range` |
| `remove` | `recursive`, `force` |
| `list` | — |
| `glob` | `path` — the subtree to search |
| `grep` | `path` — a file or subtree, `ignoreCase`, or a `RegExp` pattern |

### Line addressing

One rule, so a line number means the same thing in every call:

- **1-based**, and `end` is **inclusive**.
- A trailing newline ends the last line rather than starting an empty one, so
  `'alpha\nbeta\n'` is two lines. Line 2 is `beta`.
- `read` with `range` clamps `end` to the end of the file.
- `write` with `range` requires `end` to be inside the file.

`read` returns the file's text verbatim when no selector is given, trailing
newline included.

### Exactness

- `head`, `tail` and `range` are mutually exclusive; passing two is an error
  rather than one silently winning.
- `tail` reads backwards from the end in 64 KiB chunks, so the last lines of a
  large log cost no more than a short file, and multi-byte characters at a chunk
  boundary stay intact.
- `append` and `range` cannot be combined — one adds to the end, the other
  rewrites the middle.
- `modify` changes exactly one occurrence. Text appearing more than once is
  addressed with `occurrence`, or rewritten positionally with `rewrite` and
  `range`.
- Deleting a folder without `recursive` fails with `ERR_FS_EISDIR` rather than
  emptying it, so a folder is never half-deleted.
- `grep` skips binary files automatically, so searching a large tree is safe.

### Patterns

`<double star>/` spans zero or more folders:

| Pattern | Finds |
| --- | --- |
| `src/*.js` | `src/a.js` |
| `src/<double star>.js` | `src/a.js`, `src/deep/b.js`, `src/deep/deeper/c.js` |
| `src/<double star>` | every entry beneath `src` |

`*` stays within one segment and `?` matches one character.

## Two machines, one API

`createFilesystem()` returns a backend with the same seven operations, and it is
either this disk or a remote machine. Which one is a configuration decision, not
something calling code has to know about.

```js
import { createFilesystem } from 'filesystem-kit';

const here = createFilesystem({ cwd: '/home/you/project' });
const cloud = createFilesystem({ baseUrl: 'https://filesystem-kit.wasmer.app', token: process.env.FSK_TOKEN });

await here.write('notes/today.md', 'local');
await cloud.write('notes/today.md', 'on the volume');
```

Both expose `read`, `write`, `modify`, `remove`, `list`, `glob`, `grep`, and
`describe()`, plus `kind` and `root`. `describe()` asks a remote machine what its
root is, which is worth knowing before writing anything to it.

`path` in a result is always the path on that backend's own machine, starting
with a slash, so `/notes/today.md` reads the same way on both.

### Errors mean the same thing on both

The codes are the contract, so a `catch` written once works on either machine:

| Code | Meaning |
| --- | --- |
| `EOUTSIDE` | the path would leave the root; an `OutsideRootError` |
| `ENOENT` | no such file or directory |
| `EEXIST` | something is already in the way |
| `EINVAL` | a bad argument |
| `E_UNAUTHORIZED` | the server wants a bearer token |
| `E_UNREACHABLE` | the machine could not be reached at all |

### What cannot cross the wire

Three things are refused by the remote backend rather than quietly mistranslated,
because JSON has no way to carry them faithfully:

- A `RegExp` for `grep`. Pass the pattern as a string.
- A `Buffer` for `write`. The protocol is UTF-8 text.
- An `encoding` other than UTF-8.

### Latency is the real cost

Measured against the deployment above: the first request after an idle period
takes about **1.6s** while the instance scales up, and each subsequent request on
a warm connection about **200ms**. So a remote backend is right for state an agent
should treat as one machine's disk, and wrong for a hot loop over hundreds of
small files. `fetch` pools connections, so the warm figure is what a normal
session sees.

## CLI

```bash
fsk read README.md --head 20
fsk write notes/todo.md "first item"
fsk modify notes/todo.md --match "first" --replacement "completed"
fsk modify notes/todo.md --rewrite "new line" --start 1 --end 1
fsk list . --all
fsk glob "src/**/*.js"
fsk grep "TODO" src --ignore-case
fsk delete build --recursive
```

Every command accepts `--cwd <root>`. Output is JSON, except `read`, which writes
the content itself. Errors go to stderr with a non-zero exit code.

## HTTP server

A service exposing the same operations over HTTP, for agents that reach a machine
remotely. It is built on Node's own `node:http`, so the server has no dependencies
either and the package installs nothing at all.

```bash
FSK_ROOT=/workspace PORT=3000 npm start
```

| Method | Endpoint | Body or query |
| --- | --- | --- |
| `GET` | `/` | service name, root, and route list |
| `GET` | `/health` | service status and configured root |
| `GET` | `/api/read` | `path`, `head`, `tail`, `start`, `end` |
| `PUT` | `/api/write` | `path`, `content`, `append`, `range` |
| `PATCH` | `/api/modify` | `path`, `match`, `replacement`, `occurrence`, or `rewrite` and `range` |
| `DELETE` | `/api/delete` | `path`, `recursive`, `force` |
| `GET` | `/api/list` | `path`, `all` |
| `GET` | `/api/glob` | `pattern`, `path`, `all` |
| `GET` | `/api/grep` | `pattern`, `path`, `ignoreCase`, `all` |

Paths are resolved inside the root and reported back relative to it, so a client
never sees a host path. Errors are JSON: `403` for a path outside the root, `404`
for a missing file or route, `400` for an invalid argument.

The root is `FSK_ROOT`, then `FILESYSTEM_ROOT`, then the working directory.
`FSK_ROOT` comes first because Wasmer Edge overrides `FILESYSTEM_ROOT` with its
own scratch directory, which is not the mounted volume; trusting
`FILESYSTEM_ROOT` there silently writes to ephemeral storage. Because `exports`
maps only the library entry point, run the service from a checkout of the
repository rather than from an installed copy.

### Wasmer persistence

[`app.yaml`](https://github.com/nexuss0781/Filesystem-kit/blob/main/app.yaml)
mounts a Wasmer volume at `/home/ubuntu` and points the root there with
`FSK_ROOT`, so paths behave like a home directory and files survive restarts,
redeploys, and scale-out. It is that container's home directory, not the host's.
A deployment without the volume has an ephemeral filesystem and cannot keep state
between requests.

Set `FSK_TOKEN` on the server to require `Authorization: Bearer <token>`; without
it the service is open, which is convenient on localhost and wrong for a machine
holding real files. The client picks the token up from its own `FSK_TOKEN`.

Deploy from a checkout with `wasmer deploy --build-remote`, then check `/health`
and confirm the reported `root` is `/home/ubuntu` before trusting any writes. Two
Wasmer details are worth knowing:

- `--build-remote` is required, because there is no `wasmer.toml` and a local
  `package: .` will not build on its own.
- `health_checks` is left out of `app.yaml` on purpose. The shape published in
  the Wasmer docs is rejected by the CLI with `invalid type: map, expected a
  Value::Tagged enum`. This was reproduced on both 7.4.2 and 7.5.0, and against
  a minimal two-field entry, so it is a Wasmer bug rather than a version skew or
  a mistake in the manifest. The deployment instead relies on `GET /` answering
  `200`, which is what the platform probes after a deploy.

## Skill

`SKILL/Filesystem-kit/SKILL.md` is the tool skill: the operating manual an agent
is given alongside these tools. It documents the root as a property of the
machine rather than a rule to remember, and points at the operation to reach for
in each situation.

## Migrating from 1.0.0

Paths are now machine-relative and confined, and `glob` takes `path`:

| 1.0.0 | 2.0.0 |
| --- | --- |
| any absolute path accepted | `/x` means `<root>/x`; leaving the root throws |
| no confinement | `OutsideRootError` on traversal |
| `glob(pattern, { cwd })` | `glob(pattern, { path })`; `cwd` is now the root |
| `head` + `range` silently ignored `range` | passing two selectors is an error |
| `append` + `range` duplicated the file | passing both is an error |
| `**/` required one folder | `<double star>/` spans zero or more |
| `tail: 1` of `'a\nb\n'` returned `''` | returns `b` |

Absolute host paths are now interpreted as machine paths. Pass `cwd` set to the
directory you want addressed, and use paths relative to it.

## Development

```bash
npm test
npm run lint
```

Node's built-in test runner, no runtime dependencies.

## License

MIT
