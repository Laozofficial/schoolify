import { aiJson, AiError } from '#services/ai'

/**
 * Shared AI question generator, used by teachers (exam builder drafts) and
 * students (practice sets). Output is validated and normalised here so
 * every caller gets clean, well-formed questions:
 * - exactly one valid answer index, no duplicate options,
 * - True/False options fixed to ["True","False"],
 * - MCQ options shuffled (models favour putting the answer first),
 * - plain text with no em dashes.
 */

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

export interface GeneratedQuestion {
  type: 'mcq' | 'true_false'
  prompt: string
  options: string[]
  correctIndex: number
  marks: number
  topic: string | null
  difficulty: Difficulty
  explanation: string | null
  aiGenerated: true
}

export function noEmDash(s: string): string {
  return s.replace(/\s*\u2014\s*/g, ', ').replace(/\u2013/g, '-')
}

function shuffleWithAnswer(options: string[], correctIndex: number) {
  const tagged = options.map((o, i) => ({ o, correct: i === correctIndex }))
  for (let i = tagged.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[tagged[i], tagged[j]] = [tagged[j], tagged[i]]
  }
  return { options: tagged.map((t) => t.o), correctIndex: tagged.findIndex((t) => t.correct) }
}

export async function generateQuestions(input: {
  schoolId: number
  userId: number
  feature: string
  className: string
  classLevel: string | null
  subjectName: string
  topic: string
  count: number
  difficulty: string
  questionType: string
  notes?: string
  avoid?: string[]
  /** 'practice' asks for a teaching-quality explanation per question. */
  purpose?: 'exam' | 'practice'
}): Promise<GeneratedQuestion[]> {
  const typeRule =
    input.questionType === 'mcq'
      ? 'All questions must be type "mcq".'
      : input.questionType === 'true_false'
        ? 'All questions must be type "true_false" with options exactly ["True","False"].'
        : 'Mix types: about 75% "mcq" and 25% "true_false".'
  const diffRule = DIFFICULTIES.includes(input.difficulty as Difficulty)
    ? `Every question should be "${input.difficulty}" difficulty.`
    : 'Mix difficulty: roughly 30% easy, 50% medium, 20% hard.'

  const system = [
    input.purpose === 'practice'
      ? 'You are a patient Nigerian teacher writing PRACTICE questions (aligned to the NERDC curriculum) to help one student strengthen a weak topic.'
      : 'You are an experienced Nigerian secondary and primary school teacher setting a CBT (computer based test) aligned to the NERDC curriculum.',
    'Rules for every question:',
    '- Exactly ONE option is unambiguously correct. No "all of the above" or "none of the above".',
    '- "mcq" questions have exactly 4 short, plausible options; distractors reflect common student mistakes.',
    '- "true_false" questions have options exactly ["True","False"].',
    '- correctIndex is the 0-based index of the correct option.',
    '- Age and level appropriate for the stated class. Use Nigerian names, places and naira where context helps.',
    '- No duplicate or near-duplicate questions, and none that repeat the "avoid" list.',
    input.purpose === 'practice'
      ? '- "topic" is a short sub-topic label (2 to 5 words). "explanation" teaches: 2 to 3 sentences showing how to reach the answer, written to the student.'
      : '- "topic" is a short sub-topic label (2 to 5 words). "explanation" is 1 to 2 sentences on why the answer is correct.',
    '- If lesson notes are provided, only ask about content in the notes.',
    '- Plain text only: no LaTeX, Markdown or HTML. Write fractions as 3/10, powers as x^2, and use the naira sign for money.',
    '- No two options may be equal in value or meaning (for example 0.3 and 0.30, or 1/2 and 2/4).',
    'Write in clear British English. Never use em dashes.',
  ].join('\n')

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'prompt', 'options', 'correctIndex', 'topic', 'difficulty', 'explanation'],
          properties: {
            type: { type: 'string', enum: ['mcq', 'true_false'] },
            prompt: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            correctIndex: { type: 'integer' },
            topic: { type: 'string' },
            difficulty: { type: 'string', enum: [...DIFFICULTIES] },
            explanation: { type: 'string' },
          },
        },
      },
    },
  }

  const out = await aiJson<{
    questions: {
      type: 'mcq' | 'true_false'
      prompt: string
      options: string[]
      correctIndex: number
      topic: string
      difficulty: Difficulty
      explanation: string
    }[]
  }>({
    schoolId: input.schoolId,
    userId: input.userId,
    feature: input.feature,
    system,
    user: JSON.stringify({
      class: input.className,
      classLevel: input.classLevel,
      subject: input.subjectName,
      topic: input.topic || null,
      count: input.count,
      typeRule,
      difficultyRule: diffRule,
      lessonNotes: input.notes || null,
      avoid: input.avoid ?? [],
    }),
    schema,
    schemaName: 'exam_questions',
    maxTokens: 16000,
  })

  const questions: GeneratedQuestion[] = []
  for (const q of out.questions ?? []) {
    const prompt = noEmDash(String(q.prompt ?? '').trim())
    if (!prompt) continue
    const base = {
      prompt,
      marks: 1,
      topic: noEmDash(q.topic ?? '').slice(0, 120) || null,
      difficulty: DIFFICULTIES.includes(q.difficulty) ? q.difficulty : ('medium' as Difficulty),
      explanation: noEmDash(q.explanation ?? '') || null,
      aiGenerated: true as const,
    }
    if (q.type === 'true_false') {
      questions.push({ ...base, type: 'true_false', options: ['True', 'False'], correctIndex: q.correctIndex === 1 ? 1 : 0 })
      continue
    }
    const opts = (q.options ?? []).map((o) => noEmDash(String(o).trim()))
    if (opts.length < 2 || opts.length > 6) continue
    if (!(q.correctIndex >= 0 && q.correctIndex < opts.length)) continue
    if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) continue
    const shuffled = shuffleWithAnswer(opts, q.correctIndex)
    questions.push({ ...base, type: 'mcq', options: shuffled.options, correctIndex: shuffled.correctIndex })
  }
  if (questions.length === 0) {
    throw new AiError('The AI did not return usable questions. Please try again.', 502)
  }
  return questions
}
