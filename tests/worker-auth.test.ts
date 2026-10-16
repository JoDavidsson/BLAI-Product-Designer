import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { authenticate, authenticateBridge, enforceSameOrigin } from '../worker/auth';
import type { Env } from '../worker/types';

describe('designer authentication', () => {
  it('requires explicit local mode and a loopback hostname; ignores forged identity headers', async () => {
    const local = new Request('http://localhost/api/projects');
    await expect(authenticate(local, {} as Env)).rejects.toThrow(/Configure/);
    expect(await authenticate(local, { DEV_AUTH: 'local' } as Env)).toMatchObject({
      owner: 'local@blai.test',
      local: true,
    });
    await expect(
      authenticate(
        new Request('https://designer.example.com/api/projects', {
          headers: { 'oai-authenticated-user-email': 'owner@example.com' },
        }),
        { DEV_AUTH: 'local' } as Env,
      ),
    ).rejects.toThrow(/Configure/);
  });
  it('verifies audience, signature and owner allowlist; a service session cannot become a user', async () => {
    const pair = await generateKeyPair('RS256');
    const env = {
      CF_ACCESS_TEAM_DOMAIN: 'designer.cloudflareaccess.com',
      CF_ACCESS_AUD: 'designer-aud',
      AUTH_ALLOWED_EMAILS: 'owner@example.com',
    } as Env;
    const token = async (claims: Record<string, unknown>, audience = 'designer-aud') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer('https://designer.cloudflareaccess.com')
        .setAudience(audience)
        .setExpirationTime('5m')
        .sign(pair.privateKey);
    const request = async (claims: Record<string, unknown>, aud?: string) =>
      new Request('https://designer.example.com/api/projects', {
        headers: { 'Cf-Access-Jwt-Assertion': await token(claims, aud) },
      });
    const options = { keys: async () => pair.publicKey };
    expect(
      await authenticate(
        await request({ sub: 'verified', email: 'OWNER@example.com' }),
        env,
        options,
      ),
    ).toMatchObject({ owner: 'owner@example.com', local: false });
    await expect(
      authenticate(await request({ sub: 'verified', email: 'other@example.com' }), env, options),
    ).rejects.toThrow(/cannot access/);
    await expect(
      authenticate(await request({ sub: 'service-token' }), env, options),
    ).rejects.toThrow(/cannot access/);
    await expect(
      authenticate(
        await request({ sub: 'verified', email: 'owner@example.com' }, 'writer-aud'),
        env,
        options,
      ),
    ).rejects.toThrow(/verified/);
  });
  it('keeps bridge credentials separate and rejects browser cross-origin mutations', async () => {
    const env = { DEV_AUTH: 'local', DESIGNER_BRIDGE_SECRET: 'test-designer-only' } as Env;
    await expect(
      authenticateBridge(
        new Request('http://localhost/api/codex', {
          headers: { 'x-writing-bridge-key': 'test-designer-only' },
        }),
        env,
      ),
    ).rejects.toThrow(/not authorized/);
    expect(
      await authenticateBridge(
        new Request('http://localhost/api/codex', {
          headers: { 'x-designer-bridge-key': 'test-designer-only' },
        }),
        env,
      ),
    ).toBe('local@blai.test');
    expect(() =>
      enforceSameOrigin(
        new Request('http://localhost/api/projects', {
          method: 'POST',
          headers: { Origin: 'https://attacker.example' },
        }),
      ),
    ).toThrow(/directly/);
  });
});
