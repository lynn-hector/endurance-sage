import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import {
  ENV_BINDING_RECORD_TYPE,
  envBindingRecordSchema,
  type EnvBindingRecord,
} from './record.ts'

export const ENV_BINDING_PROJECTION_KEY = 'dshSentryEnvBinding' as const

export interface EnvBindingProjectionState {
  readonly record: EnvBindingRecord | null
  readonly seq: number | null
}

export const envBindingProjectionStateSchema = z.object({
  record: envBindingRecordSchema.nullable(),
  seq: z.number().int().nonnegative().nullable(),
}).strict()

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    [ENV_BINDING_PROJECTION_KEY]: EnvBindingProjectionState
  }
}

export const envBindingProjection: ProjectionDefinition<typeof ENV_BINDING_PROJECTION_KEY> = {
  key: ENV_BINDING_PROJECTION_KEY,
  stateSchema: envBindingProjectionStateSchema,
  stateVersion: 1,
  init: () => ({ record: null, seq: null }),
  apply(state, event) {
    const record = pluginRecordOf(event)
    if (record?.type !== ENV_BINDING_RECORD_TYPE) return state
    const parsed = envBindingRecordSchema.safeParse(record.data)
    if (!parsed.success) return state
    return { record: parsed.data, seq: record.seq }
  },
}
