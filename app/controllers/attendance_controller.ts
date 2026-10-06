import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import AttendanceDay from '#models/attendance_day'
import AttendanceRecord from '#models/attendance_record'
import Student from '#models/student'
import { markAttendanceValidator, ATTENDANCE_SESSIONS } from '#validators/attendance'
import { teacherScope } from '#services/teacher_scope'
import { fireAutomation } from '#services/automations'

type Session = (typeof ATTENDANCE_SESSIONS)[number]

export default class AttendanceController {
  /**
   * GET /schools/:schoolId/attendance/day?classId=X&date=YYYY-MM-DD&session=morning
   * Returns the roster merged with existing marks for that session.
   */
  async day({ school, request, response, serialize }: HttpContext) {
    const classId = Number(request.input('classId'))
    const date = String(request.input('date') ?? '')
    const session = String(request.input('session') ?? 'morning') as Session
    if (!Number.isInteger(classId) || classId <= 0 || !date) {
      return response.badRequest({ message: 'classId and date are required' })
    }
    if (!ATTENDANCE_SESSIONS.includes(session)) {
      return response.badRequest({ message: 'session must be morning or afternoon' })
    }

    const day = await AttendanceDay.query()
      .where('school_id', school.id)
      .where('class_id', classId)
      .where('date', date)
      .where('session', session)
      .preload('markedBy')
      .preload('records', (q) => q.preload('student'))
      .first()

    const roster = await Student.query()
      .where('school_id', school.id)
      .where('class_id', classId)
      .where('is_archived', false)
      .orderBy('last_name', 'asc')

    const recordsByStudent = new Map(day?.records.map((r) => [r.studentId, r]) ?? [])

    const rows = roster.map((s) => {
      const rec = recordsByStudent.get(s.id)
      return {
        studentId: s.id,
        admissionNumber: s.admissionNumber,
        fullName: [s.firstName, s.lastName].filter(Boolean).join(' '),
        status: rec?.status ?? null,
        remark: rec?.remark ?? null,
      }
    })

    return serialize({
      day: day
        ? {
            id: day.id,
            date: day.date?.toISODate(),
            session: day.session,
            submitted: day.submitted,
            note: day.note,
            markedBy: day.markedBy
              ? {
                  id: day.markedBy.id,
                  fullName: day.markedBy.fullName,
                  email: day.markedBy.email,
                }
              : null,
          }
        : null,
      records: rows,
    })
  }

  async mark({ school, auth, request, response, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const payload = await request.validateUsing(markAttendanceValidator)

    const scope = await teacherScope(user, school.id)
    if (!scope.unscoped && !scope.classTeacherOf.includes(payload.classId)) {
      return response.forbidden({
        message:
          'Only the class teacher (or an admin) can mark attendance for this class.',
      })
    }

    const locked = await AttendanceDay.query()
      .where('school_id', school.id)
      .where('class_id', payload.classId)
      .where('date', payload.date)
      .where('session', payload.session)
      .where('submitted', true)
      .first()
    if (locked) {
      return response.conflict({ message: 'This session has already been submitted and is locked.' })
    }

    const day = await db.transaction(async (trx) => {
      let d = await AttendanceDay.query({ client: trx })
        .where('school_id', school.id)
        .where('class_id', payload.classId)
        .where('date', payload.date)
        .where('session', payload.session)
        .first()

      if (d?.submitted) {
        throw new Error('This session has already been submitted and is locked.')
      }

      if (!d) {
        d = await AttendanceDay.create(
          {
            schoolId: school.id,
            classId: payload.classId,
            date: DateTime.fromISO(payload.date),
            session: payload.session,
            markedByUserId: user.id,
            submitted: !!payload.submit,
            note: payload.note ?? null,
          },
          { client: trx }
        )
      } else {
        d.markedByUserId = user.id
        if (payload.submit) d.submitted = true
        if (payload.note !== undefined) d.note = payload.note ?? null
        await d.save()
      }

      for (const r of payload.records) {
        await AttendanceRecord.updateOrCreate(
          { attendanceDayId: d.id, studentId: r.studentId },
          { status: r.status, remark: r.remark ?? null },
          { client: trx }
        )
      }

      return d
    })

    // Alert guardians once per student per day, only when the register is
    // submitted (drafts can still be corrected).
    if (payload.submit) {
      const flagged = payload.records.filter((r) => ['absent', 'late', 'sick'].includes(r.status))
      const when = DateTime.fromISO(payload.date).toFormat('d LLL yyyy')
      for (const r of flagged) {
        await fireAutomation(school.id, 'absence', {
          studentId: r.studentId,
          vars: { status: r.status, date: when },
          dedupeKey: `absence:${payload.date}:${r.studentId}`,
        })
      }
    }

    response.status(201)
    return serialize({ dayId: day.id, session: day.session, submitted: day.submitted })
  }

  /**
   * GET /schools/:schoolId/students/:studentId/attendance?from=&to=
   * History for one student. Parents can only read their own wards.
   */
  async studentHistory({ school, auth, params, request, response, serialize }: HttpContext) {
    const studentId = Number(params.studentId)
    const student = await Student.query()
      .where('id', studentId)
      .where('school_id', school.id)
      .first()
    if (!student) return response.notFound({ message: 'Student not found' })

    const user = auth.getUserOrFail()
    const isParent = await user.hasRole(school.id, 'parent')
    if (isParent) {
      const wards = await user.related('wards').query().where('students.id', studentId)
      if (wards.length === 0) {
        return response.forbidden({ message: 'You can only view your ward' })
      }
    }
    const isStudentSelf = student.userId === user.id
    const isStaff = await user
      .rolesAtSchool(school.id)
      .then((rs) =>
        rs.some((r) => ['super_admin', 'admin', 'teacher', 'accountant'].includes(r))
      )
    if (!isStaff && !isParent && !isStudentSelf) {
      return response.forbidden({ message: 'Not allowed' })
    }

    const from = request.input('from')
    const to = request.input('to')
    const query = AttendanceRecord.query()
      .where('student_id', studentId)
      .preload('day', (q) => q.preload('schoolClass'))
      .orderBy('id', 'desc')
      .limit(365)

    if (from || to) {
      query.whereHas('day', (q) => {
        if (from) q.where('date', '>=', String(from))
        if (to) q.where('date', '<=', String(to))
      })
    }

    const rows = await query
    return serialize(
      rows.map((r) => ({
        id: r.id,
        date: r.day?.date?.toISODate(),
        session: r.day?.session,
        status: r.status,
        remark: r.remark,
        classId: r.day?.classId,
        className: r.day?.schoolClass?.name ?? null,
      }))
    )
  }
}
