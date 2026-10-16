// Adapted from the user's ai-writing-tool Access validation; new app settings only.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError, type Env, type Identity } from './types';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const keys = new Map<string, JWTVerifyGetKey>();
export function isLocal(request: Request, env: Env): boolean {
  return env.DEV_AUTH === 'local' && localHosts.has(new URL(request.url).hostname);
}
export function accessSettings(
  env: Pick<Env, 'CF_ACCESS_TEAM_DOMAIN' | 'CF_ACCESS_AUD' | 'AUTH_ALLOWED_EMAILS'>,
) {
  const domain = env.CF_ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const audience = env.CF_ACCESS_AUD?.trim();
  const emails = env.AUTH_ALLOWED_EMAILS?.split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (
    !domain ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(domain) ||
    !audience ||
    !emails?.length ||
    emails.some((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
  )
    return null;
  return { issuer: `https://${domain}`, audience, allowedEmails: new Set(emails) };
}
export async function authenticate(
  request: Request,
  env: Env,
  options: { keys?: JWTVerifyGetKey; currentDate?: Date } = {},
): Promise<Identity | null> {
  const machine = new URL(request.url).pathname === '/api/codex' && request.method === 'POST';
  if (isLocal(request, env))
    return machine ? null : { owner: 'local@blai.test', email: 'local@blai.test', local: true };
  const settings = accessSettings(env);
  if (!settings)
    throw new AppError(
      503,
      'access_not_configured',
      'Configure this designer’s Cloudflare Access team domain, audience, and allowed owner email before using the hosted workspace.',
    );
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384)
    throw new AppError(401, 'sign_in_required', 'Sign in through Cloudflare Access.');
  let payload;
  try {
    let keyset = options.keys ?? keys.get(settings.issuer);
    if (!keyset) {
      keyset = createRemoteJWKSet(new URL(`${settings.issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
        cacheMaxAge: 600000,
      });
      keys.set(settings.issuer, keyset);
    }
    ({ payload } = await jwtVerify(token, keyset, {
      algorithms: ['RS256'],
      issuer: settings.issuer,
      audience: settings.audience,
      requiredClaims: ['iss', 'aud', 'exp'],
      clockTolerance: 5,
      currentDate: options.currentDate,
    }));
  } catch {
    throw new AppError(
      401,
      'invalid_session',
      'Your Access session could not be verified. Sign in again.',
    );
  }
  if (machine) return null;
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (
    !email ||
    typeof payload.sub !== 'string' ||
    !payload.sub.trim() ||
    !settings.allowedEmails.has(email)
  )
    throw new AppError(403, 'access_denied', 'This account cannot access the designer.');
  return { owner: email, email, local: false };
}
export async function authenticateBridge(request: Request, env: Env): Promise<string> {
  const secret = env.DESIGNER_BRIDGE_SECRET,
    supplied = request.headers.get('x-designer-bridge-key');
  if (!secret || !supplied || supplied.length > 256)
    throw new AppError(401, 'invalid_bridge', 'This designer helper is not authorized.');
  const encode = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encode.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encode.encode(supplied));
  if (!(await crypto.subtle.verify('HMAC', key, signature, encode.encode(secret))))
    throw new AppError(401, 'invalid_bridge', 'This designer helper is not authorized.');
  if (isLocal(request, env)) return 'local@blai.test';
  const owner = env.DESIGNER_OWNER_EMAIL?.trim().toLowerCase();
  if (!owner || !accessSettings(env)?.allowedEmails.has(owner))
    throw new AppError(
      503,
      'helper_owner_missing',
      'Configure DESIGNER_OWNER_EMAIL to match an allowed designer owner.',
    );
  return owner;
}
export function enforceSameOrigin(request: Request): void {
  if (
    ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
    new URL(request.url).pathname === '/api/codex'
  )
    return;
  const origin = request.headers.get('Origin');
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  )
    throw new AppError(403, 'cross_origin', 'Open the designer directly to make changes.');
}
