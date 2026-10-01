import { TTSProvider } from './types';
import { geminiTTS } from './gemini';
import { elevenLabsTTS } from './elevenlabs';
import { speechifyTTS } from './speechify';
import { openAITTS } from './openai';
import { pollyTTS } from './polly';
import { qwenTTS } from './qwen';
import { azureTTS } from './azure';
import { googleCloudTTS } from './google-cloud';
import { cartesiaTTS } from './cartesia';
import { humeTTS } from './hume';
import { deepgramTTS } from './deepgram';
import { playhtTTS } from './playht';
import { resembleTTS } from './resemble';
import { murfTTS } from './murf';
import { fishTTS } from './fish';

export const TTS_PROVIDERS: TTSProvider[] = [
  geminiTTS,
  elevenLabsTTS,
  azureTTS,
  googleCloudTTS,
  speechifyTTS,
  openAITTS,
  pollyTTS,
  qwenTTS,
  cartesiaTTS,
  humeTTS,
  deepgramTTS,
  playhtTTS,
  resembleTTS,
  murfTTS,
  fishTTS,
].filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i); // dedup safety

export function getTTSProvider(id: string): TTSProvider | undefined {
  return TTS_PROVIDERS.find(p => p.id === id);
}
