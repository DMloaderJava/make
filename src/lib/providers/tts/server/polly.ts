/**
 * Серверная реализация Amazon Polly.
 *
 * Единственный провайдер, которому нужен серверный код, отличный от клиентской
 * `generate()`: клиентская не может подписать запрос SigV4 и поэтому ходит в
 * `/api/tts`, а сервер использует официальный SDK (`@aws-sdk/client-polly`).
 * Пакет опциональный — его нет в package.json, поэтому резолвим в рантайме,
 * чтобы Turbopack не пытался его собрать.
 *
 * Файл лежит в `tts/server/`, чтобы `node:module` не попадал в клиентский бандл:
 * `catalog.ts` импортируется UI, а этот модуль — только из маршрута.
 */

import { createRequire } from 'node:module';
import type { TTSOptions } from '../types';

const nodeRequire = createRequire(import.meta.url);
// Имя собирается в рантайме: иначе сборщик попытается резолвить отсутствующий пакет.
const POLLY_MODULE = ['@aws-sdk', 'client-polly'].join('/');

interface PollyRuntimeModule {
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
}

interface PollyCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
}

function parseCredentials(raw: string): PollyCredentials {
  try {
    return JSON.parse(raw) as PollyCredentials;
  } catch {
    throw new Error(
      'Polly требует AWS credentials в формате JSON: {"accessKeyId":"...","secretAccessKey":"...","region":"eu-central-1"}'
    );
  }
}

export async function generatePollyViaSdk(text: string, options: TTSOptions): Promise<ArrayBuffer> {
  const credentials = parseCredentials(options.apiKey);
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new Error('Polly: в JSON-ключе нет accessKeyId/secretAccessKey.');
  }

  let awsModule: PollyRuntimeModule;
  try {
    awsModule = nodeRequire(POLLY_MODULE) as PollyRuntimeModule;
  } catch {
    throw new Error(
      'AWS SDK not installed. Run npm install @aws-sdk/client-polly --no-save --no-audit --no-fund'
    );
  }

  const { PollyClient, SynthesizeSpeechCommand } = awsModule;
  const client = new PollyClient({
    region: credentials.region || 'eu-central-1',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });

  const command = new SynthesizeSpeechCommand({
    Text: text,
    VoiceId: options.voice || 'Maxim',
    OutputFormat: 'mp3',
    Engine: 'neural',
    LanguageCode: options.language || 'ru-RU',
  });

  const response = await client.send(command);
  const stream = response.AudioStream;
  if (!stream) throw new Error('Polly: пустой аудиопоток в ответе');

  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.buffer;
}
