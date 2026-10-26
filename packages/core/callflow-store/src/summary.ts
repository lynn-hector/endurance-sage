/**
 * Lightweight SIP call-flow summary extraction.
 *
 * Aggregates raw `hep_1` rows into what signal-layer triage needs: method
 * counts, first/last timestamps, call milestones (INVITE / 180 / 200 / BYE /
 * CANCEL), post-dial delay, >=400 response counts, and the distinct
 * `call_id` / `trace_id` values (the latter bridging back to app-layer logs
 * and Jaeger). Aggregation only — the agent does the reasoning.
 *
 * `sip_method` mixes method names and response-code strings (`INVITE`,
 * `180`, `487`); pure three-digit values are responses. A `200` only counts
 * as the answer when an INVITE was seen and no CANCEL precedes it — a plain
 * REGISTER flow's 200 is a registration success, and a cancelled call's 200
 * acknowledges the CANCEL itself, neither is a call answer.
 *
 * @module @dsh-sentry/callflow-store/summary
 */

/** Milestone timestamps of one call; absent when the event never occurred. */
export interface CallMilestones {
  invite_at?: string
  ringing_at?: string
  answer_at?: string
  bye_at?: string
  cancel_at?: string
}

/** Aggregated view over one call's signaling rows. */
export interface CallSummary {
  total: number
  first_at?: string
  last_at?: string
  method_counts: Record<string, number>
  milestones: CallMilestones
  /** `answer_at - invite_at` in ms; absent unless both exist. */
  pdd_ms?: number
  /** Count per SIP response code >= 400, excluding 401 auth challenges. */
  error_responses: Record<string, number>
  /** Distinct non-empty `call_id` values, first-seen order. More than one means the `trace_id = ?` side of the dual-key match pulled in other calls. */
  call_ids: string[]
  /** Distinct non-empty `trace_id` values, first-seen order. */
  trace_ids: string[]
}

/** Options for {@link summarizeCallFlow}. */
export interface ExtractCallSummaryOptions {
  /** Timestamp column; defaults to `greptime_timestamp`. */
  timestampCol?: string
}

const RESPONSE_CODE = /^\d{3}$/

function tsOf(row: Record<string, unknown>, timestampCol: string): string {
  return String(row[timestampCol] ?? '')
}

/** Extract the call summary from signaling rows (any input order). */
export function summarizeCallFlow(
  messages: Record<string, unknown>[],
  options: ExtractCallSummaryOptions = {},
): CallSummary {
  const timestampCol = options.timestampCol ?? 'greptime_timestamp'
  const summary: CallSummary = {
    total: messages.length,
    method_counts: {},
    milestones: {},
    error_responses: {},
    call_ids: [],
    trace_ids: [],
  }
  if (messages.length === 0) return summary

  const ordered = [...messages].sort(
    (a, b) => Date.parse(tsOf(a, timestampCol)) - Date.parse(tsOf(b, timestampCol)),
  )
  summary.first_at = tsOf(ordered[0]!, timestampCol)
  summary.last_at = tsOf(ordered[ordered.length - 1]!, timestampCol)

  let sawInvite = false
  let sawCancel = false
  const seenCallIds = new Set<string>()
  const seenTraceIds = new Set<string>()
  for (const row of ordered) {
    const method = String(row['sip_method'] ?? '')
    if (method !== '') summary.method_counts[method] = (summary.method_counts[method] ?? 0) + 1

    // 401 is the normal SIP auth challenge (REGISTER / INVITE digest flow),
    // not a call failure.
    if (RESPONSE_CODE.test(method) && Number(method) >= 400 && method !== '401') {
      summary.error_responses[method] = (summary.error_responses[method] ?? 0) + 1
    }

    const at = tsOf(row, timestampCol)
    switch (method) {
      case 'INVITE':
        sawInvite = true
        if (summary.milestones.invite_at === undefined) summary.milestones.invite_at = at
        break
      case '180':
      case '183':
        // 180 Ringing / 183 Session Progress (early media) both mark ringback.
        if (summary.milestones.ringing_at === undefined) summary.milestones.ringing_at = at
        break
      case '200':
        // Only a 200 after INVITE is the answer — and a CANCEL already seen
        // means this 200 acknowledges the CANCEL itself, not the call
        // (INVITE → 180 → CANCEL → 200 → 487 is the classic cancel sequence).
        if (sawInvite && !sawCancel && summary.milestones.answer_at === undefined) summary.milestones.answer_at = at
        break
      case 'BYE':
        if (summary.milestones.bye_at === undefined) summary.milestones.bye_at = at
        break
      case 'CANCEL':
        sawCancel = true
        if (summary.milestones.cancel_at === undefined) summary.milestones.cancel_at = at
        break
    }

    const rowCallId = String(row['call_id'] ?? '').trim()
    if (rowCallId !== '' && !seenCallIds.has(rowCallId)) {
      seenCallIds.add(rowCallId)
      summary.call_ids.push(rowCallId)
    }

    const traceId = String(row['trace_id'] ?? '').trim()
    if (traceId !== '' && !seenTraceIds.has(traceId)) {
      seenTraceIds.add(traceId)
      summary.trace_ids.push(traceId)
    }
  }

  if (summary.milestones.invite_at !== undefined && summary.milestones.answer_at !== undefined) {
    summary.pdd_ms = Date.parse(summary.milestones.answer_at) - Date.parse(summary.milestones.invite_at)
  }
  return summary
}
