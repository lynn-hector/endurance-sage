import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

/**
 * Client-selected contribution for the package-owned host service.
 *
 * TypertRemoteService and @Remote expose the method to the host Gateway; the
 * browser namespace still has to be mounted explicitly before a child plugin
 * can inject `remote.sentrySettings`.
 */
export const sentrySettingsRemote = createTypertRemoteInfo({
  package: '@dsh-sentry/ui-settings',
  methods: {
    'sentrySettings/getDefaultEnv': {
      service: 'sentrySettings',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@dsh-sentry/ui-settings#DefaultEnvInfo',
        create: () => z.object({
          preference: z.string().optional(),
          effectiveEnv: z.string(),
          assemblyEnv: z.string(),
        }),
        jsonSchema: {
          type: 'object',
          properties: {
            preference: { type: 'string' },
            effectiveEnv: { type: 'string' },
            assemblyEnv: { type: 'string' },
          },
          required: ['effectiveEnv', 'assemblyEnv'],
          additionalProperties: true,
        },
      },
    },
    'sentrySettings/getGlobalConfig': {
      service: 'sentrySettings',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@dsh-sentry/ui-settings#GlobalConfigInfo',
        create: () => z.object({
          codeBaseDir: z.string().optional(),
        }),
        jsonSchema: {
          type: 'object',
          properties: {
            codeBaseDir: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
  },
}, z)
