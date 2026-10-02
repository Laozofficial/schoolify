import { BaseSeeder } from '@adonisjs/lucid/seeders'
import logger from '@adonisjs/core/services/logger'
import School from '#models/school'
import SchoolClass from '#models/school_class'
import User from '#models/user'
import Exam from '#models/exam'
import ExamQuestion from '#models/exam_question'
import TeacherSubject from '#models/teacher_subject'

/**
 * Seeds one APPROVED objective exam per (class, subject) so the CBT centre
 * has content to test end to end. Questions are drawn from a per-subject
 * bank (MCQ + True/False); subjects without a tailored bank fall back to a
 * generic set. Idempotent: matches the exam on (schoolId, classId,
 * subjectId, title) and fully replaces its questions on each run.
 *
 * Run: node ace db:seed --files ./database/seeders/demo_exams_seeder.ts
 */

type Q = { type: 'mcq' | 'true_false'; prompt: string; options: string[]; correctIndex: number }

const mcq = (prompt: string, options: string[], correctIndex: number): Q => ({
  type: 'mcq',
  prompt,
  options,
  correctIndex,
})
const tf = (prompt: string, answer: boolean): Q => ({
  type: 'true_false',
  prompt,
  options: ['True', 'False'],
  correctIndex: answer ? 0 : 1,
})

const BANK: Record<string, Q[]> = {
  Mathematics: [
    mcq('What is 7 × 8?', ['54', '56', '64', '48'], 1),
    mcq('What is the value of 12 ÷ 4 + 2?', ['5', '6', '3', '8'], 0),
    mcq('Which of these is a prime number?', ['9', '15', '11', '21'], 2),
    mcq('What is 25% of 200?', ['25', '75', '50', '100'], 2),
    tf('The sum of angles in a triangle is 180 degrees.', true),
  ],
  'English Language': [
    mcq('Choose the correct plural of "child".', ['childs', 'children', 'childes', 'child'], 1),
    mcq('Which word is a noun?', ['run', 'quickly', 'happiness', 'blue'], 2),
    mcq('Pick the correctly spelled word.', ['recieve', 'receive', 'receeve', 'receve'], 1),
    mcq('What is the opposite of "ancient"?', ['old', 'modern', 'past', 'former'], 1),
    tf('A verb is a word that shows an action or state.', true),
  ],
  'Basic Science': [
    mcq('Which gas do humans need to breathe in to survive?', ['Carbon dioxide', 'Nitrogen', 'Oxygen', 'Hydrogen'], 2),
    mcq('The process by which plants make food is called?', ['Respiration', 'Digestion', 'Photosynthesis', 'Excretion'], 2),
    mcq('Which of these is a source of light?', ['The moon', 'A mirror', 'The sun', 'A wall'], 2),
    tf('Water boils at 100 degrees Celsius at sea level.', true),
    tf('The heart pumps blood around the body.', true),
  ],
  'Basic Technology': [
    mcq('Which tool is used to drive a nail into wood?', ['Screwdriver', 'Hammer', 'Pliers', 'Spanner'], 1),
    mcq('What safety wear protects the eyes in a workshop?', ['Gloves', 'Helmet', 'Goggles', 'Apron'], 2),
    mcq('Which material is a good conductor of electricity?', ['Rubber', 'Wood', 'Copper', 'Plastic'], 2),
    tf('A pencil is used for setting out measurements in technical drawing.', true),
  ],
  'Social Studies': [
    mcq('The smallest unit of the family is the?', ['Community', 'Nuclear family', 'Nation', 'Clan'], 1),
    mcq('Which of these is a means of transportation?', ['Radio', 'Bicycle', 'Television', 'Newspaper'], 1),
    mcq('Culture is best described as?', ['A type of food', 'A way of life of a people', 'A kind of music', 'A festival'], 1),
    tf('Cooperation helps people live together peacefully.', true),
  ],
  'Civic Education': [
    mcq('Which of these is a right of a citizen?', ['Right to steal', 'Right to education', 'Right to cheat', 'Right to fight'], 1),
    mcq('A good citizen should always?', ['Break rules', 'Obey the law', 'Avoid voting', 'Litter'], 1),
    mcq('The document that states citizens rights and duties is the?', ['Menu', 'Constitution', 'Diary', 'Receipt'], 1),
    tf('Paying tax is a duty of every responsible citizen.', true),
  ],
  'Christian Religious Studies': [
    mcq('Who led the Israelites out of Egypt?', ['David', 'Moses', 'Paul', 'Peter'], 1),
    mcq('How many disciples did Jesus have?', ['10', '7', '12', '14'], 2),
    mcq('In which town was Jesus born?', ['Nazareth', 'Jerusalem', 'Bethlehem', 'Jericho'], 2),
    tf('The first book of the Bible is Genesis.', true),
  ],
  'Cultural & Creative Arts': [
    mcq('Which of these is a primary colour?', ['Green', 'Orange', 'Red', 'Purple'], 2),
    mcq('An instrument you beat to make sound is a?', ['Flute', 'Drum', 'Guitar', 'Trumpet'], 1),
    mcq('Mixing blue and yellow paint gives?', ['Purple', 'Green', 'Brown', 'Pink'], 1),
    tf('Sculpture is a form of visual art.', true),
  ],
  'Physical & Health Education': [
    mcq('How many players are in a standard football team on the pitch?', ['9', '10', '11', '12'], 2),
    mcq('Which of these keeps the body fit?', ['Sleeping all day', 'Regular exercise', 'Eating only sweets', 'Watching TV'], 1),
    mcq('Brushing the teeth is an example of?', ['Personal hygiene', 'Cooking', 'Farming', 'Trading'], 0),
    tf('Warming up before exercise helps prevent injury.', true),
  ],
  'Computer Studies': [
    mcq('What does CPU stand for?', ['Central Process Unit', 'Central Processing Unit', 'Computer Personal Unit', 'Control Processing Unit'], 1),
    mcq('Which of these is an input device?', ['Monitor', 'Printer', 'Keyboard', 'Speaker'], 2),
    mcq('Which is used to store data permanently?', ['RAM', 'Hard disk', 'Cache', 'Register'], 1),
    tf('A mouse is used to point and click on the screen.', true),
  ],
  Yoruba: [
    mcq('How do you say "Good morning" in Yoruba?', ['E kaasan', 'E kaaro', 'E kaale', 'O daaro'], 1),
    mcq('What is "water" in Yoruba?', ['Omi', 'Ina', 'Ile', 'Afefe'], 0),
    mcq('"Iwe" means what in English?', ['Chair', 'Book', 'Table', 'Pen'], 1),
    tf('"E se" means "thank you" in Yoruba.', true),
  ],
  French: [
    mcq('How do you say "hello" in French?', ['Merci', 'Bonjour', 'Au revoir', 'Oui'], 1),
    mcq('What does "merci" mean?', ['Please', 'Sorry', 'Thank you', 'Yes'], 2),
    mcq('The French word for "school" is?', ['Maison', 'Ecole', 'Livre', 'Chat'], 1),
    tf('"Oui" means "yes" in French.', true),
  ],
  'Home Economics': [
    mcq('Which nutrient helps to build the body?', ['Carbohydrate', 'Protein', 'Fat', 'Water'], 1),
    mcq('Which of these is a kitchen tool for cutting?', ['Spoon', 'Knife', 'Plate', 'Cup'], 1),
    mcq('Fruits and vegetables are good sources of?', ['Vitamins', 'Oil', 'Sugar', 'Salt'], 0),
    tf('Washing hands before cooking prevents contamination.', true),
  ],
  'Agricultural Science': [
    mcq('Which of these is a farm animal?', ['Lion', 'Goat', 'Snake', 'Eagle'], 1),
    mcq('The part of the plant that absorbs water is the?', ['Leaf', 'Flower', 'Root', 'Stem'], 2),
    mcq('Which tool is used for weeding?', ['Hoe', 'Kettle', 'Broom', 'Basket'], 0),
    tf('Manure is used to improve soil fertility.', true),
  ],
}

const GENERIC = (subject: string): Q[] => [
  mcq(`Which of the following is most closely related to ${subject}?`, [
    'None of these',
    `A topic in ${subject}`,
    'A random word',
    'An unrelated idea',
  ], 1),
  mcq(`${subject} is best described as a?`, ['Game', 'School subject', 'Type of food', 'Country'], 1),
  tf(`${subject} is taught in this school.`, true),
  tf(`Paying attention in ${subject} class helps you learn.`, true),
]

export default class extends BaseSeeder {
  async run() {
    const school = await School.findBy('slug', 'demo-academy')
    if (!school) {
      logger.warn('demo-academy not found; run the demo seeder first')
      return
    }

    // Fallback teacher for exams where no (class, subject) teacher is set.
    const fallbackTeacher = await User.query()
      .whereHas('roleAssignments', (r) => {
        r.where('school_id', school.id).whereIn('role', ['teacher', 'admin', 'super_admin'])
      })
      .first()
    if (!fallbackTeacher) {
      logger.warn('No teacher/admin found for the demo school; seed staff first')
      return
    }

    const classes = await SchoolClass.query()
      .where('school_id', school.id)
      .preload('subjects')

    let exams = 0
    let questions = 0

    for (const cls of classes) {
      for (const subject of cls.subjects) {
        const ts = await TeacherSubject.query()
          .where('class_id', cls.id)
          .where('subject_id', subject.id)
          .first()
        const teacherId = ts?.userId ?? cls.classTeacherId ?? fallbackTeacher.id

        const bank = BANK[subject.name] ?? GENERIC(subject.name)
        const title = `${subject.name} - Objective Test`

        const exam = await Exam.updateOrCreate(
          { schoolId: school.id, classId: cls.id, subjectId: subject.id, title },
          {
            teacherId,
            instructions: `Answer all questions. Choose the best option for each. Good luck!`,
            durationMinutes: 20,
            shuffleQuestions: true,
            // Half the exams reveal the score on submit; the rest wait for
            // admin to publish results (exercises both paths).
            showScoreImmediately: cls.id % 2 === 0,
            status: 'approved',
            reviewNote: null,
            opensAt: null,
            closesAt: null,
          }
        )
        if (exam.$isLocal) exams += 1

        // Replace the question set each run for a clean, idempotent state.
        await ExamQuestion.query().where('exam_id', exam.id).delete()
        for (const [i, q] of bank.entries()) {
          await ExamQuestion.create({
            examId: exam.id,
            type: q.type,
            prompt: q.prompt,
            options: q.options,
            correctIndex: q.correctIndex,
            marks: 1,
            orderIndex: i,
          })
          questions += 1
        }
      }
    }

    logger.info(
      `Seeded ${exams} new approved exams (${questions} questions) across ${classes.length} classes.`
    )
  }
}
