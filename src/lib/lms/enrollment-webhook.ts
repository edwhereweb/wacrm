// ============================================================
// LMS enrollment webhook — auth, payload validation, and the
// WhatsApp confirmation dispatch (template with CTA buttons, falling
// back to a plain text body with inline links).
//
// Status tracking (Sent → Delivered → Failed) reuses the existing
// Meta status callback (`/api/whatsapp/webhook`): every message we
// persist here lands in the contact's conversation, and that handler
// updates `messages.status` + the error columns by wamid. A send that
// never reaches Meta is persisted by `recordFailedConfirmation` so the
// failure (with its reason) still shows on the contact timeline.
// ============================================================

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';

export const BUTTON_APP_LABEL = 'Open App / Download';
export const BUTTON_GROUP_LABEL = 'Join WhatsApp Group';
export const DEFAULT_TEMPLATE_NAME = 'lms_enrollment_confirmation';
export const DEFAULT_TEMPLATE_LANGUAGE = 'en_US';

export interface EnrollmentPayload {
  phone: string;
  studentName: string;
  courseTitle: string;
  appDownloadUrl: string;
  groupUrl: string;
  /** Optional enrollment reference / explicit idempotency key from the LMS. */
  enrollmentId?: string;
  courseId?: string;
  idempotencyKey?: string;
}

export type ParseResult =
  | { ok: true; payload: EnrollmentPayload }
  | { ok: false; errors: string[] };

/** Constant-time check of the shared secret (header or bearer token). */
export function isAuthorized(
  request: Request,
  secret: string | undefined
): boolean {
  if (!secret) return false;
  const bearer = request.headers.get('authorization');
  const provided =
    request.headers.get('x-webhook-secret') ??
    (bearer?.toLowerCase().startsWith('bearer ') ? bearer.slice(7) : null);
  if (!provided) return false;
  // Hash both sides so the compare is fixed-length.
  const a = crypto.createHash('sha256').update(provided.trim()).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate the LMS payload. Accepts snake_case or camelCase keys.
 * `appDownloadUrl` falls back to the static `LMS_ENROLLMENT_APP_URL`.
 */
export function parseEnrollmentPayload(
  body: unknown,
  staticAppUrl: string | undefined = process.env.LMS_ENROLLMENT_APP_URL
): ParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['Body must be a JSON object'] };
  }
  const o = body as Record<string, unknown>;
  const phone = pick(o, ['phone', 'contact_phone', 'contactPhone']);
  const studentName = pick(o, ['student_name', 'studentName', 'name']);
  const courseTitle = pick(o, ['course_title', 'courseTitle', 'course']);
  const appDownloadUrl =
    pick(o, ['app_download_url', 'appDownloadUrl', 'app_url']) ||
    (staticAppUrl ?? '').trim();
  const groupUrl = pick(o, [
    'group_url',
    'groupUrl',
    'whatsapp_group_url',
    'course_group_url',
  ]);

  const enrollmentId = pick(o, ['enrollment_id', 'enrollmentId']);
  const courseId = pick(o, ['course_id', 'courseId']);
  const idempotencyKey = pick(o, ['idempotency_key', 'idempotencyKey']);

  const errors: string[] = [];
  const phoneDigits = phone.replace(/\D/g, '');
  if (!phone) errors.push('phone is required');
  else if (phoneDigits.length < 8 || phoneDigits.length > 15)
    errors.push('phone must be a valid phone number');
  if (!studentName) errors.push('student_name is required');
  if (!courseTitle) errors.push('course_title is required');
  if (!appDownloadUrl) errors.push('app_download_url is required');
  else if (!isHttpUrl(appDownloadUrl))
    errors.push('app_download_url must be an http(s) URL');
  if (!groupUrl) errors.push('group_url is required');
  else if (!isHttpUrl(groupUrl)) errors.push('group_url must be an http(s) URL');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      phone,
      studentName,
      courseTitle,
      appDownloadUrl,
      groupUrl,
      ...(enrollmentId && { enrollmentId }),
      ...(courseId && { courseId }),
      ...(idempotencyKey && { idempotencyKey }),
    },
  };
}

/** Plain-text fallback: body + inline links (no interactive buttons). */
export function buildFallbackText(p: EnrollmentPayload): string {
  return [
    `Hi ${p.studentName}, congratulations! You have successfully enrolled in ${p.courseTitle}.`,
    '',
    `${BUTTON_APP_LABEL}: ${p.appDownloadUrl}`,
    `${BUTTON_GROUP_LABEL}: ${p.groupUrl}`,
  ].join('\n');
}

/**
 * Value Meta expects for a dynamic URL button: the part that replaces
 * `{{1}}` in the template's URL. Throws when the full URL doesn't start
 * with the template's static prefix (caller falls back to text).
 */
export function dynamicButtonParam(templateUrl: string, fullUrl: string) {
  const prefix = templateUrl.replace(/\{\{\d+\}\}.*$/, '');
  if (!fullUrl.startsWith(prefix)) {
    throw new Error(
      `URL "${fullUrl}" does not match the template button base "${prefix}"`
    );
  }
  return fullUrl.slice(prefix.length);
}

export interface DispatchConfig {
  templateName: string;
  language: string;
}

export function getDispatchConfig(): DispatchConfig {
  return {
    templateName:
      process.env.LMS_ENROLLMENT_TEMPLATE_NAME?.trim() ||
      DEFAULT_TEMPLATE_NAME,
    language:
      process.env.LMS_ENROLLMENT_TEMPLATE_LANGUAGE?.trim() ||
      DEFAULT_TEMPLATE_LANGUAGE,
  };
}

/**
 * Which account receives LMS enrollments: `LMS_ENROLLMENT_ACCOUNT_ID`,
 * or the only account with WhatsApp configured.
 */
export async function resolveAccountId(
  db: SupabaseClient,
  configured: string | undefined = process.env.LMS_ENROLLMENT_ACCOUNT_ID
): Promise<string> {
  if (configured?.trim()) return configured.trim();
  const { data, error } = await db
    .from('whatsapp_config')
    .select('account_id')
    .limit(2);
  if (error || !data || data.length === 0) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured',
      400
    );
  }
  if (data.length > 1) {
    throw new SendMessageError(
      'account_ambiguous',
      'Multiple accounts have WhatsApp configured — set LMS_ENROLLMENT_ACCOUNT_ID',
      500
    );
  }
  return data[0].account_id as string;
}

export interface DispatchResult {
  mode: 'template' | 'fallback_text';
  messageId: string;
  whatsappMessageId: string;
  conversationId: string;
  contactId: string;
}

/** Persist a failed attempt so the reason is visible on the timeline. */
export async function recordFailedConfirmation(
  db: SupabaseClient,
  conversationId: string,
  text: string,
  templateName: string | null,
  err: unknown
) {
  const details = err instanceof Error ? err.message : String(err);
  const code = err instanceof SendMessageError ? err.code : 'unknown';
  const { error } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type: templateName ? 'template' : 'text',
    content_text: text,
    template_name: templateName,
    status: 'failed',
    error_title: `LMS enrollment confirmation failed (${code})`,
    error_details: details,
  });
  if (error) {
    console.error('[lms-enrollment] could not record failed message:', error);
    return;
  }
  const { error: convErr } = await db
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
  if (convErr) {
    console.error('[lms-enrollment] could not update conversation:', convErr);
  }
}

/**
 * Send the confirmation. Tries the template (CTA buttons) first; on any
 * template/button failure logs why and sends the plain-text fallback.
 * If both fail, a `failed` message row is recorded and the error rethrown.
 */
export async function dispatchEnrollmentConfirmation(
  db: SupabaseClient,
  accountId: string,
  payload: EnrollmentPayload,
  cfg: DispatchConfig = getDispatchConfig(),
  onResolved?: (ids: {
    contactId: string;
    conversationId: string;
    contactCreated: boolean;
  }) => void
): Promise<DispatchResult> {
  const resolved = await resolveConversationByPhone(
    db,
    accountId,
    payload.phone,
    payload.studentName
  );
  onResolved?.({
    contactId: resolved.contactId,
    conversationId: resolved.conversationId,
    contactCreated: resolved.contactCreated,
  });
  const base = {
    conversationId: resolved.conversationId,
    contactId: resolved.contactId,
  };

  try {
    const tpl = await resolveTemplateRow(
      db,
      accountId,
      cfg.templateName,
      cfg.language
    );
    if (!tpl.row) {
      throw new Error(`Template "${cfg.templateName}" not found locally`);
    }
    const buttonParams: Record<number, string> = {};
    const urls = [payload.appDownloadUrl, payload.groupUrl];
    // URL buttons map to [app, group] in order, whatever other button
    // types surround them.
    let urlIdx = 0;
    (tpl.row.buttons ?? []).forEach((btn, i) => {
      if (btn.type !== 'URL') return;
      const url = urls[urlIdx++];
      if (url && extractVariableIndices(btn.url).length > 0) {
        buttonParams[i] = dynamicButtonParam(btn.url, url);
      }
    });
    const result = await sendMessageToConversation(db, accountId, {
      conversationId: resolved.conversationId,
      messageType: 'template',
      templateName: cfg.templateName,
      templateLanguage: cfg.language,
      templateMessageParams: {
        body: [payload.studentName, payload.courseTitle],
        buttonParams,
      },
    });
    return { mode: 'template', ...result, ...base };
  } catch (err) {
    // The template already reached Meta; only our DB write failed.
    // Falling back would message the student twice.
    if (err instanceof SendMessageError && err.code === 'db_error') throw err;
    console.warn(
      '[lms-enrollment] template send with buttons failed, falling back to text body:',
      err instanceof Error ? err.message : err
    );
  }

  const text = buildFallbackText(payload);
  try {
    const result = await sendMessageToConversation(db, accountId, {
      conversationId: resolved.conversationId,
      messageType: 'text',
      contentText: text,
    });
    console.info('[lms-enrollment] fallback text message sent');
    return { mode: 'fallback_text', ...result, ...base };
  } catch (err) {
    console.error(
      '[lms-enrollment] fallback text send failed:',
      err instanceof Error ? err.message : err
    );
    await recordFailedConfirmation(
      db,
      resolved.conversationId,
      text,
      null,
      err
    );
    throw err;
  }
}
