# Manga Voice Studio: подробный деплой на Vercel + Supabase

Этот документ описывает полный путь от GitHub-репозитория до работающего сайта на Vercel.

## 1. Что уже сделано

В репозитории `DMloaderJava/make` уже опубликован коммит:

```text
e8aea9e Add expiring Supabase snapshots and audio import hardening
```

Добавлены:

- Supabase snapshots проектов через `/api/cloud/project`;
- автоматический TTL: 24 часа с последнего сохранения;
- очистка просроченных snapshots перед запросами;
- ежедневный Vercel Cron через `/api/cleanup`, совместимый с Hobby-планом;
- очистка локальных IndexedDB/OPFS-проектов старше 24 часов;
- импорт внешних аудиофайлов на панели по манифесту, якорю, номеру или порядку;
- серверные переменные не попадают в клиентский JavaScript;
- 291 тест и production-сборка проходят.

SQL-схема уже применена к Supabase через Management API. В базе проверены:

```text
public.mvs_project_snapshots
public.mvs_delete_expired_snapshots()
```

## 2. Важное различие: anon key и service role key

Для Supabase используются два разных типа ключей:

- `anon`/publishable key — можно использовать в браузере, но он не должен иметь доступ к временным snapshots;
- `service_role` key — только серверный секрет Vercel. Он нужен API `/api/cloud/project` и `/api/cleanup`.

Текущий REST-запрос с обычным `SUPABASE_KEY` возвращает отказ прав — это ожидаемо, потому что доступ к таблице для `anon` и `authenticated` отключён.

В Vercel обязательно добавьте именно:

```text
SUPABASE_SERVICE_ROLE_KEY
```

Не добавляйте его как `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` и не помещайте в `localStorage`.

## 3. Переменные окружения Vercel

Откройте:

```text
Vercel → Project → Settings → Environment Variables
```

Добавьте следующие переменные во все окружения: **Production**, **Preview**, **Development**.

```env
SUPABASE_URL=https://ваш-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=ваш-service-role-key
MVS_PASSWORD=длинный-пароль-для-сайта
MVS_SECURE_COOKIE=1
CRON_SECRET=отдельный-длинный-секрет
```

Минимально обязательные для облачной синхронизации:

```env
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

`MVS_PASSWORD` защищает сайт общей парольной страницей. `MVS_SECURE_COOKIE=1` нужен для HTTPS-домена Vercel. `CRON_SECRET` защищает endpoint очистки; Vercel передаёт его cron-запросу автоматически.

Для **публичного** инстанса добавьте ещё одну переменную:

```env
MVS_BLOCK_PRIVATE_PROVIDERS=1
```

Она запрещает серверу ходить по адресам пользовательских LLM-провайдеров в
loopback и приватных сетях (`localhost`, `127.0.0.1`, `10/8`, `192.168/16`,
`172.16/12`). По умолчанию они разрешены, потому что self-hosted инсталляция
официально поддерживает локальные Ollama и LM Studio. Адреса облачных метаданных
(`169.254.169.254`, `metadata.google.internal`) блокируются **всегда**, независимо
от флага.

После добавления переменных нажмите:

```text
Deployments → последний deployment → Redeploy
```

## 4. Как подключить GitHub-репозиторий к Vercel

1. Откройте `https://vercel.com`.
2. Нажмите **Add New → Project**.
3. Выберите репозиторий `DMloaderJava/make`.
4. Установите настройки:

```text
Framework Preset: Next.js
Root Directory: .
Build Command: npm run build
Install Command: npm ci
Output Directory: пусто
Node.js Version: 22.x
```

5. Добавьте environment variables из раздела выше.
6. Нажмите **Deploy**.

Файл `vercel.json` уже содержит cron:

```json
{
  "crons": [
    {
      "path": "/api/cleanup",
      "schedule": "0 3 * * *"
    }
  ]
}
```

На Vercel Hobby разрешён только один запуск Cron в сутки, поэтому используется
расписание `0 3 * * *` — ежедневно в 03:00 UTC. Для TTL это не критично:
очистка также выполняется перед каждым чтением и сохранением snapshot через
`/api/cloud/project`, поэтому просроченная запись не будет возвращена даже до
ночного cron-запуска.

Проверить cron можно в Vercel в разделе **Settings → Cron Jobs**.

## 5. Проверка сайта после деплоя

Сначала проверьте главную страницу:

```bash
curl -I https://ваш-домен.vercel.app
```

Если задан `MVS_PASSWORD`, ожидаемый ответ без cookie может быть `401` — это нормально.

Проверьте health endpoint Whisper:

```bash
curl https://ваш-домен.vercel.app/api/whisper
```

Проверьте cleanup endpoint с секретом:

```bash
curl https://ваш-домен.vercel.app/api/cleanup \
  -H "Authorization: Bearer $CRON_SECRET"
```

Ожидаемый результат похож на:

```json
{"ok":true,"deleted":0}
```

## 6. Проверка Supabase из терминала

Для SQL Management API нужен Supabase Personal Access Token. Никогда не записывайте его в файл и не добавляйте в Git.

Безопасный вариант в текущем shell:

```bash
read -s SUPABASE_ACCESS_TOKEN
export SUPABASE_ACCESS_TOKEN
```

Получите project ref из URL:

```bash
export SUPABASE_URL="https://ваш-project-ref.supabase.co"
export SUPABASE_PROJECT_REF="$(printf '%s' "$SUPABASE_URL" | sed -E 's#https?://([^.]+)\\.supabase\\.co.*#\\1#')"
echo "$SUPABASE_PROJECT_REF"
```

Проверка доступа:

```bash
curl -sS \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  https://api.supabase.com/v1/projects
```

Выполнение SQL-файла из репозитория:

```bash
python3 - <<'PY'
import json, os
from pathlib import Path
from urllib.request import Request, urlopen

sql = Path('supabase/schema.sql').read_text()
ref = os.environ['SUPABASE_PROJECT_REF']
token = os.environ['SUPABASE_ACCESS_TOKEN']
request = Request(
    f'https://api.supabase.com/v1/projects/{ref}/database/query',
    data=json.dumps({'query': sql}).encode(),
    headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    },
    method='POST',
)
with urlopen(request, timeout=60) as response:
    print(response.status)
    print(response.read().decode())
PY
```

Проверка объектов напрямую через SQL:

```bash
python3 - <<'PY'
import json, os
from urllib.request import Request, urlopen

sql = """
select
  to_regclass('public.mvs_project_snapshots') as table_name,
  to_regprocedure('public.mvs_delete_expired_snapshots()') as function_name;
"""
ref = os.environ['SUPABASE_PROJECT_REF']
token = os.environ['SUPABASE_ACCESS_TOKEN']
request = Request(
    f'https://api.supabase.com/v1/projects/{ref}/database/query',
    data=json.dumps({'query': sql}).encode(),
    headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
    method='POST',
)
with urlopen(request, timeout=60) as response:
    print(response.read().decode())
PY
```

## 7. Как работает TTL 24 часа

При каждом автосохранении редактор:

1. сохраняет проект локально в IndexedDB/OPFS;
2. отправляет JSON snapshot на `/api/cloud/project`;
3. устанавливает `expires_at = now() + 24 hours`.

Перед каждым GET/POST API удаляет записи, у которых:

```sql
expires_at <= now()
```

Дополнительно ежедневный Vercel Cron запускает `/api/cleanup` и вызывает:

```sql
select public.mvs_delete_expired_snapshots();
```

Если сайт не открывался часами, данные всё равно будут удалены при следующем запросе. Cron нужен для очистки даже без посещения сайта.

## 8. Что хранится в Supabase

Хранится JSON-состояние проекта:

- название;
- панели;
- сценарий;
- timeline;
- длительности;
- настройки проекта;
- SEO-данные;
- отметки импортированного аудио.

Не отправляются:

- ключи LLM/TTS;
- `localStorage` с API-ключами;
- service role key;
- браузерные cookies;
- файлы OPFS.

Изображения и аудио остаются в локальном OPFS браузера. Поэтому облачный snapshot не является полноценной заменой файловому backup. Для постоянного общего хранения файлов понадобится отдельная интеграция Supabase Storage.

## 9. Импорт аудиодорожки под изображения

В редакторе нажмите **Импорт аудио**.

Поддерживаются, если браузер умеет декодировать формат:

```text
mp3, wav, wave, ogg, oga, opus, m4a, aac, mp4, flac,
webm, weba, aif, aiff, caf
```

Порядок сопоставления:

1. строки `.txt`-манифеста;
2. якорь в имени файла, например:

   ```text
   Изображение 1 [0..30%].mp3
   ```

3. номер изображения/панели;
4. порядок файлов.

Пример манифеста:

```text
Изображение 1 [0..30%] = anna-01.mp3
Изображение 1 [30..100%] = anna-02.mp3
Изображение 2 = hero-03.wav
```

Перед записью приложение:

- проверяет, что файл не пустой;
- декодирует аудио;
- определяет длительность;
- проверяет свободное место OPFS;
- не перезаписывает существующее аудио без чекбокса **Перезаписать**;
- помечает панель как `audioSource: import`;
- исключает импортированное аудио из обычной массовой TTS-озвучки.

## 10. Локальная проверка перед push

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run test
npm run lint
npm run build
```

Линтер может показать предупреждения существующего проекта, но сборка не должна завершаться с ошибкой.

## 11. Безопасность после использования токена

Если Personal Access Token был введён не через защищённое поле или мог попасть в историю сообщений/терминала, после завершения миграции его следует отозвать в Supabase и создать новый токен:

```text
Supabase Dashboard → Account → Access Tokens → Revoke
```

Для работы приложения этот Personal Access Token не нужен. В Vercel должен находиться только `SUPABASE_SERVICE_ROLE_KEY` проекта.
