import { NextRequest, NextResponse } from 'next/server';
import { createRequire } from 'node:module';
import { generateGeminiTTS } from '@/lib/providers/tts/gemini';
import { resolveAudioMime } from '@/lib/providers/tts/mime';
import { generateCartesia } from '@/lib/providers/tts/cartesia';
import { generateDeepgramTTS } from '@/lib/providers/tts/deepgram';
import { mustUseProxy } from '@/lib/providers/tts/cors';
import { getServerGenerate } from '@/lib/providers/tts/catalog';
import { mapTTSProviderError } from '@/lib/providers/tts/router';

export const runtime = 'nodejs';
export const maxDuration = 60;

// These optional packages are intentionally not part of package.json. Resolve
// them at runtime so Turbopack/webpack do not emit missing-module warnings.
const nodeRequire = createRequire(import.meta.url);
// Build the optional name at runtime so Turbopack won't resolve it while compiling.
const pollyModuleName = ['@aws-sdk', 'client-polly'].join('/');

type PollyRuntimeModule = {
  PollyClient: new (config: {
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  }) => { send(command: unknown): Promise<{ AudioStream?: AsyncIterable<Uint8Array> }> };
  SynthesizeSpeechCommand: new (input: {
    Text: string;
    VoiceId: string;
    OutputFormat: string;
    Engine: string;
    LanguageCode: string;
  }) => unknown;
};

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { providerId, text, voice, apiKey, language, speed, model } = body;

    if (!providerId || !text || !apiKey) {
      return NextResponse.json({ error: 'Missing providerId, text or apiKey' }, { status: 400 });
    }

    switch (providerId) {
      case 'elevenlabs': {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voice || '21m00Tcm4TlvDq8ikWAM'}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
              'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
              text,
              model_id: model || 'eleven_multilingual_v2',
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0.3,
                use_speaker_boost: true,
                speed: speed || 1.0
              }
            })
          }
        );
        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `ElevenLabs error: ${err}` }, { status: res.status });
        }
        const arrayBuffer = await res.arrayBuffer();
        return new NextResponse(arrayBuffer, {
          headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(arrayBuffer.byteLength) }
        });
      }

      case 'openai': {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: model || 'tts-1-hd',
            input: text,
            voice: voice || 'alloy',
            speed: speed || 1.0,
            response_format: 'mp3'
          })
        });
        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `OpenAI TTS error: ${err}` }, { status: res.status });
        }
        const arrayBuffer = await res.arrayBuffer();
        return new NextResponse(arrayBuffer, { headers: { 'Content-Type': 'audio/mpeg' } });
      }

      case 'gemini': {
        try {
          const wav = await generateGeminiTTS(text, { apiKey, voice, model, language, speed });
          return new NextResponse(wav, { headers: { 'Content-Type': 'audio/wav' } });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = Number(message.match(/Gemini TTS error: (\d{3})/)?.[1]) || 500;
          return NextResponse.json({ error: message }, { status });
        }
      }

      case 'polly': {
        try {
          const creds = JSON.parse(apiKey);
          const { accessKeyId, secretAccessKey, region = 'eu-central-1' } = creds;
          let awsModule: PollyRuntimeModule;
          try {
            awsModule = nodeRequire(pollyModuleName);
          } catch {
            throw new Error('AWS SDK not installed. Run npm install @aws-sdk/client-polly --no-save --no-audit --no-fund');
          }
          const { PollyClient, SynthesizeSpeechCommand } = awsModule;
          const client = new PollyClient({ region, credentials: { accessKeyId, secretAccessKey } });
          const command = new SynthesizeSpeechCommand({ Text: text, VoiceId: voice || 'Maxim', OutputFormat: 'mp3', Engine: 'neural', LanguageCode: language || 'ru-RU' });
          const response = await client.send(command);
          const audioStream = response.AudioStream;
          if (!audioStream) throw new Error('No audio stream');
          const chunks: Uint8Array[] = [];
          for await (const chunk of audioStream) chunks.push(chunk);
          const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
          const merged = new Uint8Array(totalLength);
          let offset = 0;
          for (const c of chunks) { merged.set(c, offset); offset += c.length; }
          return new NextResponse(merged, { headers: { 'Content-Type': 'audio/mpeg' } });
        } catch (e: any) {
          return NextResponse.json({ error: `Polly error: ${e.message}` }, { status: 500 });
        }
      }

      case 'azure': {
        const ssml = `<speak version='1.0' xml:lang='${language || 'ru-RU'}'><voice name='${voice || 'ru-RU-SvetlanaNeural'}'><prosody rate='${speed || 1}'>${escapeXml(text)}</prosody></voice></speak>`;
        const res = await fetch('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1', {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
          },
          body: ssml
        });
        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `Azure TTS error: ${err}` }, { status: res.status });
        }
        const buf = await res.arrayBuffer();
        return new NextResponse(buf, { headers: { 'Content-Type': resolveAudioMime('azure', buf) } });
      }

      case 'google-cloud': {
        const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { text },
            voice: { languageCode: language || 'ru-RU', name: voice || 'ru-RU-Wavenet-A' },
            audioConfig: { audioEncoding: 'MP3', speakingRate: speed || 1.0 }
          })
        });
        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `Google Cloud TTS error: ${err}` }, { status: res.status });
        }
        const data = await res.json();
        if (!data.audioContent) return NextResponse.json({ error: 'No audioContent' }, { status: 500 });
        const binary = Buffer.from(data.audioContent, 'base64');
        const gBuf = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
        return new NextResponse(gBuf, { headers: { 'Content-Type': resolveAudioMime('google-cloud', gBuf) } });
      }

      case 'cartesia': {
        // Тот же путь, что и у клиента (включая ретрай без speed): тела больше
        // не дублируются, ошибки приходят со статусом от Cartesia.
        try {
          const buf = await generateCartesia(text, { apiKey, voice, language, speed, model });
          return new NextResponse(buf, { headers: { 'Content-Type': resolveAudioMime(providerId, buf) } });
        } catch (e: any) {
          return NextResponse.json({ error: e.message }, { status: typeof e?.status === 'number' ? e.status : 502 });
        }
      }

      case 'deepgram': {
        try {
          const buffer = await generateDeepgramTTS(text, { apiKey, voice, model, language, speed });
          return new NextResponse(buffer, { headers: { 'Content-Type': resolveAudioMime(providerId, buffer) } });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = typeof error === 'object' && error !== null && 'status' in error
            && typeof error.status === 'number'
            ? error.status
            : 502;
          return NextResponse.json({
            error: mapTTSProviderError({ providerId: 'deepgram', status, responseBody: message, model: model || voice }),
          }, { status });
        }
      }

      case 'qwen': {
        const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model || 'qwen3-tts-flash',
            input: { text, voice: voice || 'Chelsie', language_type: language || 'ru' },
            parameters: { format: 'mp3' }
          })
        });
        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `Qwen TTS error: ${err}` }, { status: res.status });
        }
        const data = await res.json();
        const audioUrl = data.output?.audio?.url || data.output?.audio_url;
        if (audioUrl) {
          const audioRes = await fetch(audioUrl);
          const buf = await audioRes.arrayBuffer();
          return new NextResponse(buf, { headers: { 'Content-Type': 'audio/mpeg' } });
        }
        return NextResponse.json({ error: 'Qwen: no audio url' }, { status: 500 });
      }

      case 'playht':
      case 'resemble':
      case 'murf':
      case 'fish':
      case 'hume':
      case 'speechify': {
        // Раньше здесь был 400 «use client-side» → эти провайдеры падали на CORS.
        // Теперь выполняем их запрос на сервере (в Node те же fetch/atob) и
        // возвращаем аудио клиенту.
        //
        // Антирекурсивный guard — структурный, а не списочный: если у провайдера
        // нет серверной реализации и клиентская ходит через прокси, честно
        // отвечаем 501, вместо «сервер вызывает сам себя до таймаута».
        const { TTS_PROVIDERS } = await import('@/lib/providers/tts');
        const provider = TTS_PROVIDERS.find(p => p.id === providerId);
        if (!provider) {
          return NextResponse.json({ error: `Provider ${providerId} not found` }, { status: 404 });
        }
        // Экспериментальные провайдеры: их дефолтные голоса не проверены живым
        // ключом, поэтому без явного voice честно просим указать его, а не
        // отправляем в API выдуманный id.
        if (provider.experimental && (!voice || voice === 'default')) {
          return NextResponse.json(
            {
              error: `${providerId}: укажите голос вручную — провайдер помечен как экспериментальный, дефолтный голос может быть невалиден.`,
              code: 'voice_required',
            },
            { status: 400 }
          );
        }
        const serverGenerate = getServerGenerate(provider);
        if (!serverGenerate) {
          return NextResponse.json(
            {
              error: `${providerId}: нет серверной реализации синтеза (клиентская ходит через /api/tts). Добавьте serverGenerate провайдеру или отдельную ветку в route.ts.`,
              code: 'no_server_generate',
            },
            { status: 501 }
          );
        }
        const buffer = await serverGenerate(text, {
          apiKey,
          // undefined, а не '': дефолт в сигнатуре провайдера срабатывает только
          // на undefined, а пустая строка ушла бы в API как voiceId=''.
          voice: voice || undefined,
          language: language || 'ru',
          speed,
          model,
        });
        // MIME по фактической сигнатуре: провайдеры не всегда отдают запрошенный формат
        return new NextResponse(buffer, {
          headers: { 'Content-Type': resolveAudioMime(providerId, buffer) },
        });
      }

      default: {
        // Здесь же ловим будущие провайдеры, которым прокси обязателен по политике:
        // молчаливая рекурсия «сервер → /api/tts → сервер» невозможна.
        const hint = mustUseProxy(providerId)
          ? `Provider ${providerId} требует прокси, но серверной ветки нет — добавьте её в route.ts`
          : `Provider ${providerId} not implemented in proxy, use client-side`;
        return NextResponse.json({ error: hint, code: mustUseProxy(providerId) ? 'no_server_branch' : 'not_implemented' }, { status: 400 });
      }
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'TTS proxy ready',
    providers: ['elevenlabs', 'openai', 'gemini', 'polly', 'azure', 'google-cloud', 'cartesia', 'deepgram', 'qwen', 'playht', 'resemble', 'murf', 'fish', 'hume', 'speechify'],
    note: 'Gemini (raw PCM) оборачивается в WAV; Content-Type остальных определяется по сигнатуре полученного аудио'
  });
}
