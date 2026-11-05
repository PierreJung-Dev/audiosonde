import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Engine release version, read from package.json at runtime.
 *
 * Resolved relative to this module's URL so it works both when running from
 * source (`src/version.ts`) and from the compiled output (`dist/version.js`):
 * in both layouts `../package.json` points at the repository / image root.
 */
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

export const ENGINE_VERSION: string = pkg.version;
