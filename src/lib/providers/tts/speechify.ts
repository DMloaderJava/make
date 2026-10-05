import { TTSProvider, TTSOptions, Voice } from './types';

export const speechifyTTS: TTSProvider = {
  id: 'speechify',
  name: 'Speechify',
  description: 'Simba 3.2 для английского · Simba 3.0 для 6 других языков',
  freeTier: false,
  defaultModel: 'simba-3.2',
  supportedModels: ['simba-3.2', 'simba-3.0'],
  languages: ['en-US', 'de-DE', 'es-ES', 'es-MX', 'fr-FR', 'it-IT', 'pt-BR'],
  // Не проверено вживую: эндпоинт/поля взяты из документации (см. npm run smoke:tts).
  experimental: true,
  // Параметр темпа в используемом эндпоинте не подтверждён — не отправляем
  // наугад: 400 от API хуже, чем честная пометка «не поддерживается».
  supportsSpeed: false,
  baseUrl: 'https://api.sws.speechify.com',

  async generate(text: string, { voice = 'matthew', apiKey, speed: _speed = 1.0, language = 'en-US', model }: TTSOptions): Promise<ArrayBuffer> {
    // simba-base was used by older project settings; migrate it to the supported
    // Simba 3 model selected for the request language.
    const languageBase = language.toLowerCase().split('-')[0];
    const supportedLanguageBases = new Set(['en', 'de', 'es', 'fr', 'it', 'pt']);
    if (!supportedLanguageBases.has(languageBase)) {
      throw new Error(`Speechify does not support ${language}; use English, German, Spanish, French, Italian, or Brazilian Portuguese.`);
    }
    const isEnglish = languageBase === 'en';
    const requestedModel = model && model !== 'simba-base' ? model : undefined;
    const modelId = !isEnglish && requestedModel === 'simba-3.2'
      ? 'simba-3.0'
      : requestedModel || (isEnglish ? 'simba-3.2' : 'simba-3.0');
    const response = await fetch('https://api.sws.speechify.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        voice_id: voice,
        audio_format: 'mp3',
        language,
        model: modelId,
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Speechify error: ${response.status} — ${err}`);
    }

    const data = await response.json();
    // Speechify returns audio_data as base64
    if (data.audio_data) {
      const binary = atob(data.audio_data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    // fallback: if returns direct audio
    return response.arrayBuffer();
  },

  async getVoices(apiKey: string): Promise<Voice[]> {
    if (!apiKey) {
      return [
        { id: 'matthew', name: 'Matthew (муж, en)', language: 'en', gender: 'male', provider: 'speechify' },
        { id: 'george', name: 'George (муж, en)', language: 'en', gender: 'male', provider: 'speechify' },
        { id: 'cliff', name: 'Cliff (муж, en)', language: 'en', gender: 'male', provider: 'speechify' },
        { id: 'guy', name: 'Guy (муж, en)', language: 'en', gender: 'male', provider: 'speechify' },
      ];
    }
    try {
      const res = await fetch('https://api.sws.speechify.com/v1/voices', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error('fail');
      const data = await res.json();
      return data.map((v: any) => ({
        id: v.id,
        name: v.name,
        language: v.language || 'en',
        gender: v.gender || 'neutral',
        provider: 'speechify'
      }));
    } catch {
      return [
        { id: 'matthew', name: 'Matthew', language: 'en', gender: 'male', provider: 'speechify' },
      ];
    }
  }
};
