import env from '#start/env'
import { defineConfig } from '@adonisjs/cors'

const origins = (env.get('CORS_ORIGIN') ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

const corsConfig = defineConfig({
  enabled: true,
  origin: origins.length > 0 ? origins : false,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  headers: true,
  exposeHeaders: [],
  credentials: true,
  maxAge: 90,
})

export default corsConfig
