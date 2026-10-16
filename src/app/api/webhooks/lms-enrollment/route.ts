// POST /api/webhooks/lms-enrollment — LMS → WACRM enrollment webhook.
// Auth: shared secret in `X-Webhook-Secret` (or `Authorization: Bearer`)
// matching LMS_WEBHOOK_SECRET. See docs/lms-enrollment-webhook.md.

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  dispatchEnrollmentConfirmation,
  isAuthorized,
  parseEnrollmentPayload,
  resolveAccountId,
} from '@/lib/lms/enrollment-webhook';
import { SendMessageError } from '@/lib/whatsapp/send-message';

export async function POST(request: Request) {
  const secret = process.env.LMS_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[lms-enrollment] LMS_WEBHOOK_SECRET is not configured');
    return NextResponse.json(
      { error: 'Webhook not configured' },
      { status: 503 }
    );
  }
  if (!isAuthorized(request, secret)) {
    console.warn('[lms-enrollment] rejected unauthorized request');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseEnrollmentPayload(body);
  if (!parsed.ok) {
    console.warn('[lms-enrollment] invalid payload:', parsed.errors);
    return NextResponse.json(
      { error: 'Invalid payload', details: parsed.errors },
      { status: 400 }
    );
  }

  try {
    const db = supabaseAdmin();
    const accountId = await resolveAccountId(db);
    const result = await dispatchEnrollmentConfirmation(
      db,
      accountId,
      parsed.payload
    );
    return NextResponse.json(
      {
        status: 'sent',
        mode: result.mode,
        message_id: result.messageId,
        conversation_id: result.conversationId,
        contact_id: result.contactId,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error('[lms-enrollment] dispatch failed:', err);
    if (err instanceof SendMessageError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
