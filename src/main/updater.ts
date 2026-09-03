import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_NAME, ASSET_SUFFIX, LATEST_RELEASE_API } from '../shared/about';
import type {
  UpdateAvailable,
  UpdateCheck,
  UpdateInstallResult,
  UpdateProgress,
} from '../shared/ipc';
import { isNewer, pickReleaseAsset, sameVersion, type ReleaseAsset } from '../shared/version';

/**
 * The "Check for updates" button's main-process half (UPDATE_BUTTON.md).
 *
 * Everything with a side effect lives here: the GitHub call, the download, the
 * unpack, the verification, and the .cmd script that does the one thing the app
 * cannot do for itself — replace the folder it is running out of. Windows holds
 * a running exe open, so the last step is always "write a script, launch it,
 * quit".
 *
 * Nothing here is automatic. Nothing checks on launch. Every failure path leaves
 * the existing install untouched.
 */

/** Both the staging folder and the .cmd carry it, so the sweep finds both. */
const STAGING_PREFIX = 'mw-update-';

/** Abandoned staging from a machine that lost power mid-update (§5). */
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

const CHECK_TIMEOUT_MS = 15_000;

/**
 * In-flight download. `cancelUpdate` aborts this and nothing else — once
 * unpacking starts there is nothing left to abort (§5), which is why the dialog
 * hides Cancel at that point rather than leaving a button there that lies.
 */
let downloadAbort: AbortController | null = null;

/* -------------------------------------------------------------------------- */
/* Version                                                                    */
/* -------------------------------------------------------------------------- */

let cachedVersion: string | null = null;

/**
 * The version this build claims to be — the number the release tag has to match
 * (UPDATE_BUTTON.md §2).
 *
 * Packaged, that is `app.getVersion()`, which reads package.json out of the
 * asar. In a dev run there is no package.json beside the loaded main script, so
 * Electron answers with *its own* version (44.x) — which would compare as newer
 * than every release and make the check permanently report "latest". Reading the
 * project's package.json keeps a dev check meaningful, which is the only thing
 * §5 allows a dev run to do.
 */
export function resolveAppVersion(appFolder: string): string {
  if (cachedVersion) return cachedVersion;
  if (app.isPackaged) {
    cachedVersion = app.getVersion();
    return cachedVersion;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appFolder, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : app.getVersion();
  } catch {
    cachedVersion = app.getVersion();
  }
  return cachedVersion;
}

/* -------------------------------------------------------------------------- */
/* Check                                                                      */
/* -------------------------------------------------------------------------- */

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  assets?: { name?: string; browser_download_url?: string; size?: number }[];
}

export async function checkForUpdate(appFolder: string): Promise<UpdateCheck> {
  const currentVersion = resolveAppVersion(appFolder);

  // Every check is also a chance to tidy up after one that never finished.
  void sweepStaging();

  let release: GithubRelease;
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub rejects an anonymous API call that does not send one.
        'User-Agent': `${APP_NAME.replace(/\s+/g, '')}/${currentVersion}`,
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });

    if (response.status === 404) {
      return { status: 'error', message: 'No release has been published yet.' };
    }
    if (response.status === 403 || response.status === 429) {
      // 60 anonymous calls an hour, per IP. A button nobody can press that fast
      // should never see this, but shared IPs exist.
      return {
        status: 'error',
        message: 'GitHub is rate limiting this network. Try again in a little while.',
      };
    }
    if (!response.ok) {
      return {
        status: 'error',
        message: `GitHub replied ${response.status} ${response.statusText}.`,
      };
    }
    release = (await response.json()) as GithubRelease;
  } catch {
    return { status: 'error', message: 'Could not reach GitHub. Check the network connection.' };
  }

  const tag = release.tag_name ?? '';

  // An unparseable tag answers *not newer* (§5): never offer an update that
  // cannot be reasoned about.
  if (!isNewer(tag, currentVersion)) {
    return { status: 'latest', currentVersion, latestVersion: tag || currentVersion };
  }

  const assets: ReleaseAsset[] = (release.assets ?? [])
    .filter(
      (a): a is { name: string; browser_download_url: string; size: number } =>
        typeof a?.name === 'string' &&
        typeof a.browser_download_url === 'string' &&
        typeof a.size === 'number',
    )
    .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));

  const asset = pickReleaseAsset(assets, ASSET_SUFFIX);
  if (!asset) {
    return {
      status: 'error',
      message: `Release ${tag} has no single ${ASSET_SUFFIX} asset to download. Get it from GitHub by hand.`,
    };
  }

  return {
    status: 'available',
    currentVersion,
    latestVersion: tag,
    assetName: asset.name,
    assetUrl: asset.url,
    assetBytes: asset.size,
    releaseUrl: release.html_url ?? '',
  };
}

/* -------------------------------------------------------------------------- */
/* Install                                                                    */
/* -------------------------------------------------------------------------- */

export function cancelUpdate(): void {
  downloadAbort?.abort();
}

export async function installUpdate(
  target: UpdateAvailable,
  onProgress: (progress: UpdateProgress) => void,
): Promise<UpdateInstallResult> {
  // §5: the exe in a dev run is node_modules/electron/dist/electron.exe.
  // Checking works in dev; installing has to say so and stop.
  if (!app.isPackaged) {
    return { ok: false, cancelled: false, error: 'This is a development build. Updates can only be installed from a packaged app.' };
  }

  const exePath = app.getPath('exe');
  const installDir = path.dirname(exePath);
  const exeName = path.basename(exePath);

  // §5: check writability *before* the download. An app unzipped under Program
  // Files cannot replace itself, and 250 MB is a rude way to find that out.
  const writable = await probeWritable(installDir);
  if (writable !== true) {
    return {
      ok: false,
      cancelled: false,
      error: `${installDir} is not writable (${writable}). Move the app somewhere else, or update it by hand.`,
    };
  }

  // The URL came back from our own API call, but it crosses IPC on the way to
  // here, so it is re-checked rather than trusted.
  if (!/^https:\/\/(github\.com|[a-z0-9-]+\.githubusercontent\.com)\//.test(target.assetUrl)) {
    return { ok: false, cancelled: false, error: 'The release asset is not hosted on GitHub. Refusing to download it.' };
  }

  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), STAGING_PREFIX));
  const zipPath = path.join(stage, 'update.zip');
  const unpackDir = path.join(stage, 'ready');

  /** Every failure path deletes its own staging and changes nothing else. */
  const fail = (message: string): UpdateInstallResult => {
    void removeStage(stage);
    return { ok: false, cancelled: false, error: message };
  };

  try {
    /* -- download ---------------------------------------------------------- */
    downloadAbort = new AbortController();

    const response = await fetch(target.assetUrl, {
      headers: { 'User-Agent': `${APP_NAME.replace(/\s+/g, '')}/${target.currentVersion}` },
      signal: downloadAbort.signal,
    });
    if (!response.ok || !response.body) {
      return fail(`Download failed: GitHub replied ${response.status} ${response.statusText}.`);
    }

    const totalBytes = Number(response.headers.get('content-length')) || target.assetBytes || 0;
    let receivedBytes = 0;
    let lastEmit = 0;

    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        receivedBytes += chunk.length;
        // §5 wants bytes shown, not just a percentage — but not one IPC message
        // per chunk either.
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          onProgress({ phase: 'downloading', receivedBytes, totalBytes });
        }
        done(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body as never),
      counter,
      fs.createWriteStream(zipPath),
    );
    onProgress({ phase: 'downloading', receivedBytes, totalBytes });
    downloadAbort = null;

    /* -- unpack ------------------------------------------------------------ */
    onProgress({ phase: 'unpacking', receivedBytes: 0, totalBytes: 0 });
    await fsp.mkdir(unpackDir, { recursive: true });
    const unpacked = await unzip(zipPath, unpackDir);
    if (unpacked !== true) return fail(`Could not unpack the download: ${unpacked}`);

    /* -- verify ------------------------------------------------------------ */
    onProgress({ phase: 'verifying', receivedBytes: 0, totalBytes: 0 });
    const appRoot = findAppRoot(unpackDir, exeName);
    if (!appRoot) {
      return fail(`The download does not look like ${APP_NAME}: ${exeName} was not in it.`);
    }

    // §4.5: "cannot read it" is unknown and carries on; "read it and it
    // disagrees" is a hard stop, because that is a silent downgrade loop.
    const unpackedVersion = readAsarVersion(path.join(appRoot, 'resources', 'app.asar'));
    if (unpackedVersion !== null && !sameVersion(unpackedVersion, target.latestVersion)) {
      return fail(
        `The download is version ${unpackedVersion} but the release is tagged ${target.latestVersion}. Nothing has been changed.`,
      );
    }

    /* -- apply ------------------------------------------------------------- */
    const scriptPath = await writeApplyScript({
      stage,
      readyDir: appRoot,
      installDir,
      exePath,
      logPath: path.join(installDir, 'update.log'),
      version: target.latestVersion,
    });

    onProgress({ phase: 'applying', receivedBytes: 0, totalBytes: 0 });

    // §4.1: spawn() has refused a .cmd as the executable since the
    // CVE-2024-27980 fix (Node 18.20.2 / 20.12.2 / 21.7.3). cmd.exe is a real
    // exe and the script stays its own argv entry — never `shell: true` with an
    // interpolated path, which is the hole that fix exists for.
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: os.tmpdir(),
    });
    child.unref();

    // The script is already waiting on this exe's file lock. Let the reply reach
    // the renderer, then go.
    setTimeout(() => app.quit(), 250);
    return { ok: true, cancelled: false, error: null };
  } catch (err) {
    if (isAbort(err)) {
      await removeStage(stage);
      return { ok: false, cancelled: true, error: null };
    }
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    downloadAbort = null;
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

async function probeWritable(dir: string): Promise<true | string> {
  const probe = path.join(dir, `.update-probe-${process.pid}`);
  try {
    await fsp.writeFile(probe, '');
    await fsp.unlink(probe);
    return true;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * §4.3: Windows 10 1803 and later ship bsdtar as System32\tar.exe, and it reads
 * zip perfectly well — far quicker than Expand-Archive, and no zip library.
 *
 * The absolute path matters: a `tar` on PATH may be the GNU tar that Git for
 * Windows ships, which cannot read zip at all.
 */
function unzip(zipPath: string, destination: string): Promise<true | string> {
  const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

  if (fs.existsSync(bsdtar)) {
    return run(bsdtar, ['-xf', zipPath, '-C', destination]).then((result) =>
      result === true ? true : expandArchive(zipPath, destination),
    );
  }
  return expandArchive(zipPath, destination);
}

/** The pre-1803 fallback. Slow, but it is there. */
function expandArchive(zipPath: string, destination: string): Promise<true | string> {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destination)} -Force`,
  ]);
}

function run(exe: string, args: string[]): Promise<true | string> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (err) => resolve(err.message));
    child.on('close', (code) =>
      resolve(code === 0 ? true : `${path.basename(exe)} exited ${code}. ${stderr.trim()}`),
    );
  });
}

/**
 * The zip electron-builder produces is flat, so the app root is the unpack
 * directory itself — but a zip built any other way may wrap everything in one
 * folder, and allowing for that is two lines.
 */
function findAppRoot(dir: string, exeName: string): string | null {
  if (fs.existsSync(path.join(dir, exeName))) return dir;

  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = children.filter((c) => c.isDirectory());
  if (dirs.length !== 1) return null;

  const nested = path.join(dir, dirs[0]!.name);
  return fs.existsSync(path.join(nested, exeName)) ? nested : null;
}

/**
 * §4.5: the version inside the download, read straight out of app.asar. The
 * header is JSON and needs no library:
 *
 *   [0..3]   4           [4..7]   pickle payload size
 *   [8..11]  string len  [12..15] JSON length, then the JSON directory
 *
 * File data starts at 8 + payloadSize, and each entry carries its own offset and
 * size. Any failure answers null — unknown, which is not the same as
 * disagreement and must not stop the update.
 */
function readAsarVersion(asarPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(asarPath, 'r');

    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) return null;
    const payloadSize = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) return null;

    const jsonBuf = Buffer.alloc(jsonLength);
    fs.readSync(fd, jsonBuf, 0, jsonLength, 16);
    // The pickle is padded to a 4-byte boundary, so the tail can carry NULs.
    const directory = JSON.parse(jsonBuf.toString('utf8').replace(/\0+$/, '')) as {
      files?: Record<string, { offset?: string; size?: number }>;
    };

    const entry = directory.files?.['package.json'];
    if (!entry || typeof entry.size !== 'number' || entry.size <= 0) return null;

    const pkgBuf = Buffer.alloc(entry.size);
    fs.readSync(fd, pkgBuf, 0, entry.size, 8 + payloadSize + Number(entry.offset ?? 0));
    const version = (JSON.parse(pkgBuf.toString('utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful left to do about it */
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The .cmd script                                                            */
/* -------------------------------------------------------------------------- */

interface ScriptSpec {
  stage: string;
  readyDir: string;
  installDir: string;
  exePath: string;
  logPath: string;
  version: string;
}

/**
 * Paths are baked in with `set`, never passed as arguments (§5): the install
 * folder can be a mapped drive with spaces in it, and inside the script there is
 * no quoting left to get wrong.
 *
 * The script lives *beside* the staging folder rather than inside it, so its
 * last line can delete that folder outright. A running .cmd cannot delete
 * itself, so it is left behind and swept by prefix on a later check.
 */
async function writeApplyScript(spec: ScriptSpec): Promise<string> {
  // §5: only ever delete a folder this app created. Checked here, because the
  // `rd /s /q` below is the line that would otherwise take a real folder with it.
  if (!path.basename(spec.stage).startsWith(STAGING_PREFIX)) {
    throw new Error(`refusing to write a cleanup script for ${spec.stage}`);
  }

  const scriptPath = path.join(path.dirname(spec.stage), `${path.basename(spec.stage)}.cmd`);

  const script = [
    '@echo off',
    // §5: `detached: true` implies DETACHED_PROCESS, which beats windowsHide, so
    // this gets its own console for a second or two. A title makes it read as
    // intentional rather than as something that should be killed.
    `title Updating ${APP_NAME}`,
    `set "EXE=${spec.exePath}"`,
    `set "TARGET=${spec.installDir}"`,
    `set "READY=${spec.readyDir}"`,
    `set "STAGE=${spec.stage}"`,
    `set "LOG=${spec.logPath}"`,
    'set /a TRIES=0',
    '',
    `echo [%DATE% %TIME%] applying ${spec.version}>>"%LOG%"`,
    '',
    // §4.2: wait on the *file lock*, never on `tasklist | find`. Piped from a
    // detached, dying parent, find.exe sits on its end of the pipe forever: the
    // copy never runs and a stray console is left on the desktop. The lock is
    // the real precondition anyway — the exe stays open a moment longer than the
    // process lives, while antivirus lets go. `>>"%EXE%" call` opens the exe for
    // append and runs a no-op: zero bytes written, size unchanged, and it simply
    // fails while the file is locked.
    ':waitloop',
    '2>nul (>>"%EXE%" call ) && goto exited',
    'set /a TRIES+=1',
    'if %TRIES% GEQ 60 goto giveup',
    'ping -n 2 127.0.0.1 >nul',
    'goto waitloop',
    '',
    ':giveup',
    'echo [%DATE% %TIME%] update aborted: exe still locked after 60s>>"%LOG%"',
    'goto restart',
    '',
    ':exited',
    // §4.4: robocopy, not xcopy. It retries a locked file (/R:3 /W:2), and it
    // skips files whose size and timestamp already match — so the ~180 MB of
    // unchanged ffmpeg binaries are not copied at all. No /MIR: mirroring would
    // delete the user's own data/ and cache/ folders beside the exe.
    'robocopy "%READY%" "%TARGET%" /E /R:3 /W:2 /NFL /NDL /NJH /NJS /NP >>"%LOG%" 2>&1',
    // Exit codes 0-7 are success. A plain `if errorlevel 1` would report every
    // successful copy as a failure.
    'if errorlevel 8 (',
    '  echo [%DATE% %TIME%] update failed: robocopy errorlevel %ERRORLEVEL%>>"%LOG%"',
    ') else (',
    '  echo [%DATE% %TIME%] update applied>>"%LOG%"',
    ')',
    '',
    ':restart',
    'start "" /D "%TARGET%" "%EXE%"',
    'rd /s /q "%STAGE%"',
    '',
  ].join('\r\n');

  await fsp.writeFile(scriptPath, script, 'utf8');
  return scriptPath;
}

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

async function removeStage(stage: string): Promise<void> {
  if (!path.basename(stage).startsWith(STAGING_PREFIX)) return;
  await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
}

/**
 * §5: a machine that loses power mid-update leaves a whole unpacked app in
 * %TEMP%. Sweep anything carrying the prefix that is more than a day old, every
 * time the user checks — that also collects the .cmd script, which cannot delete
 * itself.
 */
export async function sweepStaging(): Promise<void> {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = await fsp.readdir(tmp);
  } catch {
    return;
  }

  const cutoff = Date.now() - SWEEP_AGE_MS;
  for (const name of entries) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const full = path.join(tmp, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.mtimeMs < cutoff) await fsp.rm(full, { recursive: true, force: true });
    } catch {
      // In use, or already gone. Either way it is not this run's problem.
    }
  }
}
