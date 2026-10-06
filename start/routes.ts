/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'
import { controllers } from '#generated/controllers'

router.get('/', () => {
  return { hello: 'world' }
})

router
  .group(() => {
    // Auth
    router
      .group(() => {
        router.post('signup', [controllers.NewAccount, 'store'])
        router.post('login', [controllers.AccessTokens, 'store'])
      })
      .prefix('auth')
      .as('auth')

    // Account (authed)
    router
      .group(() => {
        router.get('profile', [controllers.Profile, 'show'])
        router.patch('password', [controllers.Profile, 'changePassword'])
        router.post('logout', [controllers.AccessTokens, 'destroy'])
        router.get('notifications', [controllers.Notifications, 'index'])
        router.patch('notifications/:id/read', [controllers.Notifications, 'markRead'])
        router.post('notifications/mark-all-read', [
          controllers.Notifications,
          'markAllRead',
        ])
        // NOTE: /account/permissions is school-scoped (needs ?schoolId via
        // the school group), so it lives in the school-scoped block below.
      })
      .prefix('account')
      .as('profile')
      .use(middleware.auth())

    // Me
    router
      .group(() => {
        router.get('schools', [controllers.Me, 'schools'])
      })
      .prefix('me')
      .as('me')
      .use(middleware.auth())

    // Uploads (any authed user; tenant-agnostic)
    router.post('uploads', [controllers.Uploads, 'store']).use(middleware.auth())

    // Payment gateway webhook (public - secured by HMAC signature, not auth).
    router.post('payments/webhook', [controllers.PaymentsWebhook, 'handle'])

    // WhatsApp Cloud API webhook (public - GET handshake, POST HMAC-signed).
    router.get('whatsapp/webhook', [controllers.WhatsappWebhook, 'verify'])
    router.post('whatsapp/webhook', [controllers.WhatsappWebhook, 'receive'])

    // Delivery reports from a school's own SMS/email/WhatsApp provider. The
    // token in the path identifies the connection (no auth header).
    router.get('hooks/messaging/:token', [controllers.MessagingHooks, 'verify'])
    router.post('hooks/messaging/:token', [controllers.MessagingHooks, 'receive'])

    // School-scoped resources
    router
      .group(() => {
        // School profile
        router.get('', [controllers.Schools, 'show'])
        router.get('dashboard', [controllers.Dashboard, 'show'])
        router
          .patch('', [controllers.Schools, 'update'])
          .use(middleware.requireRole(['super_admin']))

        // Student / parent portal (self + ward scoped; no RBAC gate)
        router.get('portal/wards', [controllers.Portal, 'wards'])
        router.get('portal/terms', [controllers.Portal, 'terms'])
        router.get('portal/students/:studentId/timetable', [
          controllers.Portal,
          'timetable',
        ])
        router.get('portal/students/:studentId/invoices', [
          controllers.Portal,
          'invoices',
        ])
        router.get('portal/students/:studentId/assignments', [
          controllers.Portal,
          'assignments',
        ])
        router.get('portal/students/:studentId/exams', [controllers.Portal, 'exams'])
        router.post('portal/students/:studentId/invoices/:invoiceId/pay', [
          controllers.Portal,
          'payInvoice',
        ])
        // Gate/front-desk pickup-code verification (staff only).
        router
          .post('pickup/verify', [controllers.Portal, 'verifyPickup'])
          .use(middleware.requireRole(['super_admin', 'admin', 'non_academic_staff']))
        router
          .group(() => {
            router.post('pickup/release', [controllers.Pickup, 'release'])
            router.get('pickup/logs', [controllers.Pickup, 'logs'])
            router.get('pickup/students/:studentId/collectors', [controllers.Pickup, 'collectors'])
            router.get('pickup/students/:studentId/authorized', [controllers.Pickup, 'listAuthorized'])
            router.post('pickup/students/:studentId/authorized', [controllers.Pickup, 'storeAuthorized'])
            router.put('pickup/authorized/:id', [controllers.Pickup, 'updateAuthorized'])
            router.delete('pickup/authorized/:id', [controllers.Pickup, 'destroyAuthorized'])
          })
          .use(middleware.requireRole(['super_admin', 'admin', 'non_academic_staff']))
        // Parents manage who else may collect their own children.
        router.get('portal/students/:studentId/pickups', [controllers.Pickup, 'portalList'])
        router.post('portal/students/:studentId/authorized', [controllers.Pickup, 'portalStore'])
        router.delete('portal/authorized/:id', [controllers.Pickup, 'portalDestroy'])

        // Permissions (RBAC)
        router.get('account/permissions', [controllers.Permissions, 'mine'])
        router
          .get('permissions/staff', [controllers.Permissions, 'staff'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .get('staff/:id/permissions', [controllers.Permissions, 'show'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .put('staff/:id/permissions', [controllers.Permissions, 'update'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Classes
        router
          .get('classes', [controllers.SchoolClasses, 'index'])
          .use(middleware.requirePermission(['classes', 'read']))
        router
          .get('classes/:id', [controllers.SchoolClasses, 'show'])
          .use(middleware.requirePermission(['classes', 'read']))
        router
          .post('classes', [controllers.SchoolClasses, 'store'])
          .use(middleware.requirePermission(['classes', 'create']))
        router
          .patch('classes/:id', [controllers.SchoolClasses, 'update'])
          .use(middleware.requirePermission(['classes', 'update']))
        router
          .delete('classes/:id', [controllers.SchoolClasses, 'destroy'])
          .use(middleware.requirePermission(['classes', 'delete']))

        // Subjects
        router
          .get('subjects', [controllers.Subjects, 'index'])
          .use(middleware.requirePermission(['subjects', 'read']))
        router
          .get('subjects/:id', [controllers.Subjects, 'show'])
          .use(middleware.requirePermission(['subjects', 'read']))
        router
          .post('subjects', [controllers.Subjects, 'store'])
          .use(middleware.requirePermission(['subjects', 'create']))
        router
          .patch('subjects/:id', [controllers.Subjects, 'update'])
          .use(middleware.requirePermission(['subjects', 'update']))
        router
          .delete('subjects/:id', [controllers.Subjects, 'destroy'])
          .use(middleware.requirePermission(['subjects', 'delete']))

        // Staff (admins, teachers, non-academic, accountant)
        router.get('staff', [controllers.Staff, 'index'])
        router
          .post('staff', [controllers.Staff, 'store'])
          .use(middleware.requireRole(['super_admin']))
        router
          .patch('staff/:id/roles', [controllers.Staff, 'updateRoles'])
          .use(middleware.requireRole(['super_admin']))
        router
          .delete('staff/:id', [controllers.Staff, 'destroy'])
          .use(middleware.requireRole(['super_admin']))
        router.get('staff/:id/subjects', [controllers.Staff, 'listSubjects'])
        router
          .put('staff/:id/subjects', [controllers.Staff, 'setSubjects'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Students
        router
          .get('students', [controllers.Students, 'index'])
          .use(middleware.requirePermission(['students', 'read']))
        router.get('students/next-admission-number', [
          controllers.Students,
          'nextAdmissionNumber',
        ])
        router
          .get('students/:id', [controllers.Students, 'show'])
          .use(middleware.requirePermission(['students', 'read']))
        router
          .post('students', [controllers.Students, 'store'])
          .use(middleware.requirePermission(['students', 'create']))
        router
          .patch('students/:id', [controllers.Students, 'update'])
          .use(middleware.requirePermission(['students', 'update']))
        router
          .post('students/:id/archive', [controllers.Students, 'archive'])
          .use(middleware.requirePermission(['students', 'delete']))
        router
          .post('students/:id/restore', [controllers.Students, 'restore'])
          .use(middleware.requirePermission(['students', 'update']))
        router
          .post('promotions', [controllers.Promotions, 'promote'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Assignments
        router.get('assignments', [controllers.Assignments, 'index'])
        router.get('assignments/:id', [controllers.Assignments, 'show'])
        router
          .post('assignments', [controllers.Assignments, 'store'])
          .use(middleware.requireRole(['super_admin', 'admin', 'teacher']))
        router
          .patch('assignments/:id', [controllers.Assignments, 'update'])
          .use(middleware.requireRole(['super_admin', 'admin', 'teacher']))
        router
          .delete('assignments/:id', [controllers.Assignments, 'destroy'])
          .use(middleware.requireRole(['super_admin', 'admin', 'teacher']))
        router.post('assignments/:id/submissions', [controllers.Assignments, 'submit'])
        router
          .patch('submissions/:submissionId/grade', [controllers.Assignments, 'grade'])
          .use(middleware.requireRole(['super_admin', 'admin', 'teacher']))

        // Expenses
        router.get('expenses', [controllers.Expenses, 'index'])
        router.get('expenses/:id', [controllers.Expenses, 'show'])
        router
          .post('expenses', [controllers.Expenses, 'store'])
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))
        router
          .patch('expenses/:id', [controllers.Expenses, 'update'])
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))
        router
          .delete('expenses/:id', [controllers.Expenses, 'destroy'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Fees & payments
        router.get('fee-structures', [controllers.Fees, 'listStructures'])
        router
          .post('fee-structures', [controllers.Fees, 'createStructure'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .patch('fee-structures/:id', [controllers.Fees, 'updateStructure'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .delete('fee-structures/:id', [controllers.Fees, 'destroyStructure'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        router
          .post('invoices/generate', [controllers.Fees, 'generateInvoices'])
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))
        router
          .post('invoices', [controllers.Fees, 'createInvoice'])
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))
        router.get('invoices', [controllers.Fees, 'listInvoices'])
        router.get('invoices/:id', [controllers.Fees, 'showInvoice'])

        router.get('payments', [controllers.Fees, 'listPayments'])
        router
          .post('payments', [controllers.Fees, 'recordPayment'])
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))
        router
          .post('payments/bulk', [controllers.Fees, 'recordBulkPayment'])
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))

        // Reports
        // Pedagogical reports (attendance + academic) are open to teachers;
        // enrollment + finance are whole-school / financial and restricted
        // to admins + accountants.
        router
          .group(() => {
            router.get('attendance', [controllers.Reports, 'attendance'])
            router.get('academic', [controllers.Reports, 'academic'])
          })
          .prefix('reports')
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant', 'teacher']))
        router
          .group(() => {
            router.get('enrollment', [controllers.Reports, 'enrollment'])
            router.get('finance', [controllers.Reports, 'finance'])
          })
          .prefix('reports')
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))

        // Parents
        router.get('parents', [controllers.Parents, 'index'])
        router.get('parents/:id', [controllers.Parents, 'show'])
        router
          .post('parents', [controllers.Parents, 'store'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .patch('parents/:id', [controllers.Parents, 'update'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .post('parents/:id/students', [controllers.Parents, 'linkStudent'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .delete('parents/:id/students/:studentId', [controllers.Parents, 'unlinkStudent'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Calendar events
        router.get('calendar', [controllers.CalendarEvents, 'index'])
        router.get('calendar/:id', [controllers.CalendarEvents, 'show'])
        router
          .post('calendar', [controllers.CalendarEvents, 'store'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .patch('calendar/:id', [controllers.CalendarEvents, 'update'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .delete('calendar/:id', [controllers.CalendarEvents, 'destroy'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Announcements
        router.get('announcements', [controllers.Announcements, 'index'])
        router.get('announcements/:id', [controllers.Announcements, 'show'])
        router
          .post('announcements', [controllers.Announcements, 'store'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .patch('announcements/:id', [controllers.Announcements, 'update'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .delete('announcements/:id', [controllers.Announcements, 'destroy'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Attendance
        router
          .get('attendance/day', [controllers.Attendance, 'day'])
          .use(middleware.requirePermission(['attendance', 'read']))
        router
          .post('attendance', [controllers.Attendance, 'mark'])
          .use(middleware.requirePermission(['attendance', 'create']))
        router.get('students/:studentId/attendance', [
          controllers.Attendance,
          'studentHistory',
        ])

        // Timetable
        router
          .get('timetable/periods', [controllers.Timetable, 'listPeriods'])
          .use(middleware.requirePermission(['timetable', 'read']))
        router
          .post('timetable/periods', [controllers.Timetable, 'createPeriod'])
          .use(middleware.requirePermission(['timetable', 'create']))
        router
          .patch('timetable/periods/:id', [controllers.Timetable, 'updatePeriod'])
          .use(middleware.requirePermission(['timetable', 'update']))
        router
          .delete('timetable/periods/:id', [controllers.Timetable, 'destroyPeriod'])
          .use(middleware.requirePermission(['timetable', 'delete']))
        router
          .get('classes/:classId/timetable', [controllers.Timetable, 'classGrid'])
          .use(middleware.requirePermission(['timetable', 'read']))
        router
          .put('classes/:classId/timetable', [controllers.Timetable, 'setClassGrid'])
          .use(middleware.requirePermission(['timetable', 'update']))

        // Whole-school timetable + per-slot CRUD
        router
          .get('timetable', [controllers.Timetable, 'schoolGrid'])
          .use(middleware.requirePermission(['timetable', 'read']))
        router
          .post('timetable/slots', [controllers.Timetable, 'createSlot'])
          .use(middleware.requirePermission(['timetable', 'create']))
        router
          .patch('timetable/slots/:id', [controllers.Timetable, 'updateSlot'])
          .use(middleware.requirePermission(['timetable', 'update']))
        router
          .delete('timetable/slots/:id', [controllers.Timetable, 'destroySlot'])
          .use(middleware.requirePermission(['timetable', 'delete']))
        router
          .post('timetable/auto-generate', [controllers.Timetable, 'autoGenerate'])
          .use(middleware.requirePermission(['timetable', 'create']))

        // Bank accounts
        router.get('bank-accounts', [controllers.BankAccounts, 'index'])
        router
          .post('bank-accounts', [controllers.BankAccounts, 'store'])
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))
        router
          .patch('bank-accounts/:id', [controllers.BankAccounts, 'update'])
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))
        router
          .delete('bank-accounts/:id', [controllers.BankAccounts, 'destroy'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Visitors log
        router.get('visitors', [controllers.Visitors, 'index'])
        router
          .post('visitors', [controllers.Visitors, 'store'])
          .use(middleware.requireRole(['super_admin', 'admin', 'non_academic_staff']))
        router
          .post('visitors/:id/checkout', [controllers.Visitors, 'checkout'])
          .use(middleware.requireRole(['super_admin', 'admin', 'non_academic_staff']))
        router
          .delete('visitors/:id', [controllers.Visitors, 'destroy'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Leave requests
        router.get('leave', [controllers.LeaveRequests, 'index'])
        router.post('leave', [controllers.LeaveRequests, 'store'])
        router
          .post('leave/:id/decide', [controllers.LeaveRequests, 'decide'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router.post('leave/:id/withdraw', [controllers.LeaveRequests, 'withdraw'])

        // Gate: QR / manual sign-in, staff GPS check-in, command centre
        const GATE_DESK = ['super_admin', 'admin', 'non_academic_staff'] as const
        router.get('gate/mine', [controllers.Gate, 'mine'])
        router.post('gate/self-checkin', [controllers.Gate, 'selfCheckin'])
        router
          .group(() => {
            router.post('gate/scan', [controllers.Gate, 'scan'])
            router.post('gate/manual', [controllers.Gate, 'manual'])
            router.get('gate/people', [controllers.Gate, 'people'])
            router.get('gate/today', [controllers.Gate, 'today'])
            router.get('gate/events', [controllers.Gate, 'events'])
            router.get('gate/badges', [controllers.Gate, 'badges'])
            router.get('gate/settings', [controllers.Gate, 'settings'])
          })
          .use(middleware.requireRole([...GATE_DESK]))
        router
          .put('gate/settings', [controllers.Gate, 'saveSettings'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Payroll (admins + accountants run it; staff see their own payslips)
        router.get('payroll/mine', [controllers.Payroll, 'mine'])
        router.get('payroll/payslips/:id', [controllers.Payroll, 'payslip'])
        router
          .group(() => {
            router.get('payroll/profiles', [controllers.Payroll, 'profiles'])
            router.put('payroll/profiles/:userId', [controllers.Payroll, 'saveProfile'])
            router.get('payroll/runs', [controllers.Payroll, 'runs'])
            router.post('payroll/runs', [controllers.Payroll, 'createRun'])
            router.get('payroll/runs/:id', [controllers.Payroll, 'showRun'])
            router.post('payroll/runs/:id/regenerate', [controllers.Payroll, 'regenerate'])
            router.put('payroll/payslips/:id', [controllers.Payroll, 'updatePayslip'])
            router.delete('payroll/payslips/:id', [controllers.Payroll, 'removePayslip'])
            router.delete('payroll/runs/:id', [controllers.Payroll, 'destroyRun'])
          })
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant']))
        router
          .group(() => {
            router.post('payroll/runs/:id/approve', [controllers.Payroll, 'approve'])
            router.post('payroll/runs/:id/paid', [controllers.Payroll, 'markPaid'])
          })
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Inventory (store keepers are non-academic staff)
        router
          .group(() => {
            router.get('inventory/summary', [controllers.Inventory, 'summary'])
            router.get('inventory/items', [controllers.Inventory, 'items'])
            router.post('inventory/items', [controllers.Inventory, 'storeItem'])
            router.put('inventory/items/:id', [controllers.Inventory, 'updateItem'])
            router.delete('inventory/items/:id', [controllers.Inventory, 'destroyItem'])
            router.post('inventory/items/:id/issue', [controllers.Inventory, 'issue'])
            router.post('inventory/items/:id/count', [controllers.Inventory, 'count'])
            router.get('inventory/movements', [controllers.Inventory, 'movements'])
            router.get('inventory/purchases', [controllers.Inventory, 'purchases'])
            router.post('inventory/purchases', [controllers.Inventory, 'storePurchase'])
            router.get('inventory/suppliers', [controllers.Inventory, 'suppliers'])
            router.post('inventory/suppliers', [controllers.Inventory, 'storeSupplier'])
            router.put('inventory/suppliers/:id', [controllers.Inventory, 'updateSupplier'])
            router.delete('inventory/suppliers/:id', [controllers.Inventory, 'destroySupplier'])
          })
          .use(middleware.requireRole(['super_admin', 'admin', 'accountant', 'non_academic_staff']))

        // Spreadsheet import (dry run, then apply)
        router
          .get('imports/columns', [controllers.Imports, 'columns'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .post('imports/:kind', [controllers.Imports, 'run'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Connections (school-owned SMS / email / WhatsApp accounts)
        router
          .group(() => {
            router.get('integrations/catalog', [controllers.Integrations, 'catalog'])
            router.get('integrations', [controllers.Integrations, 'index'])
            router.post('integrations', [controllers.Integrations, 'store'])
            router.patch('integrations/:id', [controllers.Integrations, 'update'])
            router.delete('integrations/:id', [controllers.Integrations, 'destroy'])
            router.post('integrations/:id/test', [controllers.Integrations, 'test'])

            // Messaging centre
            router.get('messaging/overview', [controllers.Messaging, 'overview'])
            router.post('messaging/audience-preview', [controllers.Messaging, 'audiencePreview'])
            router.post('messaging/send', [controllers.Messaging, 'send'])
            router.get('messaging/campaigns', [controllers.Messaging, 'campaigns'])
            router.get('messaging/campaigns/:id', [controllers.Messaging, 'campaign'])
            router.post('messaging/campaigns/:id/retry', [controllers.Messaging, 'retry'])
            router.get('messaging/deliveries', [controllers.Messaging, 'deliveries'])
            router.get('messaging/templates', [controllers.Messaging, 'templates'])
            router.post('messaging/templates', [controllers.Messaging, 'storeTemplate'])
            router.put('messaging/templates/:id', [controllers.Messaging, 'updateTemplate'])
            router.delete('messaging/templates/:id', [controllers.Messaging, 'destroyTemplate'])
            router.get('messaging/automations', [controllers.Messaging, 'automations'])
            router.put('messaging/automations', [controllers.Messaging, 'saveAutomations'])
          })
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Invitations (pending onboarding)
        router
          .get('invitations', [controllers.Invitations, 'index'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .post('invitations/:userId/resend', [controllers.Invitations, 'resend'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .delete('invitations/:userId', [controllers.Invitations, 'cancel'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        router
          .get('timetable/exceptions', [controllers.Timetable, 'listExceptions'])
          .use(middleware.requirePermission(['timetable', 'read']))
        router
          .put('timetable/slots/:id/exceptions', [
            controllers.Timetable,
            'upsertException',
          ])
          .use(middleware.requirePermission(['timetable', 'update']))

        // Results
        router.get('terms', [controllers.Results, 'listTerms'])
        router
          .post('terms', [controllers.Results, 'createTerm'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .patch('terms/:id', [controllers.Results, 'updateTerm'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .delete('terms/:id', [controllers.Results, 'destroyTerm'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        router.get('assessments', [controllers.Results, 'listAssessments'])
        router
          .post('assessments', [controllers.Results, 'createAssessment'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .patch('assessments/:id', [controllers.Results, 'updateAssessment'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .delete('assessments/:id', [controllers.Results, 'destroyAssessment'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        router
          .get('scores', [controllers.Results, 'scoreMatrix'])
          .use(middleware.requirePermission(['results', 'read']))
        router
          .post('scores', [controllers.Results, 'enterScores'])
          .use(middleware.requirePermission(['results', 'update']))

        // Report card: the controller self-authorizes (staff, the student,
        // or a parent of the student) and gates non-staff on approval, so
        // it is intentionally NOT behind requirePermission - the portal
        // relies on it.
        router.get('students/:studentId/report', [controllers.Results, 'studentReport'])
        router
          .get('classes/:classId/results', [controllers.Results, 'classResults'])
          .use(middleware.requirePermission(['results', 'read']))
        router
          .post('report-comments', [controllers.Results, 'upsertComment'])
          .use(middleware.requirePermission(['results', 'update']))
        router
          .post('report-comments/bulk', [controllers.Results, 'bulkComments'])
          .use(middleware.requirePermission(['results', 'update']))
        router
          .get('classes/:classId/comments', [controllers.Results, 'listComments'])
          .use(middleware.requirePermission(['results', 'read']))

        // AI (drafts only; a human reviews and saves through the normal
        // endpoints). Controllers re-check teacher scope per request.
        router.get('ai/status', [controllers.Ai, 'status'])

        // Family assistant (parents + students; access by relationship).
        router.get('assistant', [controllers.Assistant, 'show'])
        router.post('assistant/messages', [controllers.Assistant, 'send'])
        router.post('assistant/whatsapp/link', [controllers.Assistant, 'createLink'])
        router.delete('assistant/whatsapp', [controllers.Assistant, 'unlink'])

        // Student learning: published-exam review, AI tutor, practice sets.
        router.get('learn/overview', [controllers.Learning, 'overview'])
        router.get('learn/attempts/:attemptId', [controllers.Learning, 'review'])
        router.post('learn/attempts/:attemptId/questions/:questionId/explain', [
          controllers.Learning,
          'explain',
        ])
        router.post('learn/practice', [controllers.Learning, 'createPractice'])
        router.get('learn/practice/:id', [controllers.Learning, 'showPractice'])
        router.post('learn/practice/:id/answer', [controllers.Learning, 'answerPractice'])

        // AI grade suggestions for written assignments (teacher re-checked
        // against the class+subject they teach inside the controller).
        router
          .post('ai/assignments/:id/grade-suggestions', [controllers.Ai, 'suggestGrades'])
          .use(middleware.requireRole(['super_admin', 'admin', 'teacher']))

        // Admin copilot.
        router
          .group(() => {
            router.get('copilot', [controllers.Copilot, 'show'])
            router.post('copilot/messages', [controllers.Copilot, 'send'])
            router.post('copilot/messages/:messageId/actions/:index', [
              controllers.Copilot,
              'execute',
            ])
          })
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Early warning (class teachers see their own class; admins all).
        router
          .group(() => {
            router.get('risk-flags', [controllers.RiskFlags, 'index'])
            router.get('risk-flags/summary', [controllers.RiskFlags, 'summary'])
            router.post('risk-flags/scan', [controllers.RiskFlags, 'scan'])
            router.post('risk-flags/:id/review', [controllers.RiskFlags, 'review'])
            router.post('risk-flags/:id/reopen', [controllers.RiskFlags, 'reopen'])
          })
          .use(middleware.requireRole(['super_admin', 'admin', 'teacher']))
        router
          .post('ai/exams/generate', [controllers.Ai, 'generateQuestions'])
          .use(middleware.requirePermission(['exams', 'update']))
        router
          .post('ai/exams/check', [controllers.Ai, 'checkQuestions'])
          .use(middleware.requirePermission(['exams', 'read']))
        router
          .post('ai/report-comments/draft', [controllers.Ai, 'draftComments'])
          .use(middleware.requirePermission(['results', 'update']))

        // Grading scale (per-school)
        router.get('grade-scale', [controllers.Results, 'listGradeScale'])
        router
          .put('grade-scale', [controllers.Results, 'setGradeScale'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Report approvals
        router
          .get('terms/:termId/approvals', [controllers.Results, 'listApprovals'])
          .use(middleware.requireRole(['super_admin', 'admin', 'teacher']))
        router
          .post('approvals', [controllers.Results, 'approve'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .delete('terms/:termId/approvals/:studentId', [controllers.Results, 'unapprove'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // Exams / CBT authoring + review (teachers author their own; admins
        // review, approve, and publish results). Read/create/update/delete
        // are RBAC-gated on the `exams` resource; admin-only steps (review,
        // reopen, approve-results) are additionally role-gated inside the
        // controller.
        router
          .get('exams', [controllers.Exams, 'index'])
          .use(middleware.requirePermission(['exams', 'read']))
        router
          .get('exams/reusable', [controllers.Exams, 'reusable'])
          .use(middleware.requirePermission(['exams', 'read']))
        router
          .get('exams/:id', [controllers.Exams, 'show'])
          .use(middleware.requirePermission(['exams', 'read']))
        router
          .get('exams/:id/results', [controllers.Exams, 'results'])
          .use(middleware.requirePermission(['exams', 'read']))
        router
          .post('exams', [controllers.Exams, 'store'])
          .use(middleware.requirePermission(['exams', 'create']))
        router
          .patch('exams/:id', [controllers.Exams, 'update'])
          .use(middleware.requirePermission(['exams', 'update']))
        router
          .put('exams/:id/questions', [controllers.Exams, 'setQuestions'])
          .use(middleware.requirePermission(['exams', 'update']))
        router
          .post('exams/:id/import-questions', [controllers.Exams, 'importQuestions'])
          .use(middleware.requirePermission(['exams', 'update']))
        router
          .post('exams/:id/submit', [controllers.Exams, 'submit'])
          .use(middleware.requirePermission(['exams', 'update']))
        router
          .delete('exams/:id', [controllers.Exams, 'destroy'])
          .use(middleware.requirePermission(['exams', 'delete']))
        router
          .post('exams/:id/review', [controllers.Exams, 'review'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .post('exams/:id/reopen', [controllers.Exams, 'reopen'])
          .use(middleware.requireRole(['super_admin', 'admin']))
        router
          .post('exams/:id/approve-results', [controllers.Exams, 'approveResults'])
          .use(middleware.requireRole(['super_admin', 'admin']))

        // CBT centre (student self-service; access is by being a student of
        // the class, not by RBAC permission).
        router.get('cbt/exams', [controllers.Cbt, 'list'])
        router.post('cbt/exams/:id/start', [controllers.Cbt, 'start'])
        router.patch('cbt/attempts/:attemptId/answer', [controllers.Cbt, 'answer'])
        router.post('cbt/attempts/:attemptId/submit', [controllers.Cbt, 'submit'])
        router.get('cbt/results', [controllers.Cbt, 'myResults'])
      })
      .prefix('schools/:schoolId')
      .as('school')
      .use([middleware.auth(), middleware.schoolScope()])
  })
  .prefix('/api/v1')
