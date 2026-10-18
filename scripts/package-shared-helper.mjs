import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat } from 'node:fs/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperRoot = path.resolve(
  process.env.BLAI_HELPER_SOURCE || path.join(root, '../BLAI/helper'),
);
try {
  if (!(await lstat(path.join(root, 'dist/client'))).isDirectory()) throw new Error();
  const { packageHelper } = await import(
    pathToFileURL(path.join(helperRoot, 'scripts/package.mjs')).href
  );
  await packageHelper({ output: path.join(root, 'dist/client/blai-helper.tar.gz') });
  console.log('Shared BLAI helper packaged for release.');
} catch {
  console.error(
    'Build the app first and check out JoDavidsson/BLAI alongside the app repositories. BLAI/helper supplies the shared release package; BLAI_HELPER_SOURCE can override its path.',
  );
  process.exitCode = 1;
}
