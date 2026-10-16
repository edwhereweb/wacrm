import type { Deal, PipelineStage } from '@/types';

/**
 * Pipeline CSV export.
 *
 * Deals are fetched in pages (CHUNK_SIZE rows per request) so the browser
 * never waits on a single huge query and every stage of the pipeline is
 * included regardless of what the board currently renders. Rows are built
 * as RFC 4180 CSV, prefixed with a UTF-8 BOM so Excel detects the encoding.
 */

export const EXPORT_CHUNK_SIZE = 500;

export const PIPELINE_CSV_HEADERS = [
  'Deal Title',
  'Deal Value',
  'Currency',
  'Stage Name',
  'Contact Name',
  'Phone Number',
  'Email',
  'Created Date',
  'Last Updated Date',
  'Deal Owner/Assignee',
] as const;

const UTF8_BOM = '\uFEFF';

/** Escape one CSV cell: quote when it holds a comma, quote or newline. */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Neutralise spreadsheet formula injection from user-entered text.
  if (/^[=@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rawCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildPipelineCsv(
  deals: Deal[],
  stages: Pick<PipelineStage, 'id' | 'name'>[]
): string {
  const stageNames = new Map(stages.map((s) => [s.id, s.name]));
  const lines = [PIPELINE_CSV_HEADERS.map(escapeCsvCell).join(',')];
  for (const d of deals) {
    const stageName = d.stage?.name ?? stageNames.get(d.stage_id) ?? '';
    lines.push(
      [
        escapeCsvCell(d.title),
        rawCell(d.value),
        escapeCsvCell(d.currency),
        escapeCsvCell(stageName),
        escapeCsvCell(d.contact?.name),
        // Phones start with "+"; not a formula risk we need to mangle.
        rawCell(d.contact?.phone),
        escapeCsvCell(d.contact?.email),
        rawCell(d.created_at),
        rawCell(d.updated_at),
        escapeCsvCell(d.assignee?.full_name || d.assignee?.email),
      ].join(',')
    );
  }
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

/** Safe, timestamped filename: `pipeline-<name>-YYYYMMDD-HHmmss.csv`. */
export function pipelineExportFilename(name: string, now = new Date()): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 60) || 'pipeline';
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  return `pipeline-${slug}-${ts}.csv`;
}

interface PageResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

/** Minimal structural type of the Supabase client used here. */
export interface DealsQueryClient {
  from(table: 'deals'): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        order(
          column: string,
          opts: { ascending: boolean }
        ): {
          order(
            column: string,
            opts: { ascending: boolean }
          ): { range(from: number, to: number): PromiseLike<PageResult> };
        };
      };
    };
  };
}

/**
 * Fetch every deal of a pipeline (all stages) page by page. Throws on the
 * first API error. `onProgress` receives the running row count.
 */
export async function fetchAllPipelineDeals(
  supabase: DealsQueryClient,
  pipelineId: string,
  onProgress?: (count: number) => void,
  chunkSize = EXPORT_CHUNK_SIZE
): Promise<Deal[]> {
  const all: Deal[] = [];
  for (let from = 0; ; from += chunkSize) {
    const { data, error } = await supabase
      .from('deals')
      .select(
        '*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)'
      )
      .eq('pipeline_id', pipelineId)
      // id tiebreaker keeps pagination stable across pages.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + chunkSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Deal[];
    all.push(...rows);
    onProgress?.(all.length);
    if (rows.length < chunkSize) break;
    // Yield so the UI can repaint between chunks.
    await new Promise((r) => setTimeout(r, 0));
  }
  return all;
}

export function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
