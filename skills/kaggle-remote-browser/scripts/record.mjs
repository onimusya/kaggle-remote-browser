import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openRemotePage } from "./browser.mjs";
import { checkFFmpeg, startRemoteRecording } from "./recording.mjs";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      seconds: { type: "string", default: "30" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Usage: node --env-file=.env.local record.mjs URL [--seconds 30] [--output video.mp4]\nCapture the remote viewport without audio. Ctrl+C stops and saves early. Requires local FFmpeg.");
    return;
  }
  if (positionals.length !== 1 || !/^https?:$/.test(new URL(positionals[0]).protocol)) {
    throw new Error("Provide one HTTP(S) target URL. Use --help for usage.");
  }
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 43200) {
    throw new Error("--seconds must be greater than 0 and at most 43200 (12 hours).");
  }
  const output = values.output || path.join("remote-browser-results",
    new Date().toISOString().replace(/[:.]/g, "-"), "video.mp4");
  if (path.extname(output).toLowerCase() !== ".mp4") {
    throw new Error("--output must be an .mp4 path.");
  }
  await checkFFmpeg();
  let session;
  let recording;
  let timer;
  let interrupted = false;
  let finishWait;
  const interrupt = () => {
    interrupted = true;
    finishWait?.();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    session = await openRemotePage();
    recording = await startRemoteRecording(session.page, { output });
    console.log("Recording remote viewport. Ctrl+C stops and saves early.");
    await session.page.goto(positionals[0], { waitUntil: "domcontentloaded", timeout: 90000 });
    if (!interrupted) {
      await new Promise(resolve => {
        finishWait = resolve;
        timer = setTimeout(resolve, seconds * 1000);
      });
    }
  } finally {
    clearTimeout(timer);
    try {
      if (recording) {
        const result = await recording.stop();
        console.log(`Saved: ${result.output} (${result.frames} frames, ${result.durationSeconds.toFixed(2)}s)`);
      }
    } finally {
      if (session) await session.close();
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    let message = error.message;
    for (const key of ["KAGGLE_CDP_URL", "KAGGLE_CDP_TOKEN"]) {
      if (process.env[key]) message = message.split(process.env[key]).join(`[${key}]`);
    }
    console.error("Recording failed:", message);
    process.exitCode = 1;
  });
}
