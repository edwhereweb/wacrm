import { describe, it, expect, vi } from 'vitest';
import type { Deal } from '@/types';
import {
  buildPipelineCsv,
  escapeCsvCell,
  fetchAllPipelineDeals,
  pipelineExportFilename,
  PIPELINE_CSV_HEADERS,
  type DealsQueryClient,
} from './export';

const stages = [
  { id: 's1', name: 'New Lead' },
  { id: 's2', name: 'Won' },
];

function deal(over: Partial<Deal>): Deal {
  return {
    id: 'd',
    user_id: 'u',
    pipeline_id: 'p',
    stage_id: 's1',
    contact_id: null,
    title: 'T',
    value: 100,
    currency: 'USD',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...over,
  };
}

describe('buildPipelineCsv', () => {
  it('emits BOM, ordered headers and mapped fields across all stages', () => {
    const csv = buildPipelineCsv(
      [
        deal({
          title: 'A',
          contact: {
            name: 'Ann',
            phone: '+123',
            email: 'a@x.com',
          } as Deal['contact'],
          assignee: { full_name: 'Owen' } as Deal['assignee'],
        }),
        deal({ title: 'B', stage_id: 's2', value: 5, currency: 'EUR' }),
      ],
      stages
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(PIPELINE_CSV_HEADERS.join(','));
    expect(lines[1]).toBe(
      'A,100,USD,New Lead,Ann,+123,a@x.com,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z,Owen'
    );
    expect(lines[2]).toContain('B,5,EUR,Won,');
  });

  it('escapes commas, quotes, newlines and keeps unicode', () => {
    const csv = buildPipelineCsv(
      [
        deal({
          title: 'Big, "deal"\nline2',
          contact: { name: 'José 山田 😀' } as Deal['contact'],
        }),
      ],
      stages
    );
    expect(csv).toContain('"Big, ""deal""\nline2"');
    expect(csv).toContain('José 山田 😀');
  });

  it('neutralises formula injection', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
  });
});

describe('pipelineExportFilename', () => {
  it('sanitises the name and appends a timestamp', () => {
    const f = pipelineExportFilename(
      'Sales/2024: "Q1"',
      new Date('2026-03-04T05:06:07Z')
    );
    expect(f).toBe('pipeline-sales2024-q1-20260304-050607.csv');
  });
  it('falls back when name is empty after sanitising', () => {
    expect(pipelineExportFilename('///')).toMatch(
      /^pipeline-pipeline-\d{8}-\d{6}\.csv$/
    );
  });
});

function mockClient(pages: unknown[][] | Error) {
  let call = 0;
  const range = vi.fn(async () => {
    if (pages instanceof Error)
      return { data: null, error: { message: pages.message } };
    return { data: pages[call++] ?? [], error: null };
  });
  const chain = { order: () => ({ order: () => ({ range }) }) };
  const client = {
    from: () => ({ select: () => ({ eq: () => chain }) }),
  } as unknown as DealsQueryClient;
  return { client, range };
}

describe('fetchAllPipelineDeals', () => {
  it('pages until a short page and returns every deal', async () => {
    const { client, range } = mockClient([
      [{ id: '1' }, { id: '2' }],
      [{ id: '3' }],
    ]);
    const onProgress = vi.fn();
    const rows = await fetchAllPipelineDeals(client, 'p', onProgress, 2);
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(range).toHaveBeenNthCalledWith(1, 0, 1);
    expect(range).toHaveBeenNthCalledWith(2, 2, 3);
    expect(onProgress).toHaveBeenLastCalledWith(3);
  });

  it('returns empty for an empty pipeline', async () => {
    const { client } = mockClient([[]]);
    expect(await fetchAllPipelineDeals(client, 'p')).toEqual([]);
  });

  it('throws on API error', async () => {
    const { client } = mockClient(new Error('boom'));
    await expect(fetchAllPipelineDeals(client, 'p')).rejects.toThrow('boom');
  });
});
