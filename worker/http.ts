import type { z } from 'zod';
import { boundedJsonDepth } from '../shared/validation';
import { AppError } from './types';

export const noCache = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: noCache });
}
export async function readBounded(request: Request | Response, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > limit)
    throw new AppError(413, 'too_large', 'This upload or request is too large.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AppError(413, 'too_large', 'This upload or request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
  limit = 2 * 1024 * 1024,
): Promise<T> {
  if (!request.headers.get('Content-Type')?.includes('application/json'))
    throw new AppError(415, 'json_required', 'Send an application/json request.');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await readBounded(request, limit)));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, 'invalid_json', 'The request contains invalid JSON.');
  }
  if (!boundedJsonDepth(raw))
    throw new AppError(400, 'too_deep', 'The document is nested too deeply.');
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new AppError(
      400,
      'invalid_input',
      result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'Request'}: ${i.message}`)
        .join('; '),
    );
  return result.data;
}
