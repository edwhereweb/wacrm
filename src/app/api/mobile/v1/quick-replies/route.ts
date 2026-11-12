// GET /api/mobile/v1/quick-replies → { data: { quick_replies: [...] } }
import { GET as dashboardGET } from '@/app/api/quick-replies/route'
import { withEnvelope } from '@/lib/mobile/respond'

export const GET = withEnvelope(dashboardGET)
