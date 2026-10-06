import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import type School from '#models/school'
import SchoolClass from '#models/school_class'
import Student from '#models/student'
import User from '#models/user'
import UserSchoolRole, { type Role } from '#models/user_school_role'
import ParentStudent from '#models/parent_student'
import { provisionUserWithRoles } from '#services/user_provisioning'
import { normalizePhone } from '#services/whatsapp'
import { dispatch } from '#services/queue'
import { emitEvent } from '#services/events'
import SendInviteJob from '#jobs/send_invite_job'

/**
 * Spreadsheet import for classes, students, parents and staff.
 *
 * Every kind runs in two passes over the same code: a dry run that only
 * validates and reports what would happen, and a commit that applies the
 * rows that passed. Rows are matched to existing records (class name,
 * admission number, email or phone) so re-importing a sheet updates
 * instead of duplicating.
 */

export type ImportKind = 'classes' | 'students' | 'parents' | 'staff'
export type Row = Record<string, string>

export interface RowResult {
  row: number
  status: 'ok' | 'error'
  action: 'create' | 'update' | 'skip'
  label: string
  messages: string[]
  credentials?: { login: string; tempPassword: string } | null
}

export interface ImportOptions {
  dryRun: boolean
  sendInvites: boolean
}

export const COLUMNS: Record<ImportKind, { key: string; label: string; required?: boolean; aliases?: string[]; help?: string }[]> = {
  classes: [
    { key: 'name', label: 'Class name', required: true, aliases: ['class', 'class_name'] },
    { key: 'level', label: 'Level', aliases: ['grade', 'stage'] },
    { key: 'class_teacher_email', label: 'Class teacher email', aliases: ['teacher_email', 'class_teacher'] },
  ],
  students: [
    { key: 'admission_number', label: 'Admission number', required: true, aliases: ['admission_no', 'adm_no', 'reg_no', 'admission'] },
    { key: 'first_name', label: 'First name', required: true, aliases: ['firstname', 'given_name'] },
    { key: 'last_name', label: 'Last name', required: true, aliases: ['surname', 'lastname', 'family_name'] },
    { key: 'middle_name', label: 'Middle name', aliases: ['other_names', 'middlename'] },
    { key: 'gender', label: 'Gender', aliases: ['sex'], help: 'male or female' },
    { key: 'date_of_birth', label: 'Date of birth', aliases: ['dob', 'birth_date', 'birthday'], help: 'YYYY-MM-DD or DD/MM/YYYY' },
    { key: 'class', label: 'Class', aliases: ['class_name', 'arm'], help: 'Must match a class name' },
    { key: 'admission_year', label: 'Admission year', aliases: ['year_admitted'] },
    { key: 'phone', label: 'Student phone' },
    { key: 'email', label: 'Student email' },
    { key: 'address', label: 'Address', aliases: ['home_address'] },
    { key: 'blood_group', label: 'Blood group', aliases: ['blood_type'] },
    { key: 'allergies', label: 'Allergies' },
    { key: 'medical_notes', label: 'Medical notes', aliases: ['medical'] },
    { key: 'emergency_contact_name', label: 'Emergency contact name' },
    { key: 'emergency_contact_phone', label: 'Emergency contact phone' },
    { key: 'parent_name', label: 'Parent name', aliases: ['guardian_name', 'parent', 'guardian'] },
    { key: 'parent_email', label: 'Parent email', aliases: ['guardian_email'] },
    { key: 'parent_phone', label: 'Parent phone', aliases: ['guardian_phone', 'parent_mobile'] },
    { key: 'relationship', label: 'Relationship', aliases: ['parent_relationship'], help: 'Father, Mother, Guardian...' },
  ],
  parents: [
    { key: 'full_name', label: 'Full name', required: true, aliases: ['name', 'parent_name', 'guardian_name'] },
    { key: 'email', label: 'Email', aliases: ['email_address'], help: 'Email or phone is required' },
    { key: 'phone', label: 'Phone', aliases: ['mobile', 'phone_number'] },
    { key: 'relationship', label: 'Relationship' },
    { key: 'children', label: 'Children admission numbers', aliases: ['admission_numbers', 'students', 'wards', 'admission_number'], help: 'Separate several with ;' },
  ],
  staff: [
    { key: 'full_name', label: 'Full name', required: true, aliases: ['name', 'staff_name'] },
    { key: 'email', label: 'Email', required: true, aliases: ['email_address'] },
    { key: 'phone', label: 'Phone', aliases: ['mobile', 'phone_number'] },
    { key: 'roles', label: 'Roles', aliases: ['role', 'position'], help: 'teacher; admin; accountant; non_academic_staff' },
  ],
}

const ROLE_ALIASES: Record<string, Role> = {
  teacher: 'teacher',
  teachers: 'teacher',
  admin: 'admin',
  administrator: 'admin',
  accountant: 'accountant',
  bursar: 'accountant',
  finance: 'accountant',
  non_academic_staff: 'non_academic_staff',
  'non-academic': 'non_academic_staff',
  non_academic: 'non_academic_staff',
  support: 'non_academic_staff',
  security: 'non_academic_staff',
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  teacher: 'Teacher',
  accountant: 'Accountant',
  non_academic_staff: 'Non-academic staff',
  parent: 'Parent',
}

function v(r: Row, k: string) {
  return String(r[k] ?? '').trim()
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Accepts YYYY-MM-DD, DD/MM/YYYY, D-M-YYYY and Excel serial numbers. */
export function parseDate(raw: string): DateTime | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d{5}$/.test(s)) {
    // Excel serial date (days since 1899-12-30).
    return DateTime.fromISO('1899-12-30').plus({ days: Number(s) })
  }
  for (const fmt of ['yyyy-MM-dd', 'dd/MM/yyyy', 'd/M/yyyy', 'dd-MM-yyyy', 'd-M-yyyy', 'dd.MM.yyyy', 'yyyy/MM/dd']) {
    const d = DateTime.fromFormat(s, fmt)
    if (d.isValid) return d
  }
  const iso = DateTime.fromISO(s)
  return iso.isValid ? iso : null
}

function parseGender(raw: string): 'male' | 'female' | 'other' | null | undefined {
  const s = raw.trim().toLowerCase()
  if (!s) return undefined
  if (['m', 'male', 'boy'].includes(s)) return 'male'
  if (['f', 'female', 'girl'].includes(s)) return 'female'
  if (s === 'other') return 'other'
  return null
}

function splitName(full: string) {
  const parts = full.trim().split(/\s+/)
  return { surname: parts.length > 1 ? parts[parts.length - 1] : parts[0] }
}

function synthParentEmail(phone: string, slug: string) {
  return `p${phone}@parents.${slug}.local`
}

function synthStudentEmail(admissionNumber: string, slug: string) {
  const safe = admissionNumber.toLowerCase().replace(/[^a-z0-9]/g, '')
  return `${safe}@students.${slug}.local`
}

/** Find a user by email, or by normalised phone when no email is given. */
async function findPerson(email: string, phone: string): Promise<User | null> {
  if (email) {
    const u = await User.query().whereRaw('lower(email) = ?', [email.toLowerCase()]).first()
    if (u) return u
  }
  if (phone) {
    const norm = normalizePhone(phone)
    const rows = await User.query().whereNotNull('phone').select('id', 'phone', 'email', 'full_name')
    return rows.find((u) => u.phone && normalizePhone(u.phone) === norm) ?? null
  }
  return null
}

/* ------------------------------------------------------------------ */

export async function runImport(school: School, kind: ImportKind, rows: Row[], opts: ImportOptions): Promise<RowResult[]> {
  switch (kind) {
    case 'classes':
      return importClasses(school, rows, opts)
    case 'students':
      return importStudents(school, rows, opts)
    case 'parents':
      return importParents(school, rows, opts)
    case 'staff':
      return importStaff(school, rows, opts)
  }
}

async function importClasses(school: School, rows: Row[], opts: ImportOptions): Promise<RowResult[]> {
  const existing = await SchoolClass.query().where('school_id', school.id)
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]))
  const seen = new Set<string>()
  const out: RowResult[] = []
  for (const [i, r] of rows.entries()) {
    const name = v(r, 'name')
    const res: RowResult = { row: i + 1, status: 'ok', action: 'create', label: name || '(no name)', messages: [] }
    out.push(res)
    if (!name) {
      res.status = 'error'
      res.messages.push('Class name is required')
      continue
    }
    if (seen.has(name.toLowerCase())) {
      res.status = 'error'
      res.messages.push('Duplicate class name in this file')
      continue
    }
    seen.add(name.toLowerCase())
    const found = byName.get(name.toLowerCase())
    res.action = found ? 'update' : 'create'

    let teacherId: number | null | undefined
    const tEmail = v(r, 'class_teacher_email')
    if (tEmail) {
      const t = await db
        .from('users as u')
        .join('user_school_roles as r', 'r.user_id', 'u.id')
        .where('r.school_id', school.id)
        .where('r.role', 'teacher')
        .whereRaw('lower(u.email) = ?', [tEmail.toLowerCase()])
        .select('u.id')
        .first()
      if (!t) res.messages.push(`No teacher with email ${tEmail}; class teacher left unchanged`)
      else teacherId = t.id
    }
    if (opts.dryRun) continue
    if (found) {
      if (v(r, 'level')) found.level = v(r, 'level')
      if (teacherId) found.classTeacherId = teacherId
      await found.save()
    } else {
      const c = await SchoolClass.create({
        schoolId: school.id,
        name,
        level: v(r, 'level') || null,
        classTeacherId: teacherId ?? null,
      })
      byName.set(name.toLowerCase(), c)
    }
  }
  return out
}

async function importStudents(school: School, rows: Row[], opts: ImportOptions): Promise<RowResult[]> {
  const classes = await SchoolClass.query().where('school_id', school.id)
  const classByName = new Map(classes.map((c) => [c.name.toLowerCase().replace(/\s+/g, ''), c]))
  const existing = await Student.query().where('school_id', school.id).select('id', 'admission_number')
  const byAdm = new Map(existing.map((s) => [s.admissionNumber.toLowerCase(), s.id]))
  const seen = new Set<string>()
  const out: RowResult[] = []

  for (const [i, r] of rows.entries()) {
    const adm = v(r, 'admission_number')
    const first = v(r, 'first_name')
    const last = v(r, 'last_name')
    const res: RowResult = { row: i + 1, status: 'ok', action: 'create', label: `${first} ${last}`.trim() || adm || '(blank)', messages: [] }
    out.push(res)
    const errors: string[] = []
    if (!adm) errors.push('Admission number is required')
    if (!first) errors.push('First name is required')
    if (!last) errors.push('Last name is required')
    if (adm && seen.has(adm.toLowerCase())) errors.push('Duplicate admission number in this file')
    if (adm) seen.add(adm.toLowerCase())

    const gender = parseGender(v(r, 'gender'))
    if (gender === null) errors.push(`Gender "${v(r, 'gender')}" should be male or female`)
    const dobRaw = v(r, 'date_of_birth')
    const dob = dobRaw ? parseDate(dobRaw) : null
    if (dobRaw && !dob) errors.push(`Date of birth "${dobRaw}" is not a date`)
    let classId: number | null | undefined
    const cls = v(r, 'class')
    if (cls) {
      const c = classByName.get(cls.toLowerCase().replace(/\s+/g, ''))
      if (!c) errors.push(`Class "${cls}" does not exist. Import classes first or fix the name.`)
      else classId = c.id
    }
    const yearRaw = v(r, 'admission_year')
    const year = yearRaw ? Number(yearRaw) : undefined
    if (yearRaw && (!Number.isInteger(year) || year! < 1900 || year! > 2100)) errors.push(`Admission year "${yearRaw}" is not a year`)
    const sEmail = v(r, 'email')
    if (sEmail && !EMAIL_RE.test(sEmail)) errors.push(`Student email "${sEmail}" is not valid`)

    const pEmail = v(r, 'parent_email')
    const pPhone = v(r, 'parent_phone')
    const pName = v(r, 'parent_name')
    if (pEmail && !EMAIL_RE.test(pEmail)) errors.push(`Parent email "${pEmail}" is not valid`)
    if ((pName || pPhone) && !pEmail && !pPhone) errors.push('Parent needs an email or a phone')
    if ((pEmail || pPhone) && !pName) res.messages.push('Parent has no name; the email or phone will be used')

    if (errors.length) {
      res.status = 'error'
      res.messages.unshift(...errors)
      continue
    }
    const existingId = byAdm.get(adm.toLowerCase())
    res.action = existingId ? 'update' : 'create'
    if (opts.dryRun) continue

    const fields: Record<string, unknown> = {
      firstName: first,
      lastName: last,
      middleName: v(r, 'middle_name') || null,
    }
    if (gender) fields.gender = gender
    if (dob) fields.dateOfBirth = dob
    if (classId !== undefined) fields.classId = classId
    if (year) fields.admissionYear = year
    const map: [string, string][] = [
      ['phone', 'phone'],
      ['email', 'email'],
      ['address', 'address'],
      ['blood_group', 'bloodGroup'],
      ['allergies', 'allergies'],
      ['medical_notes', 'medicalNotes'],
      ['emergency_contact_name', 'emergencyContactName'],
      ['emergency_contact_phone', 'emergencyContactPhone'],
    ]
    for (const [col, prop] of map) if (v(r, col)) fields[prop] = v(r, col)

    try {
      let student: Student
      if (existingId) {
        student = await Student.findOrFail(existingId)
        student.merge(fields)
        await student.save()
      } else {
        const { user } = await provisionUserWithRoles({
          email: synthStudentEmail(adm, school.slug),
          fullName: `${first} ${last}`,
          surname: last,
          schoolId: school.id,
          roles: ['student'],
        })
        student = await Student.create({ schoolId: school.id, userId: user.id, admissionNumber: adm, ...fields })
        byAdm.set(adm.toLowerCase(), student.id)
        await emitEvent(school.id, 'student.created', {
          studentId: student.id,
          admissionNumber: adm,
          firstName: first,
          lastName: last,
          source: 'import',
        })
      }

      if (pEmail || pPhone) {
        const link = await ensureParent(school, { name: pName, email: pEmail, phone: pPhone }, opts)
        // A blank cell never clears a relationship recorded earlier.
        await ParentStudent.updateOrCreate(
          { parentUserId: link.user.id, studentId: student.id },
          v(r, 'relationship') ? { relationship: v(r, 'relationship') } : {}
        )
        if (link.tempPassword) {
          res.credentials = { login: link.user.email, tempPassword: link.tempPassword }
          res.messages.push(`Parent account created for ${link.user.fullName ?? link.user.email}`)
        }
      }
    } catch (e) {
      res.status = 'error'
      res.messages.unshift(String((e as Error).message ?? e).slice(0, 300))
    }
  }
  return out
}

/** Find or create a parent account and give it the parent role here. */
async function ensureParent(
  school: School,
  p: { name: string; email: string; phone: string },
  opts: ImportOptions
): Promise<{ user: User; tempPassword: string | null }> {
  const found = await findPerson(p.email, p.phone)
  if (found) {
    await UserSchoolRole.updateOrCreate({ userId: found.id, schoolId: school.id, role: 'parent' }, {})
    if (!found.phone && p.phone) {
      found.phone = p.phone
      await found.save()
    }
    return { user: found, tempPassword: null }
  }
  const email = p.email || synthParentEmail(normalizePhone(p.phone), school.slug)
  const name = p.name || p.email || p.phone
  const { user, tempPassword } = await provisionUserWithRoles({
    email,
    fullName: name,
    surname: splitName(name).surname,
    phone: p.phone || null,
    schoolId: school.id,
    roles: ['parent'],
  })
  if (tempPassword && opts.sendInvites && p.email) {
    await dispatch(SendInviteJob, { to: user.email, fullName: user.fullName, tempPassword, schoolName: school.name, roleLabel: 'Parent' })
  }
  return { user, tempPassword }
}

async function importParents(school: School, rows: Row[], opts: ImportOptions): Promise<RowResult[]> {
  const students = await Student.query().where('school_id', school.id).select('id', 'admission_number')
  const byAdm = new Map(students.map((s) => [s.admissionNumber.toLowerCase(), s.id]))
  const out: RowResult[] = []
  for (const [i, r] of rows.entries()) {
    const name = v(r, 'full_name')
    const email = v(r, 'email')
    const phone = v(r, 'phone')
    const res: RowResult = { row: i + 1, status: 'ok', action: 'create', label: name || email || phone || '(blank)', messages: [] }
    out.push(res)
    const errors: string[] = []
    if (!name) errors.push('Full name is required')
    if (!email && !phone) errors.push('Email or phone is required')
    if (email && !EMAIL_RE.test(email)) errors.push(`Email "${email}" is not valid`)
    const kids = v(r, 'children')
      .split(/[;,|]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const kidIds: number[] = []
    for (const k of kids) {
      const id = byAdm.get(k.toLowerCase())
      if (!id) errors.push(`No student with admission number ${k}`)
      else kidIds.push(id)
    }
    if (errors.length) {
      res.status = 'error'
      res.messages.push(...errors)
      continue
    }
    const found = await findPerson(email, phone)
    res.action = found ? 'update' : 'create'
    if (!kids.length) res.messages.push('No children listed; the parent will not be linked yet')
    if (opts.dryRun) continue
    try {
      const link = await ensureParent(school, { name, email, phone }, opts)
      for (const sid of kidIds) {
        await ParentStudent.updateOrCreate(
          { parentUserId: link.user.id, studentId: sid },
          v(r, 'relationship') ? { relationship: v(r, 'relationship') } : {}
        )
      }
      if (link.tempPassword) res.credentials = { login: link.user.email, tempPassword: link.tempPassword }
    } catch (e) {
      res.status = 'error'
      res.messages.unshift(String((e as Error).message ?? e).slice(0, 300))
    }
  }
  return out
}

async function importStaff(school: School, rows: Row[], opts: ImportOptions): Promise<RowResult[]> {
  const out: RowResult[] = []
  const seen = new Set<string>()
  for (const [i, r] of rows.entries()) {
    const name = v(r, 'full_name')
    const email = v(r, 'email')
    const res: RowResult = { row: i + 1, status: 'ok', action: 'create', label: name || email || '(blank)', messages: [] }
    out.push(res)
    const errors: string[] = []
    if (!name) errors.push('Full name is required')
    if (!email) errors.push('Email is required')
    else if (!EMAIL_RE.test(email)) errors.push(`Email "${email}" is not valid`)
    if (email && seen.has(email.toLowerCase())) errors.push('Duplicate email in this file')
    if (email) seen.add(email.toLowerCase())
    const rawRoles = v(r, 'roles') || 'teacher'
    const roles: Role[] = []
    for (const part of rawRoles.split(/[;,|]+/).map((s) => s.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean)) {
      const role = ROLE_ALIASES[part] ?? ROLE_ALIASES[part.replace(/_/g, '-')]
      if (!role) errors.push(`Unknown role "${part}"`)
      else if (!roles.includes(role)) roles.push(role)
    }
    if (errors.length) {
      res.status = 'error'
      res.messages.push(...errors)
      continue
    }
    const found = await User.query().whereRaw('lower(email) = ?', [email.toLowerCase()]).first()
    res.action = found ? 'update' : 'create'
    res.messages.push(`Roles: ${roles.map((x) => ROLE_LABELS[x] ?? x).join(', ')}`)
    if (opts.dryRun) continue
    try {
      const { user, tempPassword } = await provisionUserWithRoles({
        email,
        fullName: name,
        surname: splitName(name).surname,
        phone: v(r, 'phone') || null,
        schoolId: school.id,
        roles,
      })
      if (!user.phone && v(r, 'phone')) {
        user.phone = v(r, 'phone')
        await user.save()
      }
      if (tempPassword) {
        res.credentials = { login: user.email, tempPassword }
        if (opts.sendInvites) {
          await dispatch(SendInviteJob, {
            to: user.email,
            fullName: user.fullName,
            tempPassword,
            schoolName: school.name,
            roleLabel: roles.map((x) => ROLE_LABELS[x] ?? x).join(', '),
          })
        }
      }
    } catch (e) {
      res.status = 'error'
      res.messages.unshift(String((e as Error).message ?? e).slice(0, 300))
    }
  }
  return out
}
