// GET /api/mobile/v1/tags → { data: { tags: [...] } }
import { GET as dashboardGET } from '@/app/api/tags/route'
import { withEnvelope } from '@/lib/mobile/respond'

export const GET = withEnvelope(dashboardGET)
