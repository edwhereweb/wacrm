// GET /api/mobile/v1/meta/min-app-version — public; drives the app's force-upgrade gate.
// Raise MOBILE_MIN_* to lock out builds that predate a breaking API change.

import { ok } from '@/lib/mobile/respond'

export function GET() {
  const env = process.env
  const minAndroid = env.MOBILE_MIN_ANDROID ?? '1.0.0'
  const minIos = env.MOBILE_MIN_IOS ?? '1.0.0'
  return ok({
    minAndroid,
    minIos,
    latestAndroid: env.MOBILE_LATEST_ANDROID ?? minAndroid,
    latestIos: env.MOBILE_LATEST_IOS ?? minIos,
    forceUpgrade: env.MOBILE_FORCE_UPGRADE === 'true',
  })
}
