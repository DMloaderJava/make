import { TTSProvider, TTSOptions, Voice } from './types';
import { base64ToArrayBuffer } from '@/lib/utils';
import { pcmToWav } from './wav';

export const geminiTTS: TTSProvider = {
  id: 'gemini',
  name: 'Google Gemini TTS',
  description: '200+ голосов, отличный русский, free quota',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  defaultModel: 'gemini-2.5-flash-preview-tts',
  // У Gemini TTS нет параметра темпа: скорость задаётся только стилевой
  // подсказкой в тексте, поэтому speed не передаём и честно помечаем это в UI.
  supportsSpeed: false,
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',

  async generate(text: string, { voice = 'Puck', apiKey, speed: _speed = 1.0, model: requestedModel }: TTSOptions): Promise<ArrayBuffer> {
    // Client-side direct call (will be proxied via /api/tts for CORS)
    // Model list: gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts, gemini-2.0-flash-exp etc
    // Use gemini-2.5-flash-preview-tts as recommended
    const model = requestedModel || 'gemini-2.5-flash-preview-tts';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice }
              }
            }
          }
        })
      }
    );
    
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini TTS error: ${response.status} — ${err}`);
    }
    
    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('Gemini TTS: no candidates');
    const inlineData = candidate.content?.parts?.[0]?.inlineData?.data;
    if (!inlineData) throw new Error('Gemini TTS: no audio data');
    // Gemini отдаёт сырой L16 PCM 24 кГц моно — оборачиваем в WAV,
    // иначе decodeAudioData/<audio>/склейка не смогут его прочитать.
    return pcmToWav(base64ToArrayBuffer(inlineData), { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
  },
  
  async getVoices(): Promise<Voice[]> {
    // Gemini TTS prebuilt voices - no API to list, return static
    return [
      { id: 'Puck', name: 'Puck (муж, энергичный)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Charon', name: 'Charon (муж, глубокий)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Kore', name: 'Kore (жен, мягкий)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Fenrir', name: 'Fenrir (муж, мощный)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Aoede', name: 'Aoede (жен, лиричный)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Leda', name: 'Leda (жен, юный)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Orus', name: 'Orus (муж, спокойный)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Zephyr', name: 'Zephyr (жен, воздушный)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Achernar', name: 'Achernar (жен, теплый)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Algenib', name: 'Algenib (муж, гравий)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Schedar', name: 'Schedar (муж, ровный)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Gacrux', name: 'Gacrux (жен, зрелый)', language: 'ru', gender: 'female', provider: 'gemini' },
    ];
  }
};
