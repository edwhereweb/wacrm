// GET /api/mobile/v1/media/{mediaId} — inbound WhatsApp media that wasn't mirrored to storage.
// The dashboard proxy already authenticates through createClient(), which accepts the
// app's bearer token; it is re-exported here because middleware gates /api/whatsapp/* on cookies.
export { GET } from '@/app/api/whatsapp/media/[mediaId]/route'
