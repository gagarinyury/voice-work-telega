# Инструкция по деплою

## Шаг 1: Установка Wrangler

```bash
cd /Users/yurygagarin/code/equipment-journal
npm install -g wrangler
wrangler login
```

## Шаг 2: Создание D1 базы данных

```bash
wrangler d1 create equipment_journal
```

Скопируй `database_id` из вывода и вставь в `wrangler.toml` вместо `TBD`.

## Шаг 3: Создание таблиц

```bash
wrangler d1 execute equipment_journal --file=schema.sql
```

## Шаг 4: Деплой Worker

```bash
wrangler deploy
```

После деплоя получишь URL типа: `https://equipment-journal-worker.YOUR_SUBDOMAIN.workers.dev`

## Шаг 5: Настройка Telegram Webhook

Замени `YOUR_WORKER_URL` на реальный URL:

```bash
curl "https://api.telegram.org/bot8173059163:AAGVf1i3jYYTyZjXrhe3scUd0n2J2hykCTo/setWebhook?url=YOUR_WORKER_URL/webhook"
```

Пример:
```bash
curl "https://api.telegram.org/bot8173059163:AAGVf1i3jYYTyZjXrhe3scUd0n2J2hykCTo/setWebhook?url=https://equipment-journal-worker.yurygagarin.workers.dev/webhook"
```

## Шаг 6: Деплой GitHub Pages

1. Перейди в настройки репозитория на GitHub
2. Settings → Pages
3. Source: Deploy from a branch
4. Branch: main, folder: / (root)
5. Save

Через несколько минут сайт будет доступен по адресу:
`https://gagarinyury.github.io/voice-work-telega/`

## Шаг 7: Обновление API URL в HTML

После деплоя Worker, обнови URL в `index.html`:

```javascript
const API_URL = 'https://equipment-journal-worker.YOUR_SUBDOMAIN.workers.dev/api/journal';
```

Замени на реальный URL твоего воркера.

## Тестирование

1. Открой бота в Telegram
2. Отправь `/start`
3. Введи свою фамилию
4. Отправь голосовое сообщение: "Обходы 08:10, 12:15. Садовники приехали 07:05, уехали 15:40"
5. Проверь страницу на GitHub Pages

## Регистрация пользователя вручную (опционально)

Если нужно добавить пользователя без `/start`:

```bash
wrangler d1 execute equipment_journal --command "INSERT INTO users (telegram_id, surname) VALUES (YOUR_TELEGRAM_ID, 'Иванов')"
```

## Проверка логов

```bash
wrangler tail
```

## Локальная разработка

```bash
wrangler dev
```

Worker будет доступен на `http://localhost:8787`
