import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICE_NAME = 'blai-designer-codex.service';
const quote = (value) => {
  if (/[\0\r\n]/.test(value)) throw new Error('Service paths cannot contain line breaks.');
  return (
    '"' +
    value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('%', '%%')
      .replaceAll('$', '$$') +
    '"'
  );
};
export function serviceContent({
  configPath,
  rootDir = root,
  nodePath = process.execPath,
  executablePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
}) {
  return `[Unit]\nDescription=BLAI Product Designer Codex helper\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(rootDir)}\nExecStart=${quote(nodePath)} ${quote(path.join(rootDir, 'bridge/start.mjs'))} ${quote(configPath)}\nEnvironment=${quote('PATH=' + executablePath)}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=20\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
export async function installService({
  configPath = path.join(root, '.blai-designer', 'config.json'),
  serviceDirectory = path.join(homedir(), '.config/systemd/user'),
  run = execFileSync,
} = {}) {
  if (process.platform !== 'linux')
    throw new Error('The service installer requires Linux with a systemd user session.');
  await loadConfig(configPath);
  const filename = path.join(serviceDirectory, SERVICE_NAME);
  const content = serviceContent({ configPath: path.resolve(configPath) });
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Existing designer service is not a normal file and was left unchanged.');
    const old = await readFile(filename, 'utf8');
    if (old !== content)
      throw new Error(
        'A different designer service already exists. Back it up before replacing it; the writing helper was left unchanged.',
      );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(serviceDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(filename, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', SERVICE_NAME],
    ['--user', 'is-active', '--quiet', SERVICE_NAME],
  ])
    run('systemctl', args, { stdio: 'inherit' });
  console.log('Designer helper installed. It starts when you log in.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await installService({
      configPath: process.argv[2] ? path.resolve(process.argv[2]) : undefined,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
