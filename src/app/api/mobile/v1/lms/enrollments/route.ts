// GET /api/mobile/v1/lms/enrollments?phone=&email= → { data: { enrollments: [...] } }
// The LMS key stays on the server; same proxy the inbox sidebar uses.
import { GET as dashboardGET } from '@/app/api/integrations/lms/enrollments/route'
import { withEnvelope } from '@/lib/mobile/respond'

export const GET = withEnvelope(dashboardGET)
