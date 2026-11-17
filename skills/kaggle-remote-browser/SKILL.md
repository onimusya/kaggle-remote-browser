---
name: kaggle-remote-browser
description: Control a Kaggle-hosted NVIDIA T4 Chromium browser through authenticated CDP. Use for remote browser automation, screenshots, UI testing, and WebGPU validation when the local machine has no GPU.
---

# Kaggle Remote Browser

Use the existing Kaggle browser session to perform browser tasks.
Rendering executes remotely on NVIDIA T4 hardware.

## Connection

Read these variables from the target project's `.env.local`:

- KAGGLE_CDP_URL
- KAGGLE_CDP_TOKEN

Load them using Node's `--env-file=.env.local` option.
Never print, commit, or include their values in reports.

Keep the Kaggle browser notebook cell running. Both credentials change
when that cell restarts.

The helper detects Playwright in the active npm's global package directory
using `npm root --global` and loads it directly. No `NODE_PATH` setup or
project-local installation is needed. Node.js and npm must be on `PATH`.

If global Playwright is missing, the helper stops with a warning and
installation instructions:

    npm install --global playwright

Rerun the helper after installation. It does not install packages automatically.

Do not download or launch a local browser as a substitute.

## Quick test

Run from the target project directory:

    node --env-file=.env.local .agents/skills/kaggle-remote-browser/scripts/browser.mjs https://webgpu.studio/particle-simulator

The helper saves a screenshot and JSON report in a timestamped
`remote-browser-results` subdirectory.

Treat this as a connection and GPU initialization test. Add assertions
for the application's actual behavior before claiming that it works.

## Custom browser tasks

Import `openRemotePage` from `scripts/browser.mjs` in an agent-written
Node script. The helper resolves Playwright from npm's global package directory.

Example:

    const session = await openRemotePage();
    try {
      await session.page.goto(targetURL);
      // Inspect DOM, click controls, fill forms, evaluate JS,
      // assert application behavior, and capture screenshots.
    } finally {
      await session.close();
    }

Use Playwright's page APIs for navigation, locators, interaction,
screenshots, keyboard/mouse actions, and JavaScript evaluation.

Create only task-owned contexts. Close those contexts when finished.
Do not close unrelated pages or contexts, send Browser.close through CDP,
or stop the Kaggle notebook.

## Network access

Use URLs reachable from Kaggle.

Kaggle's localhost is not the local development computer. To test a local
application, use a deployed HTTPS URL or an authorized development tunnel.

For example, expose the local development port:

    cloudflared tunnel --url http://localhost:5173

Allow the generated hostname in the development server configuration.
Ensure API and WebSocket endpoints are also reachable from Kaggle.
Do not replace required COOP/COEP headers for applications using
SharedArrayBuffer.

## WebGPU validation

Verify each layer separately:

1. Remote hardware: inspect SystemInfo.getInfo for NVIDIA Tesla T4.
2. Target origin: verify a non-fallback NVIDIA WebGPU adapter/device.
3. Application: verify actual rendering or compute behavior.
4. Visual output: inspect screenshots for expected content.

Accept ANGLE device strings identifying NVIDIA T4 even if vendorId is 0.
Reject SwiftShader, llvmpipe, lavapipe, and fallback adapters.

Do not equate navigator.gpu availability with working GPU execution.
Do not equate draw/dispatch/submission counts with displayed FPS.
Do not claim visual correctness from adapter initialization alone.

For application tests, wait for a meaningful readiness signal rather
than relying only on a fixed delay. Capture page errors, uncaptured
WebGPU errors, failed requests, and screenshots.

Main-page API instrumentation does not automatically cover Web Workers.

## Screenshots and video

Save screenshots locally using page.screenshot.

Headless mode supports screenshots. If rendering evidence points to a headless
capture problem, the notebooks also support `remote_browser(minutes=120,
headed=True)`, which starts headed Chromium on a task-owned Xvfb display.
For a new Kaggle run, use `node scripts/start-kaggle.mjs --headed` from this
repository, adding the existing notebook's `--slug` if needed. This starts a new
run rather than changing the connected browser. Wait for successful GPU/CDP
verification, then refresh both `.env.local` credentials from the new run's
private output. For manual runs, rerun the updated setup cell to install Xvfb
and stop the previous server before starting the new one. Keep GPU verification
and visual assertions; headed mode alone does not prove rendering correctness.

For video, install FFmpeg locally (with libx264), then run:

    node --env-file=.env.local .agents/skills/kaggle-remote-browser/scripts/record.mjs https://example.com --seconds 30

The command captures navigation and then records for the requested duration
after DOM readiness. Ctrl+C saves early once connection/navigation completes.
It saves `remote-browser-results/<timestamp>/video.mp4`; use `--output` for a
custom .mp4 path. Existing files are never overwritten. Use `FFMPEG_PATH` if
the executable is not on PATH.

For custom interactions, import `startRemoteRecording` from
`scripts/recording.mjs`, call `await startRemoteRecording(session.page,
{ output: 'remote-browser-results/demo.mp4' })`, then call
`await recording.stop()` in a finally block before closing the session.
Stop is idempotent and returns the output path, frame count, and duration.

The recorder uses CDP screencasting, acknowledges every frame, and encodes
locally with FFmpeg using CDP timestamp intervals in a variable-frame-rate
MP4. It records the viewport without audio, holds the last frame until stop,
and cleans up temporary JPEGs. Allow local disk space for the frame sequence.
Empty captures and encoder failures are errors.

Do not assume Playwright recordVideo works through an arbitrary CDP
attachment. Confirm the resulting recording exists and plays before
reporting success.

Treat remote recordings as visual evidence, not frame-pacing benchmarks.

## Troubleshooting

Connection failure:
- Check that both environment variables exist without printing them.
- Check that the Kaggle browser cell is still running.
- Obtain fresh credentials if the notebook session restarted.
- Pass the bearer token in the CDP connection headers.

WebGPU adapter failure:
- Collect SystemInfo.getInfo, chrome://gpu, and Kaggle chrome.log.
- Preserve the working isolated NVIDIA EGL Vulkan configuration.
- Do not install replacement host/kernel NVIDIA drivers.

Known working server configuration:
- Extract matching NVIDIA graphics libraries without installing them.
- Use libEGL_nvidia as the standard Vulkan ICD.
- Exclude the Vulkan SC driver libnvidia-vksc-core.
- Pass the resulting GPU_ENV to Chromium.
- Enable Vulkan, VulkanFromANGLE, and DefaultANGLEVulkan.
- Preserve `--disable-vulkan-surface` in both headless and headed Xvfb modes;
  a virtual display does not establish native NVIDIA Vulkan surface support.
- Keep hardware verification and a real compute-readback test.

Respect notebook duration and quota limits. Do not add keepalive or
automatic session-restart mechanisms.

## Reporting

Report:
- Target URL and browser version.
- Detected hardware and WebGPU adapter.
- Actions and assertions performed.
- Screenshots and other artifacts.
- Errors and limitations.

Distinguish connection success, GPU initialization, application behavior,
visual correctness, and performance.
