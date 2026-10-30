import { TTSProvider, TTSOptions, Voice } from './types';
import { providerFetch } from '../http';
import { ttsFetch } from './transport';

export const elevenLabsTTS: TTSProvider = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  description: 'Лучшее качество, клонирование, Multilingual v2, 10k символов free',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  defaultModel: 'eleven_multilingual_v2',
  baseUrl: 'https://api.elevenlabs.io/v1',

  async generate(text: string, options: TTSOptions): Promise<ArrayBuffer> {
    const { voice = '21m00Tcm4TlvDq8ikWAM', apiKey, speed = 1.0, model } = options;
    // Таймаут/повторы/формат ошибки — в ttsFetch, тело запроса — здесь.
    const response = await ttsFetch(
      'elevenlabs',
      'ElevenLabs',
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
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
            speed: speed
          }
        })
      },
      options
    );

    return response.arrayBuffer();
  },
  
  async getVoices(apiKey: string): Promise<Voice[]> {
    if (!apiKey) {
      // Return demo voices if no key
      return [
        { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (жен, американский)', language: 'en', gender: 'female', provider: 'elevenlabs' },
        { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi (жен, сильный)', language: 'en', gender: 'female', provider: 'elevenlabs' },
        { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (жен, мягкий)', language: 'en', gender: 'female', provider: 'elevenlabs' },
        { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni (муж, теплый)', language: 'en', gender: 'male', provider: 'elevenlabs' },
        { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli (жен, юный)', language: 'en', gender: 'female', provider: 'elevenlabs' },
        { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh (муж, глубокий)', language: 'en', gender: 'male', provider: 'elevenlabs' },
      ];
    }
    try {
      // Список голосов — вспомогательный запрос: короткий таймаут и один повтор,
      // чтобы экран настроек не ждал 30 секунд. Ошибка → демо-список ниже.
      const response = await providerFetch('elevenlabs', 'https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey }
      }, { label: 'ElevenLabs voices', retries: 1, timeoutMs: 15_000 });
      const data = await response.json();
      return data.voices.map((v: any) => ({
        id: v.voice_id,
        name: `${v.name} (${v.labels?.accent || ''} ${v.labels?.age || ''})`.trim(),
        language: v.labels?.language || 'multi',
        gender: v.labels?.gender || 'neutral',
        provider: 'elevenlabs',
        description: v.labels?.description || v.labels?.use_case || ''
      }));
    } catch {
      return [
        { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', language: 'en', gender: 'female', provider: 'elevenlabs' },
      ];
    }
  }
};
