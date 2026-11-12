// POST /api/mobile/v1/media — multipart { file, kind: image|video|audio|document } (agent+).
// Stores the file in the account's `chat-media` folder and returns the public
// URL to pass as `media_url` when sending. Same bucket, path and size caps as
// the dashboard composer.

import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { buildMediaPath, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media'
import { limitUser } from '@/lib/mobile/inbox'
import { MobileError, ok, toMobileErrorResponse } from '@/lib/mobile/respond'

type Kind = keyof typeof MEDIA_MAX_BYTES_BY_KIND

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')
    limitUser(userId)

    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    const kind = form?.get('kind') as Kind | null
    if (!(file instanceof File) || !kind || !(kind in MEDIA_MAX_BYTES_BY_KIND)) {
      throw new MobileError('VALIDATION', 'Send a file and a kind of image, video, audio or document', 400)
    }
    if (file.size === 0 || file.size > MEDIA_MAX_BYTES_BY_KIND[kind]) {
      const mb = MEDIA_MAX_BYTES_BY_KIND[kind] / (1024 * 1024)
      throw new MobileError('VALIDATION', `That file is too large. The limit for ${kind} is ${mb} MB.`, 400)
    }
    if (kind !== 'document' && !file.type.startsWith(`${kind}/`)) {
      throw new MobileError('VALIDATION', `That file is not ${kind === 'image' ? 'an' : 'a'} ${kind}`, 400)
    }

    // Service role because the caller is verified above and the path is forced
    // under their own account; the bucket still enforces its MIME allow-list.
    const path = buildMediaPath(accountId, file.name || `upload.${file.type.split('/')[1] ?? 'bin'}`)
    const storage = supabaseAdmin().storage.from('chat-media')
    const { error } = await storage.upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type,
    })
    if (error) {
      // Bucket rejections (wrong type) are the caller's problem, not a 500.
      throw new MobileError('VALIDATION', `Upload rejected: ${error.message}`, 400)
    }

    return ok({ media_url: storage.getPublicUrl(path).data.publicUrl, media_type: file.type }, 201)
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
