import { NextRequest, NextResponse } from 'next/server';
import { TTS_PROVIDERS } from '@/lib/providers/tts';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { providerId, apiKey } = body;
    if (!providerId) return NextResponse.json({ error: 'Missing providerId' }, { status: 400 });
    const provider = TTS_PROVIDERS.find(p => p.id === providerId);
    if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    const voices = await provider.getVoices(apiKey || '');
    return NextResponse.json({ providerId, voices });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const providerId = searchParams.get('providerId');

  if (!providerId) {
    const all = await Promise.all(
      TTS_PROVIDERS.map(async (p) => {
        try {
          const voices = await p.getVoices('');
          return { providerId: p.id, providerName: p.name, voices: voices.slice(0, 20), count: voices.length };
        } catch {
          return { providerId: p.id, providerName: p.name, voices: [], count: 0 };
        }
      })
    );
    return NextResponse.json({ providers: all });
  }

  const provider = TTS_PROVIDERS.find(p => p.id === providerId);
  if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });

  try {
    // No apiKey via query for security – use POST for authenticated calls
    const voices = await provider.getVoices('');
    return NextResponse.json({ providerId, voices, note: 'Use POST with apiKey in body for authenticated voice list' });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
