// POST /api/mobile/v1/ai/draft — { conversation_id } → { data: { draft } } (agent+).
// Uses the account's own AI key, server-side, exactly as the inbox "AI draft" button.
import { POST as dashboardPOST } from '@/app/api/ai/draft/route'
import { withEnvelope } from '@/lib/mobile/respond'

export const POST = withEnvelope(dashboardPOST)
