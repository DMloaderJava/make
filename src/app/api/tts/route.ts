import { NextRequest, NextResponse } from 'next/server';
import { getServerGenerate, getTTSProvider } from '@/lib/providers/tts/catalog';
import { mustUseProxy } from '@/lib/providers/tts/cors';
import { resolveAudioMime } from '@/lib/providers/tts/mime';
import { describeProviderFailure } from '@/lib/providers/tts/router';
import { getServerOverride } from '@/lib/providers/tts/server/overrides';
import { TTS_REQUEST_BUDGET_MS } from '@/lib/providers/tts/transport';
import { providerFailureCode } from '@/lib/providers/http';
import { parseJsonBody, TTSRequestSchema } from '@/lib/providers/schemas';

/**
 * Прокси синтеза речи.
 *
 * Раньше здесь был `switch` на 15 ветвей: каждая вручную собирала тело запроса
 * и форматировала ошибку. Это дублировало `generate()` провайдеров (и уже
 * расходилось с ними: Azure считал `prosody rate` в процентах, а ветка писала
 * `rate='1'`; Qwen в ветке терял base64-фолбэк). Добавление провайдера означало
 * ещё одну копию.
 *
 * Теперь маршрут не знает про протоколы: он валидирует тело, находит
 * реализацию (серверное переопределение → `serverGenerate` → обычная
 * `generate()`), вызывает её и переводит сбой в HTTP-статус. Новый провайдер
 * регистрируется одним файлом, без правки этого файла.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req, TTSRequestSchema);
  if (!parsed.ok) {
    if (parsed.reason === 'invalid_json') {
      return json({ error: 'Тело запроса должно быть JSON-объектом.', code: 'invalid_json' }, 400);
    }
    const first = parsed.issues[0];
    return json(
      {
        error: first
          ? `Некорректный запрос: поле «${first.path}» — ${first.message}`
          : 'Некорректный запрос',
        code: 'invalid_request',
        issues: parsed.issues,
      },
      400
    );
  }

  const { providerId, text, voice, apiKey, language, speed, model } = parsed.data;

  const provider = getTTSProvider(providerId);
  if (!provider) {
    // Неизвестный id — это ошибка клиента, а не 404 каталога: каталог отдаёт GET.
    const proxy = mustUseProxy(providerId);
    return json(
      {
        error: proxy
          ? `Provider ${providerId} требует прокси, но его нет в каталоге — добавьте реализацию в providers/tts/*.ts и запись в реестре.`
          : `Provider ${providerId} not found`,
        code: proxy ? 'no_server_branch' : 'not_implemented',
      },
      400
    );
  }

  // Экспериментальные провайдеры: дефолтные голоса не проверены живым ключом,
  // поэтому без явного voice честно просим его указать, а не отправляем в API
  // выдуманный id. Проверка общая для всех провайдеров, а не для шести ветвей.
  if (provider.experimental && (!voice || voice === 'default')) {
    return json(
      {
        error: `${providerId}: укажите голос вручную — провайдер помечен как экспериментальный, дефолтный голос может быть невалиден.`,
        code: 'voice_required',
      },
      400
    );
  }

  const generate = getServerOverride(providerId) ?? getServerGenerate(provider);
  if (!generate) {
    return json(
      {
        error: `${providerId}: нет серверной реализации синтеза (клиентская ходит через /api/tts). Добавьте serverGenerate провайдеру или переопределение в providers/tts/server/.`,
        code: 'no_server_generate',
      },
      501
    );
  }

  try {
    const audio = await generate(text, {
      apiKey,
      // undefined, а не '': дефолт в сигнатуре провайдера срабатывает только
      // на undefined, пустая строка ушла бы в API как voiceId=''.
      voice: voice || undefined,
      language,
      speed,
      model,
      // Отмена клиентом (закрыл вкладку/экспорт) прерывает запрос к провайдеру.
      signal: req.signal,
      deadlineMs: TTS_REQUEST_BUDGET_MS,
    });

    return new NextResponse(audio, {
      headers: {
        // MIME по фактической сигнатуре: провайдеры не всегда отдают запрошенный формат.
        'Content-Type': resolveAudioMime(providerId, audio),
        'Content-Length': String(audio.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const failure = describeProviderFailure(providerId, error, { model });
    return json({ error: failure.message, code: providerFailureCode(error) }, failure.status);
  }
}

export async function GET() {
  // Список выводится из реестра: раньше он дублировался руками и отставал от
  // фактических веток маршрута.
  const { getImplementedProviders } = await import('@/lib/providers/registry');
  return NextResponse.json({
    status: 'TTS proxy ready',
    providers: getImplementedProviders('tts').map(entry => entry.id),
    note:
      'Маршрут общий для всех провайдеров: тело собирает generate() провайдера, ' +
      'Gemini (raw PCM) оборачивается в WAV, Content-Type определяется по сигнатуре аудио.',
  });
}
