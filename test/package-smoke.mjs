import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProfileSmoke } from './profile-smoke.mjs';

const archive = process.argv[2];
assert.ok(archive?.endsWith('.tgz') && existsSync(archive), 'Pass the candidate .tgz from npm pack');
const project = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(process.env.DSH_TEST_INSTALL_DIR ?? project);
const installed = createRequire(join(runtime, 'package.json'));
const candidate = resolve(archive);

await runProfileSmoke(installed, { packageSpec: candidate });
await runProfileSmoke(installed, { packageSpec: 'dsh-tool-exposure@1.0.2', upgradeArchive: candidate });
