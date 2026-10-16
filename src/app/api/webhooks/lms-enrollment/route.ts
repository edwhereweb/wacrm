// POST /api/webhooks/lms-enrollment — LMS → WACRM enrollment webhook.
// Auth: shared secret in `X-Webhook-Secret` (or `Authorization: Bearer`)
// matching LMS_WEBHOOK_SECRET. See docs/lms-enrollment-webhook.md.

import crypto from 'crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  categorizeError,
  deriveIdempotencyKey,
  ingestEnrollment,
  logEvent,
  maskPhone,
} from '@/lib/lms/enrollment-ingest';
import {
  isAuthorized,
  parseEnrollmentPayload,
  resolveAccountId,
} from '@/lib/lms/enrollment-webhook';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';

export async function POST(request: Request) {
  const correlationId =
    request.headers.get('x-correlation-id') ??
    request.headers.get('x-request-id') ??
    crypto.randomUUID();
  const headers = { 'x-correlation-id': correlationId };
  const json = (body: unknown, status: number) =>
    NextResponse.json(body, { status, headers });

  const secret = process.env.LMS_WEBHOOK_SECRET;
  if (!secret) {
    logEvent('error', correlationId, 'not_configured', {
      error_category: 'auth',
    });
    return json({ error: 'Webhook not configured' }, 503);
  }
  const authorized = isAuthorized(request, secret);
  logEvent(authorized ? 'info' : 'warn', correlationId, 'auth', {
    result: authorized ? 'ok' : 'rejected',
    ...(authorized ? {} : { error_category: 'auth' }),
  });
  if (!authorized) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json().catch(() => null);
  const parsed = parseEnrollmentPayload(body);
  if (!parsed.ok) {
    logEvent('warn', correlationId, 'invalid_payload', {
      error_category: 'validation',
      errors: parsed.errors,
    });
    return json({ error: 'Invalid payload', details: parsed.errors }, 400);
  }

  try {
    const db = supabaseAdmin();
    const accountId = await resolveAccountId(db);
    const idempotencyKey = deriveIdempotencyKey(
      accountId,
      parsed.payload,
      request.headers.get('idempotency-key')
    );
    logEvent('info', correlationId, 'accepted', {
      account_id: accountId,
      phone: maskPhone(parsed.payload.phone),
      phone_normalized_length: sanitizePhoneForMeta(parsed.payload.phone)
        .length,
      idempotency_key: idempotencyKey,
    });
    const out = await ingestEnrollment(db, accountId, parsed.payload, {
      correlationId,
      idempotencyKey,
    });
    if (out.kind === 'duplicate') {
      return json(
        {
          status: 'duplicate',
          event_id: out.eventId,
          event_status: out.status,
          message_id: out.messageId,
          conversation_id: out.conversationId,
          contact_id: out.contactId,
        },
        200
      );
    }
    const result = out.result;
    return json(
      {
        status: 'sent',
        mode: result.mode,
        message_id: result.messageId,
        conversation_id: result.conversationId,
        contact_id: result.contactId,
      },
      201
    );
  } catch (err) {
    logEvent('error', correlationId, 'dispatch_failed', {
      error_category: categorizeError(err),
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof SendMessageError) {
      return json({ error: err.message, code: err.code }, err.status);
    }
    return json({ error: 'Internal error' }, 500);
  }
}
