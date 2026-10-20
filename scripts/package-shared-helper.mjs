import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, readFile } from 'node:fs/promises';
import { DESIGNER_HELPER_VERSION } from '../bridge/schema.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperRoot = path.resolve(
  process.env.BLAI_HELPER_SOURCE || path.join(root, '../BLAI/helper'),
);
try {
  if (!(await lstat(path.join(root, 'dist/client'))).isDirectory()) throw new Error();
  const manifest = JSON.parse(await readFile(path.join(helperRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'blai-helper' || manifest.version !== DESIGNER_HELPER_VERSION)
    throw new Error('Helper release version mismatch.');
  const { packageHelper, designerFiles } = await import(
    pathToFileURL(path.join(helperRoot, 'scripts/package.mjs')).href
  );
  if (!designerFiles.includes('bridge/job-limits.json'))
    throw new Error('Helper package is missing the runtime policy.');
  await packageHelper({
    designerRoot: root,
    output: path.join(root, 'dist/client/blai-helper.tar.gz'),
  });
  console.log('Shared BLAI helper packaged for release.');
} catch {
  console.error(
    `Build the app first and use the matching BLAI/helper ${DESIGNER_HELPER_VERSION} release with its Designer runtime policy. Check out JoDavidsson/BLAI alongside the app repositories; BLAI_HELPER_SOURCE can override its path.`,
  );
  process.exitCode = 1;
}
