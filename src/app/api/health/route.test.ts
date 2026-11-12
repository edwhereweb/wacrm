import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.example');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/health', () => {
  it('is healthy when Supabase answers, and never caches the answer', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'healthy' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://project.supabase.example/auth/v1/health',
      expect.objectContaining({ headers: { apikey: 'anon-key' } })
    );
  });

  it('is unhealthy (503) when Supabase answers with an error', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 502 }));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'unhealthy' });
  });

  it('is unhealthy (503) when Supabase cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:443'));

    const response = await GET();
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/); // no internals in the answer
  });

  it('is unhealthy without calling anything when Supabase is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
