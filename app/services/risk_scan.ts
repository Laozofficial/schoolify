import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import Student from '#models/student'
import Term from '#models/term'
import AttendanceRecord from '#models/attendance_record'
import Assignment from '#models/assignment'
import AssignmentSubmission from '#models/assignment_submission'
import ExamAttempt from '#models/exam_attempt'
import FeeInvoice from '#models/fee_invoice'
import StudentRiskFlag, { type RiskSignal } from '#models/student_risk_flag'
import { computeClassResults } from '#services/class_results'
import { aiJson, isAiConfigured } from '#services/ai'
import { naira } from '#services/assistant/family_tools'

/**
 * Early warning scan. RULES decide who is flagged and why (auditable,
 * deterministic); AI only turns the signals into a short explanation and a
 * concrete next step for the class teacher. Fee signals are admin-only and
 * are never sent to the AI.
 */

const TZ = 'Africa/Lagos'

export interface ScanStats {
  scanned: number
  flagged: number
  high: number
  medium: number
  low: number
  reopened: number
}

function levelFor(score: number): 'high' | 'medium' | 'low' {
  return score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low'
}

function pct(n: number) {
  return `${Math.round(n)}%`
}

export async function scanSchool(schoolId: number, opts: { withAi?: boolean } = {}): Promise<ScanStats> {
  const now = DateTime.now().setZone(TZ)
  const today = now.startOf('day')

  const students = await Student.query()
    .where('school_id', schoolId)
    .where('is_archived', false)
    .preload('schoolClass')
  const ids = students.map((s) => s.id)
  const signals = new Map<number, RiskSignal[]>(ids.map((id) => [id, []]))
  const add = (id: number, sig: RiskSignal) => signals.get(id)?.push(sig)

  if (ids.length) {
    /* ---------------- attendance (last 4 weeks) ---------------- */
    const recs = await AttendanceRecord.query()
      .whereIn('attendance_records.student_id', ids)
      .join('attendance_days', 'attendance_days.id', 'attendance_records.attendance_day_id')
      .where('attendance_days.date', '>=', today.minus({ days: 27 }).toISODate()!)
      .select('attendance_records.student_id', 'attendance_records.status', 'attendance_days.date as day_date')
    const att = new Map<number, { total: number; attended: number; recentAbsent: number }>()
    const recentCutoff = today.minus({ days: 13 }).toISODate()!
    for (const r of recs) {
      const a = att.get(r.studentId) ?? { total: 0, attended: 0, recentAbsent: 0 }
      a.total++
      if (r.status === 'present' || r.status === 'late') a.attended++
      const d = DateTime.fromJSDate(new Date(r.$extras.day_date)).toISODate()!
      if (r.status === 'absent' && d >= recentCutoff) a.recentAbsent++
      att.set(r.studentId, a)
    }
    for (const [id, a] of att) {
      const rate = (a.attended / a.total) * 100
      if (a.total >= 6 && rate < 80) {
        add(id, {
          kind: 'attendance_low',
          label: 'Low attendance',
          detail: `Attended ${pct(rate)} of sessions in the last 4 weeks (${a.attended} of ${a.total}).`,
          weight: 2,
        })
      }
      if (a.recentAbsent >= 3) {
        add(id, {
          kind: 'recent_absences',
          label: 'Repeated absences',
          detail: `Absent ${a.recentAbsent} times in the last 2 weeks.`,
          weight: 1,
        })
      }
    }

    /* ---------------- results: current vs previous term ---------------- */
    const current =
      (await Term.query().where('school_id', schoolId).where('is_current', true).first()) ??
      (await Term.query().where('school_id', schoolId).orderBy('starts_on', 'desc').first())
    const previous = current?.startsOn
      ? await Term.query()
          .where('school_id', schoolId)
          .where('starts_on', '<', current.startsOn.toISODate()!)
          .orderBy('starts_on', 'desc')
          .first()
      : null
    const classIds = [...new Set(students.map((s) => s.classId).filter((c): c is number => !!c))]
    if (current) {
      for (const classId of classIds) {
        const [cur, prev] = await Promise.all([
          computeClassResults(schoolId, classId, current.id),
          previous ? computeClassResults(schoolId, classId, previous.id) : Promise.resolve(null),
        ])
        const prevBy = new Map((prev?.rows ?? []).map((r) => [r.student.id, r.overall.percentage]))
        for (const row of cur?.rows ?? []) {
          const p = row.overall.percentage
          if (p === null) continue
          if (p < 45) {
            add(row.student.id, {
              kind: 'failing',
              label: 'Failing overall',
              detail: `Average ${pct(p)} this term.`,
              weight: 2,
            })
          }
          const before = prevBy.get(row.student.id)
          if (before != null && before - p >= 10) {
            add(row.student.id, {
              kind: 'declining',
              label: 'Results dropping',
              detail: `Down from ${pct(before)} last term to ${pct(p)} this term.`,
              weight: 2,
            })
          }
          const weak = row.subjects.filter((x) => x.percentage !== null && x.percentage < 40)
          if (weak.length >= 3) {
            add(row.student.id, {
              kind: 'failing_subjects',
              label: 'Struggling in several subjects',
              detail: `Below 40% in ${weak.map((w) => w.subjectName).slice(0, 5).join(', ')}.`,
              weight: 1,
            })
          }
        }
      }
    }

    /* ---------------- assignments missed (last 30 days) ---------------- */
    const due = await Assignment.query()
      .where('school_id', schoolId)
      .where('published', true)
      .whereIn('class_id', classIds.length ? classIds : [0])
      .where('deadline', '<', now.toSQL()!)
      .where('deadline', '>=', now.minus({ days: 30 }).toSQL()!)
    if (due.length) {
      const subs = await AssignmentSubmission.query()
        .whereIn('assignment_id', due.map((a) => a.id))
        .select('assignment_id', 'student_id')
      const done = new Set(subs.map((s) => `${s.assignmentId}:${s.studentId}`))
      const dueByClass = new Map<number, Assignment[]>()
      for (const a of due) dueByClass.set(a.classId, [...(dueByClass.get(a.classId) ?? []), a])
      for (const s of students) {
        const list = s.classId ? (dueByClass.get(s.classId) ?? []) : []
        const missed = list.filter((a) => !done.has(`${a.id}:${s.id}`)).length
        if (missed >= 2) {
          add(s.id, {
            kind: 'missed_assignments',
            label: 'Missing assignments',
            detail: `Did not submit ${missed} of ${list.length} assignments due in the last 30 days.`,
            weight: 1,
          })
        }
      }
    }

    /* ---------------- low CBT scores (last 60 days) ---------------- */
    const attempts = await ExamAttempt.query()
      .whereIn('student_id', ids)
      .where('status', 'submitted')
      .where('submitted_at', '>=', now.minus({ days: 60 }).toSQL()!)
      .preload('exam')
    const lowBy = new Map<number, string[]>()
    for (const a of attempts) {
      if (!a.totalMarks) continue
      const p = ((a.score ?? 0) / a.totalMarks) * 100
      if (p < 40) lowBy.set(a.studentId, [...(lowBy.get(a.studentId) ?? []), `${a.exam?.title ?? 'a test'} (${pct(p)})`])
    }
    for (const [id, list] of lowBy) {
      add(id, {
        kind: 'low_cbt',
        label: 'Low test scores',
        detail: `Scored below 40% in ${list.slice(0, 3).join(', ')}.`,
        weight: 1,
      })
    }

    /* ---------------- overdue fees (admin only) ---------------- */
    const invoices = await FeeInvoice.query()
      .where('school_id', schoolId)
      .whereIn('student_id', ids)
      .whereNotIn('status', ['paid', 'cancelled'])
      .whereNotNull('due_on')
      .where('due_on', '<', today.toISODate()!)
      .preload('payments')
    const overdue = new Map<number, number>()
    for (const inv of invoices) {
      const bal = Number(inv.totalAmountKobo) - inv.payments.reduce((s, p) => s + Number(p.amountKobo), 0)
      if (bal > 0) overdue.set(inv.studentId, (overdue.get(inv.studentId) ?? 0) + bal)
    }
    for (const [id, kobo] of overdue) {
      add(id, {
        kind: 'fees_overdue',
        label: 'Fees overdue',
        detail: `${naira(kobo)} past its due date.`,
        weight: 1,
        adminOnly: true,
      })
    }
  }

  /* ---------------- persist + explain ---------------- */
  const flagged = students.filter((s) => (signals.get(s.id) ?? []).length > 0)
  const explanations = new Map<number, { summary: string; action: string }>()
  if (opts.withAi !== false && isAiConfigured()) {
    // Explain only medium/high: low flags are a single signal, the label says it all.
    const toExplain = flagged.filter((s) => {
      const sc = (signals.get(s.id) ?? []).filter((x) => !x.adminOnly).reduce((t, x) => t + x.weight, 0)
      return sc >= 2
    })
    try {
      await explain(schoolId, toExplain, signals, explanations)
    } catch (err) {
      // The scan is still useful without prose; never fail it on the AI.
      logger.warn({ err }, 'risk explanations failed; continuing without AI summaries')
    }
  }

  const existing = await StudentRiskFlag.query().where('school_id', schoolId)
  const existingBy = new Map(existing.map((f) => [f.studentId, f]))
  const stats: ScanStats = { scanned: students.length, flagged: 0, high: 0, medium: 0, low: 0, reopened: 0 }

  for (const s of flagged) {
    const sig = signals.get(s.id)!
    const score = sig.reduce((t, x) => t + x.weight, 0)
    const level = levelFor(score)
    const hash = createHash('sha256').update(sig.map((x) => x.kind).sort().join('|')).digest('hex')
    const prior = existingBy.get(s.id)
    const keepReviewed = prior?.status === 'reviewed' && prior.signalHash === hash
    const ex = explanations.get(s.id)
    const fallback = sig.filter((x) => !x.adminOnly).map((x) => x.detail).join(' ')

    await StudentRiskFlag.updateOrCreate(
      { schoolId, studentId: s.id },
      {
        classId: s.classId,
        level,
        score,
        signals: sig,
        signalHash: hash,
        summary: ex?.summary ?? (prior?.signalHash === hash ? prior?.summary : null) ?? (fallback || null),
        suggestedAction: ex?.action ?? (prior?.signalHash === hash ? prior?.suggestedAction : null) ?? null,
        status: keepReviewed ? 'reviewed' : 'open',
        reviewedByUserId: keepReviewed ? prior!.reviewedByUserId : null,
        reviewedAt: keepReviewed ? prior!.reviewedAt : null,
        reviewNote: keepReviewed ? prior!.reviewNote : null,
        computedAt: DateTime.now(),
      }
    )
    if (prior?.status === 'reviewed' && !keepReviewed) stats.reopened++
    stats.flagged++
    stats[level]++
  }

  // Students who no longer meet any rule drop off the list.
  const flaggedIds = new Set(flagged.map((s) => s.id))
  const stale = existing.filter((f) => !flaggedIds.has(f.studentId)).map((f) => f.id)
  if (stale.length) await StudentRiskFlag.query().whereIn('id', stale).delete()

  return stats
}

async function explain(
  schoolId: number,
  students: Student[],
  signals: Map<number, RiskSignal[]>,
  out: Map<number, { summary: string; action: string }>
) {
  const items = students.map((s, i) => ({
    ref: `S${i + 1}`,
    id: s.id,
    firstName: s.firstName,
    className: s.schoolClass?.name ?? null,
    signals: (signals.get(s.id) ?? []).filter((x) => !x.adminOnly).map((x) => `${x.label}: ${x.detail}`),
  }))
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['students'],
    properties: {
      students: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'summary', 'action'],
          properties: { ref: { type: 'string' }, summary: { type: 'string' }, action: { type: 'string' } },
        },
      },
    },
  }
  const system = [
    'You support class teachers in a Nigerian school with an early warning list.',
    'For each student write "summary": one or two plain sentences on what the signals show together, using only the signals given.',
    'Write "action": one concrete, kind next step for the class teacher this week (for example a check-in conversation, a call to the parent, a catch-up plan for named assignments, or extra support in a named subject).',
    'Never speculate about causes such as home problems or health. Use the first name. British English. Never use em dashes.',
  ].join(' ')
  for (let i = 0; i < items.length; i += 15) {
    const batch = items.slice(i, i + 15)
    const res = await aiJson<{ students: { ref: string; summary: string; action: string }[] }>({
      schoolId,
      userId: null,
      feature: 'risk_explain',
      system,
      user: JSON.stringify(batch.map(({ id: _id, ...rest }) => rest)),
      schema,
      schemaName: 'risk_explanations',
      effort: 'low',
      maxTokens: 6000,
    })
    const byRef = new Map(batch.map((b) => [b.ref, b.id]))
    for (const r of res.students ?? []) {
      const id = byRef.get(r.ref)
      const clean = (t: string) => t.replace(/\s*\u2014\s*/g, ', ').trim().slice(0, 600)
      if (id) out.set(id, { summary: clean(r.summary), action: clean(r.action) })
    }
  }
}
