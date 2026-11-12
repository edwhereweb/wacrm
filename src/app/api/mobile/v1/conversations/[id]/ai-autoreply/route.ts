// POST /api/mobile/v1/conversations/{id}/ai-autoreply — { paused, assign_to_me? } (agent+).
// "Take over" pauses the bot (and can assign you); resuming hands the chat back to it.
import { POST as dashboardPOST } from '@/app/api/ai/autoreply/[conversationId]/route'
import { withEnvelope } from '@/lib/mobile/respond'

const handler = withEnvelope(dashboardPOST)

// The dashboard route names its segment `conversationId`.
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(request, { params: params.then(({ id }) => ({ conversationId: id })) })
}
