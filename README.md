# Manga Voice Studio — Self-hosted озвучка манги с AI (v1.3.15)

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

### Windows

Есть готовые лаунчеры (двойной клик): `install.bat` → `run.bat` (меню режимов),
либо `start-browser.bat` / `start-window.bat` / `start-electron.bat`.
Они дублируют `.sh`-скрипты: та же проверка Node, тот же
`npm ci --legacy-peer-deps --no-audit --no-fund` и тот же фолбэк `--ignore-scripts`,
если postinstall Electron не смог проверить TLS-сертификат (корпоративный прокси,
антивирус).

`.bat`-файлы принудительно выкладываются с CRLF (`.gitattributes`): cmd.exe
переваривает LF-only батники не во всех сценариях (`goto`, `call`, метки).

Через терминал — тот же набор флагов, что в лаунчерах:

```cmd
:: cmd.exe
npm ci --legacy-peer-deps --no-audit --no-fund
npm run dev
```

```powershell
# PowerShell
npm ci --legacy-peer-deps --no-audit --no-fund
npm run dev
```

`--legacy-peer-deps` нужен из-за peer-конфликтов в цепочке Next.js/Electron,
`--ignore-scripts` добавляется как фолбэк, если установка падает на postinstall
Electron. Для веб-режима Electron не требуется, для десктопного — поставьте его
отдельно: `npm install --no-save electron --legacy-peer-deps --no-audit --no-fund`.

CI (`.github/workflows/ci.yml`) гоняет typecheck/test/lint/build на
**ubuntu-latest и windows-latest**, поэтому Windows-регрессии не доживают до релиза.
Плюс кроссплатформенные node-проверки (`npm run check:versions`, `npm run check:launchers`):
версия в `package.json` не разъехалась по баннерам лаунчеров/README/electron-моста,
а `.bat` соблюдают правила npm-флагов, delayed expansion и `%ERRORLEVEL%` вне блоков.

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

## 🧱 v1.3.13 — структурные проверки лаунчеров (разбор «что будет на Windows»)

Ревью пришло по снапшоту v1.3.12 и проверяло `.bat` глазами: пункты, которые
подтвердились, закрыты кодом, а не отпиской.

- **`::` — не комментарий, а метка.** Внутри скобочного блока cmd разбирает её как
  метку; три подряд в `start-browser.bat` давали «The system cannot find the drive
  specified», последняя строка блока — «) was unexpected at this time», метка перед
  пустой строкой — «The syntax of the command is incorrect». Все `::` внутри блоков
  заменены на `rem` (в тексте `rem` нет `%`, `!` и скобок: раскрытие `%` идёт раньше
  распознавания `rem`, а скобки внутри блока считаются структурными). `::` на верхнем
  уровне оставлен — там это безопасно и привычно.
- **Правило про `::` в блоках теперь машинное** (`findLabelCommentsInBlocks` в
  `check-launchers`): общий сканер `forEachCodeLine` считает глубину скобок, поэтому
  `echo` и комментарии не сбивают счёт, а `::` на глубине > 0 — ошибка CI.
- **Скобки в `echo` внутри блоков убраны** (`findParenthesesInEchoBlocks`): на
  актуальных Windows это работало, но на части редакций ломало разбор блока. Внутри
  блоков сообщения пишутся без круглых скобок; правило тоже в CI.
- **`npm`-вызовы через `start /wait`** больше не прячутся от правила
  `--no-audit --no-fund`; `call :метка` остаётся исключением (это наш же скрипт).
- **Electron и `--ignore-scripts`** — осознанное исключение, а не забытый фолбэк:
  бинарь Electron скачивается postinstall-скриптом, без него `npx electron` не
  заработает. Вместо бесполезного фолбэка в `start-electron.bat` теперь проверяется,
  что бинарь реально появился (`node_modules/electron/dist/electron.exe`) — при
  провале скрипт объясняет причину и уходит в Chrome-режим. Тот же текст — в
  подсказках `install.bat` и `run.sh`.
- **`smoke:server` гасит дерево процессов.** На Windows `SIGTERM`/`SIGKILL` — не
  сигналы, а терминация процесса через `TerminateProcess`: дочерние процессы `next`
  могут пережить сервер, и порт 3311 останется занят (`EADDRINUSE` на следующем
  запуске). Теперь сервер снимается через `taskkill /PID <pid> /T /F` на Windows и
  `SIGTERM` → `SIGKILL` на POSIX. В CI каждый job поднимает сервер один раз, поэтому
  там это не воспроизводилось — правка про повторные локальные запуски.
- **`echo (…)` и «старые Windows»**: Server 2016/2012R2 не запустят проект в принципе
  — Next.js 16 требует Node 20.9+, а Node поддерживает Windows Server 2016 начиная
  с 21.3.0. Для поддерживаемых версий (Windows 10+, Server 2019/2022) проблема,
  которую искал ревьюер, не воспроизводится; правило про скобки добавлено как
  страховка для редакций, которые ревьюер имел в виду.

## 🧱 v1.3.14 — дополнение к структурным проверкам

Ревью v1.3.13 подтвердило все правки и нашло одну нишу, которую та же проверка
не покрывала: `%ERRORLEVEL%` в `echo` **внутри** блока. Ловушка ровно та же, что
у `if %ERRORLEVEL% NEQ 0`, только тише: проценты раскрываются один раз при
разборе скобки, и `echo` печатает код от предыдущей команды, а не от выполненной
строкой выше. Структурный `scan` для `echo`-строк пуст (чтобы текст сообщения не
сбивал счёт скобок), поэтому правило вынесено отдельной функцией
`findErrorlevelInEchoBlocks` и подключено к общему прогону.

Заодно закрыты две «дыры на будущее»:
- **метки внутри блоков** — проверка ловила только `::`, но одиночный `:метка`
  ломает скобочный блок так же (cmd не поддерживает метки внутри `(...)`).
  Теперь внутри блока ошибкой считается любая строка, начинающаяся с `:`;
  на верхнем уровне `:: комментарии` и `:MENU` остаются нормой;
- **`start /wait "Заголовок окна" npm ci …`** — необязательный заголовок окна
  больше не прячет npm-вызов от правила `--no-audit --no-fund`.

Мутационная проверка: вставка `echo %ERRORLEVEL%` или `:retry` в реальный блок
роняет `check:launchers`, откат — снова `ok`. Тесты `launcherChecks` 10 → 11.

## 🔎 v1.3.12 — проверка чужих находок и устаревшая раскладка

Разбор прислали по снапшоту v1.3.10, поэтому три его пункта уже были закрыты в
v1.3.11 (`generateCartesia` с ретраем, отказ на `'default'`, `assertClientContext`
только по `window`). Новое по остальным пунктам:
- **Устаревшая раскладка `audioBlobs` без `audioPlacements` больше не врёт**:
  раньше в `videoEncoder.ts` старт брался как `timeline[i - 1].audioStart`, и для
  аутро (индекс за пределами таймлайна) это был старт последней панели — наложение
  вместо «после неё». Теперь `stackBlobsBackToBack` раскладывает встык по
  фактическим длительностям (новая `measureBlobDurations`), NaN/∞ не отравляют
  последующие старты. Тест — на чистой функции.
- **`check:launchers` ловит `npx npm …` и `call npm.cmd …`** — раньше префикс
  прятал вызов от правила `--no-audit --no-fund`. Тест добавлен.
- **`smoke:server` ищет бинарь next через `require.resolve`**, а не строкой
  `node_modules/next/…`: при pnpm/yarn-раскладке жёсткий путь падал бы.
- **`smoke:tts` не выдаёт догадку за факт**: если MIME не совпал с каталожным,
  для непроверенных провайдеров так и пишется — «в каталоге X, для непроверенных
  это догадка».

Проверено по коду (правок не требует):
- `proxy.ts` действительно содержит matcher
  `['/((?!_next/static|_next/image|favicon.ico).*)']` — `/__auth` и `/__logout`
  перехватываются, логин не ломается.
- Все вызовы `buildTimeline` (4 в редакторе) передают `introDuration`; старых
  пятиаргументных вызовов нет (`grep` по `src`).
- `appendPlacements` не передаёт timestamp — и не должен: в типах mediabunny
  `AudioBufferSource.add(audioBuffer)` не принимает время вовсе; timestamp нужен
  только `CanvasSource.add(timestamp, …)`, где он и передаётся.
- `Preview`: `setLoaded(map)` вызывается **один раз** после загрузки всех картинок
  (цикл копит локальную Map), а не на каждое изображение — пересоздания сцены
  на 40 страницах нет.

## 🧪 v1.3.11 — где гарантия есть, а где её даёт только живой ключ

Закрыто по замечаниям ревью к v1.3.10:
- **Cartesia — единый путь запроса** `generateCartesia()`: им пользуются и клиентская
  `generate()`, и серверная ветка `/api/tts` (раньше тела дублировались и могли
  разойтись). Из тела убрано поле `speed`, когда темп не меняли (`normal` — дефолт
  API): меньше полей — меньше шансов не совпасть со схемой версии. Плюс страховка:
  если API ответит 400 и в тексте ошибки упомянут `speed`, запрос повторяется один
  раз уже без него; прочие 400 и 5xx не повторяются (это входные данные, не схема).
  Тесты: тело, успешный путь, повтор без `speed`, отсутствие повторов.
- **`'default'` больше не считается голосом нигде**: у resemble и fish это заглушка
  из курированного списка, а не id — приняв её за выбор, мы отправили бы в API
  `voice_id='default'` и получили ошибку словами провайдера. Теперь отказ с просьбой
  указать настоящий id; серверная проверка тоже ловит `voice === 'default'`.
- **`assertClientContext` смотрит только на `window`**: `self` может появиться от
  полифилла (jsdom, `globalThis.self = globalThis`) — тогда проверка «нет window и
  нет self» молча пропустила бы серверный вызов. Тест ставит такой полифилл и
  требует отказа. Воркеров в проекте нет (`new Worker`/`worker_threads` не
  используются).

Граница честности: сборка, типы, тесты, лаунчеры, старт прод-сборки и отсутствие
рекурсии «сервер → /api/tts» проверяются машинно (`npm run verify`, CI на
ubuntu/windows, `npm run smoke:server`). А формат запросов к внешним API и валидность
дефолтных голосов **кодом не доказываются** — только живым вызовом:

```bash
PROVIDER_KEYS='{"cartesia":"...","deepgram":"..."}' npm run smoke:tts
npm run smoke:tts -- cartesia     # точечно по провайдеру
```

`smoke:tts` печатает OK/FAIL/skip с байтами, MIME и временем и прямо подсказывает,
у кого можно снять `experimental`. Флаг снимается только после OK — «написано по
документации» остаётся непроверенным, пока не подтверждено живым ключом.

## 🔬 v1.3.10 — правки протоколов и аудит «на 100%»

### Исправлено по коду
- **Deepgram получал MIME от Cartesia**: в ветке `/api/tts` ответ помечался
  `resolveAudioMime('cartesia', buf)`. Теперь MIME определяется по фактической
  сигнатуре аудио и по id самого провайдера (`resolveAudioMime(providerId, buf)`) —
  эвристика одинаковая, но больше не привязана к чужому имени.
- **Пустой голос больше не блокирует дефолт провайдера**: `voice || ''` в
  серверной ветке и в клиентском `router.ts` заменён на `voice || undefined`.
  Раньше `voice = '...'` в сигнатуре `generate()` не срабатывал, и в API мог
  уйти пустой id (а `TTSOptions.voice` был обязательным — теперь нет).
- **Cartesia приведена к своей версии API (2024-06-10)**: `output_format` для mp3 —
  `{ container: 'mp3', sample_rate: 44100, bit_rate: 128000 }` (поле `encoding`
  принимает только PCM: `pcm_f32le/pcm_s16le/pcm_mulaw/pcm_alaw`), а top-level
  `speed` — строка `slow|normal|fast`, не число; ползунок темпа переводится в
  ступень. Тело собирает общий `buildCartesiaBody`, которым пользуются и клиент,
  и серверная ветка (до этого тела дублировались и расходились).
- **`assertClientContext` больше не смотрит на `NEXT_RUNTIME`**: признак сервера
  структурный — нет ни `window` (браузер), ни `self` (воркер). Инлайн
  `process.env` сборщиком больше не может дать ложное «на сервере…» на обычной
  кнопке в браузере.
- **Экспериментальные провайдеры (playht, resemble, murf, fish, hume, speechify)
  не получают голос автоматически**: `resolveVoice` требует явный выбор из
  диалога «Голоса» и не подставляет `FALLBACK_VOICE`; серверная ветка отвечает
  `400 voice_required`, если голос не передан. Раньше в API мог уйти `matthew`
  (speechify) — и ошибка выглядела как проблема провайдера, а не наша.
  Явный `default` у resemble при этом считается выбором: это его настоящий id.
- **`check:launchers` проверяет и `.sh`**: правило `--no-audit --no-fund`
  распространено на shell-лаунчеры (5 `.bat` + 4 `.sh`) — флаги не разъедутся
  между ОС.

### Проверено по коду, правок не потребовало
- `VISION_JSON_SCHEMA` (`extractPanels.ts`) и `SEO_JSON_SCHEMA` (`generateSEO.ts`) —
  обычные JSON Schema (`type/properties/required`), Zod в проекте не используется.
- `durationCache` — `WeakMap<Blob, number>`: длительность декодированного Blob
  детерминирована, повторный экспорт того же Blob получает то же значение, а
  записи уходят вместе с Blob. Кэш декодированных буферов ограничен бюджетом.
- `/api/whisper`: кнопки «субтитры из аудио» в UI нет — SRT собирается из
  таймлайна (`generateSRT`) и выгружается клиентом. Роут остаётся опциональным
  серверным путём (вызов вручную, с ключом OpenAI или `nodejs-whisper`) и при
  отсутствии зависимости отвечает мягко (`method: 'unavailable'`), а не падает.

### Smoke вместо ручного curl
- **`npm run smoke:server`** поднимает прод-сборку (`next start` на порту 3311) и
  проверяет живые маршруты: `/`, `/settings`, `/editor/[id]` → 200, а
  `POST /api/tts` с пустым телом → 400 (роут жив и валидирует вход, а не падает
  500). Шаг выполняется в CI после сборки — на обеих ОС.
- После проверки скрипт снимает сервер вместе с потомками (`taskkill /T /F` на
  Windows, `SIGTERM` → `SIGKILL` на POSIX) и **проверяет, что порт 3311 реально
  освободился**: именно ради этого нужен `taskkill /T /F`, иначе повторный
  локальный запуск падал бы с `EADDRINUSE`.
- Граница честная: smoke проверяет, что сервер стартует и отвечает, но не
  заменяет браузерный e2e — экспорт через WebCodecs/MediaRecorder и OPFS
  проверяются только настоящим Chromium (Playwright), это отдельная задача.

### Тесты
`npm test` (`tsx --test`) — 93 теста в 11 файлах: WAV-обёртка, определение MIME,
раскладка и подпись аудио, лента (включая прогон по сетке раскладок), политика
проксирования TTS и голосов, тело Cartesia, часы рендера, планировщик Web Audio,
`check-launchers` (структура `.bat`/`.sh`) и `.sh`-лаунчеры.

Полный прогон — `npm run verify`; то же самое CI делает на ubuntu и windows.
Для локальной итерации «правлю — смотрю» есть `npm run verify:quick`:
`check:versions → check:launchers → typecheck → lint → build → smoke:server`,
без `npm test`. Тесты при этом не выброшены — они остаются в `verify` и в CI.

## 🧭 v1.3.9 — единый источник версии и тестируемые проверки

- **Версия снова разъехалась — теперь это ловится автоматически**: `install.sh`
  и `run.sh` печатали `v1.3.6`, `electron/preload.js` — `1.3.1`, при том что в
  `package.json` уже стояло 1.3.8. Добавлен `scripts/check-version.mjs`
  (единый источник — `package.json`): проверяет баннеры лаунчеров, заголовок
  README, lock-файл и electron-мост. Входит в `npm run verify` и в CI.
- **Проверка `.bat` переехала с pwsh на Node** (`scripts/check-launchers.mjs`):
  её можно прогнать локально на любой ОС, и она покрыта тестами
  (`tests/launcherChecks.test.ts`). Заодно закрыт пропуск, о котором писал ревьюер:
  `%ERRORLEVEL%` внутри блока теперь находится по глубине скобок, а не по отступу —
  сработает и на строке без пробелов в начале (и не сработает на `echo (текст)`
  или комментарии).
- **`* text=auto`** в `.gitattributes`: обычные текстовые файлы нормализуются к LF
  в репозитории независимо от `core.autocrlf` разработчика — пропадает класс
  «изменён весь файл» при смешанных настройках.
- **Зум ленты клампится**: `stripViewport` из старого проекта/IDB мог быть любым
  (ползунок зажимал только отображение) — теперь `computeStripLayout` и
  `resolveStripViewport` приводят его к диапазону 50–170 % (`STRIP_ZOOM_MIN/MAX`,
  общие с UI). Тест: битые значения не меняют раскладку.
- **Тест `supportsSpeed` больше не хрупкий**: проверяет тело запроса по URL и не
  привязан к форме ответа провайдера — смена формата ответа его не уронит.
- **Подсказки про optional-пакеты** (`@aws-sdk/client-polly`, `nodejs-whisper`)
  в `install.sh`/`install.bat` получили `--no-audit --no-fund` и упоминание
  `--ignore-scripts` для защищённых сетей — скопированная команда больше не падает
  по TLS на postinstall.

## 🪟 v1.3.8 — первый запуск на Windows и мёртвые параметры

- **Настоящий блокер первого запуска**: в `start-browser.bat` и `start-electron.bat`
  проверка `%ERRORLEVEL%` стояла внутри блока `if (...)` — cmd.exe раскрывает
  «проценты» один раз при разборе всей скобки, то есть ДО выполнения `npm ci`.
  На первом запуске (порта 3000 ещё нет) проверка видела код от `findstr` и
  **всегда** сообщала «Установка не удалась» сразу после успешной установки.
  Теперь `!ERRORLEVEL!` + `setlocal enabledelayedexpansion`, а CI проверяет это
  правило по всем `.bat` (плюс запрет `%ERRORLEVEL%` на строках внутри блоков).
- **`.gitattributes`**: `*.bat text eol=crlf` — Windows-пользователь получает
  CRLF-файлы независимо от `core.autocrlf`; `*.sh` наоборот зафиксированы как LF.
- **README больше не спорит с лаунчерами**: ручная установка описана теми же
  флагами (`npm ci --legacy-peer-deps --no-audit --no-fund`), а `--ignore-scripts`
  честно назван фолбэком при TLS-ошибке postinstall, а не первым шагом.
- **CI требует оба флага**: `--no-audit` и `--no-fund` (раньше — только первый).
- **`noUnusedParameters` включён** вслед за `noUnusedLocals` и нашёл 10 забытых
  параметров: мёртвые пропсы `onSeek` (Preview) и `panels` (Timeline),
  неиспользуемый `outroDuration` в `buildTimeline`, `time` в статичных кадрах
  интро/аутро и `drawImageCover`, параметр-заглушка у fallback-интро.
- **Темп речи**: `gemini` и `speechify` не принимают `speed` — вместо молчаливого
  игнорирования у провайдера есть флаг `supportsSpeed: false`, UI помечает поле
  «Скорость · не поддерживается», а тест проверяет, что `speed` реально не уходит
  в запрос (и что у `openai`, наоборот, уходит).
- **Страховка остановки записи** взводится после фактического `recorder.start()`,
  а не сразу после `waitForStart`: при медленном `prime()` таймер мог сработать
  до старта записи — и запись оставалась без остановки.
- **Лента**: переход между двумя короткими страницами больше не затирается
  ключом удержания следующей страницы (обе стояли в одной точке окна, сдвиг
  4–8 px читался как рывок). Добавлены два теста: именованный сценарий и
  инвариант «сдвиг < 8 px возможен только у границы прокрутки» по сетке раскладок.

## 🪟 v1.3.7 — Windows-совместимость и запрет мёртвого кода

- **CI на двух ОС**: матрица `ubuntu-latest` + `windows-latest`; на Windows дополнительно
  проверяется, что все `npm ci/install` в `.bat`-лаунчерах содержат `--no-audit --no-fund`
  (проверка уже нашла одно расхождение в `start-electron.bat`).
- **`.bat` синхронизированы с `.sh`**: `--no-audit --no-fund` везде, фолбэк
  `--ignore-scripts` при провале установки из-за TLS на postinstall Electron, актуальные
  версии в заголовках (были v1.3.1).
- **README**: отдельный раздел «Windows» (лаунчеры + команды для cmd/PowerShell)
  и три варианта задания `PROVIDER_KEYS` для `smoke:tts`.
- **`smoke:tts`**: внятные сообщения при пустом `PROVIDER_KEYS` и при невалидном JSON,
  с примерами для bash/PowerShell/cmd.
- **`noUnusedLocals` включён в `tsconfig.json`** — это корневая причина класса проблем
  «мёртвый импорт в тесте». Правило сразу нашло 12 мест с неиспользуемым кодом,
  все вычищены: `execAsync` в whisper-роуте, `z` в `extractPanels`, `mimeType` в
  `generateAudio`, неиспользуемые импорты в `db.ts`/`local.ts`/`migrate.ts`,
  целиком мёртвые функции `tryRemoveDir` и `ensureDir` в `info.ts`, недостижимая
  ветка `shouldCopy` в миграции OPFS и остатки regex-теста в `renderClock.test.ts`.
  Теперь такое ловится на этапе `npm run typecheck` — на любой ОС.

## 🔬 v1.3.6 — пятый раунд: честность вместо обещаний

### Что починено в коде

- **Планировщик аудио (`createPlacementScheduler`)**: появился `prime(seconds)`, который
  дожидается декодирования, и флаг `disposed`. Раньше `tick()` запускал декод «в отрыве»
  (`void …then()`), поэтому к моменту `recorder.start()` первый фрагмент мог быть ещё не
  в графе: Web Audio доигрывал его с глитчем и срезанным началом. Поздний декод после
  `dispose()` больше не создаёт «потерянный» источник, который никто не остановит
  (это была утечка + звук после конца записи).
- **Старт записи по часам, а не по `setTimeout`**: `waitForStart()` сверяет
  `audioContext.currentTime` каждый кадр (порог 5 мс) — `setTimeout(250)` в браузере
  промахивается на 5–10 мс и уводил картинку от звука.
- **`detectAudioMime`**: ADTS AAC проверяется до общего MPEG frame sync. Раньше
  синхро-слово `0xFFF` матчилось широким условием mp3, и ветка ADTS была недостижима —
  сырой AAC подписывался как `audio/mpeg`. Теперь есть тип `audio/aac` и тесты на оба вида.
- **«↻ Переозвучить» больше не врёт**: добавлен `forceRegenerate` — при явной переозвучке
  не используются ни OPFS-файл, ни общий TTS-кэш. Раньше при неизменном тексте и голосе
  кнопка возвращала тот же самый файл из кэша по ключу «текст+голос+провайдер».
- **`response_format` кэш стал LRU** (обращение освежает запись, деградация — с TTL).
- **Лента**: если две короткие страницы дают совпадающую позицию окна, вход следующей
  смещается — переход становится заметным (раньше пролистывание не читалось).
- **UX панели ленты**: вместо «Зона просмотра · 1.00×» — «Масштаб страницы · 100 %»
  (100 % = ширина страницы равна ширине кадра) и схема кадра со страницами рядом,
  чтобы настройку не подбирать вслепую.

### Тесты: поведение вместо поиска подстрок

Из тестов убраны проверки «в файле есть такая строка» — такие тесты ломаются от
переименования переменной и молчат при реальной гонке. Вместо них:

- `tests/pipelineScheduler.test.ts` — планировщик запускается на фейковом Web Audio:
  проверяются `prime()`, `tick()`, `dispose()` и гонка «декод завершился после dispose».
  Тест проверен на живучесть: с отключённым `disposed`-guard он падает.
- `tests/ttsProviderPolicy.test.ts` — вместо регулярки по исходникам подменяет `fetch`
  на «отравленный» и вызывает серверный путь каждого провайдера: любой поход в `/api/tts`
  ловится как рекурсия. Проверено отключением флага `proxyClientSide` у polly — тест падает.
- `tests/renderClock.test.ts` — `waitForStart()` проверяется с фейковыми часами и rAF.
- `tests/fixtures/stripScenarios.ts` — табличные сценарии ленты: новый кейс = объект
  в массиве, а не копипаста теста.

### Честность по провайдерам и по фолбэку

- **Шесть провайдеров помечены `experimental`** (`playht`, `resemble`, `murf`, `fish`,
  `hume`, `speechify`): их эндпоинты написаны по документации и вживую не проверялись.
  В модалке голосов они подписаны «не проверен» и показывают предупреждение.
- **`npm run smoke:tts`** — скрипт ручной проверки на реальных ключах.
  Синтаксис задания ключа зависит от оболочки:

  ```bash
  # bash / zsh, в т.ч. Git Bash на Windows
  PROVIDER_KEYS='{"openai":"sk-…"}' npm run smoke:tts
  ```
  ```powershell
  # PowerShell (Windows)
  $env:PROVIDER_KEYS = '{"openai":"sk-…"}'
  npm run smoke:tts
  ```
  ```cmd
  :: cmd.exe (Windows)
  set PROVIDER_KEYS={"openai":"sk-…"}
  npm run smoke:tts
  ```
  ```bash
  # одинаково во всех оболочках — файл с ключами
  npm run smoke:tts -- --keys-file .keys.json
  ```

  Если `PROVIDER_KEYS` пуст или не является корректным JSON, скрипт скажет об этом
  явно (раньше все провайдеры молча уходили в `skip`, что читалось как «ничего не работает»).
  Печатает OK/FAIL/skip,
  байты, определённый MIME, время отклика; exit code 1 при провале. Требует доступа
  в сеть к хостам провайдеров. Результат стоит вписать сюда, снимая бейдж.
  Статус на момент релиза: **провайдеры не проверялись вживую, ключей нет**.
- **WEBM-фолбэк не пишет fps в метаданные**: `canvas.captureStream(fps)` — это подсказка
  браузеру, а не метаданные контейнера, поэтому в `ffprobe` у WEBM-файла частота кадров
  может отображаться как `N/A` (само видео при этом играется корректно). MP4-путь
  (WebCodecs/mediabunny) пишет fps явно.
- **Кэши длительностей/буферов (`durationCache`, `bufferCache`) ключуются по `Blob`** —
  они живут в пределах одной сессии экспорта (внутри неё аудио читается один раз).
  При повторном открытии проекта OPFS отдаёт новые `Blob`, поэтому длительности
  пересчитываются декодированием; устойчивый кэш требует ключа «panelId + подпись»
  и пока не сделан.

## 🔧 v1.3.5 — четвёртый раунд (блокеры приёмки v1.3.4)

- **Canvas-фолбэк снова со звуком**: `scheduler.tick()` действительно вызывается —
  перед стартом записи и на каждом кадре `animate()`. В v1.3.4 планировщик
  создавался, но не опрашивался, поэтому дорожка в WEBM была пустой (регрессия).
- **A/V-синхронизация**: время кадра больше не корректируется на `leadIn` ни в одном
  месте — поправка осталась только внутри `audioStartedAt`, а запись стартует
  ровно в момент старта звука (`setTimeout` по `startDelayMs`).
  Формулы вынесены в `pipeline/renderClock.ts` и покрыты тестами — раньше они жили
  внутри функции с canvas и не проверялись; есть отдельный тест-страж, запрещающий
  вернуть `mediaClock(...) - leadIn` и потерять `tick()`.
- **Лента**: на стыке двух длинных страниц переход больше не теряет `easeInOut`
  (ключ следующей страницы с тем же временем не затирает easing); длинная страница
  читается с верха, переход ведёт в её верх, а не в центр.
- **Двойное декодирование аудио убрано** там, где хватает памяти: декодированные
  буферы остаются в LRU-кэше с бюджетом 96 МБ PCM, поэтому второй проход
  (выгрузка в muxer/планировщик) обходится без повторного `decodeAudioData`.
  Если ролик длиннее бюджета — деградация до двух проходов, но память ограничена.
- **`response_format`**: деградировавший режим (`json_object`/без схемы) кэшируется
  с TTL 10 минут и потолком в 200 записей — разовый сбой провайдера больше не
  лишает строгой схемы до перезагрузки вкладки.
- **Структурный guard от рекурсии** дополнен рантайм-проверкой: `generateTTS()`
  (клиентский путь) на сервере падает сразу с внятной ошибкой, а не уходит
  в `/api/tts` рекурсией. Проверено тестом, который выполняется в Node.
- **Мелочи**: убран мёртвый тернарник в `VoicesModal.handleProviderChange`
  (`nextProvider === selectedProvider` не мог быть `true`), поле скорости стало
  управляемым (`value`, а не `defaultValue`) и обновляется при повторном открытии.

### ⚠️ О стоимости после обновления

С v1.3.3 аудио без подписи (`.sig`) не переиспользуется вслепую: сначала идёт
проверка общего TTS-кэша по «текст + голос + провайдер + модель + язык».
Если проект озвучивался версией, которая подставляла хардкод-голос (`Puck`),
а теперь `resolveVoice()` берёт первый голос из `getVoices()` провайдера, ключ
кэша не совпадёт — **возможна разовая повторная генерация (и списание) после
обновления**. Это осознанный компромисс: иначе правки текста не применялись бы.
Аудио, озвученное начиная с v1.3.3 (с подписью), переиспользуется без затрат.

## 🧹 v1.3.4 — третий раунд правок (по критике v1.3.3)

**Исправления после ревью v1.3.3** (третий раунд):

- **A/V в canvas-фолбэке**: убран двойной учёт `leadIn` (первые 0.25 с видео оставались
  пустыми, пока играл звук). Запись теперь стартует синхронно со стартом аудио, кадр 0
  отрисовывается до `recorder.start()`.
- **Лента**: `minSlotHeight` больше не масштабируется дважды (при `viewport < кадра`
  минимум раздувался в `scale²`); последняя длинная страница не откатывает окно наверх
  в конце озвучки.
- **Мягкая миграция аудио**: отсутствие снимка текстов теперь означает «неизвестно» →
  файл без `.sig` не переиспользуется молча; запрос уходит в TaskQueue, где сначала
  проверяется общий TTS-кэш (при неизменной реплике генерация не оплачивается).
- **Антирекурсивный guard стал структурным**: общая политика `mustUseProxy` (cors.ts)
  используется и клиентом, и сервером; у провайдеров появился `serverGenerate` /
  `proxyClientSide`, а `/api/tts` отдаёт 501 вместо самовызова при неправильной
  конфигурации. Тест сканирует исходники и не даёт добавить `fetch('/api/tts')`
  в провайдер без флага.
- **Память при экспорте**: длительности фрагментов измеряются отдельным проходом
  (пик — один декодированный буфер, кэш `WeakMap`), canvas-фолбэк использует планировщик
  с опережением (в графе живут только ближайшие ~4 с, буфер отпускается по `onended`).
  Честно: `mixAudioPlacements` по-прежнему собирает единый буфер — он оставлен только для
  случаев, где такой буфер действительно нужен (например MP3-экспорт).
- **Обрезка аудио видна пользователю**: предупреждения об обрезанных репликах и сдвигах
  показываются плашкой в редакторе (с указанием панели и секунд), а не только в консоли.
- **`response_format`**: рабочий режим кэшируется по «провайдер + модель», а не по
  провайдеру — иначе вторая модель всегда платила бы за лишние попытки.
- **Сборка ленты вынесена в один хелпер** `createStripSceneFromMedia` — превью и оба
  бэкенда используют один код; в бэкенды прокидываются `panels` (fallback, если в
  таймлайне нет `imageIndex`).
- **Мелочи**: `mimeTypeForProvider` использует явный `providerMimeType`, `verify`
  включает `build`, `package-lock.json` синхронизирован с версией, добавлен CI
  (`.github/workflows/ci.yml`), удалены мёртвые `src/components/editor/*` (52 КБ).


- **Память при экспорте**: больше нет «гигантского» микса всего аудио в один `AudioBuffer`
  (10 минут стерео 44.1 кГц ≈ 212 МБ). MP4-бэкенд отдаёт фрагменты последовательно
  (`appendPlacements`, паузы — тишиной), canvas-фолбэк планирует их прямо в Web Audio
  (`schedulePlacements`). Декодирование и ресемплинг — по одному фрагменту.
- **Наложения аудио**: короткое перекрытие решается обрезкой хвоста предыдущего фрагмента,
  а не сдвигом следующего — ролик больше не «уезжает» вправо, звук не обгоняет видео.
  О вынужденных сдвигах сообщается в консоль.
- **A/V-синхронизация canvas-фолбэка**: кадры ведутся по часам `AudioContext`, а не
  `performance.now()`, поэтому картинка следует за звуком (раньше к концу ролика расхождение
  доходило до секунд).
- **Ретрай `response_format`**: если OpenAI-совместимый провайдер отвечает 400 на
  `json_schema`, запрос автоматически повторяется с `json_object`, затем без него; рабочий
  режим запоминается на сессию. Релиз больше не «ломает» не-OpenAI провайдеров.
- **Кэш `resolveVoice`**: голос резолвится один раз на прогон, а не N раз для N панелей
  (у части API `getVoices` — платный вызов).
- **Мягкая миграция аудио**: у проектов, созданных до v1.3.2, нет `.sig`-подписи. Теперь
  сравнивается снимок текстов панелей (`project.audioTexts`), так что существующая озвучка
  переиспользуется, если реплики не правились.
- **MIME по сигнатуре**: `resolveAudioMime` определяет контейнер по magic bytes
  (RIFF/OggS/fLaC/ID3/frame-sync/ftyp/EBML) во всех ветках клиента и сервера.
- **Прогресс точечной переозвучки**: полоса считается от числа переозвучиваемых панелей
  (`audioTotal`), а не от всех панелей проекта.
- **Мелочи по ревью**: дефолт `Secure` для auth-cookie — выключен (`MVS_SECURE_COOKIE=1`
  для TLS), модели TTS берутся из каталога провайдеров (`defaultModel`) вместо второй карты
  хардкодов, `handleSaveRef` объявлен до эффекта хоткеев, убраны лишние `as any`,
  Cartesia умеет `ru`.
- **Тесты**: `npm test` (`tsx --test`) — WAV-обёртка, определение MIME, раскладка аудио
  (`packStarts`), подпись аудио, лента и политика проксирования TTS; `npm run verify`
  теперь включает тесты **и** сборку. `tsx` — единственная dev-зависимость ради тестов:
  в проекте Node >= 20.9, а тесты импортируют TS без расширений и через `@/`-алиасы,
  что нативный `--experimental-strip-types` не умеет. Бинарь esbuild остаётся
  dev-only и в прод-сборку не попадает.

## 📜 Режим ленты (manga strip / webtoon scroll)

Кроме постраничного показа, у проекта есть режим «Лента»: страницы склеиваются в одну
вертикальную полосу, а окно просмотра плавно едет по ней синхронно с озвучкой.

- **Настройка** — панель «Режим рендера» под превью: `Панели` / `Лента`, «зона просмотра»
  (сколько пикселей ленты попадает в кадр) и отступ между страницами. Хранится в
  `project.settings` (`renderMode`, `stripViewport`, `stripGap`), поэтому попадает в автосейв.
- **Логика прокрутки** (`lib/pipeline/mangaStrip.ts`): пока звучит страница — окно стоит,
  а переход к следующей приходится на последние ~0.8 с её интервала (иначе не успеть прочитать).
  Страница, которая выше кадра, медленно проезжается сверху вниз — как в вебтуне,
  и остаётся у низа в конце (в т.ч. на последней странице).
- **Память**: лента живёт в виртуальных координатах и НИКОГДА не композитится целиком,
  поэтому лимит canvas в 32767 px по высоте не мешает даже 40-страничным главам —
  рисуются только страницы, пересекающиеся с окном.
- **Ken Burns**: в ленте только лёгкий зум (1.0 → 1.03 на весь ролик), сильный зум мешает
  чтению; подсветка активной панели по умолчанию выключена.
- **Единство превью и экспорта**: и редактор, и оба бэкенда (`WebCodecs`/mediabunny и
  `Canvas`/MediaRecorder) используют одну и ту же сцену `createStripScene`, так что картинка
  в превью совпадает с итоговым файлом.
- **Индикатор прогресса** в ленте — вертикальный скроллбар справа; он рисуется только в
  превью и не впечатывается в видео.

## 📝 Сценарий (текстовый формат озвучки)

Вместо анализа изображений vision-LLM сценарий можно задать текстом в редакторе —
кнопка «Сценарий» в шапке. Формат:

```
Изображение 1

Персонаж 1 (Жен.): текст реплики

Изображение 2

Персонаж 2 (Муж.): текст реплики

Изображение 3

Персонаж 1 (Жен.): текст реплики
```

Правила формата:

1. Сначала загружается изображение, затем озвучивается диалог (каждая реплика —
   сегмент таймлайна на своём изображении).
2. Каждая реплика переводится на язык озвучки проекта (один батч-вызов к
   модели, `lib/pipeline/translateScenario.ts`). Если провайдер/ключ
   недоступны, сценарий применяется без перевода, а причина показывается
   баннером в редакторе (без блокирующих диалогов — они могут быть
   запрещены во встроенном превью).
3. После завершения чтения реплики — переход к следующему изображению через
   паузу (`project.settings.panelGap`): сценарий ставит 0,6 с
   (`SCENARIO_GAP_SECONDS`), пауза меняется ползунком в таймлайне
   (0–1,5 с), обычные проекты по умолчанию используют 0,3 с.
4. Пол персонажа указывается в скобках: `(Жен.)` или `(Муж.)`. Он сохраняется
   на персонаже (`Character.gender`), показывается бейджем в «Голоса» и
   используется для автоподбора голоса: у персонажа без назначенного голоса
   берётся первый голос провайдера нужного пола.
5. Никакого лишнего текста — только «Изображение N» и реплики: парсер
   (`lib/pipeline/scenario.ts`) отклоняет любую строку, которая не является
   меткой изображения или репликой «Имя (Пол): текст», а при применении
   интро/аутро проекта очищаются.

Модалка «Сценарий» открывается с текстом текущего проекта (сериализация
`serializeScenario` из панелей и полов персонажей), модель перевода выбирается
внутри модалки (`settings.chatModel`), а если панели уже есть — применение
требует подтверждения чекбоксом (панели и их озвучка заменяются целиком).

Поведение при применении: реплики становятся панелями (одна реплика — одна
панель на всё изображение, помеченная `fullFrame`), «Изображение N» привязывает
реплику к N-му изображению (несуществующее изображение — клампится в последнее
с предупреждением), старое аудио панелей удаляется (OPFS), таймлайн и SRT
перестраиваются. Если изображений в проекте нет — применение блокируется
баннером (индекс изображения некуда класть, превью упадёт на `images[-1]`).
Тесты — `tests/scenario.test.ts`.

Рендер fullFrame-панелей: Preview и экспорт (WEBM- и MP4-пути) рисуют
изображение целиком — fit-contain с letterbox-подложкой, без зума/панорамы
(Ken Burns) и без bbox-обводки; реплика показывается плашкой как в обычном
режиме. Камера в обычном (manga) режиме идёт не по отдельной панели, а по
группе соседних панелей одного изображения (`sameImageSpan`), поэтому зум
не «скачет» на каждой панели той же страницы.

SRT собирается в единой точке — `rebuildSrt` (`lib/pipeline/buildTimeline.ts`):
реальными длительностями там, где озвучка готова, оценкой по символам — нет;
интро — сегментом `0 → introDuration`, аутро — после последней панели.
Пересобирается при смене паузы, интро/аутро, применении сценария и после
озвучки. Пока хотя бы одна панель не озвучена, SRT помечается «черновик»
(серая пометка в «Экспорте»); на экспорт это не влияет — файл всегда
собирается из актуального таймлайна. Формат SRT — стандартный.

## 🛣️ Roadmap

- [x] v1.1: OPFS + TTS-cache + TaskQueue + Zod + WEBM + demo
- [x] v1.2: WebCodecs + mediabunny proper MP4 + hygiene fixes
- [x] v1.3: Студия без хлама (graphite+amber, single column, context panel, modals)
- [x] v1.3.1: 40+ провайдеров, links.ts, тест ключей, строки вместо карточек
- [ ] v1.4: Zustand editor + undo/redo + .mvproj
- [x] v1.3.3: режим ленты (manga strip / webtoon scroll)
- [x] v1.3.15: сценарий — текстовый формат озвучки в редакторе (Изображение N + Персонаж (Жен./Муж.): реплика)
- [ ] v1.5: Фоновая музыка + batch queue persist
- [ ] v1.6: Docker self-hosted

---
**v1.3.1 готов** — `npm run dev` → `/settings` добавь OpenRouter + Gemini + Azure → загрузи мангу → озвучь (OPFS кэш) → экспорт MP4.
