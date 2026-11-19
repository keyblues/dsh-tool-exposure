/** Keep an isolated real DSH Web profile alive for interactive UI verification. */
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runProfileSmoke } from './profile-smoke.mjs';

if (process.platform === 'win32' && !process.versions.electron) {
  const executable = process.env.DSH_NODE_EXECUTABLE || join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
  const result = spawnSync(executable, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const anchor = process.env.DSH_TEST_INSTALL_DIR || join(dirname(process.execPath), 'resources', 'app.asar', 'dsh');
const installed = createRequire(join(anchor, 'package.json'));
await runProfileSmoke(installed, { onReady: async ({ origin, launchUrl, taskHome }) => {
  const stopFile = join(taskHome, 'stop-preview');
  console.log('DSH_PREVIEW ' + JSON.stringify({ origin, launchUrl, stopFile }));
  const previewMinutes = Math.min(120, Math.max(1, Number(process.env.DSH_PREVIEW_MINUTES) || 30));
  const deadline = Date.now() + previewMinutes * 60 * 1000;
  while (!existsSync(stopFile) && Date.now() < deadline) await delay(500);
  writeFileSync(join(taskHome, 'preview-complete'), 'complete');
} });
