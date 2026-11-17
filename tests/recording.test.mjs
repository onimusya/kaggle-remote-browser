import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkFFmpeg, startRemoteRecording } from "../skills/kaggle-remote-browser/scripts/recording.mjs";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const available = await checkFFmpeg().then(() => true, () => false);
const integration = { skip: available ? false : "Requires FFmpeg with libx264 (or FFMPEG_PATH)" };

function remotePage() {
  const cdp = new EventEmitter();
  cdp.commands = [];
  cdp.send = async (method, params) => { cdp.commands.push({ method, params }); };
  cdp.detach = async () => { cdp.detached = true; };
  return { cdp, page: { context: () => ({ newCDPSession: async () => cdp }) } };
}

function frame(cdp, timestamp, data, sessionId) {
  cdp.emit("Page.screencastFrame", { metadata: { timestamp }, data, sessionId });
}

test("rejects invalid output before connecting", async () => {
  await assert.rejects(startRemoteRecording(null, { output: "video.webm" }), /\.mp4/);
});

test("encodes decodable MP4 with irregular frame timings and acknowledges all frames", integration, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "recording-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "video.mp4");
  const fixture = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=64x48", "-frames:v", "1",
    "-threads", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]);
  assert.equal(fixture.status, 0, fixture.stderr.toString());
  const { page, cdp } = remotePage();
  const recorder = await startRemoteRecording(page, { output });
  const data = fixture.stdout.toString("base64");
  frame(cdp, 100, data, 1);
  frame(cdp, 100.125, data, 2);
  frame(cdp, 100.125, data, 3); // Duplicate timestamps still require ACK.
  frame(cdp, 101, data, 4);
  await new Promise(resolve => setTimeout(resolve, 60));
  const stopping = recorder.stop();
  assert.equal(recorder.stop(), stopping);
  const result = await stopping;
  assert.equal(result.frames, 3);
  assert.ok(result.durationSeconds >= 1.05);
  assert.equal((await readFile(output)).subarray(4, 8).toString(), "ftyp");
  assert.deepEqual(cdp.commands.filter(c => c.method === "Page.screencastFrameAck")
    .map(c => c.params.sessionId), [1, 2, 3, 4]);
  assert.equal(cdp.listenerCount("Page.screencastFrame"), 0);
  assert.equal(cdp.detached, true);

  // Decode every frame and inspect actual presentation timestamps, not just the file header.
  const decoded = spawnSync(ffmpeg, ["-hide_banner", "-i", output,
    "-vf", "showinfo", "-f", "null", "-"], { encoding: "utf8" });
  assert.equal(decoded.status, 0, decoded.stderr);
  const times = [...decoded.stderr.matchAll(/pts_time:([\d.]+)/g)].map(match => Number(match[1]));
  assert.ok(times.some(time => Math.abs(time - 0.125) < 0.005), decoded.stderr);
  assert.ok(times.some(time => Math.abs(time - 1) < 0.005), decoded.stderr);
  assert.ok(times.at(-1) >= 1.05, decoded.stderr);

  await assert.rejects(startRemoteRecording(page, { output }), /already exists/);
  assert.deepEqual(await readdir(directory), ["video.mp4"]);
});

test("empty capture and invalid timestamps fail and detach", integration, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "recording-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const invalidTimestamp of [false, true]) {
    const { page, cdp } = remotePage();
    const recorder = await startRemoteRecording(page, { output: path.join(directory, "video.mp4") });
    if (invalidTimestamp) frame(cdp, undefined, "", 1);
    await assert.rejects(recorder.stop(), invalidTimestamp ? /timestamp/ : /No screencast frames/);
    assert.equal(cdp.detached, true);
    assert.equal(cdp.listenerCount("Page.screencastFrame"), 0);
  }
  assert.deepEqual(await readdir(directory), []);
});

test("encoder failure does not leave an output file", integration, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "recording-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { page, cdp } = remotePage();
  const recorder = await startRemoteRecording(page, { output: path.join(directory, "video.mp4") });
  frame(cdp, 100, Buffer.from("invalid JPEG").toString("base64"), 1);
  await assert.rejects(recorder.stop(), /FFmpeg exited/);
  assert.equal(cdp.detached, true);
  assert.deepEqual(await readdir(directory), []);
});

test("refuses to overwrite files", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "recording-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "video.mp4");
  await writeFile(output, "keep me");
  await assert.rejects(startRemoteRecording(null, { output }), /already exists/);
  assert.equal(await readFile(output, "utf8"), "keep me");
});
