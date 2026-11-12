import { NextResponse } from 'next/server';

// PUBLIC on purpose: an uptime check cannot sign in. The middleware only guards pages and
// /api/whatsapp/, so this answers without a session. It says healthy or unhealthy and nothing
// else: no configuration, host names or error text.
const TIMEOUT_MS = 4000;
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  const timestamp = new Date().toISOString();
  try {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!base || !key) throw new Error('Supabase is not configured');

    // Supabase Auth's own health endpoint: it only answers while the project is up.
    const response = await fetch(`${base}/auth/v1/health`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok)
      throw new Error(`Supabase answered HTTP ${response.status}`);

    return NextResponse.json(
      { status: 'healthy', timestamp },
      { headers: NO_STORE }
    );
  } catch (err) {
    console.error(
      '[health] check failed:',
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { status: 'unhealthy', timestamp },
      { status: 503, headers: NO_STORE }
    );
  }
}
