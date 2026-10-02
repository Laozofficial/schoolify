import env from '#start/env'
import { Queue, type JobsOptions } from 'bullmq'
import { jobs } from '#jobs/index'
import type { BaseJob, JobPayload } from '#jobs/base_job'

const password = env.get('REDIS_PASSWORD')?.release()
const connection = {
  host: env.get('REDIS_HOST'),
  port: env.get('REDIS_PORT'),
  password: password || undefined,
}

const queues = new Map<string, Queue>()

function queueFor(name: string): Queue {
  let q = queues.get(name)
  if (!q) {
    q = new Queue(name, { connection })
    queues.set(name, q)
  }
  return q
}

/**
 * Enqueue a job for the worker. The job class is looked up by its static
 * `jobName` so callers can pass either the class or its name.
 */
export async function dispatch<T extends BaseJob<any>>(
  job: (new () => T) & { queueName: string; jobName: string },
  payload: Parameters<T['handle']>[0],
  options?: JobsOptions
) {
  return queueFor(job.queueName).add(job.jobName, payload as JobPayload, options)
}

export function knownQueueNames(): string[] {
  return Array.from(new Set(jobs.map((j) => j.queueName)))
}

export function redisConnection() {
  return connection
}
