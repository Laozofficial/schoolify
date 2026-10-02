import { BaseJob, type JobPayload } from '#jobs/base_job'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import mail from '@adonisjs/mail/services/main'
import env from '#start/env'
import TimetableSlot from '#models/timetable_slot'
import TimetablePeriod from '#models/timetable_period'
import User from '#models/user'
import Notification from '#models/notification'
import NotificationDispatch from '#models/notification_dispatch'

/**
 * Runs every minute (see worker.ts). For each teaching period at each
 * school it fires two alerts:
 *   - `period_starting_soon` - 10 minutes before start (email + in-app)
 *   - `period_started`       - at start (in-app only)
 *
 * `notification_dispatches` gives us idempotency: we only ever send each
 * (teacher, slot, date, kind) combination once, even if the cron fires
 * multiple times in the same minute or the process restarts.
 *
 * Timezone: hardcoded to Africa/Lagos - Nigerian schools. Adjust if
 * ever multi-region.
 */
export default class PeriodReminderJob extends BaseJob<JobPayload> {
  static queueName = 'default'
  static jobName = 'period_reminder'
  static repeatKey = 'period-reminder-heartbeat'

  async handle() {
    const now = DateTime.now().setZone('Africa/Lagos')
    const dayOfWeek = now.weekday // 1..7
    const today = now.toFormat('yyyy-LL-dd')

    // Match on HH:MM string - periods are stored that way.
    const nowHHMM = now.toFormat('HH:mm')
    const soonHHMM = now.plus({ minutes: 10 }).toFormat('HH:mm')

    const startingNow = await this.slotsAt(dayOfWeek, nowHHMM)
    const startingSoon = await this.slotsAt(dayOfWeek, soonHHMM)

    for (const s of startingNow) {
      await this.dispatch(s, 'period_started', today, /*email=*/ false)
    }
    for (const s of startingSoon) {
      await this.dispatch(s, 'period_starting_soon', today, /*email=*/ true)
    }
  }

  private async slotsAt(dayOfWeek: number, hhmm: string) {
    return TimetableSlot.query()
      .where('day_of_week', dayOfWeek)
      .whereNotNull('teacher_id')
      .whereIn(
        'period_id',
        TimetablePeriod.query()
          .select('id')
          .where('start_time', hhmm)
          .where('is_break', false)
      )
      .preload('period')
      .preload('subject')
      .preload('teacher')
      .preload('schoolClass')
      .preload('school')
  }

  /**
   * Idempotent per (userId, slotId, forDate, kind). Uses
   * `notification_dispatches` as a ledger: the row is inserted first -
   * on conflict, another worker already handled this alert and we bail.
   */
  private async dispatch(
    slot: TimetableSlot,
    kind: 'period_started' | 'period_starting_soon',
    forDate: string,
    sendEmail: boolean
  ) {
    if (!slot.teacherId) return

    const dispatched = await db.rawQuery(
      'INSERT INTO notification_dispatches (user_id, slot_id, for_date, kind, created_at) ' +
        'VALUES (?, ?, ?, ?, now()) ON CONFLICT DO NOTHING RETURNING id',
      [slot.teacherId, slot.id, forDate, kind]
    )
    // pg returns { rows: [...] } - if empty, another worker beat us to it.
    const rows = (dispatched as any).rows ?? []
    if (rows.length === 0) return

    const period = slot.period
    const subjectName = slot.subject?.name ?? 'Free period'
    const className = slot.schoolClass?.name ?? `Class ${slot.classId}`
    const timeLabel = `${period?.startTime ?? ''} \u2013 ${period?.endTime ?? ''}`

    const title =
      kind === 'period_started'
        ? `${subjectName} · ${className} starts now`
        : `${subjectName} · ${className} in 10 minutes`
    const body =
      kind === 'period_started'
        ? `${period?.name ?? 'Your period'} (${timeLabel}) is starting.`
        : `${period?.name ?? 'Your next period'} (${timeLabel}) starts in 10 minutes.`

    await Notification.create({
      userId: slot.teacherId,
      schoolId: slot.schoolId,
      kind,
      title,
      body,
      data: {
        slotId: slot.id,
        classId: slot.classId,
        className,
        subjectId: slot.subjectId,
        subjectName,
        periodId: slot.periodId,
        periodName: period?.name ?? null,
        startTime: period?.startTime ?? null,
        endTime: period?.endTime ?? null,
      },
    })

    if (sendEmail) {
      const teacher = slot.teacher ?? (await User.find(slot.teacherId))
      if (teacher?.email) {
        await this.sendEmail({
          to: teacher.email,
          teacherName: teacher.fullName?.split(' ')[0] ?? 'there',
          subject: `${subjectName} · ${className} - starts in 10 min`,
          heading: `${subjectName} · ${className}`,
          body,
          schoolName: slot.school?.name ?? 'School Portal',
        })
      }
    }
  }

  private async sendEmail(p: {
    to: string
    teacherName: string
    subject: string
    heading: string
    body: string
    schoolName: string
  }) {
    const fromAddress = env.get('MAIL_FROM_ADDRESS')
    if (!fromAddress) {
      this.logger.warn('MAIL_FROM_ADDRESS not set - skipping reminder email')
      return
    }
    await mail.send((message) => {
      message
        .from(fromAddress, p.schoolName)
        .to(p.to)
        .subject(p.subject)
        .html(emailHtml(p))
        .text(`${p.heading}\n\n${p.body}`)
    })
  }
}

function emailHtml(p: { teacherName: string; heading: string; body: string; schoolName: string }) {
  const esc = (s: string) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
    )
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f8fb;font-family:Outfit,ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellspacing="0" cellpadding="0"
             style="max-width:520px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px 28px 0;">
          <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;font-weight:600;">
            ${esc(p.schoolName)} · Class reminder
          </div>
          <h1 style="margin:6px 0 0;font-size:20px;letter-spacing:-.01em;">${esc(p.heading)}</h1>
        </td></tr>
        <tr><td style="padding:18px 28px 28px;color:#334155;font-size:14px;line-height:1.55;">
          Hi ${esc(p.teacherName)}, ${esc(p.body)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}
