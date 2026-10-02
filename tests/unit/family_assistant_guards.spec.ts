import { test } from '@japa/runner'
import { familyToolExecutor } from '#services/assistant/family_tools'
import { normalizePhone, maskPhone } from '#services/whatsapp'

/**
 * Security guards for the family assistant that must hold regardless of
 * what the model asks for. These run without a database: every guard
 * rejects before any query is made.
 */
function fakeAccess(opts: { wards: number[]; self?: number }) {
  const ids = [...opts.wards, ...(opts.self ? [opts.self] : [])]
  return {
    students: ids.map((id) => ({ id, firstName: `S${id}`, lastName: 'Test', classId: null, schoolClass: null })) as any,
    isParent: opts.wards.length > 0,
    isStudent: !!opts.self,
    wardIds: new Set(opts.wards),
  }
}

test.group('family assistant tool guards', () => {
  const tools = [
    'get_report_card',
    'get_attendance',
    'get_timetable',
    'get_fees',
    'get_assignments',
    'get_exam_results',
    'get_pickup_code',
  ]

  for (const name of tools) {
    test(`${name} refuses a student who is not linked to the caller`, async ({ assert }) => {
      const exec = familyToolExecutor({} as any, 1, fakeAccess({ wards: [10, 11] }))
      await assert.rejects(
        () => exec(name, { studentId: 999, termId: null, period: 'last_7_days', day: 'today', filter: 'recent_all' }),
        /not linked to this account/
      )
    })
  }

  test('pickup code is refused to a student asking about themself', async ({ assert }) => {
    const exec = familyToolExecutor({} as any, 1, fakeAccess({ wards: [], self: 20 }))
    const out = (await exec('get_pickup_code', { studentId: 20 })) as { error?: string }
    assert.match(out.error ?? '', /only given to parents/)
  })

  test('unknown tools return an error instead of throwing', async ({ assert }) => {
    const exec = familyToolExecutor({} as any, 1, fakeAccess({ wards: [10] }))
    const out = (await exec('drop_tables', {})) as { error?: string }
    assert.match(out.error ?? '', /Unknown tool/)
  })
})

test.group('whatsapp phone handling', () => {
  test('normalises Nigerian numbers to E.164 digits', ({ assert }) => {
    assert.equal(normalizePhone('08031234567'), '2348031234567')
    assert.equal(normalizePhone('+234 803 123 4567'), '2348031234567')
    assert.equal(normalizePhone('8031234567'), '2348031234567')
    assert.equal(normalizePhone('002348031234567'), '2348031234567')
    assert.equal(normalizePhone('447700900123'), '447700900123')
  })

  test('masks all but the last four digits', ({ assert }) => {
    assert.equal(maskPhone('2348031234567'), '+234 *** *** 4567')
  })
})
