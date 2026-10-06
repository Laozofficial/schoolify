import { aiJson, AiError } from '#services/ai'
import type { SourcePart } from '#services/ai_sources'

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
  /** Uploaded photos / PDFs (model input parts) and what each one is. */
  sources?: SourcePart[]
  sourceSummary?: string[]
  /**
   * How to use the uploads: 'notes' asks only about their content,
   * 'similar' writes new questions in the style of a past paper, 'extract'
   * copies the paper's objective questions and works out the answers.
   */
  mode?: 'notes' | 'similar' | 'extract'
}): Promise<{ questions: GeneratedQuestion[]; readingNote: string | null }> {
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
    ...(input.sources?.length ? modeRules(input.mode ?? 'notes') : []),
    '- Plain text only: no LaTeX, Markdown or HTML. Write fractions as 3/10, powers as x^2, and use the naira sign for money.',
    '- No two options may be equal in value or meaning (for example 0.3 and 0.30, or 1/2 and 2/4).',
    'Write in clear British English. Never use em dashes.',
  ].join('\n')

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['questions', 'readingNote'],
    properties: {
      readingNote: { type: 'string' },
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

  const payload = JSON.stringify({
    class: input.className,
    classLevel: input.classLevel,
    subject: input.subjectName,
    topic: input.topic || null,
    count: input.count,
    typeRule,
    difficultyRule: diffRule,
    lessonNotes: input.notes || null,
    attachments: input.sourceSummary ?? [],
    avoid: input.avoid ?? [],
  })
  const out = await aiJson<{
    readingNote: string
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
    user: input.sources?.length ? [{ type: 'text', text: payload }, ...input.sources] : payload,
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
    if (input.mode === 'extract') {
      // Keep the paper's own option order (A to D) when copying questions.
      questions.push({ ...base, type: 'mcq', options: opts.map(stripLetter), correctIndex: q.correctIndex })
      continue
    }
    const shuffled = shuffleWithAnswer(opts, q.correctIndex)
    questions.push({ ...base, type: 'mcq', options: shuffled.options, correctIndex: shuffled.correctIndex })
  }
  if (questions.length === 0) {
    const why = noEmDash(String(out.readingNote ?? '').trim())
    throw new AiError(why || 'The AI did not return usable questions. Please try again.', 502)
  }
  return { questions, readingNote: noEmDash(String(out.readingNote ?? '').trim()) || null }
}

/** "A. Lagos" or "(b) Lagos" becomes "Lagos". */
function stripLetter(o: string) {
  return o.replace(/^\(?[a-fA-F][.):]\s+/, '').trim()
}

function modeRules(mode: 'notes' | 'similar' | 'extract'): string[] {
  const common = [
    'Attachments are photos, scans or PDFs provided by the teacher. They may be handwritten, skewed or low quality: read them carefully.',
    'If part of an attachment cannot be read with confidence, do not guess at it; mention it briefly in readingNote.',
    'If the attachments are clearly for a different subject or class than the one stated, start readingNote by saying so.',
  ]
  if (mode === 'extract') {
    return [
      ...common,
      'The attachments are past question papers. Copy each OBJECTIVE question (multiple choice or true/false) as written, fixing only obvious spelling mistakes, in the order it appears.',
      'Keep the paper\'s options in their original order, without the A/B/C/D letters. Work out the correct answer yourself; do not trust any answer marked on the paper without checking it.',
      'Skip essay, theory, fill-in-the-gap and any question that needs a diagram you cannot see clearly. Return at most "count" questions.',
      'readingNote: say how many questions were copied, how many were skipped and why, in one or two sentences.',
    ]
  }
  if (mode === 'similar') {
    return [
      ...common,
      'The attachments are past question papers. Write NEW questions that test the same topics, at the same level and in the same style. Never copy a question from the paper word for word.',
      'readingNote: one sentence on which topics from the paper the new questions cover.',
    ]
  }
  return [
    ...common,
    'The attachments are lesson notes or textbook pages. Every question must be answerable from their content alone.',
    'readingNote: one sentence on what the notes covered, plus anything you could not read.',
  ]
}
