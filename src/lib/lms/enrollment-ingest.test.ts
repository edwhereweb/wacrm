import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));
vi.mock('@/lib/lms/enrollment-webhook', () => ({
  dispatchEnrollmentConfirmation: (...a: unknown[]) => dispatchMock(...a),
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
  return { SendMessageError };
});

import {
  categorizeError,
  deriveIdempotencyKey,
  ingestEnrollment,
  replayEnrollments,
} from './enrollment-ingest';
import { SendMessageError } from '@/lib/whatsapp/send-message';

type Row = Record<string, unknown>;

/** Minimal in-memory lms_enrollment_events with a unique (account, key). */
function memoryDb() {
  const rows: Row[] = [];
  let n = 0;
  const builder = (mode: 'select' | 'update', patch?: Row) => {
    const filters: ((r: Row) => boolean)[] = [];
    let limit = Infinity;
    const run = () => {
      const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, limit);
      if (mode === 'update') hit.forEach((r) => Object.assign(r, patch));
      return hit;
    };
    const b: Record<string, unknown> = {
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), b),
      gte: (k: string, v: string) => (filters.push((r) => (r[k] as string) >= v), b),
      lte: (k: string, v: string) => (filters.push((r) => (r[k] as string) <= v), b),
      order: () => b,
      limit: (l: number) => ((limit = l), b),
      select: () => b,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(res),
    };
    return b;
  };
  const db = {
    from: () => ({
      insert: (row: Row) => ({
        select: () => ({
          single: async () => {
            if (
              rows.some(
                (r) =>
                  r.account_id === row.account_id &&
                  r.idempotency_key === row.idempotency_key
              )
            )
              return { data: null, error: { code: '23505' } };
            const r = {
              id: `ev-${++n}`,
              updated_at: new Date().toISOString(),
              duplicate_count: 0,
              ...row,
            };
            rows.push(r);
            return { data: { id: r.id }, error: null };
          },
        }),
      }),
      select: () => builder('select'),
      update: (patch: Row) => builder('update', patch),
    }),
  };
  return { db: db as never, rows };
}

const payload = {
  phone: '+917356543520',
  studentName: 'Jane',
  courseTitle: 'Algebra',
  appDownloadUrl: 'https://a.io',
  groupUrl: 'https://g.io',
};
const meta = { correlationId: 'c1', idempotencyKey: 'k1' };
const ok = {
  mode: 'template',
  messageId: 'm1',
  whatsappMessageId: 'w1',
  conversationId: 'conv1',
  contactId: 'ct1',
};

beforeEach(() => {
  dispatchMock.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('deriveIdempotencyKey', () => {
  it('is deterministic across phone formats and prefers explicit keys', () => {
    const a = deriveIdempotencyKey('acct', payload);
    const b = deriveIdempotencyKey('acct', { ...payload, phone: '91 73565-43520' });
    expect(a).toBe(b);
    expect(deriveIdempotencyKey('acct2', payload)).not.toBe(a);
    expect(deriveIdempotencyKey('acct', payload, ' hdr ')).toBe('hdr');
    expect(
      deriveIdempotencyKey('acct', { ...payload, idempotencyKey: 'body' })
    ).toBe('body');
    expect(
      deriveIdempotencyKey('acct', { ...payload, enrollmentId: 'e1' })
    ).not.toBe(a);
  });
});

describe('ingestEnrollment', () => {
  it('processes once, then reports duplicates without re-sending', async () => {
    dispatchMock.mockResolvedValue(ok);
    const { db, rows } = memoryDb();
    const first = await ingestEnrollment(db, 'acct', payload, meta);
    expect(first.kind).toBe('sent');
    expect(rows[0]).toMatchObject({
      processing_status: 'processed',
      contact_id: 'ct1',
      conversation_id: 'conv1',
      message_id: 'm1',
      phone_normalized: '917356543520',
    });
    const second = await ingestEnrollment(db, 'acct', payload, meta);
    expect(second).toMatchObject({
      kind: 'duplicate',
      conversationId: 'conv1',
      status: 'processed',
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].duplicate_count).toBe(1);
  });

  it('concurrent deliveries send exactly once', async () => {
    dispatchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return ok;
    });
    const { db, rows } = memoryDb();
    const outs = await Promise.all(
      Array.from({ length: 5 }, () => ingestEnrollment(db, 'acct', payload, meta))
    );
    expect(outs.filter((o) => o.kind === 'sent')).toHaveLength(1);
    expect(outs.filter((o) => o.kind === 'duplicate')).toHaveLength(4);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it('marks failures, then a retry re-claims and succeeds', async () => {
    dispatchMock.mockImplementationOnce(async (_d, _a, _p, _c, onResolved) => {
      onResolved({ contactId: 'ct1', conversationId: 'conv1', contactCreated: true });
      throw new SendMessageError('meta_error', 'Meta down', 502);
    });
    const { db, rows } = memoryDb();
    await expect(ingestEnrollment(db, 'acct', payload, meta)).rejects.toThrow(
      'Meta down'
    );
    expect(rows[0]).toMatchObject({
      processing_status: 'failed',
      error_code: 'meta_error',
      contact_id: 'ct1',
    });
    dispatchMock.mockResolvedValue(ok);
    const retry = await ingestEnrollment(db, 'acct', payload, meta);
    expect(retry.kind).toBe('sent');
    expect(rows[0]).toMatchObject({ processing_status: 'processed', error_code: null });
  });

  it('treats a fresh in-flight claim as duplicate', async () => {
    const { db, rows } = memoryDb();
    dispatchMock.mockImplementation(() => new Promise(() => {}));
    void ingestEnrollment(db, 'acct', payload, meta);
    await new Promise((r) => setTimeout(r, 5));
    expect(rows[0].processing_status).toBe('received');
    const dup = await ingestEnrollment(db, 'acct', payload, meta);
    expect(dup).toMatchObject({ kind: 'duplicate', status: 'received' });
  });
});

describe('replayEnrollments', () => {
  it('replays only failed rows, is idempotent, and updates status', async () => {
    dispatchMock.mockRejectedValueOnce(
      new SendMessageError('meta_error', 'boom', 502)
    );
    const { db, rows } = memoryDb();
    await expect(ingestEnrollment(db, 'acct', payload, meta)).rejects.toThrow();
    await ingestEnrollment(db, 'acct', payload, meta).catch(() => {});

    // Second attempt above succeeded or failed; force failed state for replay.
    rows[0].processing_status = 'failed';
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue(ok);

    const r1 = await replayEnrollments(db, { accountId: 'acct' }, 'rc');
    expect(r1).toEqual([{ id: rows[0].id, status: 'processed' }]);
    expect(rows[0].processing_status).toBe('processed');

    const r2 = await replayEnrollments(db, { accountId: 'acct' }, 'rc');
    expect(r2).toEqual([]);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a still-failing replay and keeps the row failed', async () => {
    dispatchMock.mockRejectedValue(new SendMessageError('meta_error', 'boom', 502));
    const { db, rows } = memoryDb();
    await expect(ingestEnrollment(db, 'acct', payload, meta)).rejects.toThrow();
    const r = await replayEnrollments(db, { ids: [rows[0].id as string] }, 'rc');
    expect(r[0]).toMatchObject({ status: 'failed', error: 'boom' });
    expect(rows[0].processing_status).toBe('failed');
  });
});

describe('categorizeError', () => {
  it('maps send errors to triage categories', () => {
    expect(categorizeError(new SendMessageError('db_error', 'x', 500))).toBe('db');
    expect(categorizeError(new SendMessageError('meta_error', 'x', 502))).toBe('meta_send');
    expect(categorizeError(new Error('x'))).toBe('unknown');
  });
});
