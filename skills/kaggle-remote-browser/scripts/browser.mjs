import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);

function loadGlobalPlaywright() {
  let globalRoot;

  try {
    // A fixed command also supports npm.cmd on Windows without interpolating paths.
    globalRoot = execSync("npm root --global", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
      windowsHide: true,
    }).trim();

    if (!path.isAbsolute(globalRoot)) {
      throw new Error("npm did not return an absolute global package directory.");
    }
  } catch {
    throw new Error(
      "WARNING: Cannot locate npm's global packages. Ensure Node.js and npm " +
      "are available on PATH, then install Playwright globally:\n" +
      "  npm install --global playwright\n" +
      "Rerun this helper after installation."
    );
  }

  const playwrightPath = path.join(globalRoot, "playwright");

  if (!existsSync(path.join(playwrightPath, "package.json"))) {
    throw new Error(
      "WARNING: Playwright is not installed globally for the active npm. " +
      "Install it with:\n" +
      "  npm install --global playwright\n" +
      "Rerun this helper after installation. No local browser download is needed."
    );
  }

  return require(playwrightPath);
}

function redact(value) {
  let text = String(value);

  for (const key of ["KAGGLE_CDP_URL", "KAGGLE_CDP_TOKEN"]) {
    const secret = process.env[key];
    if (secret) text = text.split(secret).join(`[${key}]`);
  }

  return text;
}

export async function openRemotePage() {
  const { chromium } = loadGlobalPlaywright();
  const endpoint = process.env.KAGGLE_CDP_URL;
  const token = process.env.KAGGLE_CDP_TOKEN;

  if (!endpoint || !token) {
    throw new Error(
      "Missing credentials. Run Node with --env-file=.env.local."
    );
  }

  const browser = await chromium.connectOverCDP(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    timeout: 60000,
  });

  let context;

  try {
    const cdp = await browser.newBrowserCDPSession();
    let devices;

    try {
      devices = (await cdp.send("SystemInfo.getInfo")).gpu.devices;
    } finally {
      await cdp.detach();
    }

    const hasT4 = devices.some(device => {
      const identity = [
        device.vendorString,
        device.deviceString,
        device.driverVendor,
      ].join(" ");

      return (
        /nvidia/i.test(identity) &&
        /\bT4\b/i.test(identity) &&
        !/swiftshader|llvmpipe|lavapipe|software/i.test(identity)
      );
    });

    if (!hasT4) {
      throw new Error("Remote browser did not identify NVIDIA T4.");
    }

    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });

    const page = await context.newPage();

    return {
      browser,
      context,
      page,
      devices,

      async close() {
        try {
          await context.close();
        } finally {
          // Disconnect this client; the notebook owns the browser process.
          await browser.close();
        }
      },
    };
  } catch (error) {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function main() {
  const target =
    process.argv[2] ||
    "https://webgpu.studio/particle-simulator";

  const output = path.resolve(
    "remote-browser-results",
    new Date().toISOString().replace(/[:.]/g, "-")
  );

  await mkdir(output, { recursive: true });

  const report = {
    target,
    startedAt: new Date().toISOString(),
    status: "RUNNING",
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
  };

  let session;

  try {
    session = await openRemotePage();

    const { page, browser, devices } = session;

    report.browserVersion = browser.version();
    report.devices = devices;

    page.on("pageerror", error => {
      report.pageErrors.push(redact(error.message));
    });

    page.on("console", message => {
      if (message.type() === "error") {
        report.consoleErrors.push(redact(message.text()));
      }
    });

    page.on("requestfailed", request => {
      report.failedRequests.push({
        url: redact(request.url()),
        error: redact(request.failure()?.errorText),
      });
    });

    console.log("Opening:", target);

    const response = await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    report.httpStatus = response?.status();

    if (response && !response.ok()) {
      throw new Error(`Page returned HTTP ${response.status()}`);
    }

    report.webgpu = await page.evaluate(async () => {
      if (!isSecureContext || !navigator.gpu) {
        throw new Error("WebGPU unavailable on this origin.");
      }

      const adapter = await navigator.gpu.requestAdapter();

      if (!adapter) {
        throw new Error("No WebGPU adapter.");
      }

      const info =
        adapter.info || await adapter.requestAdapterInfo();

      const details = {
        vendor: info.vendor,
        architecture: info.architecture,
        description: info.description,
        fallback: Boolean(
          adapter.isFallbackAdapter || info.isFallbackAdapter
        ),
      };

      if (
        details.fallback ||
        !/nvidia|0x10de/i.test(JSON.stringify(details))
      ) {
        throw new Error("Expected a hardware NVIDIA adapter.");
      }

      const device = await adapter.requestDevice();
      device.destroy();

      return details;
    });

    // Generic observation interval; use app-specific readiness in custom tests.
    await page.waitForTimeout(5000);

    report.title = await page.title();
    report.canvasCount = await page.locator("canvas").count();

    await page.screenshot({
      path: path.join(output, "page.png"),
    });

    if (report.pageErrors.length) {
      throw new Error("Page JavaScript errors detected.");
    }

    report.status = "PASS";
    report.scope = "Remote connection and target-origin WebGPU initialization";
    console.log("PASS: Connection and WebGPU initialization verified.");

  } catch (error) {
    report.status = "FAIL";
    report.error = redact(error.message);
    process.exitCode = 1;

    console.error("FAIL:", report.error);

    if (session && !session.page.isClosed()) {
      await session.page.screenshot({
        path: path.join(output, "failure.png"),
        timeout: 15000,
      }).catch(() => {});
    }

  } finally {
    report.finishedAt = new Date().toISOString();

    try {
      await writeFile(
        path.join(output, "report.json"),
        redact(JSON.stringify(report, null, 2))
      );
    } finally {
      if (session) await session.close().catch(() => {});
    }

    console.log("Results:", output);
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await main();
}
