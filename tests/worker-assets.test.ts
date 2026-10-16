import { describe, expect, it } from 'vitest';
import {
  assertPublicDns,
  detectImage,
  importImage,
  isPublicAddress,
  publicImageUrl,
} from '../worker/assets';
import type { Env } from '../worker/types';

describe('image imports', () => {
  it('blocks local URLs, IP literals, credential URLs and non-HTTPS schemes', () => {
    for (const url of [
      'http://example.com/x.png',
      'https://127.0.0.1/x',
      'https://2130706433/x',
      'https://[::1]/x',
      'https://a.local/x',
      'https://metadata.internal/x',
      'https://u:p@example.com/x',
      'https://example.com:8443/x',
      'file:///etc/passwd',
    ])
      expect(() => publicImageUrl(url)).toThrow();
    expect(publicImageUrl('https://images.example.com/photo.png#pin').href).toBe(
      'https://images.example.com/photo.png',
    );
  });
  it('denies private/reserved DNS answers, including hosts with mixed public and private answers', async () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.1.2',
      '169.254.169.254',
      '100.64.1.1',
      '192.168.1.1',
      '198.18.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2001:0db8::1',
      '2001:20::1',
      '3fff::1',
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    const fetcher = async () =>
      Response.json({
        Status: 0,
        Answer: [
          { type: 1, data: '93.184.216.34' },
          { type: 1, data: '10.1.2.3' },
        ],
      });
    await expect(
      assertPublicDns(new URL('https://example.com'), fetcher as typeof fetch),
    ).rejects.toThrow(/public host/);
  });
  it('requires binary image content and refuses SVG masquerading as PNG', () => {
    expect(
      detectImage(
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      ),
    ).toBeNull();
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
      ),
      (v) => v.charCodeAt(0),
    );
    expect(detectImage(png)).toBe('image/png');
    expect(detectImage(png.slice(0, 20))).toBeNull();
  });
  it('revalidates redirect destinations before following and stores webpages without scraping', async () => {
    const seen: string[] = [];
    const redirectFetch = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(url.href);
      if (url.hostname === 'cloudflare-dns.com')
        return Response.json({
          Status: 0,
          Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [],
        });
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://127.0.0.1/private' },
      });
    };
    await expect(
      importImage(
        {} as Env,
        'owner',
        'project',
        { url: 'https://images.example.com/photo' },
        redirectFetch as typeof fetch,
      ),
    ).rejects.toThrow(/public HTTPS hostname/);
    expect(seen.some((url) => url.includes('127.0.0.1'))).toBe(false);
    const pageFetch = async (input: RequestInfo | URL) =>
      new URL(String(input)).hostname === 'cloudflare-dns.com'
        ? Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
        : new Response('<html><title>Do not scrape</title></html>', {
            headers: { 'Content-Type': 'text/html' },
          });
    const reference = await importImage(
      {} as Env,
      'owner',
      'project',
      { url: 'https://example.com/design' },
      pageFetch as typeof fetch,
    );
    expect(reference.imageUrl).toBe('');
    expect(reference.sourceUrl).toBe('https://example.com/design');
    expect(reference.title).toBe('example.com');
  });
});
