import { z } from 'zod'

export const ENV_BINDING_RECORD_TYPE = 'plugin:dsh-sentry/env-binding' as const

export const envBindingRecordSchema = z.object({
  v: z.literal(1),
  envName: z.string().min(1),
  changedAt: z.iso.datetime({ offset: true }),
  source: z.enum(['tool', 'sdk', 'default', 'migration', 'recovery']),
}).strict()

export type EnvBindingSource = z.infer<typeof envBindingRecordSchema>['source']
export type EnvBindingRecord = z.infer<typeof envBindingRecordSchema>

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** Session route only; endpoints, credential references, and secrets are forbidden. */
    [ENV_BINDING_RECORD_TYPE]: EnvBindingRecord
  }
}
