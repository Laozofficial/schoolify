import { BaseJob, type JobPayload } from '#jobs/base_job'
import mail from '@adonisjs/mail/services/main'
import env from '#start/env'

export interface SendInvitePayload extends JobPayload {
  to: string
  fullName: string | null
  tempPassword: string
  schoolName: string
  roleLabel: string
}

/**
 * Queued welcome email for staff/parent invites. Runs on the worker so the
 * HTTP request that created the account returns immediately even if SMTP is
 * slow or momentarily unreachable.
 */
export default class SendInviteJob extends BaseJob<SendInvitePayload> {
  static queueName = 'default'
  static jobName = 'send_invite'

  async handle(payload: SendInvitePayload) {
    const loginUrl = `${env.get('FRONTEND_URL') ?? 'http://localhost:3000'}/login`
    const name = payload.fullName?.split(' ')[0] ?? 'there'

    // Override the FROM display name so recipients see the school's name,
    // not the global MAIL_FROM_NAME (which is a tenant-agnostic default).
    const fromAddress = env.get('MAIL_FROM_ADDRESS')
    await mail.send((message) => {
      message
        .from(fromAddress, payload.schoolName)
        .to(payload.to)
        .subject(`You've been invited to ${payload.schoolName}`)
        .html(html({ name, ...payload, loginUrl }))
        .text(text({ name, ...payload, loginUrl }))
    })
  }
}

/* ---------- Templates (inline so we don't spin up Edge for a single email) ---------- */

function html(p: {
  name: string
  to: string
  tempPassword: string
  schoolName: string
  roleLabel: string
  loginUrl: string
}) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f7f8fb;font-family:Outfit,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0"
               style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
          <tr><td style="padding:32px 32px 0;">
            <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;font-weight:600;">
              ${escape(p.schoolName)}
            </div>
            <h1 style="margin:8px 0 0;font-size:22px;letter-spacing:-.01em;">Welcome, ${escape(p.name)}</h1>
            <p style="color:#64748b;margin:8px 0 0;">
              You've been added to <strong>${escape(p.schoolName)}</strong> as
              <strong>${escape(p.roleLabel)}</strong>. Use the temporary password below to sign in - you'll be asked to set a new one right away.
            </p>
          </td></tr>
          <tr><td style="padding:24px 32px 0;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                   style="border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;">
              <tr>
                <td style="padding:14px 16px;font-size:12px;color:#64748b;">Email</td>
                <td style="padding:14px 16px;text-align:right;font-weight:600;">${escape(p.to)}</td>
              </tr>
              <tr>
                <td style="padding:14px 16px;font-size:12px;color:#64748b;border-top:1px solid #e5e7eb;">Temporary password</td>
                <td style="padding:14px 16px;text-align:right;font-family:ui-monospace,monospace;font-weight:600;border-top:1px solid #e5e7eb;">${escape(p.tempPassword)}</td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding:24px 32px 32px;">
            <a href="${escape(p.loginUrl)}"
               style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;font-size:14px;">
              Sign in
            </a>
            <p style="color:#94a3b8;font-size:11px;margin:16px 0 0;">
              If you weren't expecting this, ignore this email.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
}

function text(p: {
  name: string
  to: string
  tempPassword: string
  schoolName: string
  roleLabel: string
  loginUrl: string
}) {
  return [
    `Welcome, ${p.name}`,
    ``,
    `You've been added to ${p.schoolName} as ${p.roleLabel}.`,
    `Use the temporary password below to sign in; you'll be asked to set a new one immediately.`,
    ``,
    `Email:    ${p.to}`,
    `Password: ${p.tempPassword}`,
    ``,
    `Sign in: ${p.loginUrl}`,
  ].join('\n')
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
