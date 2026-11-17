import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const usage = `Start or monitor a private Kaggle remote-browser notebook.

Usage:
  node scripts/start-kaggle.mjs [options]

Options:
  --owner NAME    Override owner (default: authenticated Kaggle username)
  --slug NAME     Notebook slug (default: kaggle-remote-browser)
  --minutes N     Browser session duration, 1–720 (default: 120)
  --dry-run       Validate and preview without uploading or starting a run
  --status        Show latest run status without starting a run
  --logs          Print latest run logs without starting a run
  --follow        Stream latest run logs (implies --logs; does not start a run)
  --help          Show this help

Prerequisites:
  uv tool install --with six kaggle
  kaggle auth login

An existing notebook with the same owner/slug will be updated.
Starting a run consumes Kaggle runtime/GPU quota.
`;

function runKaggle(args, failureMessage) {
  const result = spawnSync('kaggle', args, {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error('Kaggle CLI not found. Run "uv tool install --with six kaggle", ensure it is on PATH, then run "kaggle auth login".');
  }
  if (result.error) throw result.error;
  if (result.signal) {
    process.exitCode = result.signal === 'SIGINT' ? 130 : 1;
    return false;
  }
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    throw new Error(failureMessage);
  }
  return true;
}

function detectOwner() {
  const result = spawnSync('kaggle', ['config', 'view'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error('Kaggle CLI not found. Run "uv tool install --with six kaggle", ensure it is on PATH, then run "kaggle auth login".');
  }
  // Keep configuration and authentication diagnostics private; only extract username.
  const owner = result.stdout?.match(/^\s*(?:-\s*)?username:\s*([a-zA-Z0-9_-]+)\s*$/im)?.[1];
  if (result.error || result.status !== 0 || !owner || /^(none|null)$/i.test(owner)) {
    throw new Error('Cannot detect the authenticated Kaggle username. Run "kaggle auth login" and retry, or pass --owner YOUR-USERNAME explicitly.');
  }
  return owner;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      owner: { type: 'string' },
      slug: { type: 'string', default: 'kaggle-remote-browser' },
      minutes: { type: 'string', default: '120' },
      'dry-run': { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      logs: { type: 'boolean', default: false },
      follow: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(usage);
    return;
  }

  if (values.owner !== undefined && !/^[a-zA-Z0-9_-]+$/.test(values.owner)) {
    throw new Error('--owner must be a valid Kaggle username. Use --help for usage.');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.slug)) {
    throw new Error('--slug must contain lowercase words or numbers separated by hyphens.');
  }
  const minutes = Number(values.minutes);
  if (!/^\d+$/.test(values.minutes) || !Number.isInteger(minutes) || minutes < 1 || minutes > 720) {
    throw new Error('--minutes must be an integer between 1 and 720.');
  }
  const monitor = values.status || values.logs || values.follow;
  if (monitor && values['dry-run']) {
    throw new Error('--dry-run previews an upload; use it separately from --status, --logs, or --follow.');
  }
  const owner = values.owner ?? detectOwner();
  const id = `${owner}/${values.slug}`;

  if (monitor) {
    const accessHint = `Target: ${id}. List your notebooks with "kaggle kernels list --mine", then pass --owner OWNER --slug NOTEBOOK-SLUG from the notebook URL. Private notebooks require an account with access; --owner does not switch the logged-in account.`;
    console.error(`Monitoring notebook: ${id}`);
    if (values.status && !runKaggle(['kernels', 'status', id], `Cannot retrieve notebook status. ${accessHint}`)) return;
    if (values.logs || values.follow) {
      console.error('Notebook logs may contain private browser credentials. Keep the output private.');
      if (values.follow) console.error('Following logs. Press Ctrl+C to stop monitoring; the remote run continues.');
      runKaggle(['kernels', 'logs', id, ...(values.follow ? ['--follow'] : [])], `Cannot retrieve notebook logs. ${accessHint}`);
    }
    return;
  }

  const notebookURL = new URL('../notebook/kaggle-browser.ipynb', import.meta.url);
  const notebook = JSON.parse(await readFile(notebookURL, 'utf8'));
  let replaced = 0;
  for (const cell of notebook.cells) {
    if (cell.cell_type !== 'code') continue;
    cell.outputs = [];
    cell.execution_count = null;
    const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    cell.source = source.replace(/await remote_browser\(minutes=\d+\)/g, () => {
      replaced++;
      return `await remote_browser(minutes=${minutes})`;
    });
  }
  if (replaced !== 1) {
    throw new Error('Expected exactly one remote_browser invocation in the source notebook.');
  }
  notebook.metadata.kaggle = {
    ...notebook.metadata.kaggle,
    accelerator: 'gpu',
    isGpuEnabled: true,
    isInternetEnabled: true,
  };

  const metadata = {
    id,
    title: values.slug.split('-').join(' '),
    code_file: 'kaggle-browser.ipynb',
    language: 'python',
    kernel_type: 'notebook',
    is_private: true,
    enable_gpu: true,
    enable_internet: true,
    machine_shape: 'NvidiaTeslaT4',
    dataset_sources: [],
    competition_sources: [],
    kernel_sources: [],
    model_sources: [],
  };

  if (values['dry-run']) {
    console.log(JSON.stringify({
      dryRun: true,
      source: fileURLToPath(notebookURL),
      browserSessionMinutes: minutes,
      metadata,
    }, null, 2));
    return;
  }

  const staging = await mkdtemp(path.join(tmpdir(), 'kaggle-browser-'));
  try {
    await writeFile(path.join(staging, metadata.code_file), JSON.stringify(notebook, null, 2));
    await writeFile(path.join(staging, 'kernel-metadata.json'), JSON.stringify(metadata, null, 2));
    console.log(`Uploading and starting private notebook ${id} (T4, ${minutes}-minute browser session).`);
    if (!runKaggle(['kernels', 'push', '-p', staging, '--accelerator', 'NvidiaTeslaT4'], 'Kaggle upload/run request failed. Check the CLI output, authentication, and GPU availability.')) return;
    console.log(`\nRun requested. This does not yet confirm browser readiness.
Notebook: https://www.kaggle.com/code/${id}
Check status: node scripts/start-kaggle.mjs --owner ${owner} --slug ${values.slug} --status
Follow logs: node scripts/start-kaggle.mjs --owner ${owner} --slug ${values.slug} --follow

Wait for "Public authenticated CDP connection verified" and copy the printed
KAGGLE_CDP_URL and KAGGLE_CDP_TOKEN into your local .env.local.
Logs contain private browser credentials; do not share them.
The browser session ends automatically; no automatic restart is configured.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode ||= 1;
});
