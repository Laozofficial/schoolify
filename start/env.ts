/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  // Node
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  // App
  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),

  // Session
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'database'] as const),

  // Database
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),

  // Redis
  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  REDIS_PASSWORD: Env.schema.secret.optional(),

  // Seeder defaults
  SEED_SUPER_ADMIN_EMAIL: Env.schema.string.optional(),
  SEED_SUPER_ADMIN_PASSWORD: Env.schema.string.optional(),

  // CORS (comma-separated origins)
  CORS_ORIGIN: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring the mail package
  |----------------------------------------------------------
  */
  MAIL_MAILER: Env.schema.enum(['smtp'] as const),
  MAIL_FROM_NAME: Env.schema.string(),
  MAIL_FROM_ADDRESS: Env.schema.string(),
  SMTP_HOST: Env.schema.string(),
  SMTP_PORT: Env.schema.number(),
  SMTP_SECURE: Env.schema.boolean.optional(),
  SMTP_USERNAME: Env.schema.string.optional(),
  SMTP_PASSWORD: Env.schema.string.optional(),
  /** Dev-only: skip TLS cert verification (needed behind corporate proxies). */
  SMTP_ALLOW_UNAUTHORIZED_CERTS: Env.schema.boolean.optional(),

  // Public URL used in emails
  FRONTEND_URL: Env.schema.string.optional(),
  /** Public API origin providers call back (delivery reports). Defaults to APP_URL. */
  PUBLIC_API_URL: Env.schema.string.optional(),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: Env.schema.string.optional(),
  CLOUDINARY_API_KEY: Env.schema.string.optional(),
  CLOUDINARY_API_SECRET: Env.schema.string.optional(),

  // Payments (payment.twelveai.app). All optional so boot works before keys
  // are provisioned; the pay endpoint returns 503 until they are set.
  PAYMENT_BASE_URL: Env.schema.string.optional(),
  PAYMENT_SECRET_KEY: Env.schema.secret.optional(),
  PAYMENT_PUBLIC_KEY: Env.schema.string.optional(),
  PAYMENT_WEBHOOK_SECRET: Env.schema.secret.optional(),

  // Schoolify's own TwelveAI Business account: school plan subscriptions,
  // AI credit top-ups and bank account lookups. Never used for school fees.
  TWELVEAI_BASE_URL: Env.schema.string.optional(),
  TWELVEAI_SECRET_KEY: Env.schema.secret.optional(),
  TWELVEAI_PUBLIC_KEY: Env.schema.string.optional(),
  TWELVEAI_WEBHOOK_SECRET: Env.schema.secret.optional(),
  /** When true, schools whose trial or plan has ended become read-only. */
  BILLING_ENFORCE: Env.schema.boolean.optional(),
  /** AI credit prices in kobo per 1,000 tokens (defaults NGN 12 in, NGN 72 out). */
  AI_PRICE_KOBO_PER_1K_INPUT: Env.schema.number.optional(),
  AI_PRICE_KOBO_PER_1K_OUTPUT: Env.schema.number.optional(),

  // AI (OpenAI). Optional so boot works without a key; AI endpoints return
  // 503 until it is set.
  OPENAI_API_KEY: Env.schema.secret.optional(),
  OPENAI_MODEL: Env.schema.string.optional(),
  OPENAI_REASONING_EFFORT: Env.schema.enum.optional(['none', 'low', 'medium', 'high'] as const),

  // WhatsApp (Meta Cloud API) for the family assistant. All optional; the
  // channel stays off until WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set.
  WHATSAPP_TOKEN: Env.schema.secret.optional(),
  WHATSAPP_PHONE_NUMBER_ID: Env.schema.string.optional(),
  WHATSAPP_VERIFY_TOKEN: Env.schema.secret.optional(),
  WHATSAPP_APP_SECRET: Env.schema.secret.optional(),
  // Public number parents message, digits only e.g. 2348012345678 (for wa.me links).
  WHATSAPP_DISPLAY_NUMBER: Env.schema.string.optional(),
  WHATSAPP_GRAPH_VERSION: Env.schema.string.optional(),
})
