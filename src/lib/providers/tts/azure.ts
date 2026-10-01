import { TTSProvider, TTSOptions, Voice } from './types';

export const azureTTS: TTSProvider = {
  id: 'azure',
  name: 'Microsoft Azure TTS',
  description: '500k симв/мес F0 · нейронные голоса, отличный RU',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  baseUrl: 'https://eastus.tts.speech.microsoft.com',

  async generate(text: string, { voice = 'ru-RU-SvetlanaNeural', apiKey, speed = 1.0, language }: TTSOptions): Promise<ArrayBuffer> {
    const pct = Math.round(((speed || 1) - 1) * 100);
    const rate = pct === 0 ? '0%' : `${pct > 0 ? '+' : ''}${pct}%`;
    const ssml = `<speak version='1.0' xml:lang='${language || 'ru-RU'}'><voice name='${voice}'><prosody rate='${rate}'>${escapeXml(text)}</prosody></voice></speak>`;
    const endpoint = 'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1';
    const res = await fetch(endpoint, {
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
      throw new Error(`Azure TTS error: ${res.status} — ${err.slice(0,500)}`);
    }
    return res.arrayBuffer();
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'ru-RU-SvetlanaNeural', name: 'Svetlana (жен, RU)', language: 'ru', gender: 'female', provider: 'azure' },
      { id: 'ru-RU-DmitryNeural', name: 'Dmitry (муж, RU)', language: 'ru', gender: 'male', provider: 'azure' },
      { id: 'ru-RU-DariyaNeural', name: 'Dariya (жен, RU)', language: 'ru', gender: 'female', provider: 'azure' },
      { id: 'en-US-JennyNeural', name: 'Jenny (жен, EN)', language: 'en', gender: 'female', provider: 'azure' },
      { id: 'en-US-GuyNeural', name: 'Guy (муж, EN)', language: 'en', gender: 'male', provider: 'azure' },
      { id: 'en-US-AriaNeural', name: 'Aria (жен, EN)', language: 'en', gender: 'female', provider: 'azure' },
    ];
  }
};

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
