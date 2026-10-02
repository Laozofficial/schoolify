import Term from '#models/term'
import Assessment from '#models/assessment'
import Score from '#models/score'
import Student from '#models/student'
import Subject from '#models/subject'
import SchoolClass from '#models/school_class'
import GradeScale, { DEFAULT_WAEC_SCALE } from '#models/grade_scale'

/**
 * Single source of truth for a class's term results: weighted subject
 * percentages, per-subject and overall positions, and grades. Used by the
 * class results screen and by the AI report-comment drafter so both always
 * agree on the numbers.
 */

export type ResolvedGrade = { grade: string; remark: string } | null

export interface ClassResultRow {
  student: {
    id: number
    admissionNumber: string
    fullName: string
    firstName: string
    gender: string | null
  }
  subjects: {
    subjectId: number
    subjectName: string
    percentage: number | null
    grade: string | null
    remark: string | null
    position: number | null
  }[]
  overall: {
    percentage: number | null
    grade: string | null
    remark: string | null
    position: number | null
    classSize: number
  }
}

export interface ClassResults {
  term: Term
  classId: number
  className: string | null
  subjects: { id: number; name: string }[]
  rows: ClassResultRow[]
}

/** The school's grade scale, highest cutoff first. Seeds WAEC defaults. */
export async function gradeScaleFor(schoolId: number): Promise<GradeScale[]> {
  let rows = await GradeScale.query()
    .where('school_id', schoolId)
    .orderBy('min_percentage', 'desc')
  if (rows.length === 0) {
    for (const [i, r] of DEFAULT_WAEC_SCALE.entries()) {
      await GradeScale.create({
        schoolId,
        grade: r.grade,
        minPercentage: String(r.minPercentage),
        remark: r.remark,
        orderIndex: i,
      })
    }
    rows = await GradeScale.query()
      .where('school_id', schoolId)
      .orderBy('min_percentage', 'desc')
  }
  return rows
}

export function lookupGrade(pct: number, scale: GradeScale[]): ResolvedGrade {
  if (!Number.isFinite(pct)) return null
  for (const row of scale) {
    if (pct >= Number(row.minPercentage)) return { grade: row.grade, remark: row.remark }
  }
  return null
}

export async function computeClassResults(
  schoolId: number,
  classId: number,
  termId: number
): Promise<ClassResults | null> {
  const [term, roster, assessments, gradeScale, cls] = await Promise.all([
    Term.query().where('id', termId).where('school_id', schoolId).first(),
    Student.query()
      .where('school_id', schoolId)
      .where('class_id', classId)
      .where('is_archived', false)
      .orderBy('last_name', 'asc'),
    Assessment.query().where('school_id', schoolId).orderBy('order_index', 'asc'),
    gradeScaleFor(schoolId),
    SchoolClass.query().where('id', classId).where('school_id', schoolId).first(),
  ])
  if (!term) return null

  const studentIds = roster.map((s) => s.id)
  const [subjects, allScores] = await Promise.all([
    Subject.query().where('school_id', schoolId).orderBy('name', 'asc'),
    studentIds.length
      ? Score.query().where('term_id', termId).whereIn('student_id', studentIds)
      : Promise.resolve([] as Score[]),
  ])

  // Index scores for O(1) lookup instead of scanning per cell.
  const scoreKey = (st: number, sub: number, a: number) => `${st}:${sub}:${a}`
  const scoreMap = new Map(
    allScores.map((s) => [scoreKey(s.studentId, s.subjectId, s.assessmentId), s])
  )

  const totalWeight = assessments.reduce((sum, a) => sum + a.weight, 0) || 100
  type Perf = { percentage: number; hasAny: boolean }
  const perf = new Map<string, Perf>() // key: `${studentId}:${subjectId}`
  for (const sid of studentIds) {
    for (const sub of subjects) {
      let weighted = 0
      let hasAny = false
      for (const a of assessments) {
        const s = scoreMap.get(scoreKey(sid, sub.id, a.id))
        if (s) {
          hasAny = true
          weighted += ((Number(s.score) / a.maxScore) * 100 * a.weight) / totalWeight
        }
      }
      perf.set(`${sid}:${sub.id}`, { percentage: weighted, hasAny })
    }
  }

  // Per-subject rankings (only students with a score are ranked).
  const rankBySubject = new Map<number, Map<number, number>>()
  for (const sub of subjects) {
    const ranked = studentIds
      .map((sid) => ({ sid, p: perf.get(`${sid}:${sub.id}`)! }))
      .filter((r) => r.p.hasAny)
      .sort((a, b) => b.p.percentage - a.p.percentage)
    rankBySubject.set(sub.id, new Map(ranked.map((r, i) => [r.sid, i + 1])))
  }

  // Overall: mean of the subject percentages the student has.
  const overallByStudent = new Map<number, number>()
  for (const sid of studentIds) {
    const vals = subjects
      .map((sub) => perf.get(`${sid}:${sub.id}`)!)
      .filter((p) => p.hasAny)
    if (vals.length) {
      overallByStudent.set(sid, vals.reduce((s, p) => s + p.percentage, 0) / vals.length)
    }
  }
  const overallRanking = [...overallByStudent.entries()].sort((a, b) => b[1] - a[1])
  const overallPos = new Map(overallRanking.map(([sid], i) => [sid, i + 1]))

  const rows: ClassResultRow[] = roster.map((st) => {
    const subjectCells = subjects.map((sub) => {
      const p = perf.get(`${st.id}:${sub.id}`)
      const g = p?.hasAny ? lookupGrade(p.percentage, gradeScale) : null
      return {
        subjectId: sub.id,
        subjectName: sub.name,
        percentage: p?.hasAny ? Number(p.percentage.toFixed(2)) : null,
        grade: g?.grade ?? null,
        remark: g?.remark ?? null,
        position: rankBySubject.get(sub.id)?.get(st.id) ?? null,
      }
    })
    const overallPct = overallByStudent.get(st.id) ?? null
    const og = overallPct !== null ? lookupGrade(overallPct, gradeScale) : null
    return {
      student: {
        id: st.id,
        admissionNumber: st.admissionNumber,
        fullName: [st.firstName, st.lastName].filter(Boolean).join(' '),
        firstName: st.firstName,
        gender: st.gender ?? null,
      },
      subjects: subjectCells,
      overall: {
        percentage: overallPct !== null ? Number(overallPct.toFixed(2)) : null,
        grade: og?.grade ?? null,
        remark: og?.remark ?? null,
        position: overallPos.get(st.id) ?? null,
        classSize: overallRanking.length,
      },
    }
  })

  return {
    term,
    classId,
    className: cls?.name ?? null,
    subjects: subjects.map((s) => ({ id: s.id, name: s.name })),
    rows,
  }
}
