import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import UserSchoolRole, { type Role } from '#models/user_school_role'
import Student from '#models/student'
import SchoolClass from '#models/school_class'
import TimetablePeriod from '#models/timetable_period'
import TimetableSlot from '#models/timetable_slot'
import TimetableSlotException from '#models/timetable_slot_exception'
import TeacherSubject from '#models/teacher_subject'
import Assignment from '#models/assignment'
import AssignmentSubmission from '#models/assignment_submission'
import FeeInvoice from '#models/fee_invoice'
import Payment from '#models/payment'
import Term from '#models/term'
import AttendanceDay from '#models/attendance_day'
import AttendanceRecord from '#models/attendance_record'
import Announcement from '#models/announcement'
import ParentStudent from '#models/parent_student'
import LeaveRequest from '#models/leave_request'
import Visitor from '#models/visitor'
import Score from '#models/score'
import Notification from '#models/notification'

/**
 * Single role-aware dashboard endpoint. Inspects the caller's roles at
 * this school and returns only the sections that apply. Panels stack in
 * the frontend in the order: admin, teacher, parent, student.
 */
export default class DashboardController {
  async show({ auth, school, serialize }: HttpContext) {
    const user = auth.user!
    const roles = await user.rolesAtSchool(school.id)

    const isAdmin = roles.some((r) => (['super_admin', 'admin', 'accountant'] as Role[]).includes(r))
    const isTeacher = roles.includes('teacher')
    const isParent = roles.includes('parent')
    const isStudent = roles.includes('student')

    const [admin, teacher, parent, student] = await Promise.all([
      isAdmin ? this.adminSection(school.id) : Promise.resolve(null),
      isTeacher ? this.teacherSection(school.id, user.id) : Promise.resolve(null),
      isParent ? this.parentSection(school.id, user.id) : Promise.resolve(null),
      isStudent ? this.studentSection(school.id, user.id) : Promise.resolve(null),
    ])

    return serialize({ roles, admin, teacher, parent, student })
  }

  /* ============ ADMIN ============ */
  private async adminSection(schoolId: number) {
    const now = DateTime.now().setZone('Africa/Lagos')
    const today = now.toFormat('yyyy-LL-dd')

    // Current term (for "fees collected this term")
    const currentTerm = await Term.query()
      .where('school_id', schoolId)
      .where('is_current', true)
      .first()

    const [
      studentsCountRes,
      staffCountRes,
      openInvoicesRes,
      pendingLeaveRes,
      openVisitorsRes,
      feesTermRes,
      attendanceToday,
    ] = await Promise.all([
      Student.query().where('school_id', schoolId).where('is_archived', false).count('* as total'),
      UserSchoolRole.query()
        .where('school_id', schoolId)
        .whereIn('role', ['admin', 'teacher', 'non_academic_staff', 'accountant'])
        .countDistinct('user_id as total'),
      FeeInvoice.query()
        .where('school_id', schoolId)
        .whereIn('status', ['pending', 'partial', 'overdue'])
        .sum('total_amount_kobo as total'),
      LeaveRequest.query().where('school_id', schoolId).where('status', 'pending').count('* as total'),
      Visitor.query().where('school_id', schoolId).whereNull('checked_out_at').count('* as total'),
      currentTerm
        ? Payment.query()
            .where('school_id', schoolId)
            .whereBetween('paid_at', [
              currentTerm.startsOn.toSQLDate()!,
              currentTerm.endsOn.toSQLDate()!,
            ])
            .sum('amount_kobo as total')
        : Promise.resolve([{ $extras: { total: 0 } }] as any),
      this.attendanceRateForDate(schoolId, today),
    ])

    const activity = await this.recentActivity(schoolId)

    return {
      students: Number(studentsCountRes[0].$extras.total),
      staff: Number(staffCountRes[0].$extras.total),
      outstandingInvoicesKobo: Number(openInvoicesRes[0].$extras.total ?? 0),
      pendingLeaveRequests: Number(pendingLeaveRes[0].$extras.total),
      openVisitors: Number(openVisitorsRes[0].$extras.total),
      feesCollectedTermKobo: Number(feesTermRes[0].$extras.total ?? 0),
      attendanceRate: attendanceToday,
      currentTerm: currentTerm
        ? { id: currentTerm.id, name: currentTerm.name, session: currentTerm.session }
        : null,
      activity,
    }
  }

  private async attendanceRateForDate(schoolId: number, date: string) {
    const dayIds = await AttendanceDay.query()
      .where('school_id', schoolId)
      .where('date', date)
      .select('id')
    if (dayIds.length === 0) return null
    const ids = dayIds.map((d) => d.id)
    const rows = await AttendanceRecord.query()
      .whereIn('attendance_day_id', ids)
      .select('status')
    if (rows.length === 0) return null
    const present = rows.filter((r) => r.status === 'present' || r.status === 'late').length
    return Math.round((present / rows.length) * 1000) / 10 // 1dp
  }

  /**
   * Synthesizes an activity feed from the newest rows across half a
   * dozen tables. No audit log needed - each domain table's created_at
   * is enough for a "what's fresh" list.
   */
  private async recentActivity(schoolId: number) {
    const [students, payments, announcements, leave, visitors] = await Promise.all([
      Student.query()
        .where('school_id', schoolId)
        .orderBy('created_at', 'desc')
        .limit(5),
      Payment.query()
        .where('school_id', schoolId)
        .preload('student')
        .orderBy('paid_at', 'desc')
        .limit(5),
      Announcement.query()
        .where('school_id', schoolId)
        .orderBy('created_at', 'desc')
        .limit(5),
      LeaveRequest.query()
        .where('school_id', schoolId)
        .preload('user')
        .orderBy('created_at', 'desc')
        .limit(5),
      Visitor.query()
        .where('school_id', schoolId)
        .orderBy('checked_in_at', 'desc')
        .limit(5),
    ])

    type Item = { kind: string; title: string; at: string }
    const items: Item[] = [
      ...students.map((s) => ({
        kind: 'student',
        title: `Enrolled ${s.firstName} ${s.lastName} (${s.admissionNumber})`,
        at: s.createdAt.toISO()!,
      })),
      ...payments.map((p) => ({
        kind: 'payment',
        title: `Payment ₦${(Number(p.amountKobo) / 100).toLocaleString()} from ${
          p.student?.firstName ?? 'student'
        } ${p.student?.lastName ?? ''}`.trim(),
        at: p.paidAt.toISO()!,
      })),
      ...announcements.map((a) => ({
        kind: 'announcement',
        title: `Announced: ${a.title}`,
        at: a.createdAt.toISO()!,
      })),
      ...leave.map((l) => ({
        kind: 'leave',
        title: `${l.user?.fullName ?? 'Staff'} requested ${l.kind} leave`,
        at: l.createdAt.toISO()!,
      })),
      ...visitors.map((v) => ({
        kind: 'visitor',
        title: `Visitor signed in: ${v.fullName}`,
        at: v.checkedInAt.toISO()!,
      })),
    ]

    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12)
  }

  /* ============ TEACHER ============ */
  private async teacherSection(schoolId: number, userId: number) {
    const now = DateTime.now().setZone('Africa/Lagos')
    const todayDate = now.toFormat('yyyy-LL-dd')

    const [
      classTeacherRows,
      subjectRows,
      allMySlots,
      assignments,
      notifications,
    ] = await Promise.all([
      SchoolClass.query()
        .where('school_id', schoolId)
        .where('class_teacher_id', userId)
        .withCount('students'),
      TeacherSubject.query()
        .where('user_id', userId)
        .whereIn(
          'class_id',
          SchoolClass.query().select('id').where('school_id', schoolId)
        )
        .preload('subject')
        .preload('schoolClass'),
      // Whole-week timetable for this teacher, all classes.
      TimetableSlot.query()
        .where('school_id', schoolId)
        .where('teacher_id', userId)
        .preload('period')
        .preload('subject')
        .preload('schoolClass'),
      Assignment.query()
        .where('school_id', schoolId)
        .where('teacher_id', userId)
        .preload('subject')
        .preload('schoolClass')
        .orderBy('created_at', 'desc'),
      Notification.query()
        .where('user_id', userId)
        .where('school_id', schoolId)
        .orderBy('created_at', 'desc')
        .limit(6),
    ])

    // ---- Assigned classes: union of class-teacher-of and subjects-taught,
    // with a `role` tag so the UI can distinguish pastoral duty from
    // teaching load.
    const classTeacherIds = new Set(classTeacherRows.map((c) => c.id))
    const taughtClassIds = new Set(subjectRows.map((r) => r.classId))
    const allClassIds = Array.from(new Set([...classTeacherIds, ...taughtClassIds]))
    const allClasses = allClassIds.length
      ? await SchoolClass.query()
          .whereIn('id', allClassIds)
          .withCount('students')
      : []
    const assignedClasses = allClasses.map((c) => {
      const subjectsHere = subjectRows
        .filter((r) => r.classId === c.id)
        .map((r) => r.subject?.name ?? '')
        .filter(Boolean)
      return {
        id: c.id,
        name: c.name,
        level: c.level,
        studentsCount: Number(c.$extras.students_count ?? 0),
        isClassTeacher: classTeacherIds.has(c.id),
        subjectsHere,
      }
    })

    // ---- Weekly timetable, one entry per (day, slot) with today's
    // exceptions layered on for the current day only.
    const todaySlotIds = allMySlots
      .filter((s) => s.dayOfWeek === now.weekday)
      .map((s) => s.id)
    const exceptions = todaySlotIds.length
      ? await TimetableSlotException.query()
          .where('date', todayDate)
          .whereIn('slot_id', todaySlotIds)
      : []
    const exBySlot = new Map(exceptions.map((e) => [e.slotId, e]))

    const weekTimetable = allMySlots
      .map((s) => {
        const ex = s.dayOfWeek === now.weekday ? exBySlot.get(s.id) : undefined
        return {
          slotId: s.id,
          dayOfWeek: s.dayOfWeek,
          periodName: s.period?.name ?? null,
          startTime: s.period?.startTime ?? null,
          endTime: s.period?.endTime ?? null,
          className: s.schoolClass?.name ?? null,
          subjectName: s.subject?.name ?? null,
          isToday: s.dayOfWeek === now.weekday,
          isCancelledToday: ex?.isCancelled ?? false,
          hasOverrideToday: !!ex && !ex.isCancelled,
        }
      })
      .sort(
        (a, b) =>
          a.dayOfWeek - b.dayOfWeek ||
          (a.startTime ?? '').localeCompare(b.startTime ?? '')
      )

    // ---- Attendance snapshot per class-teacher class: has today been
    // marked, and if so how many present / absent.
    const attendanceToday = await Promise.all(
      classTeacherRows.map(async (c) => {
        const day = await AttendanceDay.query()
          .where('school_id', schoolId)
          .where('class_id', c.id)
          .where('date', todayDate)
          .first()
        if (!day) {
          return {
            classId: c.id,
            className: c.name,
            studentsCount: Number(c.$extras.students_count ?? 0),
            marked: false,
            present: 0,
            absent: 0,
            late: 0,
          }
        }
        const rows = await AttendanceRecord.query()
          .where('attendance_day_id', day.id)
          .select('status')
        return {
          classId: c.id,
          className: c.name,
          studentsCount: Number(c.$extras.students_count ?? 0),
          marked: true,
          present: rows.filter((r) => r.status === 'present').length,
          absent: rows.filter((r) => r.status === 'absent').length,
          late: rows.filter((r) => r.status === 'late').length,
        }
      })
    )

    // ---- Assignments I created: split into "to grade" and "recent".
    const teacherAssignmentIds = assignments.map((a) => a.id)
    let assignmentsToGrade = 0
    if (teacherAssignmentIds.length > 0) {
      const res = await AssignmentSubmission.query()
        .whereIn('assignment_id', teacherAssignmentIds)
        .whereNull('score')
        .count('* as total')
      assignmentsToGrade = Number(res[0].$extras.total)
    }
    const recentAssignments = assignments.slice(0, 6).map((a) => ({
      id: a.id,
      title: a.title,
      subjectName: a.subject?.name ?? null,
      className: a.schoolClass?.name ?? null,
      deadline: a.deadline,
      published: a.published,
    }))

    return {
      assignedClasses,
      classTeacherOf: classTeacherRows.map((c) => ({
        id: c.id,
        name: c.name,
        studentsCount: Number(c.$extras.students_count ?? 0),
      })),
      subjectsTaught: subjectRows.map((r) => ({
        classId: r.classId,
        className: r.schoolClass?.name ?? null,
        subjectId: r.subjectId,
        subjectName: r.subject?.name ?? null,
      })),
      weekTimetable,
      attendanceToday,
      assignmentsToGrade,
      recentAssignments,
      notifications: notifications.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
    }
  }

  /* ============ PARENT ============ */
  private async parentSection(schoolId: number, userId: number) {
    const wardsLinks = await ParentStudent.query()
      .where('parent_user_id', userId)
      .preload('student', (sq) =>
        sq.preload('schoolClass').where('school_id', schoolId).where('is_archived', false)
      )

    const wards = wardsLinks.map((l) => l.student).filter(Boolean)
    if (wards.length === 0) return { wards: [] }

    const now = DateTime.now().setZone('Africa/Lagos')
    const today = now.toFormat('yyyy-LL-dd')
    const weekEnd = now.plus({ days: 7 }).toFormat('yyyy-LL-dd') + ' 23:59:59'

    const currentTerm = await Term.query()
      .where('school_id', schoolId)
      .where('is_current', true)
      .first()

    const wardCards = await Promise.all(
      wards.map(async (w) => {
        // today's attendance
        const attRow = await AttendanceRecord.query()
          .where('student_id', w.id)
          .whereIn(
            'attendance_day_id',
            AttendanceDay.query()
              .select('id')
              .where('school_id', schoolId)
              .where('date', today)
          )
          .first()

        // outstanding fee balance
        const outstandingRes = await FeeInvoice.query()
          .where('school_id', schoolId)
          .where('student_id', w.id)
          .whereIn('status', ['pending', 'partial', 'overdue'])
          .sum('total_amount_kobo as total')

        const outstanding = Number(outstandingRes[0].$extras.total ?? 0)

        // upcoming assignments (deadline in the next 7 days)
        const upcomingRes = w.classId
          ? await Assignment.query()
              .where('school_id', schoolId)
              .where('class_id', w.classId)
              .where('published', true)
              .whereBetween('deadline', [today, weekEnd])
              .count('* as total')
          : [{ $extras: { total: 0 } } as any]

        // latest-term summary: average of all their scores this term / max
        let latestTerm: { name: string; averagePct: number } | null = null
        if (currentTerm) {
          const scores = await Score.query()
            .where('student_id', w.id)
            .where('term_id', currentTerm.id)
            .preload('assessment')
          if (scores.length > 0) {
            let earned = 0
            let outOf = 0
            for (const s of scores) {
              const val = Number(s.score)
              const max = Number(s.assessment?.maxScore ?? 100)
              earned += val
              outOf += max
            }
            latestTerm = {
              name: `${currentTerm.session} · ${currentTerm.name}`,
              averagePct: outOf > 0 ? Math.round((earned / outOf) * 1000) / 10 : 0,
            }
          }
        }

        return {
          studentId: w.id,
          fullName: `${w.firstName} ${w.lastName}`,
          admissionNumber: w.admissionNumber,
          className: w.schoolClass?.name ?? null,
          todayAttendance: attRow?.status ?? null,
          outstandingKobo: outstanding,
          upcomingAssignments: Number(upcomingRes[0].$extras.total),
          latestTerm,
        }
      })
    )

    return { wards: wardCards }
  }

  /* ============ STUDENT ============ */
  private async studentSection(schoolId: number, userId: number) {
    const studentRow = await Student.query()
      .where('user_id', userId)
      .where('school_id', schoolId)
      .where('is_archived', false)
      .preload('schoolClass')
      .first()
    if (!studentRow) return null

    const now = DateTime.now().setZone('Africa/Lagos')
    const dayOfWeek = now.weekday
    const today = now.toFormat('yyyy-LL-dd')
    const weekEnd = now.plus({ days: 7 }).toFormat('yyyy-LL-dd') + ' 23:59:59'

    const [todaySlots, assignments, outstandingRes, latestScores, announcements] =
      await Promise.all([
        studentRow.classId
          ? TimetableSlot.query()
              .where('school_id', schoolId)
              .where('class_id', studentRow.classId)
              .where('day_of_week', dayOfWeek)
              .preload('period')
              .preload('subject')
              .preload('teacher')
          : Promise.resolve([] as TimetableSlot[]),
        studentRow.classId
          ? Assignment.query()
              .where('school_id', schoolId)
              .where('class_id', studentRow.classId)
              .where('published', true)
              .whereBetween('deadline', [today, weekEnd])
              .preload('subject')
              .orderBy('deadline', 'asc')
              .limit(10)
          : Promise.resolve([] as Assignment[]),
        FeeInvoice.query()
          .where('school_id', schoolId)
          .where('student_id', studentRow.id)
          .whereIn('status', ['pending', 'partial', 'overdue'])
          .sum('total_amount_kobo as total'),
        Score.query()
          .where('student_id', studentRow.id)
          .preload('assessment')
          .preload('subject')
          .orderBy('created_at', 'desc')
          .limit(5),
        Announcement.query()
          .where('school_id', schoolId)
          .whereNotNull('published_at')
          .orderBy('created_at', 'desc')
          .limit(5),
      ])

    // Layer exceptions on today's slots.
    const slotIds = todaySlots.map((s) => s.id)
    const exceptions = slotIds.length
      ? await TimetableSlotException.query().where('date', today).whereIn('slot_id', slotIds)
      : []
    const exBySlot = new Map(exceptions.map((e) => [e.slotId, e]))

    const todayList = todaySlots
      .map((s) => {
        const ex = exBySlot.get(s.id)
        return {
          slotId: s.id,
          periodName: s.period?.name ?? null,
          startTime: s.period?.startTime ?? null,
          endTime: s.period?.endTime ?? null,
          subjectName: s.subject?.name ?? null,
          teacherName: s.teacher?.fullName ?? null,
          isCancelled: ex?.isCancelled ?? false,
          hasOverride: !!ex && !ex.isCancelled,
        }
      })
      .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''))

    return {
      student: {
        id: studentRow.id,
        fullName: `${studentRow.firstName} ${studentRow.lastName}`,
        admissionNumber: studentRow.admissionNumber,
        className: studentRow.schoolClass?.name ?? null,
      },
      today: todayList,
      assignmentsThisWeek: assignments.map((a) => ({
        id: a.id,
        title: a.title,
        subjectName: a.subject?.name ?? null,
        deadline: a.deadline,
        maxScore: a.maxScore,
      })),
      outstandingKobo: Number(outstandingRes[0].$extras.total ?? 0),
      latestScores: latestScores.map((s) => ({
        id: s.id,
        subjectName: s.subject?.name ?? null,
        assessmentName: s.assessment?.name ?? null,
        score: Number(s.score),
        maxScore: Number(s.assessment?.maxScore ?? 100),
      })),
      announcements: announcements.map((a) => ({
        id: a.id,
        title: a.title,
        publishedAt: a.publishedAt,
      })),
    }
  }
}
