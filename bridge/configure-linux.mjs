import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig, validateConfig } from './config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help' || key === '--install-service') options[key.slice(2)] = true;
    else if (
      ['--settings', '--config', '--codex-path'].includes(key) &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      options[key.slice(2)] = args[++i];
    else
      throw new Error(
        'Use --settings FILE [--config FILE] [--codex-path FILE] [--install-service].',
      );
  }
  if (!options.help && !options.settings)
    throw new Error('Provide a private JSON settings file using --settings FILE.');
  return options;
}

export async function prepareLinuxHelper(
  settingsPath,
  {
    configPath = path.join(root, '.blai-designer', 'config.json'),
    codexPath,
    run = (command, args) =>
      spawnSync(command, args, {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 64_000,
        stdio: 'pipe',
      }),
  } = {},
) {
  const stat = await lstat(settingsPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000)
    throw new Error('Choose a normal designer settings JSON file smaller than 16 KB.');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch {
    throw new Error('The settings file is not valid JSON.');
  }
  const config = validateConfig({ ...parsed, ...(codexPath ? { codexPath } : {}) });
  const command = config.codexPath || 'codex';
  const login = run(command, ['login', 'status']);
  if (login.error?.code === 'ENOENT')
    throw new Error(
      'Install Codex CLI with npm install -g @openai/codex, then run codex login and sign in with your ChatGPT account.',
    );
  const status = String(login.stdout ?? '') + '\n' + String(login.stderr ?? '');
  if (
    login.error ||
    login.status !== 0 ||
    !/\bchatgpt\b/i.test(status) ||
    /api[ -]?key/i.test(status)
  )
    throw new Error(
      'Codex needs your ChatGPT subscription sign-in. Run codex login with your ChatGPT account, then configure the designer helper again.',
    );
  const help = run(command, ['exec', '--help']);
  const text = String(help.stdout ?? '') + String(help.stderr ?? '');
  if (
    help.status !== 0 ||
    !['--ignore-user-config', '--ignore-rules', '--ephemeral', '--output-schema'].every((flag) =>
      text.includes(flag),
    )
  )
    throw new Error(
      'Update Codex CLI: this helper needs exec --ignore-user-config, --ignore-rules, --ephemeral and --output-schema.',
    );
  await saveConfig(path.resolve(configPath), config);
  return path.resolve(configPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help)
      console.log(
        'node bridge/configure-linux.mjs --settings FILE [--config FILE] [--codex-path FILE] [--install-service]\nUses your existing ChatGPT Codex login; writes only designer-specific configuration.',
      );
    else {
      const configPath = await prepareLinuxHelper(path.resolve(options.settings), {
        configPath: options.config,
        codexPath: options['codex-path'],
      });
      console.log('ChatGPT sign-in confirmed. Designer helper settings stored privately.');
      if (options['install-service']) {
        const { installService } = await import('./install-service.mjs');
        await installService({ configPath });
      }
    }
  } catch (error) {
    console.error(
      error.code
        ? 'Could not read or save designer settings. Check the paths and permissions.'
        : error.message,
    );
    process.exitCode = 1;
  }
}
