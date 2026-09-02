import { context as esbuildContext } from 'esbuild';
import { createServer } from 'vite';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { bundles, root } from './esbuild.config.mjs';

const server = await createServer();
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error('Vite dev server did not report a local URL');
server.printUrls();

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let shuttingDown = false;

function launch() {
  const proc = spawn(electronPath, [path.join(root, 'dist/main/index.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  child = proc;

  proc.on('exit', (code) => {
    // Only the process we currently consider live can end the dev session. A
    // process replaced by a restart exits on purpose and must be ignored.
    if (proc !== child || shuttingDown) return;
    void shutdown(code ?? 0);
  });
}

/**
 * Restarts are debounced and serialized. Main and preload are separate esbuild
 * contexts, so one edit can finish two builds; without this they would each
 * launch an Electron, the second would lose the single-instance lock and exit,
 * and that exit would look like the user quitting.
 */
let restartTimer = null;
let restartChain = Promise.resolve();

function scheduleRestart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartChain = restartChain.then(async () => {
      if (shuttingDown) return;
      const old = child;
      child = null; // its exit is now expected
      if (old && old.exitCode === null) {
        old.kill();
        await once(old, 'exit').catch(() => {});
      }
      if (!shuttingDown) launch();
    });
  }, 120);
}

/**
 * Renderer edits hot-reload through Vite. Main and preload edits cannot — they
 * live in another process — so rebuild and relaunch Electron instead.
 */
let outstanding = bundles('development').length;
let onInitialBuilds;
const initialBuilds = new Promise((resolve) => {
  onInitialBuilds = resolve;
});

function relaunchPlugin() {
  // watch() performs its own first build. That one produced the app we are about
  // to launch, so it must not trigger a relaunch of it.
  let sawInitial = false;
  return {
    name: 'relaunch-electron',
    setup(build) {
      build.onEnd((result) => {
        if (!sawInitial) {
          sawInitial = true;
          if (result.errors.length === 0 && --outstanding === 0) onInitialBuilds();
          return;
        }
        if (result.errors.length > 0) return;
        scheduleRestart();
      });
    },
  };
}

const contexts = await Promise.all(
  bundles('development').map((cfg) =>
    esbuildContext({ ...cfg, plugins: [relaunchPlugin()], logLevel: 'warning' }),
  ),
);

await Promise.all(contexts.map((c) => c.watch()));
await initialBuilds;
launch();

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  if (child && child.exitCode === null) child.kill();
  await Promise.all(contexts.map((c) => c.dispose()));
  await server.close();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
