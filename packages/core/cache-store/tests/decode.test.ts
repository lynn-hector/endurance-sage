import { describe, expect, it } from 'vitest'
import { decodeContent } from '../src/index.ts'

/** decodeContent moved verbatim from tool-redis-inspector when value decoding relocated into the Definition. */

describe('decodeContent — port of _decode_content', () => {
  it('decodes base64 text and parses JSON objects/arrays into values', () => {
    const json = decodeContent({ raw_base64: Buffer.from('{"a":1}', 'utf8').toString('base64'), encoding: 'utf8' })
    expect(json).toEqual({ value: { a: 1 }, encoding: 'utf8' })

    const array = decodeContent({ raw_base64: Buffer.from('[1,2]', 'utf8').toString('base64') })
    expect(array.value).toEqual([1, 2])
    expect(array.encoding).toBe('utf8')
  })

  it('keeps JSON scalars and non-JSON text as plain text', () => {
    expect(decodeContent({ raw_base64: Buffer.from('42', 'utf8').toString('base64') }).value).toBe('42')
    expect(decodeContent({ raw_base64: Buffer.from('hello', 'utf8').toString('base64') }).value).toBe('hello')
  })

  it('returns null for missing content or empty raw_base64', () => {
    expect(decodeContent(undefined)).toEqual({ value: null, encoding: '' })
    expect(decodeContent({ raw_base64: '' })).toEqual({ value: null, encoding: 'utf8' })
  })

  it('replaces undecodable bytes instead of failing', () => {
    // Invalid UTF-8 sequence decodes with replacement characters.
    const value = decodeContent({ raw_base64: Buffer.from([0xff, 0xfe, 0x41]).toString('base64') }).value
    expect(typeof value).toBe('string')
    expect(value as string).toContain('A')
  })
})
