import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock, templateRow, adminMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  templateRow: vi.fn(),
  adminMock: vi.fn(),
}));
vi.mock('@/lib/whatsapp/send-message', () => {
  class SendMessageError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return { sendMessageToConversation: sendMock, SendMessageError };
});
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: vi.fn(async () => ({
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactCreated: false,
  })),
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: (...a: unknown[]) => templateRow(...a),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => adminMock(),
}));

import {
  buildFallbackText,
  dispatchEnrollmentConfirmation,
  dynamicButtonParam,
  isAuthorized,
  parseEnrollmentPayload,
} from './enrollment-webhook';
import { POST } from '@/app/api/webhooks/lms-enrollment/route';
import { SendMessageError } from '@/lib/whatsapp/send-message';

const valid = {
  phone: '+14155550123',
  student_name: 'Jane',
  course_title: 'Algebra',
  app_download_url: 'https://app.example.com/dl',
  group_url: 'https://chat.whatsapp.com/abc123',
};
const payload = {
  phone: valid.phone,
  studentName: 'Jane',
  courseTitle: 'Algebra',
  appDownloadUrl: valid.app_download_url,
  groupUrl: valid.group_url,
};

function fakeDb() {
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        // Audit table unavailable → ingestion must fail open.
        if (table === 'lms_enrollment_events') {
          return {
            select: () => ({
              single: () =>
                Promise.resolve({ data: null, error: { code: 'XX000' } }),
            }),
          };
        }
        if (table === 'messages') inserts.push(row);
        return Promise.resolve({ error: null });
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  };
  return { db: db as never, inserts };
}

const req = (headers: Record<string, string>, body?: unknown) =>
  new Request('http://x/api/webhooks/lms-enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? valid),
  });

beforeEach(() => {
  sendMock.mockReset();
  templateRow.mockReset();
  process.env.LMS_WEBHOOK_SECRET = 'shh';
  process.env.LMS_ENROLLMENT_ACCOUNT_ID = 'acct-1';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('auth', () => {
  it('accepts header or bearer secret, rejects others', () => {
    expect(isAuthorized(req({ 'x-webhook-secret': 'shh' }), 'shh')).toBe(true);
    expect(isAuthorized(req({ authorization: 'Bearer ' + 'shh' }), 'shh')).toBe(true);
    expect(isAuthorized(req({ 'x-webhook-secret': 'nope' }), 'shh')).toBe(false);
    expect(isAuthorized(req({}), 'shh')).toBe(false);
    expect(isAuthorized(req({ 'x-webhook-secret': '' }), '')).toBe(false);
  });

  it('route: 401 without secret, 400 on bad payload, 201 on success', async () => {
    expect((await POST(req({}))).status).toBe(401);
    expect((await POST(req({ 'x-webhook-secret': 'bad' }))).status).toBe(401);

    const bad = await POST(
      req({ 'x-webhook-secret': 'shh' }, { ...valid, group_url: 'nope' })
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).details).toContain(
      'group_url must be an http(s) URL'
    );
    expect(
      (await POST(req({ 'x-webhook-secret': 'shh' }, '{not json'))).status
    ).toBe(400);

    adminMock.mockReturnValue(fakeDb().db);
    templateRow.mockResolvedValue({ row: { buttons: [] }, language: 'en_US' });
    sendMock.mockResolvedValue({ messageId: 'm1', whatsappMessageId: 'w1' });
    const ok = await POST(req({ 'x-webhook-secret': 'shh' }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).mode).toBe('template');
  });

  it('route: 503 when secret is not configured', async () => {
    delete process.env.LMS_WEBHOOK_SECRET;
    expect((await POST(req({ 'x-webhook-secret': 'x' }))).status).toBe(503);
  });
});

describe('parseEnrollmentPayload', () => {
  it('accepts valid snake and camel payloads', () => {
    expect(parseEnrollmentPayload(valid, undefined)).toEqual({
      ok: true,
      payload,
    });
    const camel = parseEnrollmentPayload(
      {
        phone: valid.phone,
        studentName: 'Jane',
        courseTitle: 'Algebra',
        appDownloadUrl: valid.app_download_url,
        groupUrl: valid.group_url,
      },
      undefined
    );
    expect(camel.ok).toBe(true);
  });
  it('reports every problem', () => {
    const r = parseEnrollmentPayload({ phone: '12' }, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(5);
  });
  it('rejects non-objects and uses static app URL fallback', () => {
    expect(parseEnrollmentPayload([], undefined).ok).toBe(false);
    const { app_download_url: _omit, ...rest } = valid;
    void _omit;
    expect(parseEnrollmentPayload(rest, undefined).ok).toBe(false);
    expect(parseEnrollmentPayload(rest, 'https://static.example.com').ok).toBe(
      true
    );
  });
});

describe('dispatch', () => {
  const tplRow = {
    buttons: [
      { type: 'URL', text: 'Open App / Download', url: 'https://app.example.com/dl' },
      {
        type: 'URL',
        text: 'Join WhatsApp Group',
        url: 'https://chat.whatsapp.com/{{1}}',
      },
    ],
  };

  it('sends template with body params and dynamic button param', async () => {
    templateRow.mockResolvedValue({ row: tplRow, language: 'en_US' });
    sendMock.mockResolvedValue({ messageId: 'm1', whatsappMessageId: 'w1' });
    const { db } = fakeDb();
    const r = await dispatchEnrollmentConfirmation(db, 'acct-1', payload, {
      templateName: 't',
      language: 'en_US',
    });
    expect(r.mode).toBe('template');
    expect(sendMock.mock.calls[0][2]).toMatchObject({
      messageType: 'template',
      templateMessageParams: {
        body: ['Jane', 'Algebra'],
        buttonParams: { 1: 'abc123' },
      },
    });
  });

  it('falls back to text with inline links when buttons are restricted', async () => {
    templateRow.mockResolvedValue({ row: tplRow, language: 'en_US' });
    sendMock
      .mockRejectedValueOnce(
        new SendMessageError('meta_error', 'Meta API error: buttons', 502)
      )
      .mockResolvedValueOnce({ messageId: 'm2', whatsappMessageId: 'w2' });
    const { db } = fakeDb();
    const r = await dispatchEnrollmentConfirmation(db, 'acct-1', payload);
    expect(r.mode).toBe('fallback_text');
    const text = sendMock.mock.calls[1][2].contentText as string;
    expect(text).toContain(payload.groupUrl);
    expect(text).toBe(buildFallbackText(payload));
  });

  it('falls back when the template is missing locally', async () => {
    templateRow.mockResolvedValue({ row: null, language: 'en_US' });
    sendMock.mockResolvedValue({ messageId: 'm2', whatsappMessageId: 'w2' });
    const { db } = fakeDb();
    const r = await dispatchEnrollmentConfirmation(db, 'acct-1', payload);
    expect(r.mode).toBe('fallback_text');
  });

  it('does not double-send when only the DB write failed', async () => {
    templateRow.mockResolvedValue({ row: tplRow, language: 'en_US' });
    sendMock.mockRejectedValue(new SendMessageError('db_error', 'x', 500));
    const { db } = fakeDb();
    await expect(
      dispatchEnrollmentConfirmation(db, 'acct-1', payload)
    ).rejects.toThrow('x');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('records a failed message with the reason on the timeline', async () => {
    templateRow.mockResolvedValue({ row: tplRow, language: 'en_US' });
    sendMock.mockRejectedValue(
      new SendMessageError('meta_error', 'Meta API error: 131047', 502)
    );
    const { db, inserts } = fakeDb();
    await expect(
      dispatchEnrollmentConfirmation(db, 'acct-1', payload)
    ).rejects.toThrow('131047');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      status: 'failed',
      error_details: 'Meta API error: 131047',
    });
  });
});

describe('dynamicButtonParam', () => {
  it('strips the static prefix and rejects mismatches', () => {
    expect(
      dynamicButtonParam('https://a.io/{{1}}', 'https://a.io/x/y')
    ).toBe('x/y');
    expect(() => dynamicButtonParam('https://a.io/{{1}}', 'https://b.io/x')).toThrow();
  });
});
