import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
        const modelName = model || 'gemini-2.5-flash-preview-tts';
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text }] }],
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Puck' } } }
              }
            })
          }
        );
        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `Gemini TTS error: ${err}` }, { status: res.status });
        }
        const data = await res.json();
        const base64Audio = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!base64Audio) return NextResponse.json({ error: 'No audio data from Gemini' }, { status: 500 });
        const binary = Buffer.from(base64Audio, 'base64');
        return new NextResponse(binary, { headers: { 'Content-Type': 'audio/wav' } });
      }

      case 'polly': {
        try {
          const creds = JSON.parse(apiKey);
          const { accessKeyId, secretAccessKey, region = 'eu-central-1' } = creds;
          // @ts-ignore
          const awsModule = await import('@aws-sdk/client-polly').catch(() => { throw new Error('AWS SDK not installed. Run npm install @aws-sdk/client-polly'); });
          const { PollyClient, SynthesizeSpeechCommand } = awsModule;
          const client = new PollyClient({ region, credentials: { accessKeyId, secretAccessKey } });
          const command = new SynthesizeSpeechCommand({ Text: text, VoiceId: voice || 'Maxim', OutputFormat: 'mp3', Engine: 'neural', LanguageCode: language || 'ru-RU' });
          // @ts-ignore
          const response = await client.send(command);
          const audioStream = response.AudioStream;
          if (!audioStream) throw new Error('No audio stream');
          const chunks: Uint8Array[] = [];
          // @ts-ignore
          for await (const chunk of audioStream as any) chunks.push(chunk);
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
        return new NextResponse(buf, { headers: { 'Content-Type': 'audio/mpeg' } });
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
        return new NextResponse(binary, { headers: { 'Content-Type': 'audio/mpeg' } });
      }

      case 'cartesia': {
        const res = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: {
            'Cartesia-Version': '2024-06-10',
            'X-API-Key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model_id: model || 'sonic-3',
            transcript: text,
            voice: { mode: 'id', id: voice || '79a125e8-cd45-4c13-8a67-188112f4dd22' },
            language: language || 'en',
            output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 44100 },
            speed: speed || 1.0,
          })
        });
        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `Cartesia error: ${err}` }, { status: res.status });
        }
        const buf = await res.arrayBuffer();
        return new NextResponse(buf, { headers: { 'Content-Type': 'audio/mpeg' } });
      }

      case 'deepgram': {
        const res = await fetch(`https://api.deepgram.com/v1/speak?model=${voice || 'aura-2-thalia-en'}&encoding=mp3`, {
          method: 'POST',
          headers: { 'Authorization': `Token ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `Deepgram error: ${err}` }, { status: res.status });
        }
        const buf = await res.arrayBuffer();
        return new NextResponse(buf, { headers: { 'Content-Type': 'audio/mpeg' } });
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
        return NextResponse.json({
          error: `Provider ${providerId} requires client-side direct call (CORS may need browser). Use preview in VoicesModal`,
          hint: 'Try client-side generation'
        }, { status: 400 });
      }

      default: {
        return NextResponse.json({ error: `Provider ${providerId} not implemented in proxy, use client-side` }, { status: 400 });
      }
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'TTS proxy ready',
    providers: ['elevenlabs', 'openai', 'gemini', 'polly', 'azure', 'google-cloud', 'cartesia', 'deepgram', 'qwen'],
    note: 'Some providers require client-side due to complex auth'
  });
}
