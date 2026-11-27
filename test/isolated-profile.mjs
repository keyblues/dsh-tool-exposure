import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Install a working-tree snapshot without linking the source into the temporary profile. */
export function copyPluginToProfile(project, profile) {
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  const destination = join(profile, 'node_modules', manifest.name);
  mkdirSync(destination);
  for (const file of ['package.json', ...manifest.files]) {
    cpSync(join(project, file), join(destination, file), { recursive: true, dereference: true });
  }
  return manifest.version;
}

function unlinkProfileLinks(directory) {
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    const entry = lstatSync(file);
    if (entry.isSymbolicLink()) unlinkSync(file);
    else if (entry.isDirectory()) unlinkProfileLinks(file);
  }
}

export function removeTestHome(taskHome, prefix) {
  const target = realpathSync(taskHome);
  if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith(prefix)) {
    throw new Error('Refusing to remove an unowned test directory: ' + target);
  }
  // Detach junctions before recursive removal under Electron on Windows.
  if (process.platform === 'win32') unlinkProfileLinks(target);
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
