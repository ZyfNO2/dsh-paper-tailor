import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/** These are the original domain services' two small runtime libraries, not host SDKs. */
export function copyResearchRuntimeDeps(output) {
  const versions = {};
  for (const name of ['fflate', 'yaml']) {
    let directory = path.dirname(require.resolve(name));
    while (!fs.existsSync(path.join(directory, 'package.json')) || JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name !== name) {
      const parent = path.dirname(directory); if (parent === directory) throw new Error(`Cannot locate ${name} runtime`); directory = parent;
    }
    const destination = path.join(output, 'node_modules', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(directory, destination, { recursive: true, dereference: true });
    versions[name] = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
  }
  return versions;
}
