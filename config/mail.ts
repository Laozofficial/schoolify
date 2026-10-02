import env from '#start/env'
import { defineConfig, transports } from '@adonisjs/mail'
import type { InferMailers } from '@adonisjs/mail/types'

const smtpUser = env.get('SMTP_USERNAME')
const smtpPass = env.get('SMTP_PASSWORD')

const mailConfig = defineConfig({
  default: env.get('MAIL_MAILER'),

  from: {
    address: env.get('MAIL_FROM_ADDRESS'),
    name: env.get('MAIL_FROM_NAME'),
  },

  globals: {
    brandName: env.get('MAIL_FROM_NAME'),
  },

  mailers: {
    smtp: transports.smtp({
      host: env.get('SMTP_HOST'),
      port: env.get('SMTP_PORT'),
      secure: env.get('SMTP_SECURE') === true,
      ...(env.get('SMTP_ALLOW_UNAUTHORIZED_CERTS') === true
        ? { tls: { rejectUnauthorized: false } }
        : {}),
      ...(smtpUser
        ? {
            auth: {
              type: 'login' as const,
              user: smtpUser,
              pass: smtpPass ?? '',
            },
          }
        : {}),
    }),
  },
})

export default mailConfig

declare module '@adonisjs/mail/types' {
  export interface MailersList extends InferMailers<typeof mailConfig> {}
}
