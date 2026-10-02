import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import TimetablePeriod from '#models/timetable_period'
import TimetableSlot from '#models/timetable_slot'
import SchoolClass from '#models/school_class'
import TeacherSubject from '#models/teacher_subject'
import UserSchoolRole from '#models/user_school_role'
import TimetableSlotException from '#models/timetable_slot_exception'
import { teacherScope } from '#services/teacher_scope'
import {
  createPeriodValidator,
  updatePeriodValidator,
  setTimetableSlotsValidator,
  createSlotValidator,
  updateSlotValidator,
  autoGenerateValidator,
  upsertSlotExceptionValidator,
} from '#validators/timetable'

export default class TimetableController {
  /* ----- periods (school-wide) ----- */
  async listPeriods({ school, serialize }: HttpContext) {
    const rows = await TimetablePeriod.query()
      .where('school_id', school.id)
      .orderBy('order_index', 'asc')
    return serialize(rows.map(this.serializePeriod))
  }

  async createPeriod({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createPeriodValidator)
    const row = await TimetablePeriod.create({
      schoolId: school.id,
      name: payload.name,
      startTime: payload.startTime,
      endTime: payload.endTime,
      orderIndex: payload.orderIndex ?? 0,
      isBreak: payload.isBreak ?? false,
    })
    response.status(201)
    return serialize(this.serializePeriod(row))
  }

  async updatePeriod({ school, params, request, response, serialize }: HttpContext) {
    const row = await TimetablePeriod.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Period not found' })
    const payload = await request.validateUsing(updatePeriodValidator)
    row.merge(payload)
    await row.save()
    return serialize(this.serializePeriod(row))
  }

  async destroyPeriod({ school, params, response }: HttpContext) {
    const row = await TimetablePeriod.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Period not found' })
    await row.delete()
    return response.noContent()
  }

  /* ----- class grid ----- */
  async classGrid({ school, auth, params, response, serialize }: HttpContext) {
    const classId = Number(params.classId)
    const scope = await teacherScope(auth.getUserOrFail(), school.id)
    if (!scope.unscoped && !scope.classIds.includes(classId)) {
      return response.forbidden({ message: 'Not in your teaching load' })
    }
    const rows = await TimetableSlot.query()
      .where('school_id', school.id)
      .where('class_id', classId)
      .preload('subject')
      .preload('teacher')
    return serialize(rows.map(this.serializeSlot))
  }

  /**
   * PUT /schools/:schoolId/classes/:classId/timetable
   * Replaces the class's timetable in a single transaction with the given
   * slot list. Any slot with no subject AND no teacher is treated as a
   * delete/skip.
   */
  async setClassGrid({ school, params, request, serialize }: HttpContext) {
    const classId = Number(params.classId)
    const { slots } = await request.validateUsing(setTimetableSlotsValidator)

    await db.transaction(async (trx) => {
      await TimetableSlot.query({ client: trx })
        .where('school_id', school.id)
        .where('class_id', classId)
        .delete()

      for (const s of slots) {
        // skip completely empty cells
        if (!s.subjectId && !s.teacherId && !s.notes) continue
        await TimetableSlot.create(
          {
            schoolId: school.id,
            classId,
            dayOfWeek: s.dayOfWeek,
            periodId: s.periodId,
            subjectId: s.subjectId ?? null,
            teacherId: s.teacherId ?? null,
            notes: s.notes ?? null,
          },
          { client: trx }
        )
      }
    })

    const fresh = await TimetableSlot.query()
      .where('school_id', school.id)
      .where('class_id', classId)
      .preload('subject')
      .preload('teacher')
    return serialize(fresh.map(this.serializeSlot))
  }

  /**
   * GET /schools/:sid/timetable
   * Whole-school timetable payload - every slot across every class, plus the
   * class list so the frontend can label rows and render clash indicators.
   */
  async schoolGrid({ school, auth, serialize }: HttpContext) {
    const user = auth.getUserOrFail()
    const scope = await teacherScope(user, school.id)

    const slotsQ = TimetableSlot.query()
      .where('school_id', school.id)
      .preload('subject')
      .preload('teacher')
      .preload('schoolClass')
    // Teachers only see slots they teach - "my timetable across all classes I
    // touch", not the whole school. Admins see everything.
    if (!scope.unscoped) slotsQ.where('teacher_id', user.id)

    const classesQ = SchoolClass.query()
      .where('school_id', school.id)
      .orderBy('name', 'asc')
    if (!scope.unscoped) {
      classesQ.whereIn('id', scope.classIds.length ? scope.classIds : [-1])
    }

    const [slots, classes] = await Promise.all([slotsQ, classesQ])
    return serialize({
      slots: slots.map((s) => this.serializeSlot(s)),
      classes: classes.map((c) => ({ id: c.id, name: c.name })),
    })
  }

  /**
   * POST /schools/:sid/timetable/slots
   * Creates one slot per period in `periodIds` - a "double lesson" is just
   * two period ids. Never blocks: if a slot already exists in a
   * (class, day, period) cell, the existing row is updated in place.
   * Teacher clashes across other classes are allowed by design.
   */
  async createSlot({ school, request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(createSlotValidator)
    const cls = await SchoolClass.query()
      .where('id', payload.classId)
      .where('school_id', school.id)
      .first()
    if (!cls) return response.badRequest({ message: 'Class not in this school' })

    const created: TimetableSlot[] = []
    for (const periodId of payload.periodIds) {
      const existing = await TimetableSlot.query()
        .where('school_id', school.id)
        .where('class_id', payload.classId)
        .where('day_of_week', payload.dayOfWeek)
        .where('period_id', periodId)
        .first()

      let row: TimetableSlot
      if (existing) {
        existing.merge({
          subjectId: payload.subjectId ?? null,
          teacherId: payload.teacherId ?? null,
          notes: payload.notes ?? null,
        })
        await existing.save()
        row = existing
      } else {
        row = await TimetableSlot.create({
          schoolId: school.id,
          classId: payload.classId,
          dayOfWeek: payload.dayOfWeek,
          periodId,
          subjectId: payload.subjectId ?? null,
          teacherId: payload.teacherId ?? null,
          notes: payload.notes ?? null,
        })
      }
      await row.load('subject')
      await row.load('teacher')
      await row.load('schoolClass')
      created.push(row)
    }
    response.status(201)
    return serialize(created.map((r) => this.serializeSlot(r)))
  }

  async updateSlot({ school, params, request, response, serialize }: HttpContext) {
    const row = await TimetableSlot.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Slot not found' })
    const payload = await request.validateUsing(updateSlotValidator)
    row.merge({
      dayOfWeek: payload.dayOfWeek ?? row.dayOfWeek,
      periodId: payload.periodId ?? row.periodId,
      subjectId: payload.subjectId === undefined ? row.subjectId : payload.subjectId,
      teacherId: payload.teacherId === undefined ? row.teacherId : payload.teacherId,
      notes: payload.notes === undefined ? row.notes : payload.notes,
    })
    await row.save()
    await row.load('subject')
    await row.load('teacher')
    await row.load('schoolClass')
    return serialize(this.serializeSlot(row))
  }

  /**
   * POST /schools/:sid/timetable/auto-generate
   *
   * Greedy timetable builder. For every (class, subject) attached under
   * class_subjects it schedules `slotsPerSubject` periods a week, picking
   * a teacher from teacher_subjects and skipping any (day, period) where
   * that teacher is already booked - so the generated grid is
   * clash-free by construction.
   *
   * Modes:
   *   fill    → keep existing slots, only place new ones in empty cells.
   *   replace → wipe every slot for this school first, then rebuild.
   *
   * Returns a summary + a `warnings` array so admins can see which
   * (class, subject) pairs couldn't be fully placed (usually because no
   * qualified teacher exists or every eligible slot was already busy).
   */
  async autoGenerate({ school, request, response }: HttpContext) {
    const payload = await request.validateUsing(autoGenerateValidator)
    const days = payload.daysOfWeek ?? [1, 2, 3, 4, 5]
    const slotsNeeded = payload.slotsPerSubject

    // Non-break periods only - break slots are lunch/short breaks and
    // must never receive a subject.
    const periods = await TimetablePeriod.query()
      .where('school_id', school.id)
      .where('is_break', false)
      .orderBy('order_index', 'asc')
    if (periods.length === 0) {
      return response.badRequest({
        message: 'Define at least one teaching period first.',
      })
    }

    const classes = await SchoolClass.query()
      .where('school_id', school.id)
      .preload('subjects')
      .orderBy('name', 'asc')

    // Fallback pool: every teacher at this school. Used when no explicit
    // teaching-load row exists for a (class, subject) pair - first the
    // class teacher, then any other teacher.
    const teacherRoles = await UserSchoolRole.query()
      .where('school_id', school.id)
      .where('role', 'teacher')
    const anyTeacherIds = teacherRoles.map((r) => r.userId)

    // (userId, dayOfWeek, periodId) → busy?  Also (classId, day, period) → busy?
    const teacherBusy = new Set<string>()
    const classBusy = new Set<string>()
    const tKey = (t: number, d: number, p: number) => `${t}-${d}-${p}`
    const cKey = (c: number, d: number, p: number) => `${c}-${d}-${p}`

    if (payload.mode === 'replace') {
      await TimetableSlot.query().where('school_id', school.id).delete()
    } else {
      // Prime the busy sets with existing slots so we don't stomp them.
      const existing = await TimetableSlot.query().where('school_id', school.id)
      for (const s of existing) {
        classBusy.add(cKey(s.classId, s.dayOfWeek, s.periodId))
        if (s.teacherId) teacherBusy.add(tKey(s.teacherId, s.dayOfWeek, s.periodId))
      }
    }

    // Preload teacher→subject rosters once for the whole school.
    const rosters = await TeacherSubject.query().whereIn(
      'class_id',
      classes.map((c) => c.id)
    )
    // (classId, subjectId) → teacherId[]
    const eligibleTeachers = new Map<string, number[]>()
    for (const r of rosters) {
      const k = `${r.classId}:${r.subjectId}`
      const arr = eligibleTeachers.get(k) ?? []
      arr.push(r.userId)
      eligibleTeachers.set(k, arr)
    }

    // Round-robin cursor per teacher so their load spreads across the week
    // rather than piling into Monday.
    const teacherLoad = new Map<number, number>()

    let created = 0
    const warnings: string[] = []

    await db.transaction(async (trx) => {
      for (const cls of classes) {
        for (const subject of cls.subjects) {
          let teachers = eligibleTeachers.get(`${cls.id}:${subject.id}`) ?? []
          // Fallback 1: use the class teacher if no explicit teaching-load row.
          if (teachers.length === 0 && cls.classTeacherId) {
            teachers = [cls.classTeacherId]
          }
          // Fallback 2: any teacher at this school - better a real assignment
          // than a hole. Admins can re-assign later.
          if (teachers.length === 0) teachers = anyTeacherIds
          if (teachers.length === 0) {
            warnings.push(
              `No teacher available for ${subject.name} in ${cls.name}. Invite at least one teacher first.`
            )
            continue
          }
          // Pick the teacher currently carrying the fewest slots - keeps
          // load even when several people can teach the same subject.
          teachers.sort(
            (a, b) => (teacherLoad.get(a) ?? 0) - (teacherLoad.get(b) ?? 0)
          )

          let placed = 0
          const perDayForSubject = new Map<number, number>() // day → count

          outer: for (const period of periods) {
            for (const day of days) {
              if (placed >= slotsNeeded) break outer
              // spread across days: no more than ceil(slotsNeeded/days)
              const maxPerDay = Math.ceil(slotsNeeded / days.length)
              if ((perDayForSubject.get(day) ?? 0) >= maxPerDay) continue
              if (classBusy.has(cKey(cls.id, day, period.id))) continue

              // Find first eligible teacher who isn't already booked.
              const teacher = teachers.find(
                (t) => !teacherBusy.has(tKey(t, day, period.id))
              )
              if (!teacher) continue

              await TimetableSlot.create(
                {
                  schoolId: school.id,
                  classId: cls.id,
                  dayOfWeek: day,
                  periodId: period.id,
                  subjectId: subject.id,
                  teacherId: teacher,
                  notes: null,
                },
                { client: trx }
              )
              classBusy.add(cKey(cls.id, day, period.id))
              teacherBusy.add(tKey(teacher, day, period.id))
              teacherLoad.set(teacher, (teacherLoad.get(teacher) ?? 0) + 1)
              perDayForSubject.set(day, (perDayForSubject.get(day) ?? 0) + 1)
              placed += 1
              created += 1
            }
          }

          if (placed < slotsNeeded) {
            warnings.push(
              `Placed only ${placed}/${slotsNeeded} periods for ${subject.name} in ${cls.name} - remaining slots were blocked by clashes.`
            )
          }
        }
      }
    })

    return { created, warnings, mode: payload.mode }
  }

  /**
   * GET /schools/:sid/timetable/exceptions?date=YYYY-MM-DD
   * Returns every one-off exception applying to this school on the
   * given date. The frontend layers these on top of the base slots to
   * render "what actually happens today".
   */
  async listExceptions({ school, request, serialize }: HttpContext) {
    const date = String(request.qs().date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { data: [] }
    }
    const rows = await TimetableSlotException.query()
      .where('date', date)
      .whereIn(
        'slot_id',
        TimetableSlot.query().select('id').where('school_id', school.id)
      )
    return serialize(
      rows.map((r) => ({
        id: r.id,
        slotId: r.slotId,
        date,
        subjectId: r.subjectId,
        teacherId: r.teacherId,
        notes: r.notes,
        isCancelled: r.isCancelled,
      }))
    )
  }

  /**
   * PUT /schools/:sid/timetable/slots/:id/exceptions
   * Upsert (or clear) the exception for this slot on a specific date.
   * If every override field is null/absent and isCancelled is false,
   * the row is deleted rather than stored - the base slot wins again.
   */
  async upsertException({ school, params, request, response, serialize }: HttpContext) {
    const slot = await TimetableSlot.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!slot) return response.notFound({ message: 'Slot not found' })

    const payload = await request.validateUsing(upsertSlotExceptionValidator)

    const isNoop =
      !payload.isCancelled &&
      payload.subjectId === undefined &&
      payload.teacherId === undefined &&
      (payload.notes == null || payload.notes === '')

    if (isNoop) {
      await TimetableSlotException.query()
        .where('slot_id', slot.id)
        .where('date', payload.date)
        .delete()
      return { cleared: true }
    }

    const existing = await TimetableSlotException.query()
      .where('slot_id', slot.id)
      .where('date', payload.date)
      .first()

    const values = {
      subjectId: payload.subjectId ?? null,
      teacherId: payload.teacherId ?? null,
      notes: payload.notes ?? null,
      isCancelled: payload.isCancelled ?? false,
    }

    let row: TimetableSlotException
    if (existing) {
      existing.merge(values)
      await existing.save()
      row = existing
    } else {
      row = await TimetableSlotException.create({
        slotId: slot.id,
        // date column is a DateTime in Lucid; string 'YYYY-MM-DD' works
        date: payload.date as any,
        ...values,
      })
    }

    return serialize({
      id: row.id,
      slotId: row.slotId,
      date: payload.date,
      subjectId: row.subjectId,
      teacherId: row.teacherId,
      notes: row.notes,
      isCancelled: row.isCancelled,
    })
  }

  async destroySlot({ school, params, response }: HttpContext) {
    const row = await TimetableSlot.query()
      .where('id', params.id)
      .where('school_id', school.id)
      .first()
    if (!row) return response.notFound({ message: 'Slot not found' })
    await row.delete()
    return response.noContent()
  }

  private serializePeriod(row: TimetablePeriod) {
    return {
      id: row.id,
      name: row.name,
      startTime: row.startTime,
      endTime: row.endTime,
      orderIndex: row.orderIndex,
      isBreak: row.isBreak,
    }
  }

  private serializeSlot(row: TimetableSlot) {
    return {
      id: row.id,
      classId: row.classId,
      className: row.schoolClass?.name ?? null,
      dayOfWeek: row.dayOfWeek,
      periodId: row.periodId,
      subjectId: row.subjectId,
      subject: row.subject ? { id: row.subject.id, name: row.subject.name } : null,
      teacherId: row.teacherId,
      teacher: row.teacher
        ? { id: row.teacher.id, fullName: row.teacher.fullName, email: row.teacher.email }
        : null,
      notes: row.notes,
    }
  }
}
