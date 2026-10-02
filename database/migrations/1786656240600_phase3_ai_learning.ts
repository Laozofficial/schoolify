import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Phase 3 AI learning features:
 * - assignments.rubric: the teacher's marking guide used for AI suggestions.
 * - assignment_submissions.ai_*: a SUGGESTED grade kept apart from the real
 *   score; it only becomes a grade when a teacher saves it.
 * - exam_tutor_notes: cached explanation per (question, chosen option), so
 *   one explanation serves every student who made the same mistake.
 * - practice_sets: ungraded, AI-generated practice for a student.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('assignments', (table) => {
      table.text('rubric').nullable()
    })

    this.schema.alterTable('assignment_submissions', (table) => {
      table.decimal('ai_suggested_score', 8, 2).nullable()
      table.text('ai_feedback').nullable()
      table.text('ai_rationale').nullable()
      // e.g. ["instruction_injection", "attachment_not_read", "off_topic"]
      table.jsonb('ai_flags').nullable()
      table.timestamp('ai_suggested_at').nullable()
    })

    this.schema.createTable('exam_tutor_notes', (table) => {
      table.increments('id').notNullable()
      table
        .integer('question_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('exam_questions')
        .onDelete('CASCADE')
      // -1 = question left unanswered
      table.integer('selected_index').notNullable()
      table.text('content').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.unique(['question_id', 'selected_index'])
    })

    this.schema.createTable('practice_sets', (table) => {
      table.increments('id').notNullable()
      table.integer('school_id').unsigned().notNullable().references('id').inTable('schools').onDelete('CASCADE')
      table.integer('student_id').unsigned().notNullable().references('id').inTable('students').onDelete('CASCADE')
      table.integer('subject_id').unsigned().notNullable().references('id').inTable('subjects').onDelete('CASCADE')
      table.string('topic', 200).notNullable()
      table.string('difficulty', 10).notNullable().defaultTo('mixed')
      // [{ type, prompt, options, correctIndex, explanation, topic }]
      table.jsonb('questions').notNullable()
      // selectedIndex per question, null until answered
      table.jsonb('answers').notNullable()
      table.integer('score').notNullable().defaultTo(0)
      table.timestamp('completed_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['student_id', 'created_at'])
    })
  }

  async down() {
    this.schema.dropTable('practice_sets')
    this.schema.dropTable('exam_tutor_notes')
    this.schema.alterTable('assignment_submissions', (table) => {
      table.dropColumn('ai_suggested_score')
      table.dropColumn('ai_feedback')
      table.dropColumn('ai_rationale')
      table.dropColumn('ai_flags')
      table.dropColumn('ai_suggested_at')
    })
    this.schema.alterTable('assignments', (table) => {
      table.dropColumn('rubric')
    })
  }
}
