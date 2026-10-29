/**
 * Session-scoped environment routing persisted in DSH plugin records.
 * Record/projection read-back helpers remain internal to this package.
 *
 * @module @dsh-sentry/env-binding
 */

export {
  EnvBindingError,
  SessionEnvBindingStore,
  type Config,
  type DefaultEnvInfo,
  type DegradedLeg,
  type EnvBindingErrorCode,
  type EnvSwitchResult,
  type EnvTarget,
  type GlobalConfigInfo,
  type ResolvedEnvBinding,
  type SessionCallContext,
} from './store.ts'
export {
  ENV_BINDING_RECORD_TYPE,
  type EnvBindingRecord,
  type EnvBindingSource,
} from './record.ts'

export { default } from './store.ts'
