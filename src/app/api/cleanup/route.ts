import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (expected && provided !== expected) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 });

  const response = await fetch(`${url}/rest/v1/rpc/mvs_delete_expired_snapshots`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  });
  if (!response.ok) return NextResponse.json({ error: await response.text() }, { status: 502 });
  return NextResponse.json({ ok: true, deleted: await response.json() });
}
