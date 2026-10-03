# Manga Voice Studio — Self-hosted озвучка манги с AI (v1.3.2)

Self-hosted веб-инструмент для автоматической генерации озвученных видео из изображений (манга/комикс) с BYOK, 25+ LLM и 15+ TTS провайдерами, OPFS кэшем, WebCodecs MP4 и SEO-пакетом.

## 🎨 v1.3 — Студия без хлама

- Палитра warm graphite `#0B0B0C #16161A #1E1E23 #26262C` + amber accent `#E8B44C`
- One action one screen: single column max-w 960, no tabs, контекстная панель снизу
- Preview canvas 1280×720 Ken Burns + amber bbox + dialogue pill
- Timeline как сегменты intro/panels/outro, clickable seek, playhead amber
- Модалки только для редких действий: голоса, экспорт, провайдеры
- Dropzone hero по центру, карточки только preview+name+duration
- Hotkeys: Space play, ←→ ±5s, ⌘S save, ⌘E export

## 🏗️ Архитектура v1.3

```
[Изображение 1..N] → OPFS /projects/{id}/images/
  ↓ Vision LLM (Zod + normalizeCharacters)
[UI редактор] → Preview + Timeline + ContextPanel
  ↓ TTS TaskQueue (concurrency 2, retry 3, OPFS hash cache)
[AudioContext] → точная длительность
  ↓ buildTimeline + SRT
[videoEncoder] → auto: WebCodecs MP4 (H264+AAC via mediabunny) или Canvas WEBM fallback
  ↓ MP4/WEBM + MP3 + SRT + SEO
```

## 🚀 Быстрый старт

```bash
npm install
npm run dev
# http://localhost:3000
```

`/settings` → добавь ключи (см таблицы ниже). Все в localStorage, прямые запросы из браузера для CORS-friendly.

## 🧠 LLM-провайдеры (анализ изображений, SEO)

### Базовые

| Провайдер | Лимиты | Ключ | Особенности |
|-----------|--------|------|-------------|
| **OpenRouter** | 20 RPM / 50 RPD (1000 RPD при $10) | [openrouter.ai/keys](https://openrouter.ai/keys) | 25+ free моделей `:free` с vision |
| **NVIDIA NIM** | ~40 RPM, без карты | [build.nvidia.com](https://build.nvidia.com) | 189+ моделей, верификация телефона |
| **Google AI Studio** | 5-15 RPM, 250 RPD | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Gemini 2.5 Flash/Pro vision, без карты |
| **Groq** | 30 RPM, 14400 RPD | [console.groq.com/keys](https://console.groq.com/keys) | Самый быстрый, Llama 4 Scout vision |
| **Mistral AI** | Free mode ~1B токенов/мес | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) | Pixtral Large vision |
| **GitHub Models** | 40+ моделей | [github.com/marketplace/models](https://github.com/marketplace/models) | GPT-4o, o1, Claude 3.5, DeepSeek-R1 |
| **Cerebras** | $5 credit | [cloud.cerebras.ai](https://cloud.cerebras.ai) | Ultra-fast, free retired July 2026 |
| **SambaNova** | 20 req/day | [cloud.sambanova.ai](https://cloud.sambanova.ai) | Llama 4 Maverick, 90B Vision |
| **OpenAI** | $5 credit | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | GPT-4o, o1 fallback |
| **Anthropic** | Платно | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | Claude 3.5 fallback |

### Расширенные (добавлены в v1.3)

| Провайдер | Лимиты | Ключ | Почему |
|-----------|--------|------|--------|
| **Cloudflare Workers AI** | 10k Neurons/день | [dash.cloudflare.com](https://dash.cloudflare.com/?to=/:account/workers/ai) | Llama 3.2 11B Vision, Whisper, без карты |
| **Cohere** | 1000 req/мес Trial | [dashboard.cohere.com/api-keys](https://dashboard.cohere.com/api-keys) | Command A, Embed, без карты |
| **Hugging Face** | 300 req/час | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) | 100k+ моделей vision |
| **DeepSeek** | Free tier, очень дёшево | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) | V3, R1 |
| **Together AI** | $5 credit | [api.together.xyz/settings/api-keys](https://api.together.xyz/settings/api-keys) | Llama 3.3 70B, Qwen 2.5 VL vision |
| **Fireworks AI** | $1 credit | [fireworks.ai/account/api-keys](https://fireworks.ai/account/api-keys) | Llama 3.2 Vision, быстрый |
| **DeepInfra** | $1 credit | [deepinfra.com/dash/api_keys](https://deepinfra.com/dash/api_keys) | Llama 3.2 90B Vision, Qwen VL |
| **Novita AI** | $0.5 credit | [novita.ai/settings/key-management](https://novita.ai/settings/key-management) | Llama 3.2 Vision, Qwen VL |
| **SiliconFlow** | Free tier щедрый | [cloud.siliconflow.cn/account/ak](https://cloud.siliconflow.cn/account/ak) | Qwen 2.5 VL, DeepSeek, CN |
| **Zhipu AI (Z.ai)** | 1 concurrent | [open.bigmodel.cn/usercenter/apikeys](https://open.bigmodel.cn/usercenter/apikeys) | GLM-4V-Flash vision |
| **Moonshot AI** | Free tier | [platform.moonshot.cn/console/api-keys](https://platform.moonshot.cn/console/api-keys) | Kimi Vision |
| **01.AI** | Free tier | [platform.01.ai](https://platform.01.ai) | Yi-Vision |
| **Perplexity** | $5/мес Pro | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) | Sonar для SEO, online search |
| **Custom** | — | LM Studio / Ollama / vLLM | Локальный endpoint |

> Актуальные лимиты: [awesome-freellm-apis](https://github.com/open-free-llm-api/awesome-freellm-apis) · [Free-LLM](https://github.com/nejib1/Free-LLM) · [free-llm.com](https://free-llm.com)

## 🔊 TTS-провайдеры (озвучка)

| Провайдер | Free tier | Ключ | Особенности |
|-----------|-----------|------|-------------|
| **Gemini TTS** | Free quota | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | 200+ голосов, отличный RU, тот же ключ что LLM |
| **ElevenLabs** | 10k симв/мес | [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) | Лучшее качество, Multilingual v2 |
| **Azure TTS** | 500k симв/мес F0 | [portal.azure.com](https://portal.azure.com/#blade/HubsExtension/BrowseResource/resourceType/Microsoft.CognitiveServices%2Faccounts) | Нейронные, отличный RU, очень щедрый |
| **Google Cloud TTS** | 4M Standard / 1M WaveNet | [console.cloud.google.com](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com) | 380+ голосов, 75+ языков |
| **Speechify** | Free tier ограничен | [platform.speechify.ai/api-keys](https://platform.speechify.ai/api-keys) | 1000+ голосов, 50+ языков |
| **OpenAI TTS** | $15/1M | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | tts-1, tts-1-hd |
| **Polly** | 5M /12 мес | [console.aws.amazon.com/iam](https://console.aws.amazon.com/iam) | Нейронные, JSON ключ |
| **Qwen3-TTS** | 1M free | [dashscope.console.aliyun.com/apiKey](https://dashscope.console.aliyun.com/apiKey) | 49 голосов, 10 языков |
| **Cartesia Sonic 3** | Free tier, 40ms | [play.cartesia.ai/keys](https://play.cartesia.ai/keys) | Самый низкий latency, SSM |
| **Hume Octave 2** | Free tier | [platform.hume.ai/settings/keys](https://platform.hume.ai/settings/keys) | Эмоциональная, контекстная |
| **Deepgram Aura-2** | $200 credit | [console.deepgram.com](https://console.deepgram.com/) | Domain-tuned pronunciation |
| **PlayHT** | Free tier | [play.ht/app/api-access](https://play.ht/app/api-access) | 900+ голосов, клонирование, userId:apiKey |
| **Resemble AI** | Free tier | [app.resemble.ai](https://app.resemble.ai/) | Клонирование, emotion control |
| **Murf AI** | Free tier | [murf.ai/api](https://murf.ai/api) | 120+ голосов, sync с видео |
| **Fish Audio** | Free tier | [fish.audio](https://fish.audio/) | 50+ языков, Novita backed |

### STT для субтитров

| Провайдер | Free | Ключ |
|-----------|------|------|
| OpenAI Whisper API | $0.006/мин | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| AssemblyAI | Free limited | [assemblyai.com/dashboard](https://www.assemblyai.com/dashboard) |
| Deepgram Nova STT | $200 credit | [console.deepgram.com](https://console.deepgram.com/) |

## 🌐 UI провайдеров

В `/settings` — два таба: **🧠 Анализ и текст** и **🔊 Озвучка**. Каждая строка:

```
┌──────────────────────────────────────────────────────┐
│  OpenRouter                              ● активен   │
│  20 RPM / 50 RPD · 25+ free моделей                  │
│  Ключ: ●●●●●●●●●●●●       [тест] [✎] [↗ ключ]        │
└──────────────────────────────────────────────────────┘
```

- **↗ ключ** → страница получения ключа
- **тест** → минимальный запрос, ✓ / ✗
- Статус: активен если ключ сохранён

Централизованный файл: `lib/providers/links.ts` — один источник правды для всех ссылок.

## 📦 Стек

- Next.js 16 App Router + TS + Tailwind 4 + shadcn/ui + Zustand + idb + OPFS
- WebCodecs + mediabunny MP4 + Canvas fallback
- TaskQueue concurrency 2, retry 3, rate limiter, OPFS hash cache
- Zod validation Vision/SEO/Timeline

## 🔧 Что в коде для провайдеров

- `lib/providers/links.ts` — 40+ провайдеров с keyUrl, docsUrl, limits, freeTier
- `lib/providers/llm/catalog.ts` — 25+ LLM (OpenRouter, NVIDIA, Google, Groq, Mistral, GitHub, Cloudflare, Cohere, HF, DeepSeek, Together, Fireworks, DeepInfra, Novita, SiliconFlow, Zhipu, Moonshot, 01.AI, Perplexity, Custom...)
- `lib/providers/tts/catalog.ts` — 15+ TTS (Gemini, ElevenLabs, Azure, Google Cloud, Speechify, OpenAI, Polly, Qwen, Cartesia, Hume, Deepgram, PlayHT, Resemble, Murf, Fish)
- `components/settings/ProviderList.tsx` — строки вместо карточек, тест, ссылка на ключ, graphite+amber
- `app/settings/page.tsx` — minimal header + ProviderList

## 🔧 v1.3.2 — исправления после аудита

Критичные баги, найденные при разборе кода и исправленные в этой версии:

- **MP4-экспорт (WebCodecs/mediabunny)**: таймстемпы кадров передавались в микросекундах вместо секунд
  (`CanvasSource.add(time*1e6, …)`), а метаданные дорожки — как `framerate` вместо `frameRate`.
  Теперь кадры пишутся корректно, ошибки кодирования не глотаются.
- **WEBM-фолбэк (Canvas/MediaRecorder)**: писался вообще без звука. Теперь аудио микшируется через
  `OfflineAudioContext` и подмешивается дорожкой в `MediaStream`; кадры ведутся по стенным часам,
  полоса прогресса больше не впечатывается в видео.
- **Аудио на таймлайне**: дорожка раскладывается по `audioStart` панелей (паузы 0.3s сохраняются),
  с корректным ресемплингом — раньше блобы склеивались подряд и A/V разъезжались.
- **Gemini TTS**: сырой PCM (L16 24 кГц моно) оборачивается в WAV на клиенте и в `/api/tts`;
  раньше буфер не декодировался, длительность падала в фолбэк 2 сек.
- **CORS у TTS**: 5 провайдеров (elevenlabs/openai/polly/azure/deepgram) и 6 «клиентских»
  (playht/resemble/murf/fish/hume/speechify) идут через `/api/tts` (`providers/tts/router.ts`).
- **Голос по умолчанию**: вместо хардкода `'Puck'` (голос Gemini) — `resolveVoice()` берёт голос
  у самого провайдера, иначе статический фолбэк.
- **Инвалидация аудио**: у файлов в OPFS появилась подпись (текст+голос+провайдер+модель+язык),
  поэтому правка реплики или смена голоса теперь реально применяются. Плюс кнопка «↻ Переозвучить».
- **JSON-схемы**: `response_format` (json_schema/json_object) наконец уходит в запрос LLM.
- **Редактор**: автосейв сохраняет timeline/SRT/длительности; перемотка во время проигрывания не
  откатывается; хоткеи не перевешивают слушатель 30 раз в секунду; прогресс озвучки двигается.
- **Timeline**: ширины интро/аутро считаются от реальных `introDuration/outroDuration`.
- **SEO**: кнопка «✨ Сгенерировать SEO» реально вызывает `generateSEO` (или шаблонный фолбэк).
- **Провайдеры**: Cartesia больше не хардкодит `language: 'en'`, PlayHT — `Bearer` и настоящие
  голоса вместо Azure-ID, Polly разделяет ошибку парсинга ключа и ошибку прокси.
- **Инфра**: `npm run typecheck|verify`, версия 1.3.2, Electron считает 401/302 живым сервером,
  `clearAllInfo` закрывает соединение IDB перед удалением, форма входа — POST с хэшем в cookie
  (пароль больше не попадает в URL), флаг `MVS_SECURE_COOKIE`.

## 🛣️ Roadmap

- [x] v1.1: OPFS + TTS-cache + TaskQueue + Zod + WEBM + demo
- [x] v1.2: WebCodecs + mediabunny proper MP4 + hygiene fixes
- [x] v1.3: Студия без хлама (graphite+amber, single column, context panel, modals)
- [x] v1.3.1: 40+ провайдеров, links.ts, тест ключей, строки вместо карточек
- [ ] v1.4: Zustand editor + undo/redo + .mvproj
- [ ] v1.5: Фоновая музыка + batch queue persist
- [ ] v1.6: Docker self-hosted

---
**v1.3.1 готов** — `npm run dev` → `/settings` добавь OpenRouter + Gemini + Azure → загрузи мангу → озвучь (OPFS кэш) → экспорт MP4.
