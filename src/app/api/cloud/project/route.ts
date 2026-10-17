import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 10;

const TTL_MS = 24 * 60 * 60 * 1000;
const TABLE = 'mvs_project_snapshots';

type SnapshotPayload = {
  project: Record<string, unknown>;
  savedAt: number;
};

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured');
  return { url, key };
}

function headers(key: string): HeadersInit {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function cleanupExpired(url: string, key: string): Promise<void> {
  // REST-фильтр выполняется до чтения/записи, поэтому TTL соблюдается даже без cron.
  await fetch(`${url}/rest/v1/${TABLE}?expires_at=lte.${encodeURIComponent(new Date().toISOString())}`, {
    method: 'DELETE',
    headers: headers(key),
    cache: 'no-store',
  });
}

function validProjectId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,160}$/.test(id);
}

function sanitizeProject(project: Record<string, unknown>): Record<string, unknown> {
  // API-ключи провайдеров никогда не должны попасть в snapshot.
  const { keys, apiKey, openaiKey, ...safeProject } = project;
  void keys; void apiKey; void openaiKey;
  return safeProject;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

export async function POST(req: NextRequest) {
  try {
    const { url, key } = config();
    const body = await req.json() as { projectId?: string; project?: Record<string, unknown> };
    if (!body.projectId || !validProjectId(body.projectId) || !body.project) {
      return NextResponse.json({ error: 'projectId and project are required' }, { status: 400 });
    }
    const payload: SnapshotPayload = {
      project: sanitizeProject(body.project),
      savedAt: Date.now(),
    };
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    await cleanupExpired(url, key);
    const response = await fetch(`${url}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { ...headers(key), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        project_id: body.projectId,
        payload,
        updated_at: new Date().toISOString(),
        expires_at: expiresAt,
      }),
      cache: 'no-store',
    });
    if (!response.ok) return NextResponse.json({ error: await readJson(response) }, { status: 502 });
    return NextResponse.json({ ok: true, expiresAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'Supabase is not configured' ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { url, key } = config();
    const projectId = req.nextUrl.searchParams.get('projectId') || '';
    if (!validProjectId(projectId)) return NextResponse.json({ error: 'Invalid projectId' }, { status: 400 });
    await cleanupExpired(url, key);
    const response = await fetch(`${url}/rest/v1/${TABLE}?select=payload,expires_at&project_id=eq.${encodeURIComponent(projectId)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`, {
      headers: headers(key), cache: 'no-store',
    });
    if (!response.ok) return NextResponse.json({ error: await readJson(response) }, { status: 502 });
    const rows = await response.json() as Array<{ payload: SnapshotPayload; expires_at: string }>;
    return NextResponse.json(rows[0] || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === 'Supabase is not configured' ? 503 : 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { url, key } = config();
    const projectId = req.nextUrl.searchParams.get('projectId') || '';
    if (!validProjectId(projectId)) return NextResponse.json({ error: 'Invalid projectId' }, { status: 400 });
    const response = await fetch(`${url}/rest/v1/${TABLE}?project_id=eq.${encodeURIComponent(projectId)}`, {
      method: 'DELETE', headers: headers(key), cache: 'no-store',
    });
    if (!response.ok) return NextResponse.json({ error: await readJson(response) }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
