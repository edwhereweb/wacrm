// ============================================================
// Idempotent LMS enrollment ingestion + audit trail
// (table: lms_enrollment_events, migration 045).
//
// Flow: derive a deterministic idempotency key → claim an audit row
// (INSERT; a unique violation means the event was seen before) →
// dispatch (reuses contact/conversation dedupe) → mark the row
// processed | failed. A `failed` row can be re-claimed by a retry or
// by replayEnrollments(); `processed` / in-flight rows are duplicates.
//
// The audit table is best-effort: if it can't be written (e.g. the
// migration isn't applied yet) we log and still deliver, so rollout
// can never break enrollment confirmations.
// ============================================================

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import {
  dispatchEnrollmentConfirmation,
  type DispatchResult,
  type EnrollmentPayload,
} from '@/lib/lms/enrollment-webhook';

export type EnrollmentStatus = 'received' | 'processed' | 'duplicate' | 'failed';

/** A `received` claim older than this is treated as crashed and re-claimable. */
export const STALE_CLAIM_MS = 5 * 60 * 1000;

export type ErrorCategory =
  | 'auth'
  | 'validation'
  | 'account_resolution'
  | 'whatsapp_config'
  | 'meta_send'
  | 'db'
  | 'unknown';

export function categorizeError(err: unknown): ErrorCategory {
  if (err instanceof SendMessageError) {
    if (err.code === 'whatsapp_not_configured') return 'whatsapp_config';
    if (err.code === 'account_ambiguous') return 'account_resolution';
    if (err.code === 'bad_request') return 'validation';
    if (err.code === 'db_error') return 'db';
    return 'meta_send';
  }
  return 'unknown';
}

/** Structured one-line JSON log; never pass secrets or full phone numbers. */
export function logEvent(
  level: 'info' | 'warn' | 'error',
  correlationId: string,
  event: string,
  fields: Record<string, unknown> = {}
) {
  console[level](
    '[lms-enrollment] ' +
      JSON.stringify({ event, correlation_id: correlationId, ...fields })
  );
}

/** Mask a phone for logs: keep the last 4 digits only. */
export function maskPhone(phone: string): string {
  const d = sanitizePhoneForMeta(phone);
  return d.length <= 4 ? '****' : `${'*'.repeat(d.length - 4)}${d.slice(-4)}`;
}

/**
 * Explicit key (header / body) wins; otherwise a deterministic hash of
 * account + normalized phone + enrollment reference (enrollment_id,
 * course_id, or course title) so LMS retries collapse to one event.
 */
export function deriveIdempotencyKey(
  accountId: string,
  payload: EnrollmentPayload,
  headerKey?: string | null
): string {
  const explicit = (headerKey ?? payload.idempotencyKey ?? '').trim();
  if (explicit) return explicit.slice(0, 200);
  const ref = (
    payload.enrollmentId ||
    payload.courseId ||
    payload.courseTitle
  )
    .trim()
    .toLowerCase();
  const hash = crypto
    .createHash('sha256')
    .update([accountId, sanitizePhoneForMeta(payload.phone), ref].join('|'))
    .digest('hex');
  return `auto:${hash}`;
}

export interface IngestMeta {
  correlationId: string;
  idempotencyKey: string;
}

export type IngestOutcome =
  | { kind: 'sent'; eventId: string | null; result: DispatchResult }
  | {
      kind: 'duplicate';
      eventId: string | null;
      contactId: string | null;
      conversationId: string | null;
      messageId: string | null;
      status: EnrollmentStatus;
    };

interface EventRow {
  id: string;
  processing_status: EnrollmentStatus;
  updated_at: string | null;
  duplicate_count: number | null;
  contact_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
}

const ROW_COLS =
  'id, processing_status, updated_at, duplicate_count, contact_id, conversation_id, message_id';

async function claim(
  db: SupabaseClient,
  accountId: string,
  payload: EnrollmentPayload,
  meta: IngestMeta
): Promise<
  | { kind: 'claimed'; id: string | null }
  | { kind: 'duplicate'; row: EventRow }
> {
  const { data, error } = await db
    .from('lms_enrollment_events')
    .insert({
      account_id: accountId,
      phone_raw: payload.phone,
      phone_normalized: sanitizePhoneForMeta(payload.phone),
      enrollment_id: payload.enrollmentId ?? null,
      course_id: payload.courseId ?? null,
      course_title: payload.courseTitle,
      idempotency_key: meta.idempotencyKey,
      processing_status: 'received',
      correlation_id: meta.correlationId,
      payload,
    })
    .select('id')
    .single();
  if (!error && data) return { kind: 'claimed', id: data.id as string };

  if (!isUniqueViolation(error)) {
    logEvent('error', meta.correlationId, 'audit_insert_failed', {
      error_category: 'db',
      error: (error as { message?: string } | null)?.message,
    });
    return { kind: 'claimed', id: null };
  }

  // Seen before: reselect and decide whether the old attempt is retryable.
  const { data: existing } = await db
    .from('lms_enrollment_events')
    .select(ROW_COLS)
    .eq('account_id', accountId)
    .eq('idempotency_key', meta.idempotencyKey)
    .maybeSingle();
  const row = existing as EventRow | null;
  if (!row) {
    logEvent('error', meta.correlationId, 'audit_reselect_failed', {
      error_category: 'db',
    });
    return { kind: 'claimed', id: null };
  }

  const age = row.updated_at ? Date.now() - Date.parse(row.updated_at) : 0;
  const retryable =
    row.processing_status === 'failed' ||
    (row.processing_status === 'received' && age > STALE_CLAIM_MS);
  if (retryable) {
    // Compare-and-set so only one concurrent retry wins the re-claim.
    const { data: won } = await db
      .from('lms_enrollment_events')
      .update({
        processing_status: 'received',
        attempts: 1,
        correlation_id: meta.correlationId,
        error_code: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('processing_status', row.processing_status)
      .select('id');
    if (won && won.length > 0) return { kind: 'claimed', id: row.id };
  }
  return { kind: 'duplicate', row };
}

async function finish(
  db: SupabaseClient,
  eventId: string | null,
  patch: Record<string, unknown>
) {
  if (!eventId) return;
  const { error } = await db
    .from('lms_enrollment_events')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', eventId);
  if (error) console.error('[lms-enrollment] audit update failed:', error);
}

/**
 * Process one enrollment idempotently. Throws the dispatch error after
 * marking the audit row `failed`.
 */
export async function ingestEnrollment(
  db: SupabaseClient,
  accountId: string,
  payload: EnrollmentPayload,
  meta: IngestMeta
): Promise<IngestOutcome> {
  const claimed = await claim(db, accountId, payload, meta);

  if (claimed.kind === 'duplicate') {
    const row = claimed.row;
    await db
      .from('lms_enrollment_events')
      .update({
        duplicate_count: (row.duplicate_count ?? 0) + 1,
      })
      .eq('id', row.id);
    logEvent('info', meta.correlationId, 'dedupe', {
      branch: 'duplicate',
      event_id: row.id,
      prior_status: row.processing_status,
    });
    return {
      kind: 'duplicate',
      eventId: row.id,
      contactId: row.contact_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      status: row.processing_status,
    };
  }

  const eventId = claimed.id;
  let linked: { contactId?: string; conversationId?: string } = {};
  try {
    const result = await dispatchEnrollmentConfirmation(
      db,
      accountId,
      payload,
      undefined,
      (ids) => {
        linked = ids;
        logEvent('info', meta.correlationId, 'conversation_resolved', {
          branch: ids.contactCreated ? 'new_contact' : 'existing_contact',
          contact_id: ids.contactId,
          conversation_id: ids.conversationId,
        });
      }
    );
    await finish(db, eventId, {
      processing_status: 'processed',
      contact_id: result.contactId,
      conversation_id: result.conversationId,
      message_id: result.messageId,
    });
    logEvent('info', meta.correlationId, 'processed', {
      mode: result.mode,
      event_id: eventId,
      contact_id: result.contactId,
      conversation_id: result.conversationId,
      message_id: result.messageId,
    });
    return { kind: 'sent', eventId, result };
  } catch (err) {
    const category = categorizeError(err);
    await finish(db, eventId, {
      processing_status: 'failed',
      error_code: err instanceof SendMessageError ? err.code : category,
      error_message: (err instanceof Error ? err.message : String(err)).slice(
        0,
        500
      ),
      contact_id: linked.contactId ?? null,
      conversation_id: linked.conversationId ?? null,
    });
    logEvent('error', meta.correlationId, 'failed', {
      error_category: category,
      event_id: eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export interface ReplayFilter {
  ids?: string[];
  accountId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ReplayResult {
  id: string;
  status: 'processed' | 'duplicate' | 'failed';
  error?: string;
}

/**
 * Replay `failed` audit rows. Re-uses ingestEnrollment, so the
 * claim (compare-and-set failed → received) makes concurrent or repeated
 * replays safe: only one actually sends.
 */
export async function replayEnrollments(
  db: SupabaseClient,
  filter: ReplayFilter,
  correlationId: string
): Promise<ReplayResult[]> {
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  let q = db
    .from('lms_enrollment_events')
    .select('id, account_id, idempotency_key, payload')
    .eq('processing_status', 'failed');
  if (filter.ids?.length) q = q.in('id', filter.ids);
  if (filter.accountId) q = q.eq('account_id', filter.accountId);
  if (filter.from) q = q.gte('received_at', filter.from);
  if (filter.to) q = q.lte('received_at', filter.to);
  const { data, error } = await q
    .order('received_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  const results: ReplayResult[] = [];
  for (const row of (data ?? []) as {
    id: string;
    account_id: string;
    idempotency_key: string;
    payload: EnrollmentPayload | null;
  }[]) {
    if (!row.payload) {
      results.push({ id: row.id, status: 'failed', error: 'no stored payload' });
      continue;
    }
    try {
      const out = await ingestEnrollment(db, row.account_id, row.payload, {
        correlationId,
        idempotencyKey: row.idempotency_key,
      });
      results.push({
        id: row.id,
        status: out.kind === 'sent' ? 'processed' : 'duplicate',
      });
    } catch (err) {
      results.push({
        id: row.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
