// POST /api/internal/lms-enrollment/replay — replay failed LMS enrollment
// ingress records (lms_enrollment_events.processing_status = 'failed').
// Auth: LMS_REPLAY_SECRET in `X-Replay-Secret` (or `Authorization: Bearer`).
// Body (all optional): { ids?: string[], account_id?, from?, to?, limit? }.
// See docs/lms-enrollment-webhook.md.

import crypto from 'crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { logEvent, replayEnrollments } from '@/lib/lms/enrollment-ingest';
import { isAuthorized } from '@/lib/lms/enrollment-webhook';

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const secret = process.env.LMS_REPLAY_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Replay not configured' }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  if (!headers.has('x-webhook-secret') && headers.has('x-replay-secret')) {
    headers.set('x-webhook-secret', headers.get('x-replay-secret')!);
  }
  if (!isAuthorized(new Request(request.url, { headers }), secret)) {
    logEvent('warn', correlationId, 'replay_auth', { result: 'rejected' });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = ((await request.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string')
    : undefined;
  const limit = typeof body.limit === 'number' ? body.limit : undefined;

  try {
    const results = await replayEnrollments(
      supabaseAdmin(),
      {
        ids,
        accountId: str(body.account_id),
        from: str(body.from),
        to: str(body.to),
        limit,
      },
      correlationId
    );
    logEvent('info', correlationId, 'replay_done', { count: results.length });
    return NextResponse.json(
      { correlation_id: correlationId, count: results.length, results },
      { status: 200 }
    );
  } catch (err) {
    logEvent('error', correlationId, 'replay_failed', {
      error_category: 'db',
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
