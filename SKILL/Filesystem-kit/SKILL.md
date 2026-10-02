---
name: filesystem-kit
description: Read, write, edit, find, delete and run commands on the files and folders of the configured FileSystem Kit. Use whenever a task requires looking at, changing, locating or building something on disk — reading a file, patching one line, creating a file, listing a folder, globbing paths, searching contents, removing something, or running a build or test.
---

# FileSystem Kit

The machine you are working on. Its root is `/`, and every operation below
resolves paths against that root.

## The root is the machine

`/` is the configured root. It is not a folder inside a larger filesystem that
you can step out of — it is the whole machine as far as this interface is
concerned.

- Write `/src/app.js` and you mean the file at `<root>/src/app.js`.
- `/` on its own is the root folder itself, and `list("/")` shows its contents.
- `..` resolves the way it always does on a filesystem, and the result is still
  required to be inside the root. A path that would leave the root is rejected
  with `outside the root` before any disk access happens.
- For file operations there is no host machine to name, no `/etc`, no `/tmp`,
  no `~`. If something is not under `/`, it is not part of this machine.
- `exec` is the one exception, and deliberately so: a command is a real shell
  and can reach outside the root. See [exec](#exec).

Because the root is enforced rather than advisory, you never have to reason
about whether a path is safe to touch. Every path that reaches a function is
already inside the machine.

Use forward slashes. Name files exactly as they are: the same capitalisation,
the same extension.

## Choosing the operation

| You want to | Use |
| --- | --- |
| see a whole file | `read` |
| see the start or end of a file | `read` with `head` or `tail` |
| see or replace known lines | `read` / `write` with `range` |
| change one exact piece of text | `modify` with `match` |
| replace a span of lines with new text | `modify` with `rewrite` and `range` |
| create a file, or replace a whole file | `write` |
| add to the end of a file | `write` with `append` |
| see what is in a folder | `list` |
| find files by name | `glob` |
| find files by what is inside them | `grep` |
| remove a file or folder | `remove` |
| run a build, a test, or any program | `exec` |

Reach for `modify` rather than `write` when you are changing something that
already exists. `write` replaces a file from the first byte; `modify` changes
only what you named and leaves every other byte alone.

## Line addressing

One rule, used by every line-based option, so a line number means the same thing
everywhere:

- Lines are **1-based**. Line 1 is the first line.
- `end` is **inclusive**.
- A trailing newline ends the last line; it does not begin an empty one. A file
  containing `alpha\nbeta\n` has two lines.
- `read` with `range` stops at the end of the file if `end` is past it.
- `write` with `range` requires `end` to be within the file, and replaces
  exactly lines `start` through `end`.

## read

Returns the file's text as a string.

Whole file:

```json
{"path": "src/app.js"}
```

A line range, 1-based and inclusive:

```json
{"path": "src/app.js", "range": {"start": 20, "end": 45}}
```

The first 40 lines, or the last 40:

```json
{"path": "logs/app.log", "head": 40}
{"path": "logs/app.log", "tail": 40}
```

`head`, `tail` and `range` are three ways to read part of a file. Use exactly one
per read; passing two is an error. `tail` reads backwards from the end of the
file in chunks, so the last lines of a large log cost no more than a short file.

## write

Returns `{ "path", "bytes" }`. Parent folders are created as needed.

Create or replace the whole file:

```json
{"path": "notes/todo.md", "content": "- Review results\n"}
```

Add to the end:

```json
{"path": "notes/todo.md", "content": "- Add tests\n", "append": true}
```

Replace lines 3 to 3 and keep the rest of the file:

```json
{"path": "src/config.js", "content": "export const mode = 'safe';", "range": {"start": 3, "end": 3}}
```

`append` and `range` are opposites — one adds to the end, the other rewrites the
middle — so they cannot be combined. Choosing between them is part of the
request: append when the new content belongs after the last line, range when it
belongs at a specific line.

## modify

Returns `{ "path", "replacements": 1 }`.

Replace one exact occurrence:

```json
{"path": "src/app.js", "match": "old text", "replacement": "new text"}
```

The same text appearing more than once is addressed by position:

```json
{"path": "src/app.js", "match": "TODO", "replacement": "DONE", "occurrence": 2}
```

Rewriting a span of lines:

```json
{"path": "src/app.js", "rewrite": "new line 1\nnew line 2", "range": {"start": 10, "end": 11}}
```

`modify` changes exactly one occurrence. That is deliberate: a text that appears
twice usually means two different things in two places, and replacing all of
them at once is how unrelated code gets broken. Choose `occurrence` to be
specific, or use `rewrite` with a range when the change is positional rather
than textual.

If `match` is not present, the file is left untouched and the call reports
`match not found`. Read the file and match what is actually there.

`rewrite` and `match` are different tools for different edits and cannot be
combined in one call.

## list

Returns an array of `{ "name", "path", "type" }`, sorted by name. `type` is
`file`, `directory`, or `other`.

```json
{"path": "src"}
```

Dotfiles are left out of the listing. Include them when they matter:

```json
{"path": ".", "all": true}
```

## glob

Returns an array of absolute path strings, sorted. Matches against paths
relative to the folder being searched.

```json
{"pattern": "src/**/*.js", "path": "."}
```

- `*` matches within one segment, `?` matches exactly one character, and
  `<double star>` matches any number of characters.
- `<double star>/` spans zero or more folders. `src/<double star>.js` finds
  `src/a.js`, `src/deep/b.js` and `src/deep/deeper/c.js` in one call, while
  `src/*.js` finds only `src/a.js`.
- `pattern` is matched against the path relative to the folder being searched,
  so a leading `/` is optional and means the same thing.
- `path` narrows where the search runs. Narrow it — a search with no `path`
  walks the entire machine, `node_modules` included.

## grep

Returns an array of `{ "path", "line", "text" }` for every matching line.

```json
{"pattern": "TODO", "path": "src", "ignoreCase": true}
```

- `pattern` is a regular expression, matched per line. Pass a `RegExp` directly
  for flags the options do not cover.
- `path` accepts a single file or a folder. Given a folder it searches
  everything beneath it.
- Dotfiles are skipped unless `all` is true.
- Binary files are skipped automatically, so a search across a large tree is
  safe to run.

## remove

Returns `{ "path", "removed": true }`.

```json
{"path": "tmp/output.txt"}
```

A folder needs `recursive`:

```json
{"path": "tmp/cache", "recursive": true}
```

Deleting a folder without `recursive` fails instead of emptying it, so a folder
is never half-deleted. Before a recursive delete, `list` the folder first: it is
one call, and it is the difference between removing a build cache and removing
the source.

## exec

`exec` runs one shell command on this machine and reports how it went.

```json
{ "command": "npm test", "directory": "app", "timeoutMs": 60000 }
```

It answers with `code`, `stdout`, `stderr`, `timedOut`, `truncated` and
`durationMs`.

- **A non-zero `code` is an answer, not a failure.** The call succeeds and you
  read the code. A test suite that fails is a result to report, not an error to
  retry.
- **It starts inside the root**, so a relative path means the same thing it does
  in `read` and `write`, and what the command writes is on this machine's disk.
- **It is not interactive.** Nothing is written to stdin, so there is no prompt
  to answer. Do not run `vim`, `top`, or anything else that waits for a person.
- **`directory` is created if it is missing.** Pass `createDir: false` if you
  would rather it be an error.
- **It runs the machine's programs.** `node` and `npm` are present on the
  deployed machine; `grep`, `sed`, `awk`, `git` and `python3` are not. Use
  `glob` and `grep` for searching — they are the same on every machine.

Prefer a file operation when one will do. `modify` is safer than a shell
rewriting a file, `grep` is available everywhere, and each one is easier to undo
when it goes wrong. Reach for `exec` when the work is genuinely running a
program.

## Working method

1. `list` or `glob` when you do not yet know the exact path.
2. `read` the part of the file that the change belongs to.
3. `modify` for an edit to existing content, `write` for a new file.
4. `read` the changed lines back when the result has to be right.

Searching before reading and reading after writing are what turn a guess into a
verified change. When an operation fails, its message names the constraint that
was violated — an unknown path, a range past the end of the file, a `match`
that is not there — and the call that fixes it is usually the one you just made
with a different value.

## Which machine

These tools may be pointed at this computer or at a remote FileSystem Kit
machine. You do not choose per call and you should not try to: the root is
configured for you, and it is the same set of operations either way.

Treat the root as one machine's disk. Paths start from it, `/` means the root of
that machine, and nothing reaches outside. A path outside the root fails with
`EOUTSIDE` rather than being rewritten, so if you see it, the path is wrong, not
the permission.

`exec` works the same way on either machine, and is the one operation that is not
confined by it.

The one difference worth knowing is speed. A remote machine answers in roughly
200ms and its first call after an idle stretch takes longer while it wakes up, so
prefer fewer, larger operations over many tiny ones, and do not poll.
