// POST / DELETE /api/mobile/v1/contacts/{id}/tags — { tag_id } (agent+). Adding a tag fires tag automations, as on the web.
import { DELETE as dashboardDELETE, POST as dashboardPOST } from '@/app/api/contacts/[id]/tags/route'
import { withEnvelope } from '@/lib/mobile/respond'

export const POST = withEnvelope(dashboardPOST)
export const DELETE = withEnvelope(dashboardDELETE)
