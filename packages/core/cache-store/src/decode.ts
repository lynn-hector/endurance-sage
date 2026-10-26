/**
 * Pure value decoding for cache entries: Providers hand the raw platform
 * payload to {@link decodeContent} so every implementation returns the same
 * reasoning shape.
 *
 * Port of `_decode_content` from `skills/redis-inspector/scripts/inspect.py`:
 * base64-decode `content.raw_base64` with replacement on undecodable bytes,
 * then return parsed JSON only when the text is an object/array (scalars
 * stay text, exactly like the original's `isinstance(parsed, (dict, list))`).
 *
 * @module @dsh-sentry/cache-store/decode
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Decoded cache value plus the encoding label the payload carried. */
export interface DecodedContent {
  value: unknown
  encoding: string
}

/** Base64-decode and best-effort parse one cache entry's content payload. */
export function decodeContent(content: Record<string, unknown> | undefined): DecodedContent {
  if (content === undefined) return { value: null, encoding: '' }
  const rawB64 = content['raw_base64']
  const encoding = (content['encoding'] as string | undefined) ?? 'utf8'
  if (typeof rawB64 !== 'string' || rawB64.length === 0) return { value: null, encoding }

  let text: string
  try {
    text = new TextDecoder(encoding || 'utf8', { fatal: false }).decode(Buffer.from(rawB64, 'base64'))
  } catch (error) {
    return { value: `<decode error: ${errorMessage(error)}>`, encoding }
  }

  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) return { value: parsed, encoding }
  } catch {
    // Not JSON: fall through to plain text, like the original.
  }
  return { value: text, encoding }
}
