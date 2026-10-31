# Manga Voice Studio — полное описание проекта от начала до конца

> Документ описывает **фактическое состояние кода** в ветке `arena/9a70dac5-make`
> (база — `main`, коммит `b7fbd57`, версия в `package.json` — **1.3.17**).
> Всё, что ниже, сверено с исходниками, а не пересказано по README: где README и
> код расходятся, это отмечено отдельно.

---

## Содержание

1. [Что это такое](#1-что-это-такое)
2. [Ключевые факты](#2-ключевые-факты)
3. [Какую задачу решает проект](#3-какую-задачу-решает-проект)
4. [Пользовательский путь: от установки до готового MP4](#4-пользовательский-путь-от-установки-до-готового-mp4)
5. [Архитектура](#5-архитектура)
6. [Структура репозитория](#6-структура-репозитория)
7. [Модель данных](#7-модель-данных)
8. [Хранение данных и целостность](#8-хранение-данных-и-целостность)
9. [Пайплайн обработки — по этапам](#9-пайплайн-обработки--по-этапам)
10. [Провайдеры LLM и TTS](#10-провайдеры-llm-и-tts)
11. [Серверные маршруты (API)](#11-серверные-маршруты-api)
12. [Интерфейс](#12-интерфейс)
13. [Аутентификация и безопасность](#13-аутентификация-и-безопасность)
14. [Облако: Supabase + Vercel](#14-облако-supabase--vercel)
15. [Десктопный режим (Electron)](#15-десктопный-режим-electron)
16. [Установка и лаунчеры](#16-установка-и-лаунчеры)
17. [Тесты, проверки, CI](#17-тесты-проверки-ci)
18. [Производительность и инженерные решения](#18-производительность-и-инженерные-решения)
19. [Известные ограничения](#19-известные-ограничения)
20. [Roadmap](#20-roadmap)
21. [Чек-лист запуска](#21-чек-лист-запуска)
22. [Заметки разработчику](#22-заметки-разработчику)
23. [Итоговая оценка](#23-итоговая-оценка)

---

## 1. Что это такое

**Manga Voice Studio** — self-hosted веб-приложение, которое превращает страницы
манги / комикса / webtoon в **озвученное видео 1920×1080** с интро, аутро,
субтитрами SRT и SEO-пакетом для YouTube.

Ключевая идея — **BYOK (Bring Your Own Key)**: приложение не продаёт подписку и
не хранит ключи на сервере. Пользователь вставляет свои ключи LLM и TTS
провайдеров, они лежат в `localStorage` браузера, а запросы идут либо напрямую
из браузера (если провайдер разрешает CORS), либо через собственный прокси
`/api/tts` (если провайдер CORS блокирует).

Приложение работает в четырёх режимах:

| Режим | Что это | Как запускается |
|---|---|---|
| Веб (dev) | `next dev` на `http://localhost:3000` | `npm run dev` |
| Веб (prod) | `next build` + `next start` | `npm run build && npm run start` |
| Vercel | Serverless-деплой + Supabase для TTL-снапшотов | push в GitHub → Vercel |
| Desktop | Electron-окно, внутри которого поднимается Next-сервер | `npm run desktop` / `.bat`/`.sh` лаунчеры |

Вся тяжёлая работа (декодирование изображений, TTS-кэш, WebAudio-микширование,
рендер кадров, кодирование видео) выполняется **в браузере**. Сервер нужен только
для: раздачи приложения, проксирования CORS-заблокированных TTS-провайдеров,
опционального Whisper и временных облачных снапшотов проекта.

---

## 2. Ключевые факты

| Параметр | Значение |
|---|---|
| Название пакета | `manga-voice-studio` |
| Версия | `1.3.17` (RC; в комментариях кода местами уже `v1.3.18`) |
| Назначение | генерация озвученных видео из манги, self-hosted, BYOK |
| Язык интерфейса | русский (`<html lang="ru">`) |
| Node.js | `>= 20.9.0` (рекомендуется 22.17+ / 24 для E2E) |
| Фреймворк | Next.js `16.3.7`, App Router, `proxy.ts` вместо `middleware.ts` |
| React | `19.2.8` |
| Стили | Tailwind CSS 4 (`@tailwindcss/postcss`), ручная палитра graphite + amber |
| Состояние | локальное React-состояние + `ProjectClock` + `HistoryManager`; `zustand` есть в зависимостях, но в `src/` не импортируется ни разу |
| Хранилище | IndexedDB (`idb`) + OPFS + `localStorage` |
| Валидация | Zod 4 |
| Видео | WebCodecs + `mediabunny` (MP4/H.264/AAC), fallback Canvas + `MediaRecorder` (WebM/VP8-VP9/Opus) |
| Иконки | `lucide-react` |
| Desktop | Electron 33 + `electron-builder` |
| E2E | `playwright-core` + `@sparticuz/chromium` |
| Объём кода | `src/` ≈ **31 150 строк** |
| Тесты | **43 файла**, **421** тест-кейс (`tsx --test`; число кейсов — снимок, см. `L-17`) |
| CI | GitHub Actions, матрица `ubuntu-latest` + `windows-latest` |
| Лицензия | MIT (`LICENSE`), поле `license` в `package.json` |

### Крупнейшие файлы (и это важная характеристика проекта)

| Файл | Строк | Что внутри |
|---|---:|---|
| `src/components/studio/Timeline.tsx` | 1 450 | таймлайн, drag-and-drop, trim-ручки, зум, скролл |
| `src/components/studio/Preview.tsx` | 1 111 | Canvas-превью, камера, лента, подсветка |
| `src/lib/pipeline/mangaStrip.ts` | 1 041 | геометрия и прокрутка ленты |
| `src/lib/pipeline/audioImport.ts` | 950 | импорт аудио v2 |
| `src/lib/pipeline/audioMix.ts` | 924 | раскладка и микширование аудио |
| `src/lib/pipeline/audioPlayer.ts` | 823 | единый плеер |
| `src/lib/pipeline/assembleVideo.ts` | 702 | сборка кадров/видео |
| `src/components/onboarding/OnboardingWizard.tsx` | 670 | мастер первого запуска |
| `src/lib/storage/db.ts` | 599 | схема и IndexedDB-слой |

Это осознанно «толстые» модули: их логика вынесена в чистые функции там, где её
можно протестировать без браузера. Единственный бывший монолит — редактор —
разобран на слои (см. 12.5): `page.tsx` занимает 16 строк и только собирает
хуки и представление.

---

## 3. Какую задачу решает проект

Классический пайплайн «манга → видео» состоит из шести ручных шагов:

1. разобрать страницы на панели и выписать реплики;
2. распределить реплики по персонажам и голосам;
3. озвучить каждую реплику;
4. синхронизировать звук и картинку;
5. сделать интро/аутро, субтитры, описание и теги;
6. отрендерить видео.

Manga Voice Studio автоматизирует все шесть, но оставляет человеку контроль:

- **Vision-LLM** размечает панели (bbox), персонажей, эмоции и реплики.
- **Альтернатива Vision** — текстовый сценарий, где автор сам пишет
  «Изображение N [X..Y%]» и реплики; это дешевле и предсказуемее.
- **TTS-провайдер** синтезирует по реплике на панель, с кэшем по хешу текста.
- **Единый таймлайн** строит `SyncTimeline` (panelId, imageIndex, audioStart/End,
  bbox, voiceId, text), из него же генерируется SRT.
- **NLE-операции** (trim, split, mute/solo, gain/fade, ripple edit, undo/redo)
  дают привычное поведение видеоредактора.
- **Экспорт** даёт MP4/WebM, WAV/MP3, SRT и SEO-текст; плюс ZIP-архив проекта.

Приложение принципиально **не хранит медиа на сервере**: изображения и аудио
живут в OPFS браузера, проект — в IndexedDB. На сервер (в Supabase) уходит
только JSON-снапшот проекта и только на 24 часа.

---

## 4. Пользовательский путь: от установки до готового MP4

### Шаг 0. Установка

```bash
npm install            # или npm ci
npm run setup          # диагностика окружения: Node, node_modules, ffmpeg, Chromium
npm run dev            # http://localhost:3000
```

На Windows — двойной клик по `install.bat`, затем `run.bat` (меню из 7 пунктов).
На Linux/macOS — `./install.sh`, `./run.sh`. Лаунчеры дополнительно умеют:
браузерный режим, «оконный» режим Chrome App размером 1280×800, Electron и
production-сборку.

### Шаг 1. Первый запуск — мастер настройки

Если в `localStorage` нет флага `onboardingCompleted`, на главной странице
открывается `OnboardingWizard` из пяти шагов:

1. **Окружение** — `evaluateEnvironment()` проверяет пять пунктов:
   OPFS, IndexedDB, WebCodecs H.264+AAC, MediaRecorder VP9/VP8+Opus и
   «Chromium ≥ 120». Каждый пункт получает статус `ok` / `warn` / `fail`.
2. **Озвучка (TTS)** — выбор провайдера, ввод ключа, кнопка «Проверить ключ»
   с реальным минимальным запросом.
3. **Анализ (LLM)** — выбор vision-провайдера и ключа, аналогичная проверка.
4. **Канал** — `channelName` и `channelTagline` (используются в fallback-интро,
   аутро и SEO).
5. **Старт** — создать демо-проект, загрузить изображения, открыть провайдеров.

Закрытие мастера ставит флаг, и при следующем заходе он сам не открывается
(кнопка «Настройка» в шапке открывает его снова).

### Шаг 2. Главная страница: загрузка изображений

Главная (`src/app/page.tsx`) — одноколоночный экран `max-w-[960px]` с
dropzone-«героем»: «Кидай сюда страницы манги».

- `ImageUploader` принимает PNG/JPEG/WebP (и вообще всё, что читает браузер),
  показывает превью через `URL.createObjectURL` — **без base64-копий всех файлов
  в памяти**.
- Искусственного лимита на количество изображений нет.
- Есть две демо-кнопки: «Создать демо-проект» (полностью готовый проект с
  локальным изображением и демо-WAV) и «Тест сценария (демо-изображения)»
  (три локальных JPEG из `/demo-images`, проект без панелей, сразу с открытой
  модалкой сценария).

При загрузке выполняется:

1. `createProject(name, blobs)` — создаёт проект, пишет изображения в
   `OPFS /mvs-info/projects/{id}/images/{index}.{ext}`; если OPFS недоступен —
   хранит data URL в IndexedDB.
2. Если есть ключ LLM: `processAllImages()` прогоняет каждое изображение через
   vision-модель (последовательно, concurrency 1, rate limit 10 запросов/мин,
   retry 2 с экспоненциальной задержкой), валидирует ответ Zod-схемой,
   пытается починить типичные ошибки LLM, при пустом результате создаёт
   панель-«Рассказчик».
3. `mergeVisionResults()` склеивает результаты: панели перенумеровываются,
   персонажи дедуплицируются, описания сцен объединяются.
4. Проект сохраняется и открывается `/editor/{id}`.

Если ключа нет — проект всё равно создаётся, но без разбора; редактор покажет
баннер «ключ не добавлен», и пользователь может пойти путём сценария.

### Шаг 3. Редактор: общий вид

Редактор (`/editor/[id]`) — «студия без хлама»: одна колонка, без вкладок.

Сверху вниз:

1. **Шапка**: назад, имя проекта, статус сохранения, кнопки «Сценарий»,
   «Интро/Аутро», «Голоса», «Проверка», «Экспорт», undo/redo, «Добавить
   изображения», меню проекта (ZIP-экспорт/импорт).
2. **Preview** — Canvas 16:9 (в превью 1280×720, в экспорте 1920×1080),
   Ken Burns-камера, плашка реплики, подсветка bbox, вертикальный скроллбар
   ленты. Рендерится на `requestAnimationFrame` из `ProjectClock`.
3. **Панель режима рендера** — `Панели` / `Лента`, зона просмотра ленты,
   отступ между страницами.
4. **Timeline** — сегменты intro / panels / gaps / outro, две дорожки
   (видео и аудио), playhead, зум, скролл, drag-and-drop, trim-ручки.
5. **ContextPanel** — контекстная панель выбранного объекта: текст реплики,
   персонаж, эмоция, тип, голос, кнопки «Озвучить», «Переозвучить»,
   reorder, trim/gain/fade и т.п.
6. **Строка статуса** — длительность, стоимость озвучки, предупреждения.

Горячие клавиши: `Space` — play/pause, `←`/`→` — ±5 с, `⌘/Ctrl+S` — сохранить,
`⌘/Ctrl+E` — экспорт, `⌘/Ctrl+Z` / `Shift+⌘/Ctrl+Z` — undo/redo,
`S` — split активного клипа (через `handleSplitRef`).

### Шаг 4. Разметка: Vision или сценарий

**Путь A — Vision (автоматически).** Панели уже созданы на главной. В редакторе
их можно править: bbox, текст, персонаж, эмоция, тип (`speech`/`thought`/
`narration`/`sfx`), порядок. Поддерживается «fullFrame»-панель — кадр целиком
без зума и bbox-обводки.

**Путь B — Сценарий (вручную).** Модалка «Сценарий» (`ScenarioModal`) содержит
текстовый редактор в формате:

```
Изображение 1 [0..30%]

Герой (Муж.): Ты правда думаешь, что сможешь меня остановить?

Изображение 1 [30..100%]

Антагонист (Жен.): Посмотрим, как ты справишься с этим.
```

Правила (реализованы в `src/lib/pipeline/scenario.ts`):

- метка `Изображение N` начинает новое изображение; опционально `[X..Y%]`
  задаёт вертикальный диапазон внутри страницы;
- реплика начинается с `Имя (Жен./Муж.):` или `Имя:`;
- жёсткие переносы и пустые строки **внутри** реплики склеиваются
  (`joinContinuation`, перенос по дефису — без пробела); это добавлено в 1.3.17;
- метка изображения в одной строке с именем распознаётся как метка, имя
  игнорируется с предупреждением;
- строка без подписи до первой реплики — ошибка;
- модалка показывает предупреждения о склеенных строках;
- `serializeScenario` умеет собрать текст обратно из панелей — с якорями
  «Скопировать с якорями»;
- перед применением, если панели уже есть, требуется подтверждение: панели и их
  аудио заменяются целиком; старое аудио удаляется из OPFS;
- реплики переводятся на язык озвучки одним батч-вызовом LLM
  (`translateScenario.ts`); при недоступности ключа сценарий применяется без
  перевода с баннером;
- если изображений в проекте нет — применение блокируется.

Y-диапазоны (`yRange.ts`):

- допустимо только `0 ≤ X < Y ≤ 100`;
- проценты — **пространственные**, а не временные: длительность определяется
  только аудио;
- `[0..100%]` эквивалентно отсутствию диапазона;
- bbox клампится в 0..100 (vision `y=90, height=20` → `[90..100%]`);
- дробные значения через точку или запятую; `%` и пробелы необязательны;
- перекрывающиеся диапазоны допустимы;
- X-координаты пока не поддерживаются — панель всегда на всю ширину.

### Шаг 5. Сценарий → панели → таймлайн

После применения сценария:

- каждая реплика становится панелью (`id`, `bbox`, `dialogue`, `character`,
  `emotion`, `type`, `order`, `imageIndex`);
- без диапазона панель получает `fullFrame: true` (кадр целиком);
- с диапазоном — `bbox { x: 0, y: X, width: 100, height: Y-X }`, без `fullFrame`;
- `rebuildSrt()` пересобирает SRT, `buildTimeline()` — `SyncTimeline`;
- несуществующий номер изображения клампится в последнее с предупреждением.

### Шаг 6. Голоса

Модалка «Голоса» (`VoicesModal`):

- список персонажей с распределением голосов;
- пол персонажа (`Character.gender`) приходит из сценария `(Жен.)`/`(Муж.)`,
  показывается бейджем и используется для автоподбора голоса нужного пола;
- `resolveVoice()` выбирает: явный голос → первый голос провайдера →
  статический `FALLBACK_VOICE`;
- для «экспериментальных» провайдеров (`experimental: true`) авто-подстановка
  запрещена — нужен явный выбор пользователя, иначе сервер вернёт
  `400 voice_required`;
- значения вроде `'default'` у resemble/fish не считаются настоящим голосом;
- голос можно прослушать (кнопка-плей в списке).

### Шаг 7. Озвучка

Кнопка «Озвучить всё» вызывает `generateAllAudio()`:

- очередь `TaskQueue` с `concurrency: 2`, `retryDelay: 1500`, до 3 попыток,
  экспоненциальной задержкой + jitter;
- каждая панель получает **подпись аудио**
  `SHA-256(provider|voice|model|speed|language|text)`;
- если подпись совпадает и файл есть в OPFS — берётся кэш; иначе синтез;
- общий TTS-кэш в `OPFS /mvs-info/tts-cache/{provider}-{sha256}.mp3`;
- при `allowCrossProviderFallback` — цепочка резервных провайдеров, у которых
  есть ключ (по умолчанию **выключено**, чтобы не тратить деньги незаметно);
- импортированные файлы (`audioSource: 'import'`) «Озвучить всё» не трогает;
- «↻ Переозвучить» требует подтверждения для импортированных и умеет
  `forceRegenerate` (иначе вернулся бы тот же кэш и кнопка бы «врала»);
- длительность измеряется через `OfflineAudioContext` (по одному блобу, чтобы не
  было гонки при concurrency 2), при ошибке — оценочная по символам;
- прогресс, число панелей в прогоне и стоимость (`estimateTotalCost`) видны в UI;
- отдельные ошибки не прерывают очередь — собираются в `errors[]`.

Дополнительно: «Озвучить интро/аутро» — отдельные слоты, отдельные файлы в OPFS.

### Шаг 8. Импорт внешних аудиодорожек

Модалка «Импорт аудио» (`AudioImportModal`) — самый сложный по бизнес-логике
модуль (`audioImport.ts`, `importPlan.ts`; ~52 теста).

Поддерживаются MP3/WAV/OGG/Opus/M4A/AAC/FLAC и другие декодируемые форматы.
Сопоставление файлов с панелями идёт строго по приоритету:

1. **ручные назначения** (`manualOverrides`) — только API: модалка их **не
   передаёт**, поля «выбрать панель вручную» в интерфейсе нет;
2. **манифест** «Изображение N [X..Y%] = файл» или «panel-0007 = файл».
   Непустой манифест **выключает** уровень 4: файлы, которых в нём нет,
   остаются несопоставленными, а не раскладываются по порядку;
3. **имя файла**: сначала номер панели («panel-0007.mp3», «7.mp3»,
   «voice_7.wav»), затем якорь («Изображение 1 [0..30%].mp3»). Номер в имени
   не должен проигрывать якорю, который подходит нескольким панелям сразу;
4. **числовой фрагмент в имени** (`003.mp3`, `voice_01.wav`, `2.mp3`) → N-я
   цель по порядку, если номер есть у **всех** оставшихся файлов; иначе —
   natural sort и строгое 1:1 по количеству (несовпадение количества — ошибка,
   а не усечение).

Номер для имён без префикса — **первое число где угодно в имени**
(`leadingNumber`): `Глава 2.mp3` → панель 2, `3d-voice.mp3` → панель 3,
`qwen3.8-27b.wav` → панель 3. Это плата за угадывание: посторонние числа в
имени надо убирать. Номер — это номер панели (реплики), а **не** номер
изображения: `2.mp3` означает вторую реплику, а не панель на изображении 2.

Перепривязать файл вручную в окне нельзя: либо имя файла, либо строка в
манифесте (сообщения об ошибках говорят именно это).

Номер в «panel-N» — это **номер панели по порядку** (тот же, что «Панель №N»
в таблице и что в `003.mp3`), а **не** её внутренний `id`. Раньше код сначала
искал панель с `id = N` и только потом брал позицию N: в проекте с удалёнными
или переставленными панелями это давало ложный «Дубль» (файл `panel-0053.wav`
уходил на панель с id 53, а `panel-0054.wav` без такого id падал на позицию 54,
которой оказывалась та же панель) и часть реплик оставалась без аудио. Если
номер совпадает с чужим `id`, в предупреждениях прямо написано, какая панель
выбрана и какая осталась в стороне. Номер вне `1..N` — ошибка с диапазоном,
а не подстановка «ближайшей» панели.

Конфликт на одном уровне (два файла на одну цель, один файл на две цели, дубль
якоря) — ошибка. Более высокий уровень приоритета молча вытесняет более низкий.

Подпись панели в сообщениях — «Изображение N [полоса] · персонаж» — у двух
панелей одной полосы с одним персонажем совпадает буквально, поэтому
ориентироваться нужно на «Панель №N» в строке файла.

Дополнительно:

- предварительная диагностическая таблица плана (`buildAudioImportPreviewRows`);
- пред-декод и проверка сигнатур (magic bytes), SHA-256 дедупликация;
- проверка квоты хранилища (`checkStorageQuotaBeforeImport`) с откатом;
- выборочный повторный импорт отмеченных файлов;
- откат последнего импорта (`createAudioImportUndoSnapshot` / `undoLastAudioImport`);
- журнал прерванного импорта (`ImportJournal`) и восстановление при следующем
  открытии проекта;
- `audioOriginalMime` / `audioNormalizedMime` сохраняются в панели.

Файл панели всегда лежит по ключу `audio/{panelId}.mp3` (расширение условное,
MIME восстанавливается по сигнатуре при чтении).

### Шаг 9. Таймлайн, SRT, NLE

**Построение.** `buildTimeline(panels, durations, voiceAssignments, introDuration, panelGap, options)`:

- режим `'draft'` разрешает оценочную длительность по тексту, `'real'` требует
  реальную длительность или `durationOverride`;
- панели выстраиваются последовательно с паузой `panelGap`
  (по умолчанию 0.3 с; сценарий ставит 0.6 с — `SCENARIO_GAP_SECONDS`);
- аудио-интро сдвигает первую панель на `introDuration`;
- `roundMediaDuration` борется с плавающей точкой;
- `sameImageSpan` группирует соседние панели одной страницы — камера не
  «скачет» на каждой панели.

**SRT.** Единая точка — `rebuildSrt()`:

- реальные длительности там, где озвучка готова; оценка по символам — где нет;
- интро — сегмент `0 → introDuration`, аутро — после последней панели;
- пересобирается при смене паузы, интро/аутро, применении сценария и после
  озвучки;
- пока хотя бы одна панель не озвучена, SRT помечается «черновик» (серая
  пометка в «Экспорте»), но файл всё равно экспортируется.

**NLE (`nleOperations.ts`, `historyManager.ts`).**

| Операция | Поведение |
|---|---|
| Reorder | смена порядка клипов с подтверждением |
| Trim in/out | подрезка аудио, сохраняется в `PanelData.trimIn` / `trimOut` |
| Split | делит клип на два связанных (`splitGroupId`, `sourceAudioPanelId`) |
| `durationOverride` | отдельная длительность изображения при фиксированном аудио |
| Ripple edit | сдвиг последующих клипов без наложений |
| Track lock | блокировка видео- и аудиодорожки |
| Mute / Solo | на уровне клипа, глобальный `hasSolo` учитывается в миксе |
| Gain / Fade | `gain` 0..2, `fadeIn` / `fadeOut` в секундах, применяются в WebAudio и экспорте |
| Snapping | к `audioStart`, `audioEnd`, границам изображений (`snapTimeToTargets`) |
| Undo / Redo | `HistoryManager` на 50 снимков, снимок = panels + durations + timeline + srt + gap + locks |

Изменение порядка и трим-ручки проверяются не только юнит-тестами, но и
pointer-событиями в реальном Chromium (`smoke:editor`).

### Шаг 10. Превью

`Preview.tsx`:

- Canvas 1280×720, 16:9; кадр рисуется из `ProjectClock` на 60 fps,
  React-дерево редактора обновляется ~20 Гц (троттлинг), чтобы не «варить»
  сорок компонентов на каждый кадр;
- камера — единая чистая функция `sampleCameraFrame` для превью **и** обоих
  бэкендов экспорта; Ken Burns-зум и панорама считаются по bbox панели;
- в режиме `panels` рисуется плашка диалога (`drawDialogue`), bbox-обводка
  (если включён debug), letterbox через `drawContain`;
- в режиме `strip` — «чистый вебтун без плашек»: облачка уже нарисованы на
  самой манге, плашка `drawDialogue` отключена и в превью, и в экспорте;
- интро/аутро — единые оверлеи `drawIntroOverlay` / `drawOutroOverlay`;
- загрузка страниц ждёт настоящий `load`/`decode` (`loadImage.ts`), а не
  фиксированные 2–3 с; длинные полосы не оставляют пустой кадр;
- двусторонняя подсветка связанных видео- и аудиоклипов (`selected`);
- селектор шапки подписан на `useSyncExternalStore`, чтобы не перерисовывать
  всё дерево;
- `CanvasFrameDeduplicator` не даёт рисовать один и тот же кадр повторно;
- `ObjectUrlRegistry` переиспользует и гарантированно освобождает `blob:` URL.

### Шаг 11. Проверка проекта

Кнопка «Проверка» (`ProjectHealthModal`, `projectHealth.ts`) — 6 категорий
проблем: `sync`, `audio`, `image`, `range`, `duration`, `storage`.

- `inspectProjectHealth()` собирает ошибки/предупреждения/инфо и общий статус
  готовности: `ready` / `draft` / `warnings` / `errors`;
- проверяет валидность таймлайна (`validateTimelineFull`: немонотонность,
  пересечения, дырки, несоответствие SRT, длительности клипов < 0.2 с и > 60 с);
- сверяет манифест ресурсов SHA-256 (`verifyProjectManifest`);
- проверяет y-диапазоны и наличие изображений;
- кнопка «Скачать диагностический JSON» — полный отчёт
  (`buildDiagnosticReportJson`), включая журнал событий проекта.

### Шаг 12. Экспорт

Модалка «Экспорт» (`ExportModal`) умеет:

| Что | Формат | Как |
|---|---|---|
| Видео | MP4 (H.264 + AAC) | WebCodecs + `mediabunny`, 1920×1080, 30 fps |
| Видео (fallback) | WebM (VP8/VP9 + Opus) | Canvas + `MediaRecorder` |
| Аудио | WAV | `OfflineAudioContext` → `renderExportAudioMixPreviewWav` |
| Аудио (fallback) | MP3/склеенный блоб | `concatenateAudioBlobs`, если микширование недоступно |
| Субтитры | `.srt` | из `project.srt` |
| SEO | `.txt` | `formatSEOPackage`: заголовок, описание, теги, превью, главы, время публикации, закреплённый комментарий |
| Проект | `.zip` | `project.json` + `manifest.json` + `images/*` + `audio/*` |
| Диагностика | `.json` | `buildDiagnosticReportJson` |

Особенности экспорта:

- перед рендером можно **прослушать финальный микс** (WAV-URL);
- показывается прогресс, стадия и ETA, экспорт можно отменить (`AbortController`);
- обрезанные из-за наложений реплики показываются списком предупреждений
  (`onAudioTrimmed` / `userFacingOverlaps`), а не только в консоли;
- выбор бэкенда: `auto` (WebCodecs, если есть H.264 + mediabunny, иначе Canvas),
  `webcodecs`, `canvas`;
- итоговый файл не скачивается автоматически — открывается кнопка «Скачать»
  (чтобы не терять большой blob при блокировке попапов);
- рендер идёт по тем же функциям отрисовки, что превью: `renderExportFrameToCanvas`
  и `sampleCameraFrame`, поэтому картинка совпадает структурно (см. L-12).

### Шаг 13. Облачный снапшот (опционально)

При каждом сохранении `syncProjectSnapshot(project)` шлёт POST на
`/api/cloud/project`. Если Supabase не настроен — ответ 503, приложение
продолжает работать локально. Ключи провайдеров из снапшота вырезаются
(`sanitizeProject`). TTL — 24 часа с последнего сохранения; просроченные
снапшоты удаляются при чтении/записи и по cron.

### Шаг 14. Жизненный цикл проекта

- Локальные проекты живут **24 часа** с последнего изменения
  (`PROJECT_TTL_MS`); просроченные удаляются при `getAllProjects()` /
  `getProject()`.
- `saveProject` — атомарная запись через временный ключ `__snapshot__:<id>` и
  оптимистическая блокировка ревизии (`revision`, `StaleProjectRevisionError`).
- Восстановление: если вкладка закрылась между шагами, при чтении подхватывается
  временный снапшот.
- Экспорт/импорт ZIP позволяет сохранить проект навсегда вручную.
- Есть полная очистка `clearAllInfo()` и экспорт всех данных
  (`exportAllInfo`, `exportAllInfoWithFiles`) — в dev доступно через
  `window.mvsInfo`.

---

## 5. Архитектура

### 5.1. Общая схема

```
┌───────────────────────────────────────────────────────────────────────┐
│                            БРАУЗЕР (основная работа)                   │
│                                                                       │
│  Главная /            Редактор /editor/[id]         Настройки /settings│
│  ImageUploader        Preview │ Timeline │ Context  ProviderList       │
│        │                  │        │          │          │            │
│        ▼                  ▼        ▼          ▼          ▼            │
│  ┌───────────────────────────────────────────────────────────────┐    │
│  │                     lib/pipeline (чистые функции)              │    │
│  │ extractPanels │ scenario │ buildTimeline │ audioMix │ mangaStrip│   │
│  │ cameraSampler │ videoEncoder │ projectHealth │ timelineDrag ... │   │
│  └───────────────────────────────────────────────────────────────┘    │
│        │                     │                     │                  │
│        ▼                     ▼                     ▼                  │
│  lib/providers/llm     lib/providers/tts      lib/storage             │
│  (прямой fetch или      (прямой fetch или      IndexedDB + OPFS       │
│   прокси /api/llm)       прокси /api/tts)      localStorage           │
└────────┬──────────────────────┬───────────────────────┬───────────────┘
         │                      │                       │
         ▼                      ▼                       ▼
   LLM API (vision,       TTS API (15 провайдеров)   /api/cloud/project
   перевод, SEO)                  │                       │
         │                        │                       ▼
         │                  CORS-блокирующие          Supabase
         │                  → /api/tts (сервер)       (JSON-снапшоты, TTL 24ч)
         │
         ▼
   /api/llm, /api/seo — легаси-прокси (нужны только для не-CORS провайдеров)
```

### 5.2. Слои

| Слой | Где | Задача |
|---|---|---|
| Страницы (App Router) | `src/app/*` | `page.tsx`, `editor/[id]`, `settings`, `layout`, `error` |
| UI-компоненты | `src/components/*` | студия, модалки, онбординг, провайдеры, upload, ui-примитивы |
| Доменный пайплайн | `src/lib/pipeline/*` | чистые функции и классы без React |
| Провайдеры | `src/lib/providers/*` | LLM (13) и TTS (15), каталоги, роутеры, ошибки |
| Хранилище | `src/lib/storage/*` | IndexedDB, OPFS, localStorage, архивы, целостность |
| Серверные маршруты | `src/app/api/*` | прокси TTS/LLM/SEO, Whisper, облако, cron |
| Промпты | `src/lib/prompts/*` | vision, intro/outro, SEO |
| Утилиты | `src/lib/utils.ts`, `validators.ts` | downloadBlob, formatTime, Zod-схемы, стоимость |

### 5.3. Принципы, которые видно в коде

1. **Один источник времени.** Все изменения времени (seek, play/pause, колесо,
   drag, хоткеи, синхронизация с `HTMLAudioElement`) идут через `ProjectClock`.
   Дочерним компонентам запрещено заводить свои таймеры.
2. **Один источник отрисовки.** `sampleCameraFrame`, `drawDialogue`,
   `drawIntroOverlay`, `drawOutroOverlay`, `containRect` — общие для превью и
   экспорта.
3. **Один источник таймлайна/SRT.** `buildTimeline` + `rebuildSrt`, а
   `invalidateAndRebuildTimeline` поднимает монотонный `timelineVersion`.
4. **Один источник версии.** `package.json`; `check-version.mjs` сверяет
   README, лаунчеры, lock-файл и Electron-мост.
5. **Чистые функции тестируемы без браузера.** Геометрия, раскладка звука,
   сценарий, импорт, планировщик, часы — всё вынесено и покрыто `tsx --test`.
6. **Честность про возможности.** `checkCapabilities()` реально проверяет
   `VideoEncoder.isConfigSupported`, а не предполагает; недоступные пути
   помечены `experimental` и требуют явного выбора.

---

## 6. Структура репозитория

```
make/
├── .env.example                  # Supabase, пароль, cron secret
├── .github/workflows/ci.yml      # CI: ubuntu + windows
├── .gitattributes                # .bat → CRLF, текст → LF
├── DEPLOYMENT_GUIDE_RU.md        # деплой на Vercel + Supabase, TTL, безопасность
├── README.md                     # 93 КБ: возможности, провайдеры, история версий
├── known-limits.md               # L-1..L-18: платформа, браузеры, архитектура
├── next.config.ts                # serverExternalPackages, webpack fallback
├── vercel.json                   # cron /api/cleanup раз в сутки в 03:00
├── package.json                  # скрипты, зависимости, node >= 20.9
├── eslint.config.mjs
├── tsconfig.json
├── postcss.config.mjs
│
├── electron/
│   ├── main.js                   # окно 1280×800, запуск next, меню
│   └── preload.js                # contextBridge: window.mangaStudio
│
├── public/
│   ├── demo-images/scene-1..3.jpg
│   └── *.svg
│
├── supabase/schema.sql           # таблица снапшотов, RPC очистки, RLS
│
├── scripts/
│   ├── setup.mjs                 # диагностика окружения (npm run setup)
│   ├── check-version.mjs         # единый источник версии
│   ├── check-launchers.mjs       # структурные проверки .bat/.sh
│   ├── smoke-server.mjs          # next start + живые маршруты
│   ├── smoke-editor.mjs          # E2E Chromium: сценарий, импорт, NLE, экспорт
│   ├── smoke-onboarding.mjs      # E2E мастера + демо, 15 скриншотов
│   ├── smoke-audio.ts            # OfflineAudioContext → WAV
│   └── smoke-tts.ts              # живая проверка TTS-провайдеров по ключам
│
├── tests/                        # 43 файла, 421 тест + fixtures/browserEnv
│
├── artifacts/                    # скриншоты и видео smoke-прогонов (в git не попадают)
│
├── src/
│   ├── proxy.ts                  # auth (заменяет middleware в Next 16)
│   ├── app/
│   │   ├── layout.tsx, globals.css, page.tsx, favicon.ico
│   │   ├── settings/page.tsx
│   │   ├── editor/[id]/page.tsx, error.tsx
│   │   └── api/
│   │       ├── cleanup/route.ts        # cron-очистка Supabase
│   │       ├── cloud/project/route.ts  # GET/POST/DELETE снапшотов
│   │       ├── llm/route.ts            # легаси-прокси LLM
│   │       ├── seo/route.ts            # прокси SEO
│   │       ├── tts/route.ts            # прокси TTS
│   │       ├── tts/voices/route.ts     # список голосов
│   │       └── whisper/route.ts        # STT/SRT
│   ├── components/
│   │   ├── MigrationRunner.tsx
│   │   ├── onboarding/OnboardingWizard.tsx
│   │   ├── settings/ProviderList.tsx
│   │   ├── studio/
│   │   │   ├── Preview.tsx, Timeline.tsx, ContextPanel.tsx, RenderModePanel.tsx
│   │   │   ├── editor/                 # редактор по слоям (см. 12.5)
│   │   │   │   ├── EditorView.tsx, EditorWorkspace.tsx, EditorModals.tsx
│   │   │   │   ├── useEditorController.ts, useEditorState.ts, useEditorDerived.ts
│   │   │   │   ├── useEditorProjectLoader.ts, useEditorPersistence.ts,
│   │   │   │   ├── useEditorImages.ts, useEditorAudioOps.ts,
│   │   │   │   ├── useEditorAudioImport.ts, useEditorExport.ts, useEditorNle.ts,
│   │   │   │   └── useEditorPlayback.ts, useEditorScenario.ts,
│   │   │   │       useEditorSrtOps.ts, useEditorDialogue.ts
│   │   │   └── modals/
│   │   │       ├── AudioImportModal.tsx, ExportModal.tsx,
│   │   │       ├── IntroOutroModal.tsx, ProjectHealthModal.tsx,
│   │   │       ├── ScenarioModal.tsx, VoicesModal.tsx
│   │   ├── ui/ (button, card, input, label, select, textarea)
│   │   └── upload/ImageUploader.tsx
│   └── lib/
│       ├── cloud/projectSync.ts
│       ├── pipeline/  (51 модуль, см. §9)
│       ├── prompts/   (vision, intro, seo)
│       ├── providers/
│       │   ├── links.ts (44 ссылки: 25 LLM + 15 TTS + 3 STT + custom)
│       │   ├── llm/   (catalog, openai-compatible, router, types, index)
│       │   └── tts/   (15 провайдеров, catalog, cors, mime, router,
│       │               voice-resolver, wav, types)
│       ├── storage/   (db, opfs, local, info, migrate, schemaMigration,
│       │               projectArchive, resourceIntegrity)
│       ├── utils.ts
│       └── validators.ts
│
├── install.sh / install.bat
├── run.sh / run.bat
├── start-browser.sh / start-browser.bat
├── start-window.sh / start-window.bat
└── start-electron.bat
```

---

## 7. Модель данных

### 7.1. `Project` (`src/lib/storage/db.ts`)

```ts
interface Project {
  id: string; name: string;
  schemaVersion?: number;        // CURRENT_PROJECT_SCHEMA_VERSION = 2
  timelineVersion?: number;      // CURRENT_TIMELINE_VERSION = 2
  revision?: number;             // оптимистическая блокировка

  images: string[];              // legacy data URL, если OPFS нет
  imageFiles?: string[];         // имена файлов в OPFS
  useOPFS?: boolean;

  panels: PanelData[];
  characters: Character[];
  voiceAssignments: Record<string, string>;

  timeline: SyncTimeline[];
  intro: string; outro: string;
  introDuration: number; outroDuration: number;

  audioDurations?: Record<number, number>;   // panelId → сек
  audioTexts?: Record<number, string>;       // снимок текста на момент озвучки
  resourceManifest?: Record<string, ResourceManifestEntry>;
  lastAudioImportUndo?: LastAudioImportSnapshot | null;
  eventLog?: ProjectEventEntry[];            // до 200 записей

  srt: string;
  seoPackage: SEOPackage | null;

  settings: {
    ttsProvider: string; llmProvider: string; visionModel: string;
    ttsModel?: string; chatModel?: string;
    ttsLanguage?: string; ttsSpeed?: number;
    renderMode?: 'panels' | 'strip';
    stripViewport?: number; stripGap?: number;
    panelGap?: number;
    videoTrackLocked?: boolean; audioTrackLocked?: boolean;
    debugOverlay?: boolean;
    channelName?: string; channelTagline?: string;
    backgroundMusic?: string; musicVolume: number;
  };

  createdAt: number; updatedAt: number;
  sceneDescription?: string;
  taskProgress?: { completed: number; total: number; lastImageIndex: number };
}
```

### 7.2. `PanelData`

Панель — это одновременно единица разметки и единица аудио.

| Поле | Смысл |
|---|---|
| `id`, `order`, `imageIndex` | идентичность и порядок |
| `bbox {x,y,width,height}` | проценты от изображения |
| `fullFrame?` | панель на весь кадр: contain + letterbox, без зума и обводки |
| `dialogue`, `character`, `emotion`, `type` | реплика и её контекст |
| `audioSource?` | `'tts'` или `'import'` |
| `audioFileName?`, `audioOriginalMime?`, `audioNormalizedMime?`, `audioSha256?` | метаданные импорта |
| `trimIn?`, `trimOut?`, `durationOverride?` | NLE |
| `muted?`, `solo?`, `gain?`, `fadeIn?`, `fadeOut?` | аудио-микс |
| `splitGroupId?`, `sourceAudioPanelId?` | split-связи |

### 7.3. `Character`

```ts
{ name, appearance, voiceId, emotion, gender?: 'female' | 'male' }
```

### 7.4. `SyncTimeline`

Канонический сегмент: `panelId`, `imageIndex`, `audioStart`, `audioEnd`,
`panelBbox`, `voiceId`, `text`, `character`, `audioSource`, `isEstimated`,
`trimIn`, `trimOut`, `muted`, `solo`, `gain`, `fadeIn`, `fadeOut`.

Именно из него считаются длительность, SRT, раскладка аудио и кадры экспорта.

### 7.5. `SEOPackage`

```ts
{
  title: { main, alternatives[] },
  description: { hook, body, hashtags[] },
  tags[],
  thumbnail: { prompt, textOverlay, emotion },
  chapters: { time, title }[],
  publishTime,
  pinnedComment
}
```

Валидируется Zod-схемами (`validators.ts`), генерируется `generateSEO` или
шаблонным fallback-ом.

### 7.6. Журнал событий

`appendProjectEvent` пишет `create`, `import`, `audio`, `export`, `nle`,
`migration` и т.п.; хранится последние 200 записей. Используется в
диагностическом JSON и в истории проекта.

---

## 8. Хранение данных и целостность

### 8.1. Три уровня

| Уровень | Что хранит | Ключи/пути |
|---|---|---|
| **OPFS** | изображения, аудио панелей, интро/аутро, TTS-кэш | `mvs-info/projects/{id}/images/{i}.{ext}` |
| | | `mvs-info/projects/{id}/audio/{panelId}.mp3` |
| | | `mvs-info/projects/{id}/audio/{panelId}.sig` |
| | | `mvs-info/projects/{id}/audio/intro.mp3`, `outro.mp3` |
| | | `mvs-info/tts-cache/{provider}-{sha256}.mp3` |
| **IndexedDB** | проекты целиком (JSON), временные снапшоты | БД `mvs-info`, store `projects`, keyPath `id` |
| **localStorage** | ключи провайдеров, настройки, custom LLM | `mvs-info:keys`, `mvs-info:settings`, `mvs-info:custom-llm-config`, `mvs-info:migration-v1-done` |

Плюс `onboardingCompleted` (без префикса) — флаг мастера.

### 8.2. Атомарность и ревизии

`saveProject`:

1. сериализует сохранения по `project.id` (очередь `saveLocks`);
2. проверяет `expectedRevision` (если передан) и `project.revision`;
   при расхождении — `StaleProjectRevisionError`;
3. пишет `__snapshot__:<id>`;
4. пишет основную запись с `revision + 1`;
5. удаляет временный снапшот.

`getProject` умеет восстановить запись из снапшота, если вкладка умерла между
шагами. `getAllProjects` отфильтровывает снапшоты и удаляет просроченные
проекты (TTL 24 часа).

### 8.3. Схемные миграции

`schemaMigration.ts` — явные идемпотентные миграции по номерам
`schemaVersion` / `timelineVersion`:

- нормализует `bbox` (0..100, ширина/высота > 0);
- подставляет `character = 'Рассказчик'`, `emotion = 'neutral'`, `type = 'speech'`;
- чистит NaN/отрицательные значения NLE-полей;
- пересобирает SRT, если нужно;
- возвращает `{ migrated, fromSchemaVersion, toSchemaVersion, steps[] }`;
- повторный вызов на актуальном проекте ничего не меняет.

### 8.4. Контроль целостности ресурсов

`resourceIntegrity.ts`:

- `computeBlobSha256` — SHA-256 через `crypto.subtle`;
- `createResourceManifestEntry` — id, путь, имя, MIME (оригинальный и
  нормализованный), размер, роль (`image` / `panel-audio` / `intro-audio` /
  `outro-audio`), SHA-256, `importedAt`;
- `verifyProjectManifest` — отчёт по каждому ресурсу (есть/нет, совпала ли
  сумма);
- `verifyAndRepairResourceManifest` — ремонт;
- `checkStorageQuotaBeforeImport` — оценка свободного места через
  `navigator.storage.estimate()`, с честным `freeBytes: null`, если браузер не
  умеет;
- `beginImportJournal` / `recordImportJournalStep` / `completeImportJournal` /
  `getPendingImportJournal` / `recoverInterruptedImport` — журнал прерванного
  импорта.

### 8.5. ZIP-архив проекта

`projectArchive.ts` — собственный кодировщик/декодировщик ZIP (CRC-32, stored
без сжатия):

- `project.json` — проект;
- `manifest.json` — формат `mvs-project-archive` v1, записи с SHA-256;
- `images/{index}.{ext}` — детерминированные имена (без коллизий между ОС);
- `audio/{slot}.mp3` — панели, `intro`, `outro`.

При импорте проверяется SHA-256 каждого блоба, схема мигрируется, таймлайн и
ресурсы восстанавливаются. Это «вечное сохранение» проекта в обход 24-часового
TTL.

### 8.6. Namespace `mvs-info` и миграция

Раньше данные лежали в `manga-voice-keys`, `manga-voice-settings`,
`custom-llm-config`, БД `manga-voice-db`, OPFS-папках `projects` и `tts-cache`.
`MigrationRunner` при старте однократно копирует всё в `mvs-info`
(localStorage, IndexedDB, OPFS), ставит флаг и больше не повторяет.

---

## 9. Пайплайн обработки — по этапам

### 9.1. Загрузка изображений

- `ImageUploader` — drag-and-drop и выбор файлов, превью через object URL.
- `createProject` пишет blobs в OPFS последовательно; при отсутствии OPFS —
  читает как data URL в IndexedDB.
- В редакторе можно дозагрузить изображения кнопкой «Добавить изображения»:
  новые файлы дописываются в OPFS (`saveProjectImage(project.id, index, blob)`),
  проект не пересоздаётся.
- `loadImage.ts` — `loadImageElement` ждёт `load` + `decode`, страховочный
  таймаут 30 с; `isImageDrawable` не даёт рисовать «пустую» картинку.

### 9.2. Vision-разметка

Файлы: `extractPanels.ts`, `prompts/vision-prompt.ts`, `validators.ts`.

1. `extractPanels(imageDataUrl, provider, options)`:
   - сначала пробует `provider.vision(imageBase64, prompt, options)`;
   - если провайдер не умеет vision или формат не тот — fallback на
     `provider.chat` с `image_url`-контентом;
   - ошибки 429/402 (и 403 для Gemini-квоты) **пробрасываются**, чтобы сработал
     кросс-провайдерный fallback, а не маскировались под «неверный формат».
2. Ответ парсится `safeParseJSON` (в том числе из markdown-блока), затем
   `validateVisionResult` (Zod).
3. При провале — `attemptFixVisionResult` (нормализует bbox, эмоции, типы,
   порядок), повторная валидация.
4. `normalizeResult` сортирует панели по `order` и при пустом списке создаёт
   панель-«Рассказчик» с описанием сцены.
5. `processAllImages` — `TaskQueue` concurrency 1, rate limit 10/60 000 мс,
   retry 2 с, прогресс в UI.
6. `mergeVisionResults` — склейка страниц: панели перенумеровываются,
   персонажи дедуплицируются, описания объединяются.

Схема vision (`VisionResultSchema`): `imageWidth`, `imageHeight`, до 50 панелей,
`sceneDescription` ≤ 1000 символов, до 20 персонажей.

### 9.3. Сценарий и перевод

- `scenario.ts` — парсер/сериализатор (`parseScenario`, `serializeScenario`,
  `applyScenarioToProject`), `SCENARIO_GAP_SECONDS = 0.6`, `joinContinuation`.
- `scenarioFormat.ts` — общий формат якоря «Изображение N [X..Y%]» для сценария
  и импорта файлов; без зависимостей от хранилища.
- `translateScenario.ts` — один батч-вызов LLM: массив реплик → массив той же
  длины; `isTranslatableLanguage` не гоняет перевод, если язык совпадает.
- `yRange.ts` — валидация и кламп диапазонов; `isWholeRange`.

### 9.4. TTS

Файлы: `generateAudio.ts`, `providers/tts/*`, `taskQueue.ts`,
`storage/opfs.ts`, `loadPanelAudio.ts`, `audioImport.ts`.

Поток одной панели:

```
text + voice + provider + model + speed + language
        │
        ▼
 buildAudioSignature → SHA-256
        │
        ├── есть panel.audioSignature и файл в OPFS? → использовать
        ├── есть в tts-cache? → скопировать в проект, измерить
        └── нет → generateTTS() (прямо или через /api/tts)
                    │
                    ▼
             Blob + корректный MIME (по сигнатуре)
                    │
                    ├── saveProjectAudio(projectId, panelId, blob)
                    ├── saveProjectAudioSignature(...)
                    ├── saveTTSCache(key, blob)
                    └── измерить длительность (OfflineAudioContext)
```

Особенности:

- `resolveAudioMime(providerId, buffer)` определяет формат по magic bytes, а не
  по имени провайдера: Gemini/Qwen часто отдают WAV/PCM, остальные — MP3;
- `assertClientContext` не даёт случайно вызвать TTS-провайдера на сервере;
- `getServerGenerate` возвращает `null` для провайдеров с `proxyClientSide`,
  чтобы не получить рекурсию `/api/tts → /api/tts`;
- `voice-resolver.ts` кэширует разрешённые голоса;
- `estimateTotalCost` считает символы и примерную стоимость по каталогу;
- `loadPanelAudio.ts` при открытии проекта грузит `audio/{id}.mp3` **по факту
  наличия файла**, а не по наличию `.sig` — иначе импортированные файлы
  потерялись бы;
- singleton `AudioContext` (лимит Chrome ~6 контекстов), `closeSharedAudioContext`.

### 9.5. Аудио-микс

`audioMix.ts` — ключевой модуль честного звука:

- `AudioPlacement` — `{ start, duration, blob, role, trimIn, trimOut, gain,
  fadeIn, fadeOut, muted, solo }`;
- `buildTimelineAudioPlacements()` — собирает placements из таймлайна, панелей,
  блобов, интро/аутро; учитывает mute/solo и обрезку;
- `packStarts()` — укладывает элементы, возвращает конфликты
  (`kind`, `trimmedBy`, `severity`); `userFacingOverlaps` превращает их в
  понятные предупреждения;
- `measurePlacements()` / `measureBlobDurations()` — измеряет по одному блобу,
  кэш `WeakMap`, чтобы не держать все буферы в памяти;
- `mixAudioPlacements()` — единый буфер (используется для WAV/MP3 и
  preflight-прослушивания); для длинных роликов не рекомендуется;
- `createPlacementScheduler()` — для Canvas-фолбэка: в графе Web Audio живут
  только ближайшие ~4 с, буфер отпускается по `onended`;
- `appendPlacements()` — для mediabunny: фрагменты отдаются последовательно,
  паузы добиваются тишиной;
- `applyEnvelopeAndTrimToChannelData()` — trim + gain + fade + mute на уровне
  сэмплов;
- `stackBlobsBackToBack()` — устаревшая раскладка без placements, но с
  измеренными длительностями (защита от NaN/∞).

### 9.6. Таймлайн и валидация

`buildTimeline.ts`:

- `resolvePanelEffectiveDuration` — `durationOverride` → `trimOut - trimIn` →
  реальная длительность → оценка по тексту;
- `buildTimeline` — сегменты с паузой, интро-сдвигом, `voiceId`;
- `invalidateAndRebuildTimeline` — пересборка + рост `timelineVersion`;
- `calculateTotalDuration`, `formatSRTTime`, `generateSRT`, `parseSRTCues`;
- `getKenBurnsParams` — параметры зума/панорамы.

`timelineValidator.ts` — коды проблем: `NON_POSITIVE_SEGMENT`,
`STARTS_BEFORE_INTRO`, `MONOTONICITY_VIOLATION`, `GAP_MISMATCH`,
`AUDIO_OVERLAP`, `BLOB_EXCEEDS_WINDOW`, `DURATION_MISMATCH`,
`SRT_COUNT_MISMATCH` и др.

`timelineGeometry.ts` — единая система координат: `trackRect`, `TIMELINE_TRACK_OFFSET = 72`,
базовая ширина 960, зум 0.75–4, `collectSnapTargets`, `snapTimeToTargets`,
`computeZoomAroundTime`, `computeAutoFollowScrollLeft`, `computeTimelineGaps`,
`computeIntroOutroSegments`.

`timelineDrag.ts` — конечный автомат pointer-событий:

- `computeDragDropReorderTarget` — куда встанет клип с учётом snap и допуска
  0.15 с;
- `computeTrimHandleUpdate` — новое `trimIn`/`trimOut` по координате;
- `createTimelinePointerController` — `pointerdown → pointermove → pointerup`,
  без React-зависимостей (поэтому тестируется в Node).

### 9.7. Камера и кадры

`cameraSampler.ts`:

- `sampleCameraFrame({ time, renderMode, timeline, panels, images, ... })` —
  единая функция: определяет фазу (`intro` / `panel` / `gap` / `outro`),
  активную панель, `zoom`, `pan`, `scrollY` ленты, текст плашки;
- `computePanelCameraDrawRect` — прямоугольник отрисовки панели;
- `drawPanelWithCamera` — drawImage с учётом камеры;
- `drawDialogue`, `drawIntroOverlay`, `drawOutroOverlay` — текстовые слои;
- `resolveFirstSegmentForPage` — какой сегмент показывать при входе на страницу;
- `diagnoseSlotResources` — почему слот пустой (нет изображения, не загрузилось,
  вне диапазона);
- `CanvasFrameDeduplicator` — не рисует повторный кадр.

`draw.ts`:

- `containRect` — fit-contain с letterbox;
- общие canvas-хелперы (drawContain, roundRect и т.п.).

`overlayText.ts`:

- `wrapOverlayText` — перенос строк по ширине;
- `drawIntroOverlay` / `drawOutroOverlay` — титульный и финальный текст,
  одинаковые в превью и экспорте;
- дефолты «Добро пожаловать в мир манги...» и «Спасибо за просмотр!
  Подписывайтесь!».

### 9.8. Режим «лента» (webtoon scroll)

`mangaStrip.ts` — самый «математический» модуль:

- страницы склеиваются в вертикальную полосу в **виртуальных координатах**;
  полоса никогда не композитится целиком, поэтому лимит canvas 32 767 px по
  высоте не мешает даже 40-страничным главам;
- `computeStripLayout` — слоты, отступы, зум 50–170 %, ограничения
  `min/max` высоты слота;
- `buildScrollKeyframes` — прокрутка привязана к аудио: пока реплика звучит,
  окно стоит (или медленно едет), переход — на последние ~0.8 с интервала;
- `buildStripScrollSpans` — если у панели есть y-диапазон, окно проезжает
  именно её полосу, а не всю страницу; несколько реплик подряд под одним
  диапазоном дают один проезд, а не «вниз-вверх»;
- `renderStripFrame` — рисует только пересекающиеся со окном страницы,
  9-аргументным `drawImage` (из исходника берётся видимый срез — текстура
  размером с окно, а не со всю полосу);
- `timeAtScroll` / `timeAtScrollIndexed` — ручной скролл перематывает к реплике
  под центром окна;
- `STRIP_DEFAULTS`, `STRIP_ZOOM_MIN/MAX`, `clampScroll`, `maxScrollY`,
  `visibleSlots`, `pageIndexAtScroll`;
- `createStripSceneFromMedia` — одна сцена для превью и обоих бэкендов
  экспорта.

Инвариант: в режиме `strip` в фазах `panel`/`gap` **нет плашек** диалога;
в фазах `intro`/`outro` плашки есть в обоих режимах.

### 9.9. Экспорт видео

`videoEncoder.ts`:

```ts
interface RenderBackend {
  id: string;
  render(options, onProgress, signal): Promise<{ blob, mimeType }>;
}
```

- `checkCapabilities()` — реальные проверки:
  `VideoEncoder`/`AudioEncoder`, H.264 `avc1.42E01E`, AAC `mp4a.40.2`,
  наличие `mediabunny` API (`Output`, `Mp4OutputFormat`, `CanvasSource`,
  `BufferTarget`);
- `getBestBackendId(caps)` — `webcodecs`, если всё есть, иначе `canvas`;
- `WebCodecsBackend` — mediabunny, MP4 H.264 + AAC, кадры подаются с
  timestamp в секундах, аудио — последовательными фрагментами;
- `CanvasMediaRecorderBackend` — рисует кадры на canvas по стенным часам,
  микширует звук через `OfflineAudioContext` + `MediaStreamDestination`,
  пишет WebM;
- `renderVideo()` — выбирает бэкенд, отдаёт прогресс/стадию, поддерживает
  `AbortSignal`.

`assembleVideo.ts`:

- `renderExportFrameToCanvas` — единственная функция отрисовки кадра для
  экспорта; использует те же `sampleCameraFrame`, `drawDialogue`,
  `drawIntroOverlay`, `drawOutroOverlay`, `containRect`;
- `concatenateAudioBlobs` — fallback-склейка;
- `createStripSceneFromMedia` — лента.

`renderClock.ts` — формулы старта записи: `startDelayMs`, `frameTime`,
`waitForStart`. Вынесены отдельно, потому что в них дважды ошибались с
`leadIn`; теперь покрыты тестами.

### 9.10. Диагностика и здоровье

`projectHealth.ts`:

- `inspectProjectHealth({ project, timeline, images, audioIds, ... })` —
  6 категорий, статус готовности, список проблем с id, severity, сообщением и
  подсказкой;
- `validateTimelineFull` — структурная проверка;
- проверка длительностей: < 0.2 с и > 60 с — предупреждения;
- `buildDiagnosticReportJson` — JSON со схемой, ревизией, ресурсами,
  таймлайном, SRT, журналом событий;
- `renderExportAudioMixPreviewWav` — WAV-предпрослушивание финального микса;
- `formatRangeTooltip`, `formatClipTooltip`, `formatGapTooltip` — тултипы
  таймлайна.

`environmentProbe.ts` — 5 проверок окружения для онбординга и
`environmentProbeReport`.

`projectSettings.ts` — `resolveTTSProviderId`: явный выбор → проект → дефолт.

`voiceButtonState.ts` — когда кнопка озвучки активна/заблокирована.

`objectUrlRegistry.ts` — refCount-реестр `URL.createObjectURL` с
`acquire`/`release`/`releaseAll`, чтобы не течь памятью.

`audioPlayer.ts` — `UnifiedAudioPlayer`:

- единый плеер для Preview и Timeline;
- статусы `idle/loading/canplay/playing/paused/waiting/stalled/ended/error`;
- `formatMediaElementError` — человеческие сообщения для `MediaError`
  (`format`, `decode`, `autoplay`, `network`);
- `convertAudioBufferToWavBlob`, `pcmToWav` — WAV-обёртки;
- синхронизация с `ProjectClock` по `requestAnimationFrame`;
- WAV-fallback для форматов, которые `HTMLAudioElement` не берёт.

`historyManager.ts` — `HistoryManager` на 50 снимков; снимок включает панели,
`audioDurations`, `timeline`, `srt`, `panelGap`, блокировки дорожек.

`demoProject.ts` — готовый демо-проект: 1 изображение (JPEG из `/demo-images`
или встроенный SVG), 2 панели `[0..50%]` и `[50..100%]`, тексты, интро/аутро по
1.5 с, пауза 0.2 с, синтезированные WAV (220 Гц и 330 Гц) — без вызова платного
TTS.

`environmentProbe`, `demoProject`, `onboarding` — новые модули v1.3.18,
помеченные в коде, хотя `package.json` ещё 1.3.17.

---

## 10. Провайдеры LLM и TTS

### 10.1. LLM (анализ изображений, перевод, SEO)

`providers/llm/catalog.ts` содержит **12 провайдеров + custom**:

| id | Название | Vision | Free/trial |
|---|---|---|---|
| `gemini` | Google Gemini | да | free (15 RPM / 30 RPD) |
| `nvidia-nim` | NVIDIA NIM | да | free (~40 RPM) |
| `groq` | Groq | да | free (30 RPM / 14 400 RPD) |
| `openrouter` | OpenRouter | да | free-модели `:free` |
| `mistral` | Mistral AI | да | free-режим |
| `huggingface` | Hugging Face | да | free (300 req/час) |
| `cloudflare` | Cloudflare Workers AI | да | free (10k Neurons/день) |
| `siliconflow` | SiliconFlow | да | free tier |
| `zhipu` | Zhipu AI | да | free (1 concurrent) |
| `ai21` | AI21 Labs | да | trial |
| `novita` | Novita AI | да | trial |
| `moonshot` | Moonshot (Kimi) | да | trial ($5/30 дней) |
| `custom` | OpenAI-compatible | да | локальный endpoint (LM Studio/Ollama/vLLM) |

В README заявлено «25+ LLM» — это маркетинговое число из `links.ts`, где
перечислены ссылки на 25 LLM-сервисов; **реализованных в каталоге провайдеров —
13** (включая custom). Часть сервисов (GitHub Models, Cerebras, SambaNova,
OpenAI, Anthropic, Cohere, DeepSeek, Together, Fireworks, DeepInfra, 01.AI,
Perplexity) описана только в таблице ссылок и в легаси-прокси `/api/llm` /
`/api/seo`, но не имеет собственного объекта `LLMProvider`.

Устройство:

- `LLMProvider` — `id`, `name`, `description`, `baseUrl`, `models`,
  `defaultModel`, `freeTier`, `trialOnly`, `limitsUrl`, `rateLimits`,
  `supportsVision`, `visionModels`, `chat()`, `vision()`;
- `createOpenAICompatibleProvider` — фабрика для OpenAI-совместимых API;
- `resolveLLMVisionModel` и `getLLMProviderVisionModels` — **явный allowlist**
  моделей с поддержкой изображений: флаг `supportsVision` сам по себе не
  доказывает, что каждая модель принимает картинки;
- `FREE_FALLBACK_CHAIN = ['gemini','groq','nvidia-nim','openrouter','mistral']` —
  переключение только между постоянными бесплатными провайдерами;
- `getLLMProvider('google-ai')` — алиас на `gemini` для старых проектов;
- `providers/llm/router.ts` — `mapLLMProviderError` переводит HTTP-ошибки в
  конкретные подсказки: квота Gemini (00:00 PST), кредиты NVIDIA (402), Account
  ID Cloudflare, лимит Mistral Experiment (5 RPM), перегрузка HF (503), лимит
  Groq (30 RPM), общий 429;
- `getLLMHttpError` вытаскивает `{ status, responseBody }` из текста ошибки,
  чтобы внешний код мог решить, делать ли fallback.

### 10.2. TTS (15 провайдеров)

| id | Free tier | Особенности |
|---|---|---|
| `gemini` | да | 200+ голосов, хороший русский, тот же ключ, что LLM; PCM → WAV |
| `elevenlabs` | 10k симв/мес | лучшее качество, Multilingual v2, CORS → прокси |
| `azure` | 500k симв/мес F0 | нейронные, отличный RU, CORS → прокси |
| `google-cloud` | 4M Standard / 1M WaveNet | 380+ голосов, 75+ языков |
| `speechify` | ограничен | 1000+ голосов, experimental |
| `openai` | платно ($15/1M) | tts-1 / tts-1-hd, CORS → прокси |
| `polly` | 5M / 12 мес | нейронные, JSON-ключ, `proxyClientSide` |
| `qwen` | 1M free | 49 голосов, 10 языков, PCM → WAV |
| `cartesia` | free tier, 40 мс | Sonic 3, отдельная версия API 2024-06-10, ретрай без `speed` на 400 |
| `hume` | free tier | Octave 2, эмоциональная, experimental |
| `deepgram` | $200 credit | Aura-2 / Flux, язык закодирован в id голоса |
| `playht` | free tier | 900+ голосов, клонирование, experimental |
| `resemble` | free tier | клонирование, эмоции, experimental |
| `murf` | free tier | 120+ голосов, experimental |
| `fish` | free tier | 50+ языков, experimental |

Устройство:

- `TTSProvider` — `id`, `name`, `freeTier`, `experimental?`,
  `proxyClientSide?`, `languages`, `defaultModel`, `supportedModels`,
  `getVoices()`, `getModels()`, `generate()`, `serverGenerate()`;
- `cors.ts` — единая политика:
  - `CORS_BLOCKED_PROVIDERS = { elevenlabs, openai, polly, azure, deepgram }`;
  - `CLIENT_PROXY_PROVIDERS = { playht, resemble, murf, fish, hume, speechify }`;
  - `mustUseProxy()` = объединение; один источник правды и для клиента, и для
    сервера;
- `router.ts` (клиент) — `generateTTS()`: CORS-провайдеры идут через
  `/api/tts`, остальные — прямым `fetch`; возвращает `{ buffer, mimeType }`;
  `mapTTSProviderError` даёт подсказки (права ключа ElevenLabs, 401 OpenAI,
  и т.д.);
- `mime.ts` — `detectAudioMime` по magic bytes, `resolveAudioMime(providerId,
  buffer)`, `providerMimeType`; это исправляет случаи, когда Gemini/Qwen
  отдавали WAV, а помечались как MP3;
- `wav.ts` — `pcmToWav`, конвертация PCM (L16 24 кГц моно) в WAV на клиенте и
  на сервере;
- `voice-resolver.ts` — `resolveVoice(providerId, apiKey, explicit?, language?)`
  и `FALLBACK_VOICE`; для `experimental` провайдеров авто-выбор запрещён,
  `'default'` не считается голосом у resemble/fish; для Deepgram проверяется,
  что язык входит в поддерживаемые, иначе честная ошибка, а не английский
  голос;
- `links.ts` — 44 ссылки: 25 LLM + 15 TTS + 3 STT + custom; каждая с
  `keyUrl`, `docsUrl`, лимитами и free tier. Один источник правды для UI.

#### 10.2.1. Общий транспорт запросов (`providers/http.ts`)

Раньше каждый провайдер вызывал `fetch` сам и сам придумывал обработку ошибки.
Отсюда были три системные дыры: **ни у одного запроса не было таймаута**,
**429/503 нигде не повторялись**, а текст ошибки у каждого провайдера был свой,
поэтому `mapTTSProviderError`/`mapLLMProviderError` угадывали статус регуляркой
по сообщению. Теперь сеть описана в одном месте:

| Что | Значение по умолчанию |
|---|---|
| Таймаут одной попытки | 25 с (TTS/LLM-прокси), 30 с в самом транспорте |
| Повторы | 2 (всего 3 попытки) на 408, 425, 429, 500, 502, 503, 504 |
| Пауза | `Retry-After`, иначе экспонента 400 мс → x2 с джиттером 0.5–1.0 |
| Потолок паузы | 8 с |
| Бюджет запроса | 50 с у маршрутов (110 с у Whisper) — меньше `maxDuration` |
| Отмена | `req.signal` → `AbortError` → 499, повторов нет |
| Формат ошибки | `<Label> error: <status> — <body>` (тело целиком в `error.body`, обрезано в сообщении) |

- `providerFetch()` возвращает `Response`; тело читает вызывающий. С
  `throwOnHttpError: false` не-2xx отдаётся как есть — это нужно деградации
  `response_format` в LLM, где 400/422 анализируются по телу (400/422 в список
  повторяемых не входят, поэтому число запросов не растёт);
- `assertProviderTarget()` — защита от SSRF для пользовательского `baseUrl`
  (`/api/llm`, `/api/seo`): только `http/https`, без креденшелов в URL, всегда
  запрещены адреса облачных метаданных (`169.254.169.254`,
  `metadata.google.internal`, …). Loopback и приватные сети **разрешены** — это
  официальный сценарий «локальный Ollama/LM Studio»; для публичного инстанса
  есть `MVS_BLOCK_PRIVATE_PROVIDERS=1`;
- `tts/transport.ts` — тонкая обёртка `ttsFetch()` с TTS-дефолтами, чтобы
  провайдер описывал только тело и заголовки;
- `providers/schemas.ts` — zod-схемы тел `/api/tts`, `/api/llm`, `/api/seo`,
  `/api/tts/voices`: 400 с `code: invalid_request` и списком проблемных полей
  вместо падения в невнятном месте.

**Маршрут `/api/tts` больше не содержит `switch` по провайдерам.** Он валидирует
тело, берёт реализацию (`tts/server/overrides.ts` → `serverGenerate` →
`generate()`) и переводит сбой в статус. Серверное переопределение сейчас одно —
Polly (SigV4 через `@aws-sdk/client-polly`), потому что его клиентская
`generate()` ходит в `/api/tts`. Новый провайдер добавляется файлом и записью в
реестре, без правки маршрута: раньше ветки маршрута дублировали тела провайдеров
и уже расходились с ними (Azure считал `prosody rate` в процентах, а ветка
писала `rate='1'`; Qwen в ветке терял base64-фолбэк).

### 10.3. STT

- `/api/whisper` умеет две вещи:
  1. принять `timeline` и вернуть SRT, собранный из таймлайна
     (`method: 'timeline'`);
  2. принять аудио + ключ OpenAI → Whisper API; либо локальный
     `nodejs-whisper`, если пакет установлен.
- Если зависимости нет — мягкий ответ `method: 'unavailable'`, а не падение.
- В UI отдельной кнопки «субтитры из аудио» нет: SRT собирается из таймлайна.

---

## 11. Серверные маршруты (API)

| Маршрут | Методы | Runtime | Назначение |
|---|---|---|---|
| `/api/tts` | POST | nodejs, 60 с | прокси TTS для всех 15 провайдеров (общая диспетчеризация, без `switch`) |
| `/api/tts/voices` | GET, POST | nodejs | список голосов провайдера (POST — с ключом) |
| `/api/llm` | POST | nodejs, 60 с | легаси-прокси LLM для не-CORS провайдеров; Anthropic → 501 |
| `/api/seo` | POST | nodejs, 60 с | прокси генерации SEO-пакета |
| `/api/whisper` | POST | nodejs, 120 с | SRT из таймлайна / Whisper API / nodejs-whisper |
| `/api/cloud/project` | GET, POST, DELETE | nodejs, 10 с | JSON-снапшоты в Supabase, TTL 24 ч |
| `/api/cleanup` | GET | nodejs, 10 с | cron: RPC `mvs_delete_expired_snapshots`, защищён `CRON_SECRET` (Bearer) |

Особенности `/api/tts`:

- тело валидируется zod-схемой `TTSRequestSchema`: 400 `invalid_json` /
  `invalid_request` (с полями) вместо исключения в глубине провайдера;
- для экспериментальных провайдеров без голоса — `400 voice_required`;
- если серверной реализации нет — `501 no_server_generate` (без молчаливой
  рекурсии «сервер → /api/tts → сервер»);
- Polly и `nodejs-whisper` подгружаются через `createRequire` и **не входят** в
  `package.json` — это опциональные пакеты; имя модуля собирается в runtime,
  чтобы Turbopack не пытался его разрешить;
- MIME ответа определяется по фактической сигнатуре (`resolveAudioMime`);
- ошибки провайдеров прогоняются через `mapTTSProviderError`;
- таймаут апстрима — `504 provider_timeout`, сетевой сбой — `502
  provider_network`, отмена клиентом — `499 aborted`: UI больше не показывает
  «вечную загрузку» из-за зависшего провайдера.

Особенности `/api/cloud/project`:

- `validProjectId` — regex `^[a-zA-Z0-9_-]{1,160}$`;
- `sanitizeProject` вырезает `keys`, `apiKey`, `openaiKey` — ключи никогда не
  попадают в снапшот;
- очистка просроченных записей выполняется REST-фильтром `expires_at=lte.now`
  перед чтением/записью, поэтому TTL работает даже без cron;
- без Supabase — 503, клиент молча остаётся в локальном режиме.

`vercel.json` ставит cron `/api/cleanup` на `0 3 * * *`.

---

## 12. Интерфейс

### 12.1. Дизайн-система

- Палитра: `#0B0B0C` (фон), `#16161A` (карточка), `#1E1E23` (ховер),
  `#26262C` (граница), `#2F2F36` (граница ховера), `#F5F5F7` (текст),
  `#8A8A93` (вторичный), `#E8B44C` (amber accent), `#4ADE80` (успех),
  `#F87171` (ошибка).
- Типографика: Inter / system-ui, моноширинные цифры и таймкоды.
- Принцип «one action one screen»: одна колонка `max-w-960`, без вкладок,
  контекстная панель снизу, модалки только для редких действий.
- UI-примитивы в `components/ui` повторяют shadcn-подход (class-variance-authority,
  tailwind-merge, clsx), но написаны вручную.
- Все интерактивные элементы имеют `data-testid` / `data-*` атрибуты для E2E:
  `[data-video-clip-id]`, `[data-audio-clip-id]`, `[data-trim-handle="in"]`,
  `[data-linked-clip-highlight]`, `open-onboarding-btn`,
  `create-demo-project-btn` и др.

### 12.2. Экраны

| Экран | Файл | Что делает |
|---|---|---|
| Главная | `app/page.tsx` | загрузка, демо, список последних проектов (до 9 превью), удаление |
| Мастер | `components/onboarding/OnboardingWizard.tsx` | 5 шагов настройки, проверки ключей, создание демо |
| Провайдеры | `app/settings/page.tsx` + `ProviderList.tsx` | два таба: «Анализ и текст», «Озвучка»; строки с ключом, тестом, ссылкой, лимитами, FREE/TRIAL/VISION бейджами, Account ID для Cloudflare |
| Редактор | `app/editor/[id]/page.tsx` | всё остальное |
| Ошибка редактора | `app/editor/[id]/error.tsx` | error boundary |

### 12.3. Модалки редактора

| Модалка | Назначение |
|---|---|
| `ScenarioModal` | текст сценария, перевод, предупреждения, применение |
| `VoicesModal` | распределение голосов, прослушивание, пол персонажа |
| `IntroOutroModal` | текст и длительность интро/аутро, AI-генерация, озвучка, загрузка аудио |
| `AudioImportModal` | таблица плана импорта, манифест, ручные назначения, откат |
| `ExportModal` | варианты экспорта, бэкенд, прогресс/ETA/отмена, health-отчёт, прослушивание микса, диагностический JSON |
| `ProjectHealthModal` | 6 категорий проблем и кнопка диагностического JSON |

### 12.5. Из чего собран редактор

`src/app/editor/[id]/page.tsx` — 16 строк: получает `id`, вызывает
`useEditorController(id)` и рендерит `EditorView`. Вся логика живёт в
`src/components/studio/editor/`, ни один файл не превышает 400 строк:

| Модуль | Строк | Ответственность |
|---|---:|---|
| `useEditorController.ts` | 338 | композиция: порядок хуков и один объект `EditorController` |
| `useEditorState.ts` | 151 | 40+ `useState`/`useRef`: всё изменяемое состояние |
| `useEditorDerived.ts` | 89 | `useMemo`: таймлайн, длительность, черновик SRT, стоимость, health |
| `EditorView.tsx` | 251 | шапка, баннеры, подвал, подключение модалок |
| `EditorWorkspace.tsx` | 275 | превью, режим рендера, таймлайн, инспектор панели |
| `EditorModals.tsx` | 204 | шесть модалок редактора |
| `useEditorProjectLoader.ts` | 205 | IndexedDB + OPFS + миграция схемы, ошибки загрузки |
| `useEditorPersistence.ts` | 99 | автосейв (2 с дебаунс), `handleSave`, `updateProject` |
| `useEditorImages.ts` | 69 | добавление изображений в существующий проект |
| `useEditorAudioOps.ts` | 315 | генерация TTS, SEO, точечная переозвучка |
| `useEditorAudioImport.ts` | 173 | план импорта, OPFS-журнал, слияние с таймлайном, откат |
| `useEditorExport.ts` | 320 | рендер видео, ZIP проекта, диагностический JSON |
| `useEditorNle.ts` | 298 | trim/split/mute/solo/ripple, undo/redo, блокировки дорожек |
| `useEditorDialogue.ts` | 282 | интро/аутро, озвучка, импорт аудио интро/аутро |
| `useEditorPlayback.ts` | 210 | часы, плеер, seek, горячие клавиши |
| `useEditorScenario.ts` | 153 | сценарий, перевод, применение к панелям |
| `useEditorSrtOps.ts` | 78 | SRT в текст и обратно, пауза между репликами |

Правило: новый код редактора попадает в тот модуль, который уже отвечает за
эту область; `useEditorController` только соединяет их (в нём нет ни одной
бизнес-операции) и отдаёт представлению один объект `EditorController`.

## 13. Аутентификация и безопасность

`src/proxy.ts` (в Next.js 16 заменяет `middleware.ts`, matcher
`/((?!_next/static|_next/image|favicon.ico).*)`):

- если `MVS_PASSWORD` не задан — приложение открыто;
- иначе:
  - `GET /__logout` — сбрасывает cookie;
  - `POST /__auth` — форма с паролем; при верном пароле ставится httpOnly
    cookie `mvs_auth` с **SHA-256 хешем** пароля (не самим паролем),
    `SameSite=Lax`, `maxAge` 30 дней, `Secure` — только при
    `MVS_SECURE_COOKIE=1` (по умолчанию выключен, чтобы self-host по http мог
    войти);
  - `?password=...` — обратная совместимость со старыми ссылками: ставит cookie
    и редиректит на чистый URL;
  - `Authorization: Basic ...` — поддержка basic-auth;
  - `/api/*` без авторизации — `401 JSON`, остальные — HTML-страница логина;
  - сравнение токенов — timing-safe (`diff |= charCode ^ charCode`);
- пароль больше не попадает в URL (POST-форма), это исправление v1.3.2.

Ключи провайдеров:

- лежат только в `localStorage` браузера (`mvs-info:keys`);
- на сервер уходят только в теле конкретного запроса к `/api/tts` или
  `/api/llm` и не логируются;
- в облачный снапшот не попадают (`sanitizeProject`);
- экспорт всех данных может включать ключи только по явному флагу
  `includeKeys: true` (dev-хелпер).

Прочее:

- `/api/cleanup` защищён `CRON_SECRET` (Bearer), если переменная задана;
- Supabase работает с `service_role`-ключом **только на сервере**;
  `.env.example` прямо запрещает `NEXT_PUBLIC_` для этих значений;
- RLS включён, доступ `anon`/`authenticated` к таблице и функции отозван —
  API ходит service-role-ключом;
- `next.config.ts` не включает COOP/COEP (приложение не требует
  cross-origin isolation);
- зависимости `@aws-sdk/client-polly` и `nodejs-whisper` — внешние, не
  бандлятся.

---

## 14. Облако: Supabase + Vercel

### 14.1. Что нужно

1. Выполнить `supabase/schema.sql` в SQL Editor.
2. В Vercel задать переменные:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
MVS_PASSWORD=<пароль приложения>
MVS_SECURE_COOKIE=1
CRON_SECRET=<секрет для /api/cleanup>
```

3. Redeploy.

Если Supabase не настроен — приложение полностью работоспособно локально;
`/api/cloud/project` вернёт 503, клиент это молча проглотит.

### 14.2. Схема БД

```sql
create table public.mvs_project_snapshots (
  project_id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index ... on (expires_at);
alter table ... enable row level security;
create function public.mvs_delete_expired_snapshots() returns integer ...
revoke all on function ... from public;
revoke all on table ... from anon, authenticated;
```

### 14.3. TTL и очистка

- TTL 24 часа от последнего сохранения;
- удаление при каждом чтении/записи (REST-фильтр) + Vercel Cron раз в сутки в
  03:00;
- локальные проекты и OPFS-файлы старше 24 часов тоже удаляются
  (`PROJECT_TTL_MS`), чтобы браузерное хранилище не росло бесконечно;
- ручное «вечное» сохранение — ZIP-архив проекта.

### 14.4. Ограничения Vercel

- serverless-функции: `/api/tts` 60 с, `/api/whisper` 120 с,
  `/api/cloud/project` и `/api/cleanup` 10 с;
- прокси TTS не должен вызывать сам себя: `getServerGenerate` возвращает
  `null` для `proxyClientSide`-провайдеров.

---

## 15. Десктопный режим (Electron)

`electron/main.js`:

- создаёт `BrowserWindow` 1280×800 (минимум 1024×700), фон `#0B0B0C`,
  `nodeIntegration: false`, `contextIsolation: true`, preload;
- проверяет, жив ли сервер (`checkServer` принимает 200, 401, 301, 302 —
  важно, когда включён `MVS_PASSWORD`);
- если сервера нет — запускает `npm run dev` (в dev) или `npm run start`
  (в упакованном виде) на `0.0.0.0:3000`;
- меню: «Файл» (перезагрузка, настройки провайдеров, выход), «Вид»
  (DevTools, зум, полный экран), «Помощь» (открыть в браузере, документация);
- при закрытии убивает дочерний процесс Next.

`electron/preload.js`:

```js
contextBridge.exposeInMainWorld('mangaStudio', {
  version: '1.3.17',
  isElectron: true,
  platform: process.platform,
});
```

Скрипты: `npm run desktop`, `npm run desktop:dev` (concurrently + wait-on),
`npm run desktop:build` (`next build && electron-builder`).

---

## 16. Установка и лаунчеры

### 16.1. Linux / macOS

| Файл | Что делает |
|---|---|
| `install.sh` | проверка Node, `npm ci --legacy-peer-deps --no-audit --no-fund`, fallback на `--ignore-scripts` при TLS-ошибке postinstall Electron, подсказки по Polly/Whisper |
| `run.sh` | меню из 7 пунктов: установка, браузер, окно Chrome App, Electron, production build+start, `/settings`, выход |
| `start-browser.sh` | проверка порта 3000, установка при необходимости, `next dev` |
| `start-window.sh` | то же + запуск Chrome в режиме app 1280×800, pid/log в `.dev-window.*` |
| `start-electron.bat` | только Windows |

### 16.2. Windows

`install.bat`, `run.bat`, `start-browser.bat`, `start-window.bat`,
`start-electron.bat`. Все они:

- проверяют Node;
- используют те же флаги npm (`--legacy-peer-deps --no-audit --no-fund`);
- имеют fallback `--ignore-scripts` для корпоративных сетей;
- в `start-electron.bat` проверяют, что бинарь Electron реально появился
  (`node_modules/electron/dist/electron.exe`), иначе объясняют причину и
  уходят в Chrome-режим;
- обязываются быть в CRLF (`.gitattributes`), иначе `cmd.exe` ломает `goto` и
  метки;
- проходят структурные проверки `check-launchers.mjs`:
  - `::` внутри блоков `(...)` запрещён (это метка, а не комментарий);
  - `:метка` внутри блоков запрещена;
  - круглые скобки в `echo` внутри блоков запрещены;
  - `%ERRORLEVEL%` в `echo` внутри блока запрещён (раскрывается раньше);
  - `npm`-вызовы обязаны иметь `--no-audit --no-fund`, в том числе под
    `start /wait`, `npx npm`, `call npm.cmd`.

### 16.3. Проверка окружения

`npm run setup` (`scripts/setup.mjs`) проверяет:

- версию Node (рекомендует ≥ 22.17 для тестов);
- наличие `node_modules`;
- `ffmpeg` / `ffprobe` в PATH (для smoke-проверок контейнеров);
- Chromium / Playwright / `CHROMIUM_PATH`;
- целостность лаунчеров.

### 16.4. CI

`.github/workflows/ci.yml`:

- job `verify`: матрица `ubuntu-latest` + `windows-latest` (`fail-fast: false`),
  Node 22, `npm ci --ignore-scripts`, потолок 25 минут;
- шаги: `typecheck` → `test` → `lint` → `build` → `smoke:server` → `smoke:editor`
  на Linux и `smoke:editor --quick` на Windows (Chrome ставится через `choco`
  с `continue-on-error`, чтобы сетевой сбой не ломал прогон);
- `upload-artifact` с `artifacts/smoke-editor` и `artifacts/smoke-onboarding`,
  `if: always()`, retention 14 дней — поэтому локальные артефакты в git не нужны;
- job `desktop`: та же матрица, `npm ci` с postinstall (нужен бинарь Electron),
  `next build` → `electron-builder --publish never` → выгрузка `*.AppImage`,
  `*.exe` и `*-unpacked/**`. Загрузка не падает из-за формата
  (`if-no-files-found: warn`), но следующий шаг проверяет, что `release/` не
  пуст, и роняет джобу — «зелёной» сборки без артефакта не бывает;
- в job `verify` desktop **не** собирается, поэтому ни `electron-builder`, ни
  проверки `release/` там нет: проверка «`release/` не пуст» живёт только в job `desktop`.

---

## 17. Тесты, проверки, CI

### 17.1. Скрипты

```bash
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm test                # tsx --test, 43 файла;
                        #  число кейсов — снимок, L-17)
npm run smoke:server    # next start + живые маршруты
npm run smoke:editor    # E2E Chromium
npm run smoke:onboarding# E2E мастера + демо
npm run smoke:audio     # OfflineAudioContext → WAV
npm run smoke:tts       # живая проверка TTS по ключам
npm run verify          # всё, включая тесты и сборку
npm run verify:quick    # без npm test
```

### 17.2. Что покрыто юнит-тестами (43 файла)

| Группа | Файлы |
|---|---|
| Звук | `wav`, `mime`, `audioMix`, `audioSignature`, `audioImport`, `audioImportV2AndFormats`, `voicePipeline`, `deepgram`, `cartesia`, `gemini`, `speechify`, `providerErrorMapping` |
| Таймлайн/часы/NLE | `renderClock`, `pipelineScheduler`, `syncClockAndTimeline`, `nleStorageAndExport` (1 252 строки: revision, манифест, квоты, ZIP round-trip) |
| Блокировки дорожек и схема v3 | `projectLocksV3` (миграция 2→3, `assertTrackUnlocked`, реальные NLE-операции с `locks`, передача `project.locks` из редактора) |
| Квота OPFS | `opfsQuota` (нет `estimate`, нехватка места, предупреждение о запасе) |
| Сценарий | `scenario`, `scenarioFormat`, `scenarioRanges`, `stripDialogueParity` |
| Лента/камера | `mangaStrip`, `cameraStripAndGeometry`, `draw` |
| Провайдеры | `llmProviderCatalog`, `ttsProviderPolicy`, `providerRegistry` (43 записи, CORS-политика, ссылки), `providerTransport` (таймауты, повторы, `Retry-After`, бюджет, SSRF-гард), `ttsRoute` и `llmProxyRoute` (маршруты как чёрный ящик: статусы, коды, тела запросов), `voiceResolver`, `projectSettings` |
| SRT/каналы | `srt`, `channel` |
| UI/фидбек | `feedback` (баннеры вместо `alert`/`confirm`), `browserSupport` (предупреждение о неподдерживаемом браузере), `chunkReload` (детект «Failed to load chunk», авто-перезагрузка устаревшей вкладки с анти-циклом) |
| Инфраструктура | `desktopConfig` (файлы main.js/preload.js и electron-builder), `editorControllerContract` (спреды контроллера, дубли ключей, лимит 400 строк), `loadImage`, `onboardingAndDemo`, `previewVsExportIntroOutro` |

Характерная черта: тесты проверяют **поведение**, а не поиск подстрок в файлах;
там, где это возможно, — чистые функции. Для браузерных API есть
`tests/fixtures/browserEnv.ts` (226 строк) — фейковое окружение.

### 17.3. E2E smoke (`scripts/smoke-editor.mjs`, 855 строк)

Поднимает Next на свободном порту, запускает headless Chromium и проверяет:

1. загрузку PNG 100×2000 на главной → создание проекта в IndexedDB + OPFS;
2. применение сценария с двумя панелями `[0..50%]` и `[50..100%]`;
3. интро/аутро по 0.4 с, импорт двух WAV по 0.6 с, пауза 0.2 с — итог 2.20 с;
4. двустороннюю подсветку `.selected` на видео- и аудиоклипах;
5. pointer-события на `[data-trim-handle="in"]` с проверкой `trimIn` и роста
   `timelineVersion`;
6. pointer-события перетаскивания `[data-video-clip-id="0"]` на позицию 1;
7. seek и Play/Pause с проверкой роста `currentTime`;
8. кадры Preview и Export в фазах intro/panel/gap/outro в режимах `panels` и
   `strip` + сводные таблицы сравнения;
9. экспорт клипа ≤ 3 с, проверку размера, сигнатуры WebM/MP4, 1920×1080 и
   длительности.

Результаты складываются в `artifacts/smoke-editor/` и дублируются в системный
tmp. В git они **не** попадают (`.gitignore` → `/artifacts/`): это
регенерируемые бинарники. Визуальное доказательство живёт в CI — job `verify`
выгружает `artifacts/smoke-editor` и `artifacts/smoke-onboarding` как
артефакты сборки (`actions/upload-artifact`, 14 дней), поэтому упавший прогон
всегда оставляет скриншоты и WebM для разбора.

`smoke-onboarding.mjs` (425 строк) снимает 15 скриншотов мастера, демо-проекта,
плеера, мобильного layout 375×667 и Firefox-UA-предупреждения.

### 17.4. Границы проверок (честно)

- `npm run verify` и CI доказывают: типы, сборку, старт прод-сервера, живые
  маршруты, структуру лаунчеров, большинство доменной логики.
- **Не доказывают**: корректность форматов запросов к внешним API и валидность
  дефолтных голосов. Это проверяется только живым ключом:
  ```bash
  PROVIDER_KEYS='{"cartesia":"...","deepgram":"..."}' npm run smoke:tts
  npm run smoke:tts -- cartesia
  ```
- Совпадение Preview и Export гарантируется **структурно** (общие функции
  отрисовки, инварианты Canvas 2D), а не побитовым сравнением сжатых кадров
  (L-12).
- Safari официально не поддерживается (L-2).

---

## 18. Производительность и инженерные решения

| Проблема | Решение в коде |
|---|---|
| Долгое декодирование длинных webtoon-полос | `loadImage.ts` ждёт настоящий `load`/`decode`; превью перерисовывается, когда картинка догрузилась |
| Лимит canvas 32 767 px | лента в виртуальных координатах, рисуется только видимый срез 9-аргументным `drawImage` |
| Гигантский аудио-буфер на длинных роликах | планировщик с опережением ~4 с для Canvas; последовательные фрагменты для mediabunny; `mixAudioPlacements` оставлен только для WAV/MP3 |
| Утечка `AudioContext` (лимит ~6) | singleton + `closeSharedAudioContext` |
| Утечка `blob:` URL | `ObjectUrlRegistry` с refCount |
| Пересоздание blob URL при seek | переиспользование по ключу/Blob |
| Дублирование base64 всех изображений | превью через `URL.createObjectURL`, data URL читаются последовательно только для vision |
| Ререндер React на 60 fps | `ProjectClock` + троттлинг 20 Гц для React, Canvas — 60 fps |
| Повторный TTS за деньги | `sha256`-подпись аудио + общий OPFS-кэш + «Переозвучить» с `forceRegenerate` |
| Гонка при параллельных сохранениях | очередь `saveLocks` по projectId + временный snapshot + revision |
| Разъехавшийся A/V | `buildTimelineAudioPlacements` по `audioStart`, ресемплинг, `packStarts` с предупреждениями |
| Молчаливая потеря реплик при наложении | `packStarts` возвращает конфликты, UI показывает список обрезанных |
| Неверный MIME от TTS | `resolveAudioMime` по сигнатуре, а не по имени провайдера |
| Кэш «врёт» после правки текста | подпись аудио меняется → файл перегенерируется |
| Скачок зума на каждой панели | `sameImageSpan` — камера идёт по группе панелей одной страницы |
| Firefox/Safari ограничения | честно вынесены в `known-limits.md` и в проверку окружения |

---

## 19. Известные ограничения

Полный список — `known-limits.md` (L-1…L-18). Кратко:

| ID | Ограничение | Тип |
|---|---|---|
| L-1 | Квантование `HTMLAudioElement.currentTime` | платформа |
| L-2 | `OfflineAudioContext` и экспорт микса в Safari / старых Firefox | браузер |
| L-3 | Квота OPFS / IndexedDB | браузер |
| L-4 | Декодирование AIFF / CAF | браузер |
| L-5 | Режим `strip` — чистый вебтун без плашек (осознанное решение) | дизайн |
| L-6 | Мобильный layout вне рамок RC | продукт |
| L-7 | Синтетическая форма волны на клипах | продукт |
| L-8 | Solo/Mute только на уровне клипов | дизайн |
| L-9 | Состояние блокировки дорожек не сохраняется в IndexedDB | дизайн |
| L-10 | Индикатор `[X..Y%]` в шапке — статический диапазон активной панели | дизайн |
| L-11 | `smoke:editor` только Chromium и только Linux-CI | инфраструктура |
| L-12 | Preview = Export по структурным инвариантам, а не побитово | тестовая граница |
| L-13 | Node ≥ 22.17 / 24+ и эвристика распаковки `@sparticuz/chromium` | инфраструктура |
| L-14 | Pointer-события NLE разделены между unit-тестами и браузерным smoke | тестовая граница |
| L-15 | Таймаут отзыва `blob:` URL (60 с) при скачивании архивов > 2 ГБ | продукт |
| L-16 | Длинная webtoon-полоса (> 20 000 px) — виртуальная высота, а не лимит canvas | архитектура |

Плюс продуктовые ограничения, явно описанные в README:

- X-координаты панелей не поддерживаются — панель всегда на всю ширину;
- перекрывающиеся y-диапазоны не валидируются;
- `Anthropic` не проксируется (`/api/llm` → 501), потому что API не
  OpenAI-совместимый;
- часть TTS-провайдеров помечена `experimental` и требует явного голоса;
- SRT может быть «черновиком», пока не озвучены все панели.

---

## 20. Roadmap

Из `README.md`:

- [x] v1.1 — OPFS + TTS-кэш + TaskQueue + Zod + WEBM + demo
- [x] v1.2 — WebCodecs + mediabunny + MP4 + гигиена
- [x] v1.3 — «студия без хлама» (graphite + amber, одна колонка, контекстная панель)
- [x] v1.3.1 — 40+ провайдеров в `links.ts`, тест ключей, строки вместо карточек
- [x] v1.3.3 — режим ленты (webtoon scroll)
- [x] v1.3.15 — текстовый сценарий в редакторе
- [x] v1.3.16 — синхронная лента, SRT из `rebuildSrt`, интро/аутро, канал
- [x] v1.3.17 — y-диапазоны, жёсткие переносы в сценарии
- [x] длинные webtoon-полосы (900×12540) без потери пропорций
- [ ] v1.4 — Zustand-редактор + undo/redo + `.mvproj`
- [ ] v1.5 — фоновая музыка + batch queue persist
- [ ] v1.6 — Docker self-hosted

Важно: undo/redo и `.mvproj` фактически уже есть (`HistoryManager`,
ZIP-архив), поэтому roadmap-пункт v1.4 частично устарел.

---

## 21. Чек-лист запуска

### Локально (веб)

```bash
# 1. зависимости
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install

# 2. полная проверка репозитория
npm run verify

# 3. dev-сервер
npm run dev
# → http://localhost:3000

# 4. настройка
#    /settings → OpenRouter + Gemini + Azure (или свои)
#    или мастер «Настройка» на главной

# 5. сценарий использования
#    загрузить страницы → дождаться разбора → «Сценарий» или vision-панели
#    → «Голоса» → «Озвучить всё» → «Проверка» → «Экспорт» → MP4
```

### Production

```bash
npm run build
npm run start
# или
npm run verify
```

### Vercel

1. Импортировать GitHub-репозиторий.
2. Задать env-переменные (см. §14).
3. Выполнить `supabase/schema.sql`.
4. Redeploy.
5. Проверить `/`, `/settings`, `/editor/1`, `POST /api/tts` с пустым телом.

### Desktop

```bash
npm install --no-save electron --legacy-peer-deps --no-audit --no-fund
npm run desktop
# или ./run.sh → 4
```

---

## 22. Заметки разработчику

### 22.1. Куда смотреть при изменениях

| Задача | Файлы |
|---|---|
| Изменить формат сценария | `pipeline/scenario.ts`, `scenarioFormat.ts`, `tests/scenario*.test.ts` |
| Изменить раскладку/длительности | `pipeline/buildTimeline.ts`, `timelineValidator.ts`, `tests/srt.test.ts` |
| Изменить звук | `pipeline/audioMix.ts`, `audioPlayer.ts`, `tests/audioMix.test.ts` |
| Добавить TTS-провайдера | `providers/tts/<name>.ts`, `catalog.ts`, `cors.ts` (если нужен прокси), `/api/tts/route.ts`, `links.ts`, `tests/ttsProviderPolicy.test.ts` |
| Добавить LLM-провайдера | `providers/llm/catalog.ts`, `openai-compatible.ts` (если OpenAI-совместимый), `links.ts`, `ProviderList`, `tests/llmProviderCatalog.test.ts` |
| Изменить превью/кадр | `pipeline/cameraSampler.ts`, `overlayText.ts`, `draw.ts`, `Preview.tsx`, `assembleVideo.ts` |
| Изменить ленту | `pipeline/mangaStrip.ts`, `tests/mangaStrip.test.ts`, `cameraStripAndGeometry.test.ts` |
| Изменить экспорт | `pipeline/videoEncoder.ts`, `renderClock.ts`, `audioMix.ts`, `ExportModal` |
| Изменить хранение | `storage/db.ts`, `opfs.ts`, `resourceIntegrity.ts`, `projectArchive.ts` |
| UI-тему | `app/globals.css`, `tailwind`-классы в компонентах |

### 22.2. Правила, которые нельзя нарушать

1. Время меняется только через `ProjectClock`.
2. Кадр рисуется только через `sampleCameraFrame` + общие draw-функции; иначе
   превью и экспорт разъедутся.
3. SRT строится только `rebuildSrt`; `timelineVersion` должен монотонно расти.
4. Ключи провайдеров не уходят на сервер, кроме тела конкретного запроса.
5. TTS-провайдер, помеченный `proxyClientSide`, не может вызывать `/api/tts`
   из серверной ветки (рекурсия).
6. `experimental`-провайдеры не получают голос автоматически.
7. При изменении логики импорта аудио сначала меняются тесты
   `tests/audioImport.test.ts` (порядок приоритетов — контракт).
8. Версия задаётся только в `package.json` и подставляется сборкой (`NEXT_PUBLIC_APP_VERSION`).
9. `.bat` только CRLF; внутри блоков — `rem`, а не `::`.
10. Любая новая ветка логики должна быть либо покрыта unit-тестом, либо честно
    описана в `known-limits.md`.

### 22.3. Технический долг и риски

| Риск | Где | Комментарий |
|---|---|---|
| `Project` как «божественный объект» | `db.ts` | panel-поля, аудио, NLE, SEO, события в одной сущности |
| Ручной ZIP-кодек | `projectArchive.ts` | нет сжатия (stored), но зато без зависимостей |
| Оценка длительности по символам | `buildTimeline.ts` | черновой SRT и «прыгающая» длительность до озвучки |
| Тесты в основном unit | `tests/` | браузерное поведение покрыто E2E, но полный `smoke:editor` идёт только на Linux (на Windows — `--quick`) |
| Desktop-сборка проверяется только в CI | `electron-builder` | в песочнице без доступа к бинарю Electron локальная упаковка невозможна, поэтому `desktop`-job — единственная проверка артефактов |
| `check-providers` запускает `tsx` подпроцессом | `scripts/check-providers.mjs` | стабильно, но лишняя точка отказа; кандидат на предгенерённый JSON |
| Safari и мобильный layout | — | осознанно вне области стабилизации |

#### 22.3.1. Что закрыто стабилизацией (v1.3.17)

| Было | Стало |
|---|---|
| `page.tsx` — 2 326 строк монолита | 16 строк: `useEditorController` + `EditorView` + 16 модулей, каждый ≤ 400 строк (12.5) |
| Дублирование списков провайдеров в 5 местах | `lib/providers/registry.ts` — единственный источник, остальное проекции |
| `alert()`/`confirm()` в 6 местах | баннеры и двухшаговые кнопки (`lib/ui/feedback.ts`), проверка `tests/feedback.test.ts` |
| Расхождение версий в комментариях | версия живёт только в `package.json`, в исходниках не хардкодится |
| Число тестовых файлов в README «на честном слове» | цифры в доках — снимок; источник правды — `npm test` (см. `L-17`) |
| Блокировки дорожек только в состоянии компонента | схема проекта v3, `locks` переживают перезагрузку |
| `smoke`-артефакты в git | `.gitignore`, выгрузка в CI на 14 дней |
| Нет лицензии | `LICENSE` (MIT) + поле `license` |
| CI без Windows и без desktop | матрица `ubuntu+windows`, job `desktop` с артефактами |

### 22.4. Сильные стороны

- честная документация ограничений (`known-limits.md`) и «границ проверок»;
- продуманная работа с хранилищем: TTL, revision, манифест SHA-256, журнал
  импорта, ZIP-round-trip;
- единые источники времени, кадра, таймлайна, версии;
- 421 тест (43 файла) на чистых функциях и поведении;
- реальные E2E-проверки с артефактами (скриншоты, видео, кадры сравнения);
- кроссплатформенные лаунчеры и CI на Windows;
- отсутствие обязательного бэкенда и ключей на сервере.

---

## 23. Итоговая оценка

**Что это по сути:** зрелый (RC-уровня) вертикальный продукт «манга → озвученное
видео», собранный как локальное браузерное приложение с опциональным облаком.
Он закрывает весь путь пользователя: установка → настройка провайдеров →
загрузка страниц → разметка (Vision или сценарий) → голоса → озвучка →
таймлайн/NLE → превью → проверка → MP4/WebM + WAV + SRT + SEO → архив проекта.

**Уровень инженерии — выше среднего для пет-проекта:**

- продуманная модель данных и миграции;
- атомарные сохранения и оптимистическая блокировка;
- контроль целостности ресурсов и восстановление после сбоев;
- общие функции отрисовки для превью и экспорта;
- широкая сеть unit-тестов и браузерный E2E;
- кроссплатформенные лаунчеры с машинной проверкой структуры;
- честно задокументированные ограничения вместо обещаний.

**Главные слабости:**

- полный браузерный E2E идёт только на Linux (на Windows — сокращённый `--quick`);
- desktop-артефакты проверяются только в CI: локально electron-бинаръ
  недоступен без сети;
- отсутствие Safari и мобильного layout;
- часть «бесплатных» тарифов провайдеров меняется быстрее, чем обновляется
  каталог.

**Кому подойдёт:** автору манга-канала на YouTube, который готов завести свои
ключи LLM/TTS и получить локальный конвейер без подписок и загрузки страниц на
чужой сервер. **Кому нет:** тем, кто хочет «нажал кнопку — готово» без
настройки ключей, и тем, кто работает на Safari/iPad.

---

*Документ подготовлен по исходникам ветки `arena/9a70dac5-make`. Если код
изменится, актуальными остаются `README.md`, `known-limits.md` и
`DEPLOYMENT_GUIDE_RU.md`; этот файл — снимок состояния.*
