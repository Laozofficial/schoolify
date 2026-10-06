import type { GatewayPlanSpec } from '#services/twelveai'

/**
 * What schools pay to use Schoolify. Prices are in kobo and are the only
 * place to change them: the matching TwelveAI plans are created or updated
 * from this list the next time a school subscribes. Existing subscribers
 * keep the price they signed up at until they change plan.
 */

export type PlanKey = 'starter' | 'standard' | 'premium'
export type IntervalKey = 'monthly' | 'termly' | 'yearly'

export interface PlanDef {
  key: PlanKey
  name: string
  blurb: string
  /** Largest number of active students the plan covers; null = no limit. */
  maxStudents: number | null
  prices: Record<IntervalKey, number>
  highlights: string[]
}

const N = (naira: number) => naira * 100

export const PLANS: PlanDef[] = [
  {
    key: 'starter',
    name: 'Starter',
    blurb: 'For small schools getting organised.',
    maxStudents: 200,
    prices: { monthly: N(15_000), termly: N(50_000), yearly: N(135_000) },
    highlights: ['Up to 200 students', 'Every module included', 'Email support'],
  },
  {
    key: 'standard',
    name: 'Standard',
    blurb: 'For growing schools running everything on Schoolify.',
    maxStudents: 600,
    prices: { monthly: N(35_000), termly: N(120_000), yearly: N(320_000) },
    highlights: ['Up to 600 students', 'Every module included', 'Priority support'],
  },
  {
    key: 'premium',
    name: 'Premium',
    blurb: 'For large schools and groups of schools.',
    maxStudents: null,
    prices: { monthly: N(70_000), termly: N(240_000), yearly: N(640_000) },
    highlights: ['Unlimited students', 'Every module included', 'Dedicated onboarding'],
  },
]

export const INTERVALS: { key: IntervalKey; label: string; per: string; gateway: Pick<GatewayPlanSpec, 'interval' | 'intervalCount'> }[] = [
  { key: 'monthly', label: 'Monthly', per: 'month', gateway: { interval: 'monthly', intervalCount: 1 } },
  // A school term is roughly four months; three terms a year.
  { key: 'termly', label: 'Per term', per: 'term', gateway: { interval: 'monthly', intervalCount: 4 } },
  { key: 'yearly', label: 'Yearly', per: 'year', gateway: { interval: 'yearly', intervalCount: 1 } },
]

export const TRIAL_DAYS = 30

export function planFor(key: string): PlanDef | undefined {
  return PLANS.find((p) => p.key === key)
}

export function intervalFor(key: string) {
  return INTERVALS.find((i) => i.key === key)
}

export function gatewaySpec(plan: PlanDef, interval: (typeof INTERVALS)[number]): GatewayPlanSpec {
  return {
    key: `${plan.key}:${interval.key}`,
    name: `Schoolify ${plan.name} (${interval.label})`,
    description: `${plan.blurb} Billed ${interval.label.toLowerCase()}.`,
    amountKobo: plan.prices[interval.key],
    ...interval.gateway,
  }
}
