/**
 * Backend-neutral message-queue inspection Service Definition.
 *
 * A Provider implements this seam and owns the console protocol, cluster
 * connection, authentication and session refresh. The vocabulary stays in
 * message-domain terms — a topic's message list within a time window, and
 * one message's body with its consumption tracks; endpoints, session
 * cookies and console paths never cross this seam.
 *
 * @module @dsh-sentry/mq-store
 */

import { Context, Service } from '@deepseek-ai/cordis'

export { parseTimeMs } from './time.ts'

/** One row of a message-list page, kept raw for the evidence layer. */
export type MqMessageRow = Record<string, unknown>

/** Message-list intent; times are epoch milliseconds. */
export interface MqMessageListRequest {
  /** Topic to page through. */
  topic: string
  /** Window start in epoch ms. */
  beginMs: number
  /** Window end in epoch ms. */
  endMs: number
  /** 1-based page number; Providers default to 1. */
  pageNum?: number
  /** Page size; Providers default to 10. */
  pageSize?: number
  /** Substring filter on message bodies, when the backend supports one. */
  keyword?: string
}

/** Aggregated message-list answer the evidence layer shapes. */
export interface MqMessageListResult {
  /** Backend status marker; 0 conventionally means success. */
  status: unknown
  /** Backend error message, when provided. */
  errMsg: string | null
  /** Backend scan-task identifier, when the backend runs an async scan. */
  taskId: unknown
  /** True when the backend truncated the scan window. */
  truncated: boolean
  /** Number of messages the backend reports having scanned. */
  scanned: number
  /** Total elements across pages, when reported. */
  totalElements: number | null
  /** Total pages, when reported. */
  totalPages: number | null
  /** The requested page's messages, raw. */
  messages: MqMessageRow[]
  /** Full backend response, for raw evidence. */
  raw: Record<string, unknown>
}

/** One message's detail-and-tracks intent. */
export interface MqMessageDetailRequest {
  /** Topic the message belongs to. */
  topic: string
  /** Message id to look up. */
  msgId: string
}

/** Aggregated message-detail answer the evidence layer shapes. */
export interface MqMessageDetailResult {
  /** Backend status marker; 0 conventionally means success. */
  status: unknown
  /** Backend error message, when provided. */
  errMsg: string | null
  /** Message body and metadata, raw. */
  messageView: Record<string, unknown>
  /** Consumption tracks: which consumer groups consumed / missed / filtered it. */
  messageTrackList: Record<string, unknown>[]
  /** Full backend response, for raw evidence. */
  raw: Record<string, unknown>
}

/**
 * Exactly one mq Provider occupies this slot in a Context. All methods are
 * read-only; login, session validation and 401/403 re-login are Provider
 * internals, never Consumer choreography.
 */
export abstract class MqStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mqStore')
  }

  /** Stable, non-secret backend identity used in evidence refs. */
  abstract get backendRef(): string

  /** Page through a topic's messages within the time window. */
  abstract queryMessages(request: MqMessageListRequest): Promise<MqMessageListResult>

  /** Fetch one message's body and its consumption tracks. */
  abstract queryMessageDetail(request: MqMessageDetailRequest): Promise<MqMessageDetailResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mqStore: MqStore
  }
}

export default MqStore
