import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", error => reject(new Error(
      `Cannot run FFmpeg: ${error.message}. Install FFmpeg locally or set FFMPEG_PATH.`
    )));
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with ${code}: ${stderr.trim()}`));
    });
  });
}

export async function checkFFmpeg() {
  await runFFmpeg(["-version"]);
}

// Capture the remote viewport. CDP screencasting has no audio track.
export async function startRemoteRecording(page, { output } = {}) {
  if (!output || path.extname(output).toLowerCase() !== ".mp4") {
    throw new Error("Recording output must be an .mp4 path.");
  }
  output = path.resolve(output);
  if (existsSync(output)) throw new Error(`Recording already exists: ${output}`);
  await checkFFmpeg();
  await mkdir(path.dirname(output), { recursive: true });
  const directory = await mkdtemp(path.join(tmpdir(), "remote-browser-recording-"));
  let cdp;
  let queue = Promise.resolve();
  let failure;
  const frames = [];
  let stopPromise;

  const onFrame = event => {
    const receivedAt = performance.now();
    queue = queue.then(async () => {
      try {
        if (failure) return;
        const timestamp = event.metadata.timestamp;
        if (!Number.isFinite(timestamp)) {
          throw new Error("Screencast frame has no capture timestamp.");
        }
        // Ignore duplicate/out-of-order frames rather than inventing timings.
        if (frames.length && timestamp <= frames.at(-1).timestamp) return;
        const filename = `frame-${frames.length}.jpg`;
        await writeFile(path.join(directory, filename), Buffer.from(event.data, "base64"));
        frames.push({ filename, timestamp, receivedAt });
      } catch (error) {
        failure ||= error;
      } finally {
        await cdp.send("Page.screencastFrameAck", {
          sessionId: event.sessionId,
        }).catch(error => { failure ||= error; });
      }
    });
  };

  try {
    cdp = await page.context().newCDPSession(page);
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", {
      format: "jpeg", quality: 80, everyNthFrame: 1,
    });
  } catch (error) {
    if (cdp) {
      cdp.off("Page.screencastFrame", onFrame);
      await queue;
      await cdp.detach().catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    // Idempotent so a finally block can always finalize the recording.
    stop() {
      stopPromise ||= (async () => {
        const stoppedAt = performance.now();
        try {
          await cdp.send("Page.stopScreencast");
          cdp.off("Page.screencastFrame", onFrame);
          await queue;
          if (failure) throw failure;
          if (!frames.length) throw new Error("No screencast frames received; no video was saved.");

          const lines = ["ffconcat version 1.0"];
          let duration = 0;
          for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            const seconds = i + 1 < frames.length
              ? frames[i + 1].timestamp - frame.timestamp
              : Math.max(0.001, (stoppedAt - frame.receivedAt) / 1000);
            duration += seconds;
            // A fine input time base preserves CDP intervals in the VFR output.
            lines.push(`file ${frame.filename}`, "option framerate 1000", `duration ${seconds.toFixed(6)}`);
          }
          // Repeat the last image so concat honors its hold duration.
          lines.push(`file ${frames.at(-1).filename}`, "option framerate 1000");
          await writeFile(path.join(directory, "frames.ffconcat"), lines.join("\n") + "\n");
          await runFFmpeg([
            "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
            "-f", "concat", "-safe", "0", "-i", path.join(directory, "frames.ffconcat"),
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-vsync", "vfr",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            path.join(directory, "video.mp4"),
          ]);
          await copyFile(path.join(directory, "video.mp4"), output, constants.COPYFILE_EXCL);
          return { output, frames: frames.length, durationSeconds: duration };
        } finally {
          cdp.off("Page.screencastFrame", onFrame);
          await queue;
          await cdp.detach().catch(() => {});
          await rm(directory, { recursive: true, force: true });
        }
      })();
      return stopPromise;
    },
  };
}
