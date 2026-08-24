import { describe, expect, it } from 'vitest'
import { toTicketRow } from '../src/index.ts'
import type { TapdBug } from '@dsh-sentry/service-tapd'

describe('toTicketRow', () => {
  it('keeps the list fields and hides absent detail fields', () => {
    const bug: TapdBug = {
      id: '1136382267300123456', title: '通话中断', status: 'in_progress',
      severity: 'High', priority: 'High', current_owner: 'yangfm',
      reporter: 'tester', created: '2026-08-24 10:00:00', modified: '2026-08-24 11:00:00',
    }
    const row = toTicketRow(bug)
    expect(row.id).toBe('1136382267300123456')
    expect(row).not.toHaveProperty('description')
    expect(row).not.toHaveProperty('resolution')
  })

  it('detail fields appear only when the service returned them', () => {
    const bug = {
      id: '1', title: 't', status: 'resolved', severity: 'Middle', priority: 'Middle',
      current_owner: 'a', reporter: 'b', created: 'c', modified: 'm',
      description: '现象描述', resolution: 'fixed', fixer: 'dev1',
    } as TapdBug
    const row = toTicketRow(bug)
    expect(row.description).toBe('现象描述')
    expect(row.resolution).toBe('fixed')
    expect(row.fixer).toBe('dev1')
  })
})
