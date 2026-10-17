#!/usr/bin/env node
/**
 * Development runner.
 *
 * Runs `tsc --watch` and `node --watch` side by side, restarting the server on
 * every successful rebuild.
 *
 * Why not `tsx` or `nest start --watch`?
 * --------------------------------------
 * Both are faster, but neither emits TypeScript's `design:paramtypes` metadata,
 * and Nest's dependency injection is built entirely on that metadata. Running the
 * application through an esbuild-based transpiler therefore fails at boot with
 * `Cannot read properties of undefined`. Compiling with `tsc` keeps the metadata
 * intact, so the runtime behaviour matches production exactly.
 *
 * Written as a plain Node script rather than an npm one-liner so it behaves the
 * same on Windows, macOS and Linux, and so Ctrl-C tears both processes down.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildConfig = join(projectRoot, 'tsconfig.build.json');
const entryPoint = join(projectRoot, 'dist', 'main.js');

/** Resolves a locally installed binary, e.g. `typescript/bin/tsc`. */
function localBin(packageName, relativePath = '') {
  return require.resolve(join(packageName, relativePath), { paths: [projectRoot] });
}

const children = [];
let shuttingDown = false;

/**
 * Spawns a child process and forwards its stdio.
 *
 * @param {string} command Executable to run.
 * @param {string[]} args Arguments for the executable.
 * @param {string} label Human readable name used in log lines.
 * @returns {import('node:child_process').ChildProcess} The spawned process.
 */
function run(command, args, label) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(child);

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }
    process.stderr.write(`[dev] ${label} exited (code=${code ?? 'null'} signal=${signal ?? 'none'})\n`);
    shutdown(code ?? 1);
  });

  return child;
}

/**
 * Stops every child process and exits.
 *
 * @param {number} code Exit code for the parent process.
 * @returns {void}
 */
function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 1. Type-check and compile in watch mode.
process.stdout.write('[dev] starting tsc --watch\n');
run(
  process.execPath,
  [localBin('typescript', 'bin/tsc'), '-p', buildConfig, '--watch', '--preserveWatchOutput'],
  'tsc',
);

// 2. Restart the server whenever the output changes. `node --watch` handles the
//    restart itself, so it can be started immediately: the first run may fail
//    with a missing entry point, and `--watch` restarts once tsc emits it.
if (!existsSync(entryPoint)) {
  process.stdout.write(
    '[dev] dist/main.js does not exist yet; the server will start after the first build\n',
  );
}
run(process.execPath, ['--watch', entryPoint], 'server');
