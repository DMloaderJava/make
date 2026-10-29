import { NextRequest, NextResponse } from 'next/server';
import { TTS_PROVIDERS, getTTSProvider } from '@/lib/providers/tts';
import { providerFailureCode, providerFailureStatus, ProviderHttpError } from '@/lib/providers/http';
import { parseJsonBody, VoicesRequestSchema } from '@/lib/providers/schemas';

/**
 * Список голосов провайдера. Тело валидируется схемой: раньше в
 * `provider.getVoices(apiKey || '')` уезжало что угодно (объект, число), и
 * провайдер падал в невнятном месте вместо 400.
 */

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req, VoicesRequestSchema);
  if (!parsed.ok) {
    if (parsed.reason === 'invalid_json') {
      return NextResponse.json({ error: 'Тело запроса должно быть JSON-объектом.', code: 'invalid_json' }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Некорректный запрос: ${parsed.issues[0]?.path ?? ''} — ${parsed.issues[0]?.message ?? ''}`, code: 'invalid_request', issues: parsed.issues },
      { status: 400 }
    );
  }

  const { providerId, apiKey } = parsed.data;
  const provider = getTTSProvider(providerId);
  if (!provider) return NextResponse.json({ error: 'Provider not found', code: 'unknown_provider' }, { status: 404 });

  try {
    const voices = await provider.getVoices(apiKey || '');
    return NextResponse.json({ providerId, voices });
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      return NextResponse.json(
        { error: error.message, code: providerFailureCode(error) },
        { status: providerFailureStatus(error) }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error', code: 'internal_error' },
      { status: 500 }
    );
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

  const provider = getTTSProvider(providerId);
  if (!provider) return NextResponse.json({ error: 'Provider not found', code: 'unknown_provider' }, { status: 404 });

  try {
    // No apiKey via query for security – use POST for authenticated calls
    const voices = await provider.getVoices('');
    return NextResponse.json({ providerId, voices, note: 'Use POST with apiKey in body for authenticated voice list' });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    );
  }
}
