import { NextRequest, NextResponse } from 'next/server';
import { createRequire } from 'node:module';
import { providerFailureCode, providerFailureStatus, providerFetch, ProviderHttpError } from '@/lib/providers/http';

export const runtime = 'nodejs';
export const maxDuration = 120;

const nodeRequire = createRequire(import.meta.url);
const whisperModuleName = ['nodejs', 'whisper'].join('-');
type NodeWhisper = (audioPath: string, options: Record<string, unknown>) => Promise<unknown>;
type NodeWhisperModule = NodeWhisper & { nodewhisper?: NodeWhisper; default?: NodeWhisper };

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File | null;
    const timelineStr = formData.get('timeline') as string | null;

    if (timelineStr) {
      try {
        const timeline = JSON.parse(timelineStr);
        const { generateSRT } = await import('@/lib/pipeline/buildTimeline');
        const intro = formData.get('intro') as string || '';
        const outro = formData.get('outro') as string || '';
        const introDuration = Number(formData.get('introDuration') || 8);
        const outroDuration = Number(formData.get('outroDuration') || 5);
        
        const srt = generateSRT(timeline, intro, outro, introDuration, outroDuration);
        return NextResponse.json({ srt, method: 'timeline' });
      } catch (e: any) {
        console.error('Timeline SRT generation failed', e);
        return NextResponse.json({ error: `SRT generation failed: ${e.message || e}` }, { status: 500 });
      }
    }

    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file and no timeline' }, { status: 400 });
    }

    const openaiKey = formData.get('openaiKey') as string | null;
    
    if (openaiKey) {
      const whisperForm = new FormData();
      whisperForm.append('file', audioFile);
      whisperForm.append('model', 'whisper-1');
      whisperForm.append('response_format', 'srt');

      // Транскрипция длинного файла — самая долгая операция в приложении:
      // бюджет поднят под maxDuration = 120, повтор только один (аплоад дорогой).
      let res: Response;
      try {
        res = await providerFetch('openai', 'https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
          },
          body: whisperForm
        }, {
          label: 'Whisper API',
          retries: 1,
          timeoutMs: 90_000,
          deadlineMs: 110_000,
          signal: req.signal,
          throwOnHttpError: false,
        });
      } catch (error) {
        if (error instanceof ProviderHttpError) {
          return NextResponse.json(
            { error: `Whisper API error: ${error.message}`, code: providerFailureCode(error) },
            { status: providerFailureStatus(error) }
          );
        }
        throw error;
      }

      if (!res.ok) {
        const err = await res.text();
        return NextResponse.json(
          { error: `Whisper API error: ${err}`, code: 'provider_http_error' },
          { status: res.status }
        );
      }

      const srt = await res.text();
      return NextResponse.json({ srt, method: 'openai-whisper' });
    }

    try {
      // exec/promisify здесь не нужны: whisper вызывается через nodejs-whisper,
      // а не через командную строку (мёртвый код удалён — ловится noUnusedLocals).
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');

      const tmpDir = os.tmpdir();
      const audioPath = path.join(tmpDir, `whisper-${Date.now()}.mp3`);
      const buffer = Buffer.from(await audioFile.arrayBuffer());
      await fs.writeFile(audioPath, buffer);

      try {
        const whisperModule = nodeRequire(whisperModuleName) as NodeWhisperModule;
        const nodewhisper: NodeWhisper = whisperModule.nodewhisper || whisperModule.default || whisperModule;
        const result = await nodewhisper(audioPath, {
          modelName: 'base',
          autoDownloadModelName: 'base',
          removeWavFileAfterTranscription: true,
          withCuda: false,
          whisperOptions: {
            outputInSrt: true,
            outputInText: false,
            wordTimestamps: false,
            splitOnWord: true,
          }
        });
        await fs.unlink(audioPath).catch(() => {});
        if (typeof result === 'string' && result.includes('-->')) {
          return NextResponse.json({ srt: result, method: 'nodejs-whisper' });
        }
        if (typeof result === 'string') {
          try {
            const srtContent = await fs.readFile(result, 'utf-8');
            await fs.unlink(result).catch(() => {});
            return NextResponse.json({ srt: srtContent, method: 'nodejs-whisper' });
          } catch {
            return NextResponse.json({ srt: result, method: 'nodejs-whisper' });
          }
        }
        return NextResponse.json({ srt: String(result), method: 'nodejs-whisper' });
      } catch (whisperErr) {
        await fs.unlink(audioPath).catch(() => {});
        throw whisperErr;
      }
    } catch (e: any) {
      return NextResponse.json({
        srt: '',
        method: 'unavailable',
        warning: `Whisper not available: ${e.message}. Provide OpenAI key or install nodejs-whisper. Client should fallback to timeline SRT.`
      });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: 'Whisper API ready', methods: ['timeline', 'openai-whisper', 'nodejs-whisper'] });
}
