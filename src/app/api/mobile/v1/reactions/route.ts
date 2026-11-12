// POST /api/mobile/v1/reactions — { message_id, emoji } (agent+); an empty emoji removes ours.
import { POST as dashboardPOST } from '@/app/api/whatsapp/react/route'
import { withEnvelope } from '@/lib/mobile/respond'

export const POST = withEnvelope(dashboardPOST)
