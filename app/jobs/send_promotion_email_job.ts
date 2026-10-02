import { BaseJob, type JobPayload } from '#jobs/base_job'
import mail from '@adonisjs/mail/services/main'
import env from '#start/env'

export interface SendPromotionEmailPayload extends JobPayload {
  to: string
  parentName: string | null
  studentName: string
  schoolName: string
  fromClassName: string
  toClassName: string | null
  graduated: boolean
}

export default class SendPromotionEmailJob extends BaseJob<SendPromotionEmailPayload> {
  static queueName = 'default'
  static jobName = 'send_promotion_email'

  async handle(payload: SendPromotionEmailPayload) {
    const loginUrl = `${env.get('FRONTEND_URL') ?? 'http://localhost:3000'}/login`
    const fromAddress = env.get('MAIL_FROM_ADDRESS')

    const subject = payload.graduated
      ? `${payload.studentName} has graduated from ${payload.schoolName}`
      : `${payload.studentName} has been promoted to ${payload.toClassName}`

    await mail.send((message) => {
      message
        .from(fromAddress, payload.schoolName)
        .to(payload.to)
        .subject(subject)
        .html(html({ ...payload, loginUrl, subject }))
        .text(text({ ...payload, loginUrl, subject }))
    })
  }
}

function html(p: {
  parentName: string | null
  studentName: string
  schoolName: string
  fromClassName: string
  toClassName: string | null
  graduated: boolean
  loginUrl: string
  subject: string
}) {
  const greeting = p.parentName ? `Dear ${escape(p.parentName)}` : 'Dear parent'
  const body = p.graduated
    ? `Congratulations! <b>${escape(p.studentName)}</b> has graduated from <b>${escape(p.schoolName)}</b>. Their student portal will remain accessible for a short window.`
    : `We're pleased to inform you that <b>${escape(p.studentName)}</b> has been promoted from <b>${escape(p.fromClassName)}</b> to <b>${escape(p.toClassName ?? '')}</b>.`
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f8fb;font-family:Outfit,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
      <tr><td style="padding:32px;">
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;font-weight:600;">${escape(p.schoolName)}</div>
        <h1 style="margin:8px 0 12px;font-size:20px;letter-spacing:-.01em;">${escape(p.subject)}</h1>
        <p style="color:#475569;margin:0 0 12px;">${greeting},</p>
        <p style="color:#334155;margin:0 0 16px;">${body}</p>
        <a href="${escape(p.loginUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open parent portal</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

function text(p: {
  parentName: string | null
  studentName: string
  schoolName: string
  fromClassName: string
  toClassName: string | null
  graduated: boolean
  loginUrl: string
  subject: string
}) {
  const greeting = p.parentName ? `Dear ${p.parentName}` : 'Dear parent'
  const body = p.graduated
    ? `${p.studentName} has graduated from ${p.schoolName}.`
    : `${p.studentName} has been promoted from ${p.fromClassName} to ${p.toClassName}.`
  return [p.subject, '', `${greeting},`, '', body, '', `Open portal: ${p.loginUrl}`].join('\n')
}

function escape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c] as string)
}
