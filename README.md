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

## Development

```bash
npm test
npm run lint
```

The project uses Node's built-in test runner and has no runtime dependencies.
