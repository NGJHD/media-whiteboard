# The Check-for-Update button

How to give a self-contained Windows app a working **Check for updates** button
that pulls its own new version off GitHub Releases and replaces itself.

Written after building it twice — once in C#/WPF (MovieCatelogSoftware, two
files) and once in Electron (Video Trim & Crop, a whole folder). The workflow
is identical; only the "what gets replaced" step differs.

**To reuse this: read the whole file, then work through §6 (the checklist).**
The traps in §4 are the entire value here — every one of them cost a build
cycle to find, and four of the five only show up in a *packaged* app.

---

## 1. The workflow

Nine steps. Nothing clever, and every failure leaves the old install running.

```
  1. User clicks "Check for updates"
        |
  2. GET https://api.github.com/repos/<owner>/<repo>/releases/latest
        |
  3. Parse tag_name ("v1.2.0") -> 1.2.0, compare with the running version
        |
        +-- not newer --> "Version 1.1.0 is the latest."  DONE
        |
  4. Pick the .zip asset, show "Version 1.2.0 is available (248 MB)"
        |
  5. User clicks Update
        |
  6. Is the install folder writable?  no --> explain, change nothing.  DONE
        |
  7. Download the zip to a staging folder in %TEMP%, with a progress bar
        |
  8. Unpack it. Verify: the exe is there, and its version == the tag
        |     (mismatch --> stop, change nothing)
        |
  9. Write a .cmd script, launch it, quit the app.
     The script waits for the exe to unlock, copies the new files over
     the install folder, and starts the app again.
```

The app never overwrites itself. It can't — Windows holds a running exe open.
That is the only reason step 9 needs a script at all.

---

## 2. What the release has to look like

The updater is only as good as the release it reads. Three rules:

| | |
| --- | --- |
| **Tag** | `v<version>`, matching the version inside the app exactly. `v1.2.0` for version `1.2.0`. |
| **Asset** | Exactly one `.zip`, attached to the release. Nothing else is looked at. |
| **Publish** | A real published release, not a draft. `/releases/latest` skips drafts and pre-releases. |

If the app is versioned in `package.json` (Electron) or `AssemblyVersion` (C#),
that is the number the tag has to match. Step 8 enforces it, so a mismatch is a
failed update rather than a silent downgrade loop.

Anonymous GitHub API calls are rate limited to **60/hour per IP**. A button
nobody can press that fast will never see it, so no token is needed — and one
must not be shipped in the app anyway.

---

## 3. The pieces to write

Four files. Names are from the Electron app; adapt as needed.

| File | What is in it |
| --- | --- |
| `src/shared/about.js` | App name, author, `owner/repo`, the asset-name suffix. **The only file that changes per app.** |
| `src/shared/version.js` | `parseVersion` / `compareVersions` / `isNewer` / `pickReleaseAsset`. Pure, no Electron, no fs — so the test script can exercise it. |
| `src/main/updater.js` | Everything with a side effect: fetch, download, unpack, verify, the .cmd script. |
| `src/renderer/.../AboutDialog.jsx` | The dialog. Name, version, repo link, the button, a progress bar. |

Plus wiring: five IPC channels (`update:about`, `update:check`, `update:install`,
`update:cancel`, `update:open-link`) and one event (`update:progress`).

---

## 4. The five traps

Every one of these is real. Four only appear in a packaged build.

### 4.1 Node will not spawn a `.cmd` — `spawn EINVAL`

Since the CVE-2024-27980 fix (Node 18.20.2 / 20.12.2 / 21.7.3 and later),
`spawn()` refuses a `.bat` or `.cmd` as the executable. It fails at the very
last step, after the whole download, which is a miserable place to find out.

```js
// WRONG — throws EINVAL
spawn(scriptPath, [], { detached: true });

// RIGHT — cmd.exe is a real exe, the script stays a separate argv entry
spawn(process.env.ComSpec || 'cmd.exe', ['/c', scriptPath], {
  detached: true, stdio: 'ignore', windowsHide: true,
});
```

Never `shell: true` with an interpolated path — that is the vulnerability the
fix exists for. Keep the path as its own array element.

### 4.2 Do not wait with `tasklist | find`

The obvious way to wait for the app to exit is:

```bat
tasklist /FI "PID eq 1234" /NH | find /I "MyApp.exe" >nul
```

It works interactively and **hangs** when launched detached from a dying parent:
`find.exe` sits forever on its end of the pipe, the copy never runs, and a
stray console window is left on the desktop. Seen, reproduced, twice.

Wait on the *file lock* instead. That is the real precondition anyway — the exe
stays locked a moment longer than the process lives while antivirus lets go —
and it needs no pipe:

```bat
:waitloop
2>nul (>>"%EXE%" call ) && goto exited
set /a TRIES+=1
if %TRIES% GEQ 60 goto restart
ping -n 2 127.0.0.1 >nul
goto waitloop
```

`>>"%EXE%" call` opens the exe for append and runs a no-op. It writes zero
bytes and leaves the file size unchanged; it just fails when the file is
locked. Verified both ways before trusting it.

### 4.3 Unzip without a dependency

Windows 10 1803 and later ship **bsdtar** as `%SystemRoot%\System32\tar.exe`,
and it reads zip perfectly well:

```js
spawn(path.join(process.env.SystemRoot, 'System32', 'tar.exe'),
      ['-xf', zipPath, '-C', destination]);
```

Far quicker than `Expand-Archive`, which is the fallback for anything older.
Do not add a zip library for this.

Note `tar.exe` on the PATH may be **GNU tar** (Git for Windows ships one) which
cannot read zip. Always use the absolute System32 path.

### 4.4 Copy with robocopy, not xcopy

For a folder-shaped app:

```bat
robocopy "%READY%" "%TARGET%" /E /R:3 /W:2 /NFL /NDL /NJH /NJS /NP >>"%LOG%" 2>&1
if errorlevel 8 ( echo failed >>"%LOG%" )
```

- It **retries** a locked file instead of giving up (`/R:3 /W:2`).
- It **skips files whose size and timestamp already match** — so the 290 MB of
  unchanged FFmpeg binaries in this app are not copied at all. A 250 MB update
  applied in **3 seconds**.
- **Exit codes 0–7 are success.** `if errorlevel 8` is the failure test; a
  plain `if errorlevel 1` would report every successful copy as a failure.
- **No `/MIR`.** Mirroring deletes anything in the user's folder that isn't in
  the release. Not worth the megabytes.

### 4.5 Verify the download before trusting it

Check the unpacked folder actually contains the app, and that its version is
the one the tag claimed. For Electron, read `version` straight out of
`resources/app.asar` — no library needed, the header is JSON:

```js
// [0..3] = 4, [4..7] = pickle payload size, [8..11] = string len,
// [12..15] = JSON length, then the JSON directory. File data starts at
// 8 + payloadSize, and each entry carries its own offset and size.
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const dataStart = 8 + head.readUInt32LE(4);
const json = /* read head.readUInt32LE(12) bytes at offset 16 */;
const entry = JSON.parse(json).files['package.json'];
// read entry.size bytes at dataStart + Number(entry.offset) -> JSON -> .version
```

For a C#/WPF app the equivalent is one line:
`FileVersionInfo.GetVersionInfo(exePath)`.

Treat "cannot read it" as unknown and carry on; treat "read it and it disagrees"
as a hard stop.

---

## 5. Details that are easy to get wrong

**Compare versions numerically.** `"1.10.0" > "1.9.0"` is false as strings.
Parse to a triple. Strip a leading `v`. An unparseable tag must answer *not
newer* — never offer an update you cannot reason about.

**Bake paths into the script, don't pass them as arguments.** The install
folder can be a mapped drive with spaces in it. `set "TARGET=C:\Program Files\X"`
inside the script has no quoting left to get wrong.

**Only delete a staging folder you created.** The script ends with
`rd /s /q "%STAGE%"`. Check the folder name carries your prefix before writing
that line — pointed anywhere else it takes a real folder with it.

**Sweep abandoned staging folders.** A machine that loses power mid-update
leaves a whole unpacked app in `%TEMP%`. Sweep anything with your prefix older
than a day, every time the user checks. The `.cmd` cannot delete itself, so it
gets swept the same way.

**Refuse to install in a dev run.** `app.isPackaged === false` means the exe is
`node_modules/electron/dist/electron.exe`. Check *works* in dev; install must
say so and stop.

**Check the folder is writable before the download,** not after. An app
unzipped under `Program Files` cannot replace itself, and finding that out
after 250 MB is rude.

**Make the download cancellable** (`AbortController`), and hide the Cancel
button once unpacking starts — there is nothing left to abort, so a button
there would be lying.

**Show bytes, not just a percentage.** "48.2 MB of 248.8 MB" tells the user
whether it is stuck. A bare spinner does not.

**Restrict `openExternal`.** The renderer may only send people to this app's own
GitHub pages; the main process re-checks the URL prefix. A general-purpose
"open any URL" bridge is a hole worth not opening.

**A console window flashes** while the script runs. `detached: true` implies
DETACHED_PROCESS, which beats `windowsHide`, so the child gets its own console.
Give it `title Updating <App>` so it reads as intentional for the second or
two it exists.

---

## 6. Checklist for a new app

1. Copy `src/shared/version.js` unchanged.
2. Copy `src/shared/about.js`, change four values: `appName`, `author`, `repo`
   (`owner/name`), `assetSuffix` (must match the build's `artifactName`).
3. Copy `src/main/updater.js`. Change, if the app is shaped differently:
   - `STAGING_PREFIX`
   - `verifyUnpacked()` — which files prove this is the app
   - `readAsarVersion()` — only right for Electron
4. Copy `AboutDialog.jsx`, restyle to the app's own look.
5. Add the five IPC channels, the preload methods, and the main handlers.
6. Put the About entry point somewhere reachable **in every state the app can
   be in** — see §7.
7. Add the version tests to whatever the project's test script is.
8. Test it for real — §8. Do not ship it untested; §4 exists because four of
   those five only fail in a packaged build.

---

## 7. Where the button goes

Two rules, both learned the boring way:

- **About must be reachable from every state**, including the empty one. In
  this app the left rail only exists once a video is loaded, so the empty
  drop-zone needed its own About link. One entry point looked fine right up
  until the app had nothing loaded.
- **Low-key, bottom-left, out of the workflow.** Pinned with `mt-auto` rather
  than absolute positioning, so it sits below whatever the last section is.

---

## 8. Testing it properly

The only test that means anything is a packaged build updating itself off the
real GitHub release. It takes about ten minutes.

```bash
# 1. Claim to be older than the published release
#    package.json:  "version": "0.9.0"

# 2. Package (no zip needed — --dir is much faster)
npm run pack

# 3. Copy the build to a scratch folder, so nothing real is at risk
robocopy "release/win-unpacked" "<scratch>/updtest" /E

# 4. Run <scratch>/updtest/<App>.exe, click About -> Check -> Update

# 5. Confirm:
#      - the progress bar moves and shows bytes
#      - the app closes and comes back on its own
#      - (Get-Item exe).VersionInfo.ProductVersion is now the release version
#      - <install>/update.log says "update applied"
#      - %TEMP% has no vtc-update-* folder left (the .cmd is expected)

# 6. Delete the scratch folder, restore the real version in package.json
```

The window can be driven from PowerShell without any test framework —
`SetForegroundWindow` + `SetCursorPos` + `mouse_event` to click, and
`Graphics.CopyFromScreen` over `GetWindowRect` to screenshot. Match the process
by **name**, not window title: a stray `find.exe` console from trap §4.2 has the
app's exe name in its title and will steal every click.

Also worth exercising once each:

| Case | Expected |
| --- | --- |
| Already on the latest | "Version X is the latest." No download offered. |
| Network off | "Could not reach GitHub. Check the network connection." |
| Repo with no release | "No release has been published yet." |
| Cancel mid-download | Back to the offer, staging folder deleted. |
| Install folder read-only | Refused **before** downloading, with the path. |
| Dev run | Check works; install says it's a development build. |

---

## 9. What this deliberately is not

- **Not automatic.** Nothing checks on launch, nothing nags. The user presses a
  button. An app that quietly replaces itself is an app that breaks in the
  middle of someone's work.
- **Not delta updates.** The whole zip is downloaded every time — 250 MB here,
  because FFmpeg is bundled. robocopy makes the *apply* nearly free, but the
  download is not. If that ever matters, the answer is a separate small zip for
  the app files, not a patch format.
- **Not signed.** Nothing verifies the download beyond HTTPS to github.com and
  the version check. That is the same trust as clicking the release link by
  hand, which is what this replaces.
- **Not electron-updater.** That wants an installer target (NSIS), a latest.yml
  and code signing to work properly. These apps ship as a plain zip on purpose,
  and this is ~400 lines with no dependency.
