/**
 * Unified evidence envelope, the TS form of `templates/evidence-format.md`.
 *
 * Every dsh-sentry tool returns this shape so the agent can aggregate and
 * cross-verify evidence across data sources. Replaces the original
 * `skills/lib/evidence.py` — which only metrics-inspector actually used;
 * every other script hand-built the envelope. One typed builder closes that
 * drift.
 *
 * @module @dsh-sentry/evidence
 */

import { randomUUID } from 'node:crypto'

/**
 * Evidence types documented in `templates/evidence-format.md`, plus `alert`
 * and `cicd`, which the original metrics-inspector / zadig-inspector emitted
 * without the contract listing them (recorded drift; kept deliberately).
 */
export const KNOWN_EVIDENCE_TYPES = [
  'log',
  'trace',
  'code',
  'metric',
  'alert',
  'db',
  'redis',
  'mq',
  'cicd',
  'inference',
] as const

/** Documented evidence types. */
export type KnownEvidenceType = (typeof KNOWN_EVIDENCE_TYPES)[number]

/**
 * Evidence type tag. Open on purpose: the original contract says "string"
 * while listing known values, and scripts already stepped outside the list.
 * New recurring types should be promoted into {@link KNOWN_EVIDENCE_TYPES}.
 */
export type EvidenceType = KnownEvidenceType | (string & {})

/** One evidence record; see `templates/evidence-format.md` for semantics. */
export interface Evidence {
  /** Unique identifier (uuid). */
  id: string
  /** Producing skill/tool id, e.g. "log-analyzer". */
  source: string
  /** Evidence type tag. */
  type: EvidenceType
  /** Generation time, ISO8601 with `Z` suffix. */
  timestamp: string
  /** Payload; shape defined by the producing tool. */
  data: Record<string, unknown>
  /** One-sentence summary for quick scanning. */
  summary: string
  /** Confidence in [0, 1]; low when uncertain. */
  confidence: number
  /** Reasoning trace; required in practice for `inference` evidence. */
  reasoning?: string
  /** Locatable references: log lines, traceIds, file paths, URLs. */
  refs?: string[]
}

/** The wire envelope every tool returns: `{ evidence: {...} }`. */
export interface EvidenceEnvelope {
  evidence: Evidence
}

/** Input to {@link buildEvidence}. */
export interface BuildEvidenceOptions {
  source: string
  type: EvidenceType
  data: Record<string, unknown>
  summary: string
  confidence: number
  reasoning?: string
  refs?: string[]
}

/** Current UTC time as ISO8601 with `Z` suffix and second precision. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Build a conforming evidence envelope. Throws when `confidence` falls
 * outside [0, 1], matching the original Python builder's contract.
 */
export function buildEvidence(options: BuildEvidenceOptions): EvidenceEnvelope {
  const { source, type, data, summary, confidence, reasoning, refs } = options
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError(`confidence must be in [0, 1], got ${confidence}`)
  }
  const evidence: Evidence = {
    id: randomUUID(),
    source,
    type,
    timestamp: nowIso(),
    data,
    summary,
    confidence,
  }
  if (reasoning !== undefined) evidence.reasoning = reasoning
  if (refs !== undefined) evidence.refs = refs
  return { evidence }
}

/**
 * Build the failure-form envelope: `confidence = 0` and `data.error` carries
 * the cause, so the agent parses success and failure through one schema.
 */
export function buildEvidenceError(options: {
  source: string
  type: EvidenceType
  error: string
  summary: string
  refs?: string[]
}): EvidenceEnvelope {
  return buildEvidence({
    source: options.source,
    type: options.type,
    data: { error: options.error },
    summary: options.summary,
    confidence: 0,
    ...options.refs !== undefined ? { refs: options.refs } : {},
  })
}

/**
 * Validate an unknown value against the evidence contract.
 * @returns a list of violations; empty means conforming.
 */
export function validateEvidence(value: unknown): string[] {
  const violations: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['evidence envelope must be an object']
  }
  const envelope = value as Record<string, unknown>
  const evidence = envelope['evidence']
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return ['evidence envelope must carry an "evidence" object']
  }
  const record = evidence as Record<string, unknown>

  if (typeof record['id'] !== 'string' || record['id'].length === 0) {
    violations.push('evidence.id must be a non-empty string')
  }
  if (typeof record['source'] !== 'string' || record['source'].length === 0) {
    violations.push('evidence.source must be a non-empty string')
  }
  if (typeof record['type'] !== 'string' || record['type'].length === 0) {
    violations.push('evidence.type must be a non-empty string')
  }
  if (typeof record['timestamp'] !== 'string' || Number.isNaN(Date.parse(record['timestamp']))) {
    violations.push('evidence.timestamp must be an ISO8601 string')
  }
  if (typeof record['data'] !== 'object' || record['data'] === null || Array.isArray(record['data'])) {
    violations.push('evidence.data must be an object')
  }
  if (typeof record['summary'] !== 'string' || record['summary'].length === 0) {
    violations.push('evidence.summary must be a non-empty string')
  }
  const confidence = record['confidence']
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    violations.push('evidence.confidence must be a number in [0, 1]')
  }
  if (record['reasoning'] !== undefined && typeof record['reasoning'] !== 'string') {
    violations.push('evidence.reasoning must be a string when present')
  }
  if (record['refs'] !== undefined) {
    const refs = record['refs']
    if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string')) {
      violations.push('evidence.refs must be a string array when present')
    }
  }
  return violations
}

/** Type guard form of {@link validateEvidence}. */
export function isEvidenceEnvelope(value: unknown): value is EvidenceEnvelope {
  return validateEvidence(value).length === 0
}
