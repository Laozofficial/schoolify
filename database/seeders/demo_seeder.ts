import { BaseSeeder } from '@adonisjs/lucid/seeders'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import User from '#models/user'
import School from '#models/school'
import UserSchoolRole from '#models/user_school_role'
import SchoolClass from '#models/school_class'
import Subject from '#models/subject'
import Student from '#models/student'
import ParentStudent from '#models/parent_student'
import TeacherSubject from '#models/teacher_subject'
import TimetablePeriod from '#models/timetable_period'
import TimetableSlot from '#models/timetable_slot'
import Term from '#models/term'
import FeeStructure from '#models/fee_structure'
import FeeItem from '#models/fee_item'
import FeeInvoice from '#models/fee_invoice'
import FeeInvoiceItem from '#models/fee_invoice_item'
import Payment from '#models/payment'
import env from '#start/env'
import db from '@adonisjs/lucid/services/db'

/**
 * Comprehensive demo data for a Nigerian secondary school. Idempotent -
 * safe to re-run; existing rows are updated or skipped.
 */
export default class extends BaseSeeder {
  async run() {
    const school = await School.updateOrCreate(
      { slug: 'demo-academy' },
      {
        name: 'Demo Academy',
        subdomain: 'demo',
        theme: { primary: '#0f766e', accent: '#f59e0b' },
      }
    )

    await this.seedSuperAdmin(school.id)
    await this.seedClasses(school.id)
    const subjects = await this.seedSubjects(school.id)
    const teachers = await this.seedTeachers(school.id)

    // Timetable must cover every class at the school (including any that
    // pre-existed before this seeder ran), so re-fetch the full list.
    const classes = await SchoolClass.query().where('school_id', school.id).orderBy('name', 'asc')

    await this.attachSubjectsToClasses(classes, subjects)
    await this.assignClassTeachers(classes, teachers)
    await this.seedTeachingLoad(classes, teachers)
    const students = await this.seedStudents(school.id, classes)
    await this.seedParents(school.id, students)
    const periods = await this.seedPeriods(school.id)
    await this.seedTimetable(school.id, classes, periods, subjects, teachers)
    const term = await this.ensureCurrentTerm(school.id)
    const feeStructures = await this.seedFeeStructures(school.id, term.id, classes)
    await this.generateInvoices(school.id, term.id, feeStructures, students)
    await this.recordSamplePayments(school.id)

    logger.info(
      `Seeded ${classes.length} classes, ${subjects.length} subjects, ${teachers.length} teachers, ${students.length} students, ${periods.length} periods, ${feeStructures.length} fee structures.`
    )
  }

  private async seedSuperAdmin(schoolId: number) {
    const email = env.get('SEED_SUPER_ADMIN_EMAIL', 'superadmin@demo-academy.test')
    const password = env.get('SEED_SUPER_ADMIN_PASSWORD', 'ChangeMe123!')
    // firstOrCreate: never overwrite an existing user's password or their
    // must-change flag on a re-seed. Only initialize on first creation.
    const admin = await User.firstOrCreate(
      { email },
      { fullName: 'Super Admin', surname: 'Admin', password, mustChangePassword: true }
    )
    await UserSchoolRole.updateOrCreate(
      { userId: admin.id, schoolId, role: 'super_admin' },
      {}
    )
    return admin
  }

  private async seedClasses(schoolId: number): Promise<SchoolClass[]> {
    const specs = [
      { name: 'JSS 1A', level: 'JSS 1' },
      { name: 'JSS 1B', level: 'JSS 1' },
      { name: 'JSS 2A', level: 'JSS 2' },
      { name: 'JSS 3A', level: 'JSS 3' },
      { name: 'SS 1A', level: 'SS 1' },
      { name: 'SS 2A', level: 'SS 2' },
    ]
    const rows: SchoolClass[] = []
    for (const s of specs) {
      rows.push(
        await SchoolClass.updateOrCreate(
          { schoolId, name: s.name },
          { level: s.level }
        )
      )
    }
    return rows
  }

  private async seedSubjects(schoolId: number): Promise<Subject[]> {
    const specs = [
      { name: 'Mathematics', code: 'MTH' },
      { name: 'English Language', code: 'ENG' },
      { name: 'Basic Science', code: 'BSC' },
      { name: 'Basic Technology', code: 'BTC' },
      { name: 'Social Studies', code: 'SOS' },
      { name: 'Civic Education', code: 'CVE' },
      { name: 'Christian Religious Studies', code: 'CRS' },
      { name: 'Cultural & Creative Arts', code: 'CCA' },
      { name: 'Physical & Health Education', code: 'PHE' },
      { name: 'Computer Studies', code: 'CMP' },
      { name: 'Yoruba', code: 'YOR' },
      { name: 'French', code: 'FRE' },
      { name: 'Home Economics', code: 'HEC' },
      { name: 'Agricultural Science', code: 'AGR' },
    ]
    const rows: Subject[] = []
    for (const s of specs) {
      rows.push(
        await Subject.updateOrCreate({ schoolId, name: s.name }, { code: s.code })
      )
    }
    return rows
  }

  private async seedTeachers(schoolId: number): Promise<User[]> {
    const specs = [
      { fullName: 'Adeola Ogundipe', email: 'adeola.ogundipe@demo-academy.test' },
      { fullName: 'Chinedu Okafor', email: 'chinedu.okafor@demo-academy.test' },
      { fullName: 'Aisha Mohammed', email: 'aisha.mohammed@demo-academy.test' },
      { fullName: 'Emeka Nwosu', email: 'emeka.nwosu@demo-academy.test' },
      { fullName: 'Funmi Adebayo', email: 'funmi.adebayo@demo-academy.test' },
      { fullName: 'Sade Balogun', email: 'sade.balogun@demo-academy.test' },
      { fullName: 'Tunde Fashola', email: 'tunde.fashola@demo-academy.test' },
      { fullName: 'Ngozi Ibe', email: 'ngozi.ibe@demo-academy.test' },
    ]
    const rows: User[] = []
    for (const t of specs) {
      const surname = t.fullName.split(' ').slice(-1)[0]
      // Preserve teachers who've already changed their password.
      const user = await User.firstOrCreate(
        { email: t.email },
        {
          fullName: t.fullName,
          surname,
          password: surname.toLowerCase(),
          mustChangePassword: true,
        }
      )
      await UserSchoolRole.updateOrCreate(
        { userId: user.id, schoolId, role: 'teacher' },
        {}
      )
      rows.push(user)
    }
    return rows
  }

  private async attachSubjectsToClasses(classes: SchoolClass[], subjects: Subject[]) {
    // Junior classes get the JSS core subject set; senior classes get an SS
    // curriculum. Kept simple - every class gets 8-10 subjects.
    const jssSubjectNames = [
      'Mathematics',
      'English Language',
      'Basic Science',
      'Basic Technology',
      'Social Studies',
      'Civic Education',
      'Christian Religious Studies',
      'Cultural & Creative Arts',
      'Physical & Health Education',
      'Computer Studies',
      'Yoruba',
      'French',
    ]
    const ssSubjectNames = [
      'Mathematics',
      'English Language',
      'Civic Education',
      'Physical & Health Education',
      'Computer Studies',
      'Agricultural Science',
      'Home Economics',
      'French',
    ]
    for (const cls of classes) {
      const wanted = cls.level?.startsWith('SS') ? ssSubjectNames : jssSubjectNames
      const subs = subjects.filter((s) => wanted.includes(s.name))
      // Sync: attach any missing links (existing links stay)
      const existingIds = (await cls.related('subjects').query().select('subjects.id')).map(
        (s) => s.id
      )
      const toAdd = subs.map((s) => s.id).filter((id) => !existingIds.includes(id))
      if (toAdd.length) await cls.related('subjects').attach(toAdd)
    }
  }

  /**
   * Distribute the school's subjects across teachers per class in a
   * round-robin so every (class, subject) pair has at least one qualified
   * teacher. Idempotent - skips pairs that already exist.
   */
  private async seedTeachingLoad(classes: SchoolClass[], teachers: User[]) {
    if (teachers.length === 0) return
    for (const cls of classes) {
      await cls.load('subjects')
      for (const [sIdx, subject] of cls.subjects.entries()) {
        const teacher = teachers[(cls.id + sIdx) % teachers.length]
        await TeacherSubject.updateOrCreate(
          { userId: teacher.id, classId: cls.id, subjectId: subject.id },
          {}
        )
      }
    }
  }

  private async assignClassTeachers(classes: SchoolClass[], teachers: User[]) {
    for (const [i, cls] of classes.entries()) {
      if (cls.classTeacherId) continue
      cls.classTeacherId = teachers[i % teachers.length].id
      await cls.save()
    }
  }

  private async seedStudents(
    schoolId: number,
    classes: SchoolClass[]
  ): Promise<Student[]> {
    // 6 students per class = 36 total. Uses realistic Nigerian names.
    const firstNames = [
      'Chiamaka', 'Kunle', 'Aisha', 'Emeka', 'Titi',
      'Yakubu', 'Amara', 'Femi', 'Zainab', 'Ifeanyi',
      'Oluchi', 'Musa', 'Ngozi', 'Segun', 'Halima',
    ]
    const lastNames = [
      'Okonkwo', 'Adegoke', 'Bello', 'Uche', 'Adebayo',
      'Onyeka', 'Ibrahim', 'Adeleke', 'Nwankwo', 'Yusuf',
    ]

    const rows: Student[] = []
    const yr = new Date().getFullYear()
    let counter = 1

    for (const cls of classes) {
      for (let i = 0; i < 6; i++) {
        const first = firstNames[(cls.id * 3 + i) % firstNames.length]
        const last = lastNames[(cls.id * 5 + i) % lastNames.length]
        const admissionNumber = `ADM/${yr}/${String(counter).padStart(4, '0')}`
        counter += 1

        // Create synthetic user so login works, using our existing pattern
        const email = `${admissionNumber
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')}@students.demo-academy.local`
        const user = await User.firstOrCreate(
          { email },
          {
            fullName: `${first} ${last}`,
            surname: last,
            password: last.toLowerCase(),
            mustChangePassword: true,
          }
        )
        await UserSchoolRole.updateOrCreate(
          { userId: user.id, schoolId, role: 'student' },
          {}
        )

        const student = await Student.updateOrCreate(
          { schoolId, admissionNumber },
          {
            userId: user.id,
            firstName: first,
            lastName: last,
            classId: cls.id,
            gender: i % 2 === 0 ? 'female' : 'male',
            admissionYear: yr,
            isArchived: false,
          }
        )
        rows.push(student)
      }
    }
    return rows
  }

  /** Two parent users, each linked to a handful of students, to show off the pivot. */
  private async seedParents(schoolId: number, students: Student[]) {
    const parents = [
      { fullName: 'Byron Lovelace', email: 'lovelace.parent@demo-academy.test' },
      { fullName: 'Grace Adeyemi', email: 'grace.adeyemi@demo-academy.test' },
      { fullName: 'Musa Ibrahim', email: 'musa.ibrahim@demo-academy.test' },
    ]
    for (const [i, p] of parents.entries()) {
      const surname = p.fullName.split(' ').slice(-1)[0]
      const user = await User.firstOrCreate(
        { email: p.email },
        {
          fullName: p.fullName,
          surname,
          password: surname.toLowerCase(),
          mustChangePassword: true,
        }
      )
      await UserSchoolRole.updateOrCreate(
        { userId: user.id, schoolId, role: 'parent' },
        {}
      )
      // Link to a slice of students so at least some invoices/promotions have
      // real parents behind them.
      const wards = students.slice(i * 4, i * 4 + 3)
      for (const [wIdx, w] of wards.entries()) {
        await ParentStudent.updateOrCreate(
          { parentUserId: user.id, studentId: w.id },
          { relationship: wIdx === 0 ? 'father' : 'guardian', isPrimary: wIdx === 0 }
        )
      }
    }
  }

  private async seedPeriods(schoolId: number): Promise<TimetablePeriod[]> {
    const specs = [
      { name: 'Period 1', startTime: '08:00', endTime: '08:40', orderIndex: 1, isBreak: false },
      { name: 'Period 2', startTime: '08:40', endTime: '09:20', orderIndex: 2, isBreak: false },
      { name: 'Period 3', startTime: '09:20', endTime: '10:00', orderIndex: 3, isBreak: false },
      { name: 'Break', startTime: '10:00', endTime: '10:20', orderIndex: 4, isBreak: true },
      { name: 'Period 4', startTime: '10:20', endTime: '11:00', orderIndex: 5, isBreak: false },
      { name: 'Period 5', startTime: '11:00', endTime: '11:40', orderIndex: 6, isBreak: false },
      { name: 'Period 6', startTime: '11:40', endTime: '12:20', orderIndex: 7, isBreak: false },
    ]
    const rows: TimetablePeriod[] = []
    for (const s of specs) {
      rows.push(
        await TimetablePeriod.updateOrCreate(
          { schoolId, name: s.name },
          s
        )
      )
    }
    return rows
  }

  /**
   * Fills every class × day × non-break period with a subject+teacher.
   * Deterministic - same seed input produces the same grid.
   * Deliberately introduces subject repeats (Maths & English 2× on some days)
   * and teacher clashes (same teacher in two classes at once) so the UI has
   * something interesting to render.
   */
  private async seedTimetable(
    schoolId: number,
    classes: SchoolClass[],
    periods: TimetablePeriod[],
    subjects: Subject[],
    teachers: User[]
  ) {
    // Wipe existing so a re-run gives a clean, deterministic grid.
    await TimetableSlot.query().where('school_id', schoolId).delete()

    const teachingPeriods = periods.filter((p) => !p.isBreak).sort((a, b) => a.orderIndex - b.orderIndex)
    const days = [1, 2, 3, 4, 5] // Mon-Fri

    // Pin core subjects to specific teachers for consistency.
    const nameToSubject = new Map(subjects.map((s) => [s.name, s]))
    const teacherByIdx = (n: number) => teachers[n % teachers.length]

    const rotation: { subject: Subject; teacher: User }[] = [
      { subject: nameToSubject.get('Mathematics')!, teacher: teacherByIdx(0) },
      { subject: nameToSubject.get('English Language')!, teacher: teacherByIdx(1) },
      { subject: nameToSubject.get('Basic Science') ?? nameToSubject.get('Agricultural Science')!, teacher: teacherByIdx(2) },
      { subject: nameToSubject.get('Social Studies') ?? nameToSubject.get('Civic Education')!, teacher: teacherByIdx(3) },
      { subject: nameToSubject.get('Computer Studies')!, teacher: teacherByIdx(4) },
      { subject: nameToSubject.get('Physical & Health Education')!, teacher: teacherByIdx(5) },
    ].filter((r) => r.subject)

    for (const [classIdx, cls] of classes.entries()) {
      for (const day of days) {
        for (const [pIdx, period] of teachingPeriods.entries()) {
          // Base rotation offset per (day + class + period) creates variety.
          const rotIdx = (day + classIdx + pIdx) % rotation.length
          let pick = rotation[rotIdx]

          // Sprinkle repeats: on Mon+Wed, put Maths in periods 1 AND 4 for
          // every class so the ×N badges have something to show.
          if ((day === 1 || day === 3) && (pIdx === 0 || pIdx === 3)) {
            pick = { subject: nameToSubject.get('Mathematics')!, teacher: teacherByIdx(0) }
          }
          // Same for English on Tue/Thu, periods 2 + 5.
          if ((day === 2 || day === 4) && (pIdx === 1 || pIdx === 4)) {
            pick = { subject: nameToSubject.get('English Language')!, teacher: teacherByIdx(1) }
          }

          await TimetableSlot.create({
            schoolId,
            classId: cls.id,
            dayOfWeek: day,
            periodId: period.id,
            subjectId: pick.subject.id,
            teacherId: pick.teacher.id,
          })
        }
      }
    }
    // Because every class shares the same Mon-P1 Maths (teacherByIdx(0)),
    // and Tue-P2 English (teacherByIdx(1)), the whole-school clash detector
    // will light up nicely.
  }

  private async ensureCurrentTerm(schoolId: number): Promise<Term> {
    const yr = new Date().getFullYear()
    const session = `${yr}/${yr + 1}`
    let term = await Term.query()
      .where('school_id', schoolId)
      .where('session', session)
      .where('name', 'first')
      .first()
    if (!term) {
      // Clear any other current-flag so ours can hold it exclusively.
      await Term.query().where('school_id', schoolId).update({ is_current: false })
      term = await Term.create({
        schoolId,
        session,
        name: 'first',
        startsOn: DateTime.fromISO(`${yr}-09-15`),
        endsOn: DateTime.fromISO(`${yr}-12-15`),
        isCurrent: true,
      })
    }
    return term
  }

  private async seedFeeStructures(
    schoolId: number,
    termId: number,
    classes: SchoolClass[]
  ): Promise<FeeStructure[]> {
    const jssClassIds = classes.filter((c) => c.level?.startsWith('JSS')).map((c) => c.id)
    const ssClassIds = classes.filter((c) => c.level?.startsWith('SS')).map((c) => c.id)

    const specs = [
      {
        name: 'JSS Term Fees',
        classIds: jssClassIds,
        items: [
          { description: 'Tuition', amount: 75000 },
          { description: 'PTA Levy', amount: 2500 },
          { description: 'Sports & Games', amount: 3000 },
          { description: 'ICT Levy', amount: 5000 },
          { description: 'Books & Materials', amount: 12000 },
        ],
      },
      {
        name: 'SS Term Fees',
        classIds: ssClassIds,
        items: [
          { description: 'Tuition', amount: 95000 },
          { description: 'PTA Levy', amount: 2500 },
          { description: 'Sports & Games', amount: 3500 },
          { description: 'ICT Levy', amount: 6000 },
          { description: 'Books & Materials', amount: 15000 },
          { description: 'Lab Consumables', amount: 8000 },
        ],
      },
    ]

    const rows: FeeStructure[] = []
    for (const spec of specs) {
      const s = await FeeStructure.updateOrCreate(
        { schoolId, name: spec.name },
        {
          classId: spec.classIds[0] ?? null,
          classIds: spec.classIds.length ? spec.classIds : null,
          termId,
        }
      )
      // Reset items to match spec
      await FeeItem.query().where('fee_structure_id', s.id).delete()
      for (const it of spec.items) {
        await FeeItem.create({
          feeStructureId: s.id,
          description: it.description,
          amountKobo: it.amount * 100,
          isOptional: false,
        })
      }
      await s.load('items')
      rows.push(s)
    }
    return rows
  }

  private async generateInvoices(
    schoolId: number,
    termId: number,
    structures: FeeStructure[],
    students: Student[]
  ) {
    // Determine starting invoice number so we don't collide with any manual
    // invoices already in the DB.
    const existingCount = await FeeInvoice.query()
      .where('school_id', schoolId)
      .count('* as total')
    let nextN = Number(existingCount[0].$extras.total) + 1
    const yr = new Date().getFullYear()

    for (const structure of structures) {
      const classIds = structure.classIds ?? (structure.classId ? [structure.classId] : [])
      const total = structure.items.reduce((s, i) => s + Number(i.amountKobo), 0)
      const eligibleStudents = students.filter(
        (s) => s.classId && classIds.includes(s.classId)
      )
      for (const stu of eligibleStudents) {
        const existing = await FeeInvoice.query()
          .where('student_id', stu.id)
          .where('term_id', termId)
          .where('fee_structure_id', structure.id)
          .first()
        if (existing) continue

        const invoice = await FeeInvoice.create({
          schoolId,
          studentId: stu.id,
          termId,
          feeStructureId: structure.id,
          invoiceNumber: `INV-${yr}-${String(nextN).padStart(5, '0')}`,
          totalAmountKobo: total,
          status: 'pending',
          issuedOn: DateTime.now(),
          dueOn: DateTime.now().plus({ days: 30 }),
        })
        nextN += 1
        for (const item of structure.items) {
          await FeeInvoiceItem.create({
            invoiceId: invoice.id,
            description: item.description,
            amountKobo: Number(item.amountKobo),
          })
        }
      }
    }
  }

  /**
   * For every 3rd invoice → full payment (status: paid).
   * For every other invoice → 40% partial payment (status: partial).
   * The rest stay pending. Gives the Payments tab realistic mix.
   */
  private async recordSamplePayments(schoolId: number) {
    const invoices = await FeeInvoice.query()
      .where('school_id', schoolId)
      .preload('payments')
      .orderBy('id', 'asc')

    const admin = await User.query()
      .whereHas('roleAssignments', (q) => q.where('school_id', schoolId).where('role', 'super_admin'))
      .first()

    for (const [i, inv] of invoices.entries()) {
      if (inv.payments.length > 0) continue // already paid on before

      let action: 'full' | 'partial' | 'none'
      if (i % 3 === 0) action = 'full'
      else if (i % 2 === 0) action = 'partial'
      else action = 'none'
      if (action === 'none') continue

      const total = Number(inv.totalAmountKobo)
      const amount = action === 'full' ? total : Math.round(total * 0.4)
      await db.transaction(async (trx) => {
        await Payment.create(
          {
            schoolId,
            invoiceId: inv.id,
            studentId: inv.studentId,
            amountKobo: amount,
            method: 'transfer',
            reference: `SEED-${inv.invoiceNumber}`,
            paidAt: DateTime.now().minus({ days: 3 }),
            recordedByUserId: admin?.id ?? null,
          },
          { client: trx }
        )
        inv.useTransaction(trx)
        inv.status = action === 'full' ? 'paid' : 'partial'
        await inv.save()
      })
    }
  }
}
