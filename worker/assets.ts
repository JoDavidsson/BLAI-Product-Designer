import { uid, type BoardAsset } from '../shared/model';
import { AppError, type Env } from './types';
import { readBounded } from './http';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}
export function detectImage(bytes: Uint8Array): string | null {
  if (bytes.length < 16) return null;
  if (
    bytes[0] === 137 &&
    ascii(bytes, 1, 4) === 'PNG' &&
    bytes[4] === 13 &&
    bytes[5] === 10 &&
    bytes[6] === 26 &&
    bytes[7] === 10 &&
    ascii(bytes, 12, 16) === 'IHDR' &&
    bytes.length >= 45 &&
    ascii(bytes, bytes.length - 8, bytes.length - 4) === 'IEND'
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      w = view.getUint32(16),
      h = view.getUint32(20);
    return w && h && w <= 24000 && h <= 24000 && w * h <= 100000000 ? 'image/png' : null;
  }
  if (
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  )
    return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6)) && bytes[bytes.length - 1] === 59) {
    const w = bytes[6] + bytes[7] * 256,
      h = bytes[8] + bytes[9] * 256;
    return w && h && w * h <= 100000000 ? 'image/gif' : null;
  }
  if (
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 16)) &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 ===
      bytes.length
  )
    return 'image/webp';
  return null;
}
function verifyImage(bytes: Uint8Array, declared: string): string {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new AppError(413, 'image_too_large', 'Choose an image smaller than 10 MB.');
  const mime = declared.toLowerCase().split(';')[0].trim(),
    detected = detectImage(bytes);
  if (!imageTypes.has(mime) || detected !== mime)
    throw new AppError(
      415,
      'unsupported_image',
      'Use a valid PNG, JPEG, GIF, or WebP image. SVG and mismatched file types are not accepted.',
    );
  return detected;
}
export async function storeImage(
  env: Env,
  owner: string,
  projectId: string,
  bytes: Uint8Array,
  mime: string,
  title: string,
  kind: BoardAsset['kind'],
  sourceUrl = '',
): Promise<BoardAsset> {
  const contentType = verifyImage(bytes, mime),
    key = uid('asset'),
    createdAt = new Date().toISOString();
  await env.ASSETS_BUCKET.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { owner, projectId },
  });
  try {
    await env.DB.prepare(
      'INSERT INTO assets(key,owner,project_id,mime,bytes,created_at) VALUES(?,?,?,?,?,?)',
    )
      .bind(key, owner, projectId, contentType, bytes.length, createdAt)
      .run();
  } catch (error) {
    await env.ASSETS_BUCKET.delete(key);
    throw error;
  }
  return {
    id: key,
    title: title.slice(0, 200) || 'Untitled reference',
    kind,
    imageUrl: `/api/assets/${key}`,
    sourceUrl,
    note: '',
    createdAt,
  };
}
export async function uploadImage(
  request: Request,
  env: Env,
  owner: string,
  projectId: string,
): Promise<BoardAsset> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.startsWith('multipart/form-data;'))
    throw new AppError(415, 'multipart_required', 'Upload an image using multipart/form-data.');
  const bytes = await readBounded(request, MAX_IMAGE_BYTES + 65536);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(bytes).buffer, {
      headers: { 'Content-Type': contentType },
    }).formData();
  } catch {
    throw new AppError(400, 'invalid_upload', 'The image upload could not be read.');
  }
  const file = form.get('file'),
    kind = form.get('kind'),
    title = form.get('title');
  if (!(file instanceof File))
    throw new AppError(400, 'file_required', 'Choose an image to upload.');
  if (kind !== 'reference' && kind !== 'screenshot')
    throw new AppError(400, 'invalid_kind', 'Choose a reference or implementation screenshot.');
  if (typeof title === 'string' && title.length > 200)
    throw new AppError(400, 'title_too_long', 'Keep image titles under 200 characters.');
  return storeImage(
    env,
    owner,
    projectId,
    new Uint8Array(await file.arrayBuffer()),
    file.type,
    typeof title === 'string' ? title : file.name,
    kind,
  );
}
export function publicImageUrl(raw: string): URL {
  if (raw.length > 2048)
    throw new AppError(
      400,
      'url_too_long',
      'Use a direct image URL shorter than 2,048 characters.',
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'invalid_url', 'Enter a public HTTPS image or webpage URL.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    host.length > 253 ||
    !host.includes('.') ||
    host.startsWith('[') ||
    /^\d+(\.\d+){3}$/.test(host) ||
    /(?:^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) ||
    !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
  )
    throw new AppError(
      400,
      'unsafe_url',
      'Use a public HTTPS hostname without credentials, a custom port, or a local/private address.',
    );
  url.hash = '';
  return url;
}
export function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const v = address.toLowerCase();
    // Only global-unicast IPv6; reject mapped IPv4, special/documentation and local ranges.
    const [first, second = 0] = v.split(':').map((part) => Number.parseInt(part || '0', 16));
    return (
      /^[23][0-9a-f]{3}:/.test(v) &&
      !v.includes('.') &&
      first !== 0x2002 &&
      first !== 0x3fff &&
      !(first === 0x2001 && (Number(second) < 0x200 || second === 0xdb8))
    );
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isInteger(v) || v < 0 || v > 255))
    return false;
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export async function assertPublicDns(url: URL, fetcher: typeof fetch = fetch): Promise<void> {
  const answers = await Promise.all(
    ['A', 'AAAA'].map(async (type) => {
      const dns = new URL('https://cloudflare-dns.com/dns-query');
      dns.searchParams.set('name', url.hostname);
      dns.searchParams.set('type', type);
      let response: Response;
      try {
        response = await fetcher(dns, {
          headers: { Accept: 'application/dns-json' },
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
      } catch {
        throw new AppError(
          502,
          'dns_unavailable',
          'Could not verify this image host. Try uploading the image instead.',
        );
      }
      if (!response.ok)
        throw new AppError(
          502,
          'dns_unavailable',
          'Could not verify this image host. Try uploading the image instead.',
        );
      const data = (await response.json()) as {
        Status?: number;
        Answer?: { type: number; data: string }[];
      };
      if (data.Status !== 0)
        throw new AppError(
          400,
          'unknown_host',
          'This hostname could not be resolved. Check the URL or upload the image.',
        );
      return data.Answer ?? [];
    }),
  );
  const all = answers.flat(),
    addresses = all.filter((a) => a.type === 1 || a.type === 28);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.data)))
    throw new AppError(
      400,
      'private_destination',
      'Images must come from a public host. Local and private destinations are blocked.',
    );
  for (const a of all.filter((a) => a.type === 5))
    publicImageUrl(`https://${a.data.replace(/\.$/, '')}/`);
}
export async function importImage(
  env: Env,
  owner: string,
  projectId: string,
  input: { url: string; title?: string; kind?: BoardAsset['kind'] },
  fetcher: typeof fetch = fetch,
): Promise<BoardAsset> {
  let url = publicImageUrl(input.url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertPublicDns(url, fetcher);
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif,text/html;q=0.5' },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new AppError(
        502,
        'import_failed',
        'The image host could not be reached. Download the image and upload it instead.',
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('Location');
      await response.body?.cancel();
      if (!next || redirects === 3)
        throw new AppError(
          400,
          'redirect_limit',
          'This URL redirects too many times. Use the final direct image URL.',
        );
      url = publicImageUrl(new URL(next, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        400,
        'remote_unavailable',
        `The image host returned ${response.status}. Try a direct image URL or upload the file.`,
      );
    }
    const mime = (response.headers.get('Content-Type') ?? '').toLowerCase().split(';')[0];
    const title = (input.title || url.hostname).slice(0, 200);
    if (mime === 'text/html' || mime === 'application/xhtml+xml') {
      await response.body?.cancel();
      return {
        id: uid('reference'),
        title,
        kind: input.kind ?? 'reference',
        imageUrl: '',
        sourceUrl: url.href,
        note: 'Webpage reference. Upload an image or use a direct image URL for a visual preview.',
        createdAt: new Date().toISOString(),
      };
    }
    if (!imageTypes.has(mime)) {
      await response.body?.cancel();
      throw new AppError(
        415,
        'unsupported_image',
        'The URL did not return a supported image or webpage. Use a direct PNG, JPEG, GIF, or WebP URL.',
      );
    }
    return storeImage(
      env,
      owner,
      projectId,
      await readBounded(response, MAX_IMAGE_BYTES),
      mime,
      title,
      input.kind ?? 'reference',
      url.href,
    );
  }
  throw new AppError(400, 'import_failed', 'The image could not be imported.');
}
export async function serveAsset(env: Env, owner: string, key: string): Promise<Response> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key))
    throw new AppError(404, 'asset_not_found', 'Image not found.');
  const row = await env.DB.prepare('SELECT project_id,mime FROM assets WHERE key=? AND owner=?')
    .bind(key, owner)
    .first<{ project_id: string; mime: string }>();
  if (!row) throw new AppError(404, 'asset_not_found', 'Image not found.');
  const object = await env.ASSETS_BUCKET.get(key);
  if (
    !object ||
    object.customMetadata?.owner !== owner ||
    object.customMetadata?.projectId !== row.project_id
  )
    throw new AppError(404, 'asset_not_found', 'Image not found.');
  return new Response(object.body, {
    headers: {
      'Content-Type': row.mime,
      'Content-Length': String(object.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    },
  });
}
