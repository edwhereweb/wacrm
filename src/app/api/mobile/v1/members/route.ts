// GET /api/mobile/v1/members → { data: { members: [...] } } — assignee picker and sender names.
// Emails are included only for admin+, as on the dashboard.
import { GET as dashboardGET } from '@/app/api/account/members/route'
import { withEnvelope } from '@/lib/mobile/respond'

export const GET = withEnvelope(dashboardGET)
