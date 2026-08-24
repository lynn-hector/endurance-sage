import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  credentialRefField,
  DEFAULT_TIMEOUT_MS,
  endpointField,
  resolveCredential,
  secretField,
  timeoutMsField,
} from '../src/index.ts'

describe('shared config fields', () => {
  it('fills the default timeout and keeps explicit values', () => {
    const Config = z.object({
      endpoint: endpointField('数据源地址'),
      timeoutMs: timeoutMsField(),
    })
    const filled = Config({ endpoint: 'https://example.com' })
    expect(filled.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(Config({ endpoint: 'https://example.com', timeoutMs: 3000 }).timeoutMs).toBe(3000)
  })

  it('rejects a missing endpoint', () => {
    const Config = z.object({ endpoint: endpointField('数据源地址') })
    expect(() => Config({})).toThrow()
  })

  it('carries credential-ref and secret roles for configuration surfaces', () => {
    expect(credentialRefField('用户名引用').meta?.role).toBe('credential-ref')
    expect(secretField('内联凭据').meta?.role).toBe('secret')
  })
})

describe('resolveCredential', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('falls back to the process environment when no credentials seam is mounted', async () => {
    vi.stubEnv('SENTRY_TEST_CREDENTIAL', 'from-env')
    const ctx = new Context()
    await expect(resolveCredential(ctx, 'SENTRY_TEST_CREDENTIAL')).resolves.toBe('from-env')
  })

  it('returns undefined when the reference is unset everywhere', async () => {
    const ctx = new Context()
    await expect(resolveCredential(ctx, 'SENTRY_TEST_MISSING')).resolves.toBeUndefined()
  })

  it('treats empty environment values as unset', async () => {
    vi.stubEnv('SENTRY_TEST_EMPTY', '')
    const ctx = new Context()
    await expect(resolveCredential(ctx, 'SENTRY_TEST_EMPTY')).resolves.toBeUndefined()
  })

  it('rejects a malformed reference name', async () => {
    const ctx = new Context()
    await expect(resolveCredential(ctx, 'not a ref')).rejects.toThrow(TypeError)
  })
})
