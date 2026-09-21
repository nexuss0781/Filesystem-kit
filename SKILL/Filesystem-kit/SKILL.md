---
name: filesystem-kit
description: Use the configured filesystem operations to read, write, edit, search, list, and delete files. Use when an agent needs to inspect or change files and folders.
---

# Filesystem operations

Use the configured FileSystem Kit interface for all local file and folder work. Do not invent paths, contents, or results. Operate only on the files needed for the current task.

## Paths

- Treat the configured root as `/` for this interface. Use paths relative to that root, such as `src/app.js` or `notes/research.md`.
- Do not use `..`, host-machine paths, or paths outside the configured root.
- Use forward slashes.
- Before changing a file, read the relevant part of it first unless the task explicitly provides the complete new content.
- Keep paths exact. Do not silently change capitalization or file extensions.

## Read

Read a whole file:

```json
{"path":"src/app.js"}
```

Read selected lines with a 1-based inclusive range:

```json
{"path":"src/app.js","range":{"start":20,"end":45}}
```

Read only the beginning or end:

```json
{"path":"logs/app.log","head":40}
{"path":"logs/app.log","tail":40}
```

Use only one of `range`, `head`, or `tail` per read. Prefer a range or head/tail for large files.

## Write

Create or replace a file:

```json
{"path":"notes/todo.md","content":"- Review results\n"}
```

Append to a file:

```json
{"path":"notes/todo.md","content":"- Add tests\n","append":true}
```

Replace existing lines without rewriting the rest:

```json
{"path":"src/config.js","content":"export const mode = 'safe';","range":{"start":3,"end":3}}
```

Parent folders are created automatically. Use write for a complete replacement or for a deliberate append. Do not use append when the intended result is replacement.

## Edit

Replace one exact occurrence:

```json
{"path":"src/app.js","match":"old text","replacement":"new text"}
```

If the same text occurs more than once, select the intended occurrence explicitly:

```json
{"path":"src/app.js","match":"TODO","replacement":"DONE","occurrence":2}
```

Rewrite a selected line range:

```json
{"path":"src/app.js","rewrite":"new line 1\nnew line 2","range":{"start":10,"end":11}}
```

Use either `match` with `replacement`, or `rewrite` with an optional `range`; do not mix the two forms. An edit that reports no match must stop and inspect the file instead of trying a different replacement blindly.

## List and search

List one folder:

```json
{"path":"src"}
```

Include hidden entries only when they are relevant:

```json
{"path":".","all":true}
```

Find paths with a simple pattern:

```json
{"pattern":"src/**/*.js","cwd":"."}
```

Search file contents:

```json
{"pattern":"TODO","path":"src","ignoreCase":true}
```

`grep` returns matching file paths, line numbers, and line text. `glob` returns matching paths. Hidden files are excluded unless `all` is true. Prefer a narrow `path` or `cwd` over searching the whole root.

## Delete

Delete one file only after confirming the exact path:

```json
{"path":"tmp/output.txt"}
```

Delete a folder only when the task explicitly requires it and recursive deletion is intended:

```json
{"path":"tmp/cache","recursive":true}
```

Never use recursive deletion for an uncertain path. Treat deletion as irreversible.

## Safe workflow

1. Identify the exact path.
2. Read the relevant content or list the relevant folder.
3. Make the smallest write or edit that satisfies the task.
4. Read the changed content again when correctness matters.
5. Use grep or glob to verify related files when needed.
6. Delete only temporary artifacts created for the current task.

If an operation fails, use its error to correct the request. Do not retry a destructive operation without checking whether it already succeeded. Keep returned file content and paths in context only as long as needed for the task.
