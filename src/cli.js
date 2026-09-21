#!/usr/bin/env node
import { read, write, modify, remove, list, glob, grep } from './index.js';

function usage() {
  console.error(`Usage: fsk <command> [args] [options]\n\nCommands:\n  read <path> [--head N|--tail N|--start N --end N]\n  write <path> <content> [--append]\n  modify <path> --match TEXT --replacement TEXT [--occurrence N]\n  modify <path> --rewrite TEXT [--start N --end N]\n  delete <path> [--recursive]\n  list [path] [--all]\n  glob <pattern> [--cwd path]\n  grep <pattern> [path] [--ignore-case]\n\nOutput is JSON except read, which prints file content.`);
}

function args(argv) {
  const positional = [], flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) { const key = arg.slice(2); flags[key] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true; }
    else positional.push(arg);
  }
  return { positional, flags };
}

const { positional, flags } = args(process.argv.slice(2));
const command = positional.shift();
const number = (value) => value == null ? undefined : Number(value);
const range = flags.start || flags.end ? { start: number(flags.start), end: number(flags.end) } : undefined;
try {
  let result;
  if (command === 'read') result = await read(positional[0], { head: number(flags.head), tail: number(flags.tail), range });
  else if (command === 'write') result = await write(positional[0], positional.slice(1).join(' '), { append: Boolean(flags.append), range });
  else if (command === 'modify') result = await modify(positional[0], { match: flags.match, replacement: flags.replacement, occurrence: number(flags.occurrence), rewrite: flags.rewrite, range });
  else if (command === 'delete') result = await remove(positional[0], { recursive: Boolean(flags.recursive), force: Boolean(flags.force) });
  else if (command === 'list') result = await list(positional[0] ?? '.', { all: Boolean(flags.all) });
  else if (command === 'glob') result = await glob(positional[0], { cwd: flags.cwd, all: Boolean(flags.all) });
  else if (command === 'grep') result = await grep(positional[0], { path: positional[1] ?? '.', ignoreCase: Boolean(flags['ignore-case']), all: Boolean(flags.all) });
  else { usage(); process.exitCode = 1; }
  if (command === 'read') process.stdout.write(result);
  else if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`fsk: ${error.message}`); process.exitCode = 1; }
