import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function validateConfig(value) {
  const keys = ['site', 'bridgeSecret', 'accessClientId', 'accessClientSecret', 'codexPath'];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Use a designer helper JSON configuration with only supported fields.');
  let site;
  try {
    site = new URL(value.site);
  } catch {
    throw new Error('Configure a valid designer app HTTPS origin.');
  }
  const local =
    site.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname);
  if (
    (!local && site.protocol !== 'https:') ||
    site.username ||
    site.password ||
    site.pathname !== '/' ||
    site.hash ||
    site.search
  )
    throw new Error(
      'Use an HTTPS origin without a path or embedded credentials; HTTP is allowed only on localhost.',
    );
  if (typeof value.bridgeSecret !== 'string' || !/^[\x21-\x7e]{32,200}$/.test(value.bridgeSecret))
    throw new Error('Set a designer-only bridgeSecret of 32–200 printable characters.');
  const access = value.accessClientId !== undefined || value.accessClientSecret !== undefined;
  if (
    (!local || access) &&
    ![value.accessClientId, value.accessClientSecret].every(
      (v) => typeof v === 'string' && /^[\x21-\x7e]{1,512}$/.test(v),
    )
  )
    throw new Error('Configure both Cloudflare Access service-token fields for the designer app.');
  if (
    value.codexPath !== undefined &&
    (typeof value.codexPath !== 'string' ||
      !value.codexPath.trim() ||
      /[\0\r\n]/.test(value.codexPath))
  )
    throw new Error('Configure a valid Codex executable path.');
  return { ...value, site: site.origin };
}

export function bridgeHeaders(config) {
  const headers = {
    'content-type': 'application/json',
    'x-designer-bridge-key': config.bridgeSecret,
  };
  if (config.accessClientId && config.accessClientSecret) {
    headers['CF-Access-Client-Id'] = config.accessClientId;
    headers['CF-Access-Client-Secret'] = config.accessClientSecret;
  }
  return headers;
}

export async function loadConfig(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000)
    throw new Error('The helper configuration must be a normal JSON file smaller than 16 KB.');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    throw new Error('Keep helper credentials private: chmod 600 the configuration file.');
  let raw;
  try {
    raw = JSON.parse(await readFile(filename, 'utf8'));
  } catch {
    throw new Error('The helper configuration is not valid JSON.');
  }
  return validateConfig(raw);
}

export async function saveConfig(filename, config) {
  const directory = path.dirname(filename);
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()))
    throw new Error('The designer configuration directory must be a normal directory.');
  if (directoryStat && process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0)
    throw new Error(
      'Choose a private configuration directory (mode 700). Existing parent permissions were left unchanged.',
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(filename, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await loadConfig(filename);
    if (
      JSON.stringify(Object.entries(existing).sort()) !==
      JSON.stringify(Object.entries(config).sort())
    )
      throw new Error(
        'Existing designer settings differ and were left unchanged. Choose a new --config path or explicitly back up and remove the old file.',
      );
  }
}
