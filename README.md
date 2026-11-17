# Kaggle Remote Browser

Control a headless Chromium browser running on an NVIDIA T4 in Kaggle from your local computer. Use it for remote browser automation, screenshots, and WebGPU testing when your local machine has no suitable GPU.

Browser commands travel through an authenticated Chrome DevTools Protocol (CDP) connection over a temporary Cloudflare tunnel. Rendering and GPU computation run in Kaggle; screenshots and test reports are saved locally.

## Requirements

- A Kaggle account with access to a T4 GPU notebook and internet access.
- Local Node.js with support for `--env-file` (Node.js 22 or newer) and npm on `PATH`.
- Global Playwright installed under the npm installation used to run the helper.
- A target website reachable from Kaggle.

No local GPU or local Chromium installation is required.

## Installation

### 1. Get the project

Download or clone this repository, then open a terminal in its root directory. The relevant files are:

```text
notebook/kaggle-browser.ipynb                  Kaggle setup and browser server
notebook/colab-browser.ipynb                   Experimental Colab T4 version
skills/kaggle-remote-browser/SKILL.md          Agent usage instructions
skills/kaggle-remote-browser/scripts/browser.mjs
                                             Local connection and test helper
skills/kaggle-remote-browser/scripts/record.mjs
                                             Video recording command
skills/kaggle-remote-browser/scripts/recording.mjs
                                             Reusable CDP video recorder
```

### 2. Install Playwright globally

Run on your local computer:

```sh
npm install --global playwright
```

The helper queries `npm root --global` and loads Playwright directly from that directory. You do not need to configure `NODE_PATH` or install Playwright in each project. If the global package is missing, the helper stops with a warning and installation instructions; it does not install anything automatically.

Do not run `playwright install` locally for this workflow. The notebook installs its own remote Chromium browser.

### 3. Start the Kaggle browser

Choose the automated upload below or run the notebook manually.

#### Automated upload and run

Install the official Kaggle CLI (requires Python 3.11+), then authenticate:

```sh
uv tool install --with six kaggle
kaggle auth login
```

The explicit `six` dependency avoids an import error observed with Kaggle CLI
2.2.5 in an isolated uv installation. If you already installed Kaggle with uv,
rerun the installation command above to add the dependency.

Alternatively, install it with `pipx install kaggle`; if it reports a missing
`six` module, run `pipx inject kaggle six`. Ensure the `kaggle`
command is on `PATH`.

Preview the upload without creating or starting a notebook:

```sh
node scripts/start-kaggle.mjs --dry-run
```

Upload and start the notebook:

```sh
node scripts/start-kaggle.mjs
```

The launcher detects your authenticated Kaggle username with `kaggle config view`.
Use `--owner YOUR-KAGGLE-USERNAME` to override it. With an explicit owner,
`--dry-run` skips account detection; otherwise the CLI may contact Kaggle to
resolve authentication. Configuration output is captured without being printed.

The script uses the official CLI's API client to create or update
`YOUR-KAGGLE-USERNAME/kaggle-remote-browser` and request execution. It sets the
notebook to private, enables internet, and selects `NvidiaTeslaT4`. It clears
saved cell outputs in the uploaded copy and leaves the source notebook unchanged.
An existing notebook with the same owner and slug will be updated. Runs consume
Kaggle GPU/runtime quota and depend on your account's accelerator access.

Optional flags: `--slug my-browser` changes the notebook name, and
`--minutes 60` changes the browser session duration (1–720 minutes).

For a headed browser on a virtual Xvfb display (for example, when investigating
headless rendering or screenshot issues), start a new run with:

```sh
node scripts/start-kaggle.mjs --headed
```

Use the same `--slug` as your existing notebook if it has a custom name. This
updates that notebook and requests a new run. It does not change an already
running browser in place. Wait for GPU and public CDP verification in the new
run's logs, then replace both connection values in `.env.local` with the new
values. The local `browser.mjs` client works with either browser mode.

For manual Kaggle or Colab execution, rerun the updated setup cell (which installs
Xvfb), stop any existing server cell, then use this call in the server cell:

```python
await remote_browser(minutes=120, headed=True)
```

Headed mode starts Xvfb with a dynamically allocated display, sets Chromium's
`DISPLAY`, and omits the headless flag. Xvfb is stopped with the notebook-owned
browser processes during cleanup. Inspect `xvfb.log` in the notebook's working
directory if display startup fails. The Kaggle headed session passed a live
CDP connection, NVIDIA WebGPU initialization, and screenshot rendering check;
the Colab headed version remains unverified. Xvfb provides a virtual screen rather
than a desktop viewer; use CDP screenshots or screencasting for visual evidence.
Both modes retain `--disable-vulkan-surface` so Vulkan does not require a native
window-system surface. If WebGPU device creation fails, compare headless mode
and inspect `gpu-failure.json`, `chrome-system-info.json`, `chrome-gpu.txt`, and
`chrome.log`; an instance-lifetime error alone does not identify the root cause.

Check the latest run's status, retrieve its logs, or follow live output using the
launcher (your username is detected automatically):

```sh
node scripts/start-kaggle.mjs --status
node scripts/start-kaggle.mjs --logs
node scripts/start-kaggle.mjs --follow
```

These monitoring flags do not upload or start a notebook. Combine `--status
--logs` to show both, or `--status --follow` to show status before streaming logs.
Use the same `--slug` you used when starting a custom-named notebook; `--owner`
also works as an override. Press Ctrl+C to stop following logs; the remote
notebook continues running. Monitoring flags cannot be combined with `--dry-run`.

Status describes the latest submitted run (for example, queued, running,
complete, or errored). It does not confirm that the browser tunnel is ready and
does not monitor a separate interactive editor session.

Wait for `PASS: Public authenticated CDP connection verified.` Copy the printed
connection URL and token into `.env.local` as described in step 4. Execution logs
contain private browser credentials. A successful upload means the run was
requested; GPU initialization and tunnel readiness still need to succeed.

The launcher does not automatically download credentials or restart sessions.
For command details, see the official [Kaggle CLI notebook documentation](https://github.com/kaggle/kaggle-cli/blob/main/docs/kernels.md).

#### Manual notebook setup

1. Import [notebook/kaggle-browser.ipynb](notebook/kaggle-browser.ipynb) into Kaggle.
2. Confirm **Internet** is enabled and select an accelerator providing an **NVIDIA T4**. The notebook metadata requests GPU and internet, but confirm the actual session settings after import. Let the session restart after changing the accelerator, then run the cells from the beginning.
3. Run the first code cell and wait for `PASS: T4 Vulkan works through EGL.` It installs dependencies, extracts matching NVIDIA graphics libraries without replacing the host driver, and verifies Vulkan access.
4. Run the second code cell. It launches Chromium, verifies a real WebGPU compute result, and checks the public authenticated CDP connection.
5. Copy the `KAGGLE_CDP_URL` and `KAGGLE_CDP_TOKEN` values printed under `PRIVATE CONNECTION DETAILS`.
6. Leave the second cell running while you use the browser.

The second cell ends with:

```python
await remote_browser(minutes=120, headed=False)
```

This sets a two-hour session limit. The function accepts 1–720 minutes, subject to Kaggle's own runtime and quota limits. Interrupt the cell to stop the browser and tunnel. Restarting it generates a new connection URL and token.

### 4. Save connection credentials locally

Copy `.env.local.example` to `.env.local` in this repository's root directory
(`Copy-Item .env.local.example .env.local` in PowerShell), then edit the values:

```dotenv
KAGGLE_CDP_URL=wss://YOUR-TUNNEL.trycloudflare.com/devtools/browser/YOUR-BROWSER-ID
KAGGLE_CDP_TOKEN=YOUR-TOKEN
```

Replace both placeholders with the complete values from the notebook output.

Keep these values private: the token grants control of the remote browser.
The included `.gitignore` excludes local environment files and generated browser
results while keeping `.env.local.example` available for version control.
Clear notebook outputs before sharing the notebook.

### 5. Run the connection test

From this repository's root directory:

```sh
node --env-file=.env.local ./skills/kaggle-remote-browser/scripts/browser.mjs https://webgpu.studio/particle-simulator
```

You can replace the URL with another website reachable from Kaggle. The helper requires WebGPU to be available on the target origin, normally through HTTPS, and checks for a hardware NVIDIA adapter. It performs its own initialization probe, so a pass does not establish that the website itself uses WebGPU.

Results are written relative to your current directory:

```text
remote-browser-results/<timestamp>/
  report.json
  page.png       Screenshot when the check reaches the capture step
  failure.png    Best-effort screenshot on failure
```

The report includes browser version, detected GPU devices, WebGPU adapter details, page errors, console errors, and failed requests. A passing result verifies the connection and target-origin WebGPU initialization. Application behavior, visual correctness, and performance need additional assertions and inspection.

## Google Colab T4 version

An experimental Colab notebook is available at
[notebook/colab-browser.ipynb](notebook/colab-browser.ipynb). It uses the same
authenticated CDP server, T4 checks, and compute-readback verification as the
Kaggle notebook, with runtime files under `/content/webgpu-browser`.

Colab restricts remote control on free managed runtimes without a positive
compute-unit balance. Its FAQ says paid plans with a positive balance remove
those additional restrictions; other usage restrictions still apply. GPU types
and availability are not guaranteed. Review the
[Colab FAQ](https://research.google.com/colaboratory/faq.html) before using this
remote-control workflow.

1. Upload `notebook/colab-browser.ipynb` through Colab's **File → Upload notebook**.
2. Choose **Runtime → Change runtime type → T4 GPU**, if available, and connect.
3. Run the first code cell. It checks T4 hardware, installs dependencies, and
   configures Vulkan with isolated NVIDIA libraries matching the host driver.
4. Run the second code cell. Wait for successful GPU compute and public CDP
   verification, then leave that cell running.
5. Copy the printed `KAGGLE_CDP_URL` and `KAGGLE_CDP_TOKEN` into `.env.local`.
   These names are retained for client compatibility and point to Colab here.
6. Run the existing local helper:

```sh
node --env-file=.env.local ./skills/kaggle-remote-browser/scripts/browser.mjs https://webgpu.studio/particle-simulator
```

The server defaults to 120 minutes; edit `await remote_browser(minutes=120, headed=False)` in
the final code cell to change that. Colab may end the runtime sooner. Interrupt
the cell when finished, and clear credential-bearing output before sharing.
Runtime files are temporary; the notebook does not mount Google Drive.

This version has been checked locally for Python syntax and configuration, but
has not been run on a live Colab T4. The setup requires matching NVIDIA graphics
packages in the runtime's apt repositories. If those packages are unavailable,
it stops with a version diagnostic; do not install replacement host drivers.
`scripts/start-kaggle.mjs` manages Kaggle notebooks only; it does not upload,
start, or monitor Colab sessions.

### Upload to Colab through the Google Drive API

Use `scripts/upload-colab.py` to upload the notebook to Google Drive and print
a Colab editor link. This uses the Drive API rather than the Colab CLI's
`upload` command, which transfers a file to a running VM's filesystem.

#### Automated setup with Google Cloud CLI

This route uses Google's documented
[`gcloud auth login --enable-gdrive-access`](https://cloud.google.com/sdk/docs/authenticate)
flow, so you do not need to create your own OAuth consent screen, Desktop app
client, or `client-secret.json`. It requests Google Cloud and Google Drive access
through gcloud's consent flow, which is broader than the custom client's
`drive.file` scope. Review Google's permission prompt before granting access.

Install the Google Cloud CLI first. On Windows:

```sh
winget install --id Google.CloudSDK --exact
```

Reopen your terminal after installation. Choose a globally unique project ID
(6–30 lowercase letters, digits, or hyphens, starting with a letter and ending
with a letter or digit). Preview the setup, then run it:

```sh
uv run scripts/setup-colab.py --project YOUR-UNIQUE-PROJECT-ID --create-project --upload --dry-run
uv run scripts/setup-colab.py --project YOUR-UNIQUE-PROJECT-ID --create-project --upload
```

Replace `YOUR-UNIQUE-PROJECT-ID` with your chosen ID. The setup script opens
Google sign-in, requests Drive access, creates the project, enables Drive API,
and uploads the notebook. Account selection and consent still happen in your
browser. Project creation and API enablement require suitable account permissions
and may be restricted by your organization or quota. The script does not enable
billing or start a Colab runtime.

For an existing project, omit `--create-project`. To configure without uploading,
omit `--upload`. On later uploads:

```sh
uv run scripts/upload-colab.py --auth gcloud --project YOUR-PROJECT-ID
```

This uses gcloud's active account and credential storage; it does not create a
local `.colab-auth/token.json`. To choose another account and refresh Drive
consent, rerun the setup script without `--create-project`.

#### Alternative: custom desktop OAuth client

Use this route for the narrower `drive.file` scope. One-time setup:

1. Create or select a Google Cloud project and enable **Google Drive API**.
2. Configure the Google Auth platform's branding and audience. For a personal
   Google account, use an External audience and add your account as a test user
   if the app is in testing mode.
3. Add the scope `https://www.googleapis.com/auth/drive.file` in Data Access.
   This script requests per-file access rather than access to all Drive files.
4. Create an OAuth client of type **Desktop app** and download its JSON file.
5. Create `.colab-auth` in the repository root and save the downloaded file as
   `.colab-auth/client-secret.json`. This directory is excluded by `.gitignore`.

Google's [Drive Python quickstart](https://developers.google.com/workspace/drive/api/quickstart/python)
describes the Cloud project and OAuth client setup. The uploader follows the
documented [Drive file upload flow](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

Run locally with Python 3.11+ and uv. The script declares its dependencies, so
uv installs them into its managed environment:

```sh
uv run scripts/upload-colab.py --dry-run
uv run scripts/upload-colab.py
```

Dry run validates and previews the notebook without Google sign-in or API
calls (uv may download Python dependencies). The first upload opens Google
sign-in in your browser. Choose the account you use for Colab and grant the
requested access. The script caches login tokens in `.colab-auth/token.json`;
keep that directory private. Use `--reauth` to choose another account:

```sh
uv run scripts/upload-colab.py --reauth
```

Optional arguments: `--name my-browser.ipynb`, `--notebook path/to/notebook.ipynb`,
`--client-secrets path/to/client.json`, and `--token-file path/to/token.json`.
Store any custom credential/token paths outside version control as well.

Each upload creates a new notebook in your Drive root and prints
`https://colab.research.google.com/drive/FILE_ID`. It clears code-cell outputs
in the uploaded copy, leaves the local source unchanged, and makes no sharing
changes. It does not allocate a GPU or execute the notebook: open the link,
select a T4 runtime, and run the cells. Existing Drive files are not overwritten.

## Install the skill in another project

Copy the entire `skills/kaggle-remote-browser` directory into your target project's `.agents/skills/` directory:

```text
your-project/
  .env.local
  .agents/skills/kaggle-remote-browser/
    SKILL.md
    scripts/browser.mjs
    scripts/record.mjs
    scripts/recording.mjs
```

Store the connection credentials in that project's `.env.local`. Run from the target project's root:

```sh
node --env-file=.env.local ./.agents/skills/kaggle-remote-browser/scripts/browser.mjs https://webgpu.studio/particle-simulator
```

The global Playwright installation is shared across projects using the same npm installation.

## Custom browser automation

For ordinary websites or application-specific checks, import `openRemotePage` instead of running the WebGPU connection test. For example, save this as `remote-check.mjs` in the repository root:

```js
import { openRemotePage } from './skills/kaggle-remote-browser/scripts/browser.mjs';

const session = await openRemotePage();
try {
  await session.page.goto('https://example.com', {
    waitUntil: 'domcontentloaded',
  });
  console.log(await session.page.title());
  await session.page.screenshot({ path: 'remote-page.png' });
} finally {
  await session.close();
}
```

Run it with:

```sh
node --env-file=.env.local remote-check.mjs
```

The helper verifies T4 hardware and creates a task-owned browser context. Use `session.close()` when finished to close that context and disconnect. Keep the notebook running for later tasks, and avoid closing unrelated pages or contexts.

## Capture remote browser video

Install [FFmpeg](https://ffmpeg.org/download.html) locally with the `libx264`
encoder available, and put `ffmpeg` on `PATH`. Alternatively, set `FFMPEG_PATH`
to the full executable path. No notebook changes or local browser are required.

Record a remote page to MP4:

```sh
node --env-file=.env.local ./skills/kaggle-remote-browser/scripts/record.mjs https://example.com --seconds 30
```

The command opens a task-owned remote page, captures navigation, then records
for 30 seconds after the DOM loads. Press Ctrl+C to stop and save early; during
connection or navigation, it finishes that operation before saving. The default
output is `remote-browser-results/<timestamp>/video.mp4`. Choose another path
with `--output remote-browser-results/demo.mp4`. Existing files are never
overwritten. Closing the recording disconnects the client and leaves the
notebook's browser server running. This command does not require WebGPU on the
target website, but retains the remote T4 hardware check.

For recording interactions in your own automation, import the recorder:

```js
import { openRemotePage } from './skills/kaggle-remote-browser/scripts/browser.mjs';
import { startRemoteRecording } from './skills/kaggle-remote-browser/scripts/recording.mjs';

const session = await openRemotePage();
let recording;
try {
  recording = await startRemoteRecording(session.page, {
    output: 'remote-browser-results/demo.mp4',
  });
  await session.page.goto('https://example.com');
  // Perform interactions and wait for application-specific readiness here.
  await session.page.waitForTimeout(5000);
} finally {
  try {
    if (recording) console.log(await recording.stop());
  } finally {
    await session.close();
  }
}
```

Stop the recorder before closing its page or context. Frames are temporarily
stored on local disk and removed after encoding or failure, so allow enough
disk space for long captures. Empty captures and encoder failures are reported
as errors.

Capture uses [CDP screencasting](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)
with JPEG frames and no audio. The variable-frame-rate MP4 uses CDP timestamp
intervals through FFmpeg's [concat demuxer](https://ffmpeg.org/ffmpeg-formats.html#concat-1),
holding the final frame until stop. Static pages may emit very few frames.
Frame delivery can be limited by the tunnel, rendering, and local disk speed;
use recordings as visual evidence, not as frame-pacing benchmarks.

Run recorder tests with `node --test tests/recording.test.mjs`. Encoding and
decoding checks require local FFmpeg and are skipped when it is unavailable.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `requestDevice` reports `A valid external Instance reference no longer exists` | Ensure the Chrome launch arguments include `--disable-vulkan-surface` in headed mode as well as headless mode. An earlier headed-mode version omitted it. Retry the server cell, compare `headed=False`, and inspect the GPU diagnostics printed above the traceback. Keep NVIDIA hardware and compute verification enabled. |
| Server cell reports `No module named 'playwright'` | Run the GPU setup cell (starts with `import os`) successfully in the same notebook session before the server cell. It installs Python Playwright and Chromium; global npm Playwright on your computer is separate. Rerun setup after a runtime restart. |
| Drive upload reports HTTP 403 | The uploader prints Google's structured reason and a matching hint. `SERVICE_DISABLED` or `accessNotConfigured` means enable Drive API in the quota project and allow time for propagation; `ACCESS_TOKEN_SCOPE_INSUFFICIENT` or `insufficientPermissions` means sign in again with Drive access. Retry the upload command directly after fixing the cause; project creation does not need repeating. |
| Monitoring reports `Permission 'kernels.get' was denied` | Run `kaggle kernels list --mine` and use the owner and slug from the notebook URL: `node scripts/start-kaggle.mjs --owner OWNER --slug NOTEBOOK-SLUG --follow`. The default slug is `kaggle-remote-browser`; imported or renamed notebooks may differ. `--owner` selects the target, not the authenticated account. Private notebooks require account access. |
| Kaggle CLI reports `No module named 'six'` | Run `uv tool install --with six kaggle`, then retry `kaggle auth login`. This adds the dependency inside the CLI's isolated environment. |
| Cell 1 cannot find `nvidia-smi` | Select **Settings → Accelerator → GPU T4**, enable Internet, let the session restart, then rerun Cell 1. Check GPU access and quota if selection is unavailable. The launcher requests a T4 for its submitted run; confirm accelerator settings separately if running cells in the notebook editor. |
| Global Playwright is missing | Run `npm install --global playwright` with the active npm. `npm root --global` shows the package directory the helper checks. |
| Cannot locate npm's global packages | Ensure Node.js and npm are on `PATH`, and that `npm root --global` succeeds. |
| Missing credentials | Run with `--env-file=.env.local` from the directory containing the file, and confirm both variables are set. |
| Connection fails or is unauthorized | Keep the second notebook cell running and copy fresh credentials if it restarted. |
| NVIDIA package matching fails | The first cell requires graphics packages matching Kaggle's host driver. Inspect its available-version output; do not replace the host NVIDIA driver. |
| GPU verification fails | Confirm the notebook uses a T4. Inspect `vulkan.txt`, `chrome.log`, and any GPU diagnostic files under `/kaggle/working/webgpu-browser/`. |
| Target-origin WebGPU initialization fails | Use a secure origin with WebGPU support and inspect `report.json`. The helper rejects fallback adapters. |
| Local development URL cannot be reached | Kaggle's `localhost` refers to Kaggle. Use a deployed URL or an authorized development tunnel, with API and WebSocket endpoints also reachable from Kaggle. |

See [SKILL.md](skills/kaggle-remote-browser/SKILL.md) for additional guidance on WebGPU validation, development tunnels, screenshots, and recording.
