/**
 * Cloudflare Worker for Equipment Journal Telegram Bot
 */

// JSON Schema for Gemini structured output
const JOURNAL_SCHEMA = {
  type: "object",
  properties: {
    rounds: {
      type: "array",
      description: "List of round intervals (start time only). Bot will auto-add +10min for end time",
      items: { type: "string" }
    },
    events: {
      type: "array",
      description: "List of events with time and description",
      items: {
        type: "object",
        properties: {
          time: {
            type: "string",
            description: "Time in HH:MM format"
          },
          description: {
            type: "string",
            description: "Event description"
          }
        },
        required: ["time", "description"]
      }
    }
  },
  required: ["rounds", "events"]
};

// JSON Schema for voice command recognition
const VOICE_COMMAND_SCHEMA = {
  type: "object",
  properties: {
    commandType: {
      type: "string",
      enum: ["edit", "delete", "add_journal"],
      description: "Type of command: edit (modify existing entry), delete (remove entry), add_journal (new journal entry)"
    },
    entryIndex: {
      type: "number",
      description: "Entry index number (1, 2, 3, etc.) for edit/delete commands"
    },
    action: {
      type: "string",
      enum: ["add_rounds", "remove_rounds", "add_events", "remove_events", "replace_rounds", "replace_events"],
      description: "What to do: add/remove/replace rounds or events"
    },
    rounds: {
      type: "array",
      items: { type: "string" },
      description: "Round times to add/remove/replace (HH:MM format)"
    },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          time: { type: "string" },
          description: { type: "string" }
        }
      },
      description: "Events to add/remove"
    }
  },
  required: ["commandType"]
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers for GitHub Pages
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API endpoint - get journal entries
    if (url.pathname === '/api/journal' && request.method === 'GET') {
      return handleGetJournal(env, corsHeaders);
    }

    // Webhook endpoint for Telegram
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
    }

    // Health check
    if (url.pathname === '/') {
      return new Response('Equipment Journal Bot is running', { headers: corsHeaders });
    }

    // Debug endpoint - REMOVE IN PRODUCTION
    // if (url.pathname === '/debug') {
    //   return new Response(JSON.stringify({
    //     hasTelegramToken: !!env.TELEGRAM_BOT_TOKEN,
    //     hasGeminiKey: !!env.GEMINI_API_KEY,
    //     hasDB: !!env.DB
    //   }), {
    //     headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    //   });
    // }

    return new Response('Not found', { status: 404 });
  }
};

/**
 * Handle Telegram webhook
 */
async function handleTelegramWebhook(request, env) {
  try {
    const update = await request.json();

    // Handle callback queries (button clicks)
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
      return new Response('OK', { status: 200 });
    }

    const telegramId = update.message?.from?.id;
    const chatId = update.message?.chat?.id;

    // Check rate limit (skip for /start command)
    if (telegramId && !update.message?.text?.startsWith('/start')) {
      const isAllowed = await checkRateLimit(telegramId, chatId, env);
      if (!isAllowed) {
        return new Response('OK', { status: 200 });
      }
    }

    // Handle voice message
    if (update.message?.voice) {
      await handleVoiceMessage(update.message, env);
    }
    // Handle /start command - user registration
    else if (update.message?.text?.startsWith('/start')) {
      await handleStartCommand(update.message, env);
    }
    // Handle /delete command - delete today's entry
    else if (update.message?.text?.startsWith('/delete')) {
      await handleDeleteCommand(update.message, env);
    }
    // Handle /list command - show recent entries
    else if (update.message?.text?.startsWith('/list')) {
      await handleListCommand(update.message, env);
    }
    // Handle /edit command - edit entry
    else if (update.message?.text?.startsWith('/edit')) {
      await handleEditCommand(update.message, env);
    }
    // Handle /help command - show instructions
    else if (update.message?.text?.startsWith('/help')) {
      await handleHelpCommand(update.message, env);
    }
    // Handle text message - could be menu button, surname registration, or journal entry
    else if (update.message?.text) {
      const text = update.message.text;
      // Check if it's a menu button press
      if (text === '🎙️ Start') {
        await handleStartCommand(update.message, env);
      } else if (text === '✏️ Edit') {
        await handleEditCommand(update.message, env);
      } else if (text === 'ℹ️ Help') {
        await handleHelpCommand(update.message, env);
      } else {
        await handleTextMessage(update.message, env);
      }
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Webhook error:', error);
    return new Response('Error', { status: 500 });
  }
}

/**
 * Check rate limit - max 10 requests per hour per user
 */
async function checkRateLimit(telegramId, chatId, env) {
  const MAX_REQUESTS = 10;
  const WINDOW_MINUTES = 60;

  // Get current rate limit info
  const rateLimitInfo = await env.DB.prepare(
    'SELECT request_count, window_start FROM rate_limits WHERE telegram_id = ?'
  ).bind(telegramId).first();

  const now = new Date();

  if (!rateLimitInfo) {
    // First request - create record
    await env.DB.prepare(
      'INSERT INTO rate_limits (telegram_id, request_count, window_start) VALUES (?, 1, ?)'
    ).bind(telegramId, now.toISOString()).run();
    return true;
  }

  const windowStart = new Date(rateLimitInfo.window_start);
  const minutesElapsed = (now - windowStart) / (1000 * 60);

  // Reset window if expired
  if (minutesElapsed >= WINDOW_MINUTES) {
    await env.DB.prepare(
      'UPDATE rate_limits SET request_count = 1, window_start = ? WHERE telegram_id = ?'
    ).bind(now.toISOString(), telegramId).run();
    return true;
  }

  // Check if limit exceeded
  if (rateLimitInfo.request_count >= MAX_REQUESTS) {
    const minutesRemaining = Math.ceil(WINDOW_MINUTES - minutesElapsed);
    await sendTelegramMessage(
      chatId,
      `⏱ Превышен лимит запросов (${MAX_REQUESTS} в час).\n\nПопробуйте через ${minutesRemaining} мин.`,
      env
    );
    return false;
  }

  // Increment counter
  await env.DB.prepare(
    'UPDATE rate_limits SET request_count = request_count + 1 WHERE telegram_id = ?'
  ).bind(telegramId).run();

  return true;
}

/**
 * Handle /start command - register user or show date selection
 */
async function handleStartCommand(message, env) {
  const telegramId = message.from.id;
  const chatId = message.chat.id;

  // Check if user already registered
  const existing = await env.DB.prepare(
    'SELECT surname FROM users WHERE telegram_id = ?'
  ).bind(telegramId).first();

  if (existing) {
    // User already registered - show date selection
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const todayStr = formatDate(today);
    const yesterdayStr = formatDate(yesterday);
    const tomorrowStr = formatDate(tomorrow);

    const buttons = [
      [
        { text: '📅 Вчера', callback_data: `select_date_${yesterdayStr}` },
        { text: '📅 Сегодня', callback_data: `select_date_${todayStr}` },
        { text: '📅 Завтра', callback_data: `select_date_${tomorrowStr}` }
      ]
    ];

    const helpText = `🎙️ Привет, ${existing.surname}!

Выберите дату для заполнения журнала обходов:`;

    await sendTelegramMessageWithButtons(chatId, helpText, buttons, env);
    return;
  }

  // Check max users limit (4 users max)
  const usersCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM users'
  ).first();

  if (usersCount.count >= 4) {
    await sendTelegramMessage(
      chatId,
      '❌ Регистрация закрыта.\n\nДостигнут лимит пользователей (4).\n\nОбратитесь к администратору.',
      env
    );
    return;
  }

  await sendTelegramMessageWithMenu(
    chatId,
    `🎙️ Добро пожаловать в голосовой журнал обходов!

Введите вашу фамилию для регистрации:`,
    env
  );
}

/**
 * Handle /help command - show instructions
 */
async function handleHelpCommand(message, env) {
  const chatId = message.chat.id;

  const helpText = `🎙️ ГОЛОСОВОЙ БОТ ЖУРНАЛА ОБХОДОВ

Этот бот работает преимущественно с голосовыми сообщениями!

📋 ОСНОВНЫЕ КОМАНДЫ:

🎙️ Start - Начать заполнение (выбрать дату)
✏️ Edit - Редактировать запись
ℹ️ Help - Показать эту справку
/list - Показать последние 5 записей
/delete [дата] - Удалить запись

🎤 КАК ИСПОЛЬЗОВАТЬ:

1️⃣ Нажми кнопку <b>Start</b>
2️⃣ Выбери дату (Вчера / Сегодня / Завтра)
3️⃣ Скажи обходы и события:

<b>Пример:</b>
"Обходы 10:10, 12:25. Садовники приехали 07:05, уехали 15:40"

⚠️ ВАЖНО:
• Говори только ВРЕМЯ НАЧАЛА обходов (10:10)
• Бот автоматически добавит +10 минут (10:10-10:20)
• События указывай со временем и описанием

💡 ПОДСКАЗКИ:

• Можно использовать текст вместо голоса
• Запись обновляется если отправить данные за тот же день
• В таблице показываются все записи всех охранников

📊 Таблица: https://gagarinyury.github.io/voice-work-telega/`;

  await sendTelegramMessageWithMenu(chatId, helpText, env);
}

/**
 * Handle /list command - show recent entries
 */
async function handleListCommand(message, env) {
  const telegramId = message.from.id;
  const chatId = message.chat.id;

  // Check if user is registered
  const user = await env.DB.prepare(
    'SELECT surname FROM users WHERE telegram_id = ?'
  ).bind(telegramId).first();

  if (!user) {
    await sendTelegramMessage(
      chatId,
      'Сначала зарегистрируйтесь: отправьте /start',
      env
    );
    return;
  }

  // Get last 5 entries for this user
  const { results } = await env.DB.prepare(`
    SELECT id, date, rounds, events
    FROM journal
    WHERE telegram_id = ?
    ORDER BY date DESC, created_at DESC
    LIMIT 5
  `).bind(telegramId).all();

  if (results.length === 0) {
    await sendTelegramMessage(
      chatId,
      '📋 У вас пока нет записей',
      env
    );
    return;
  }

  let message_text = '📋 Ваши последние записи:\n\n';
  results.forEach((entry, index) => {
    const rounds = JSON.parse(entry.rounds || '[]');
    const events = JSON.parse(entry.events || '[]');

    message_text += `${index + 1}. ${entry.date} (ID: ${entry.id})\n`;
    message_text += `   Интервалов обходов: ${rounds.length}\n`;
    message_text += `   События: ${events.length}\n\n`;
  });

  message_text += 'Для удаления: /delete <дата>\nНапример: /delete 09.12.2025\n\n';
  message_text += 'Для редактирования: нажми ✏️ Edit';

  await sendTelegramMessageWithMenu(chatId, message_text, env);
}

/**
 * Handle /delete command - delete entry
 */
async function handleDeleteCommand(message, env) {
  const telegramId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();

  // Check if user is registered
  const user = await env.DB.prepare(
    'SELECT surname FROM users WHERE telegram_id = ?'
  ).bind(telegramId).first();

  if (!user) {
    await sendTelegramMessage(
      chatId,
      'Сначала зарегистрируйтесь: отправьте /start',
      env
    );
    return;
  }

  // Parse date from command: /delete 09.12.2025 or /delete (today)
  const parts = text.split(' ');
  let dateToDelete;

  if (parts.length === 1) {
    // No date provided - delete today
    dateToDelete = new Date().toISOString().split('T')[0];
  } else {
    // Parse date DD.MM.YYYY
    const dateStr = parts[1];
    const dateParts = dateStr.split('.');
    if (dateParts.length === 3) {
      const [day, month, year] = dateParts;
      dateToDelete = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    } else {
      await sendTelegramMessage(
        chatId,
        '❌ Неверный формат даты.\n\nИспользуйте: /delete ДД.ММ.ГГГГ\nНапример: /delete 09.12.2025\n\nИли просто /delete для удаления сегодняшней записи',
        env
      );
      return;
    }
  }

  // Delete entry
  const result = await env.DB.prepare(
    'DELETE FROM journal WHERE telegram_id = ? AND date = ?'
  ).bind(telegramId, dateToDelete).run();

  if (result.meta.changes > 0) {
    await sendTelegramMessage(
      chatId,
      `✅ Запись за ${dateToDelete} удалена`,
      env
    );
  } else {
    await sendTelegramMessage(
      chatId,
      `❌ Записей за ${dateToDelete} не найдено`,
      env
    );
  }
}

/**
 * Handle /edit command - show list with buttons
 */
async function handleEditCommand(message, env) {
  const telegramId = message.from.id;
  const chatId = message.chat.id;

  // Check if user is registered
  const user = await env.DB.prepare(
    'SELECT surname FROM users WHERE telegram_id = ?'
  ).bind(telegramId).first();

  if (!user) {
    await sendTelegramMessage(
      chatId,
      'Сначала зарегистрируйтесь: отправьте /start',
      env
    );
    return;
  }

  // Get last 3 entries
  const { results } = await env.DB.prepare(`
    SELECT id, date, rounds, events
    FROM journal
    WHERE telegram_id = ?
    ORDER BY date DESC, created_at DESC
    LIMIT 3
  `).bind(telegramId).all();

  if (results.length === 0) {
    await sendTelegramMessage(
      chatId,
      '📋 У вас пока нет записей',
      env
    );
    return;
  }

  // Create message with buttons
  let message_text = '✏️ Выберите запись для редактирования:\n\n';

  const buttons = [];
  results.forEach((entry, index) => {
    const rounds = JSON.parse(entry.rounds || '[]');
    const events = JSON.parse(entry.events || '[]');

    message_text += `${index + 1}. ${entry.date}\n`;
    message_text += `   Обходов: ${rounds.length}, События: ${events.length}\n\n`;

    buttons.push([{
      text: `📅 ${entry.date}`,
      callback_data: `edit_${entry.date}`
    }]);
  });

  await sendTelegramMessageWithButtons(chatId, message_text, buttons, env);
}

/**
 * Handle partial edit (only rounds or only events)
 */
async function handlePartialEdit(telegramId, surname, field, text, chatId, env, date = null) {
  const dateToEdit = date || new Date().toISOString().split('T')[0];

  // Get existing entry
  const existing = await env.DB.prepare(
    'SELECT rounds, events FROM journal WHERE telegram_id = ? AND date = ?'
  ).bind(telegramId, dateToEdit).first();

  if (!existing) {
    await sendTelegramMessage(
      chatId,
      `❌ Записи за ${dateToEdit} нет.`,
      env
    );
    return;
  }

  try {
    let newRounds = existing.rounds;
    let newEvents = existing.events;

    if (field === 'rounds') {
      // Parse rounds manually: "09:10, 12:15, 16:30" (start times only)
      const roundsArray = text.split(',').map(t => t.trim()).filter(t => t);
      // Convert to intervals (+10 minutes each)
      const intervalsArray = convertToIntervals(roundsArray);
      newRounds = JSON.stringify(intervalsArray);
    } else if (field === 'events') {
      // Parse events with Gemini
      const parsedData = await parseTranscription(`События: ${text}`, env);
      newEvents = JSON.stringify(parsedData.events || []);
    }

    // Update entry
    await env.DB.prepare(`
      UPDATE journal
      SET rounds = ?, events = ?
      WHERE telegram_id = ? AND date = ?
    `).bind(newRounds, newEvents, telegramId, dateToEdit).run();

    await sendTelegramMessage(
      chatId,
      `✅ Обновлено!\n\n${field === 'rounds' ? '🚶 Интервалы обходов' : '📋 События'} изменены для ${dateToEdit}.`,
      env
    );
  } catch (error) {
    console.error('Partial edit error:', error);
    await sendTelegramMessage(
      chatId,
      `❌ Ошибка: ${error.message}`,
      env
    );
  }
}

/**
 * Handle text message - register surname
 */
async function handleTextMessage(message, env) {
  const telegramId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();

  // Check if user already registered
  const user = await env.DB.prepare(
    'SELECT surname FROM users WHERE telegram_id = ?'
  ).bind(telegramId).first();

  if (!user) {
    // Check max users limit before registration
    const usersCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM users'
    ).first();

    if (usersCount.count >= 4) {
      await sendTelegramMessage(
        chatId,
        '❌ Регистрация закрыта.\n\nДостигнут лимит пользователей (4).',
        env
      );
      return;
    }

    // Register new user
    await env.DB.prepare(
      'INSERT INTO users (telegram_id, surname) VALUES (?, ?)'
    ).bind(telegramId, text).run();

    await sendTelegramMessageWithMenu(
      chatId,
      `✅ Регистрация завершена!

Ваша фамилия: <b>${text}</b>

🎙️ Нажми кнопку <b>Start</b> чтобы начать заполнение журнала обходов!`,
      env
    );
    return;
  }

  // Check for special edit commands
  if (text.toLowerCase().startsWith('rounds:')) {
    // Edit only rounds
    const roundsText = text.substring(7).trim();
    await handlePartialEdit(telegramId, user.surname, 'rounds', roundsText, chatId, env);
    return;
  }

  if (text.toLowerCase().startsWith('events:')) {
    // Edit only events
    const eventsText = text.substring(7).trim();
    await handlePartialEdit(telegramId, user.surname, 'events', eventsText, chatId, env);
    return;
  }

  // User is registered - process as journal entry
  try {
    await sendTelegramMessage(chatId, '⏳ Обрабатываю...', env);

    // Parse text with Gemini
    const parsedData = await parseTranscription(text, env);

    // Check if entry exists for today
    const today = new Date().toISOString().split('T')[0];
    const existing = await env.DB.prepare(
      'SELECT id FROM journal WHERE telegram_id = ? AND date = ?'
    ).bind(telegramId, today).first();

    if (existing) {
      // Update existing entry
      await env.DB.prepare(`
        UPDATE journal
        SET rounds = ?, events = ?
        WHERE telegram_id = ? AND date = ?
      `).bind(
        JSON.stringify(parsedData.rounds),
        JSON.stringify(parsedData.events),
        telegramId,
        today
      ).run();
    } else {
      // Insert new entry
      await env.DB.prepare(`
        INSERT INTO journal (telegram_id, surname, date, rounds, events)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        telegramId,
        user.surname,
        today,
        JSON.stringify(parsedData.rounds),
        JSON.stringify(parsedData.events)
      ).run();
    }

    // Send confirmation
    const confirmation = formatConfirmation(user.surname, today, parsedData);
    await sendTelegramMessageWithMenu(chatId, confirmation, env);

  } catch (error) {
    console.error('Text processing error:', error);
    let errorMsg = '❌ Ошибка обработки:\n\n';
    errorMsg += error.message || error.toString();
    await sendTelegramMessageWithMenu(chatId, errorMsg, env);
  }
}

/**
 * Handle voice message
 */
async function handleVoiceMessage(message, env) {
  const telegramId = message.from.id;
  const chatId = message.chat.id;

  // Check if user is registered
  const user = await env.DB.prepare(
    'SELECT surname FROM users WHERE telegram_id = ?'
  ).bind(telegramId).first();

  if (!user) {
    await sendTelegramMessage(
      chatId,
      'Сначала зарегистрируйтесь: отправьте команду /start',
      env
    );
    return;
  }

  try {
    // Step 1: Download voice file from Telegram
    await sendTelegramMessage(chatId, '⏳ Обрабатываю голосовое...', env);

    const voiceFileId = message.voice.file_id;
    const audioBuffer = await downloadTelegramFile(voiceFileId, env);

    // Step 2: Transcribe with Gemini (supports audio input)
    const transcription = await transcribeAudio(audioBuffer, env);

    // Show transcription to user
    await sendTelegramMessage(
      chatId,
      `📝 Распознано:\n"${transcription}"\n\n⏳ Обрабатываю данные...`,
      env
    );

    // Step 3: Parse transcription with Gemini structured output
    const parsedData = await parseTranscription(transcription, env);

    // Step 4: Check if entry exists for today
    const today = new Date().toISOString().split('T')[0];
    const existing = await env.DB.prepare(
      'SELECT id FROM journal WHERE telegram_id = ? AND date = ?'
    ).bind(telegramId, today).first();

    if (existing) {
      // Update existing entry
      await env.DB.prepare(`
        UPDATE journal
        SET rounds = ?, events = ?
        WHERE telegram_id = ? AND date = ?
      `).bind(
        JSON.stringify(parsedData.rounds),
        JSON.stringify(parsedData.events),
        telegramId,
        today
      ).run();
    } else {
      // Insert new entry
      await env.DB.prepare(`
        INSERT INTO journal (telegram_id, surname, date, rounds, events)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        telegramId,
        user.surname,
        today,
        JSON.stringify(parsedData.rounds),
        JSON.stringify(parsedData.events)
      ).run();
    }

    // Send confirmation
    const confirmation = formatConfirmation(user.surname, today, parsedData);
    await sendTelegramMessageWithMenu(chatId, confirmation, env);

  } catch (error) {
    console.error('Voice processing error:', error);

    // Send detailed error to user
    let errorMsg = '❌ Ошибка обработки:\n\n';
    errorMsg += error.message || error.toString();

    if (error.stack) {
      errorMsg += `\n\nДетали: ${error.stack.substring(0, 200)}`;
    }

    await sendTelegramMessageWithMenu(chatId, errorMsg, env);
  }
}

/**
 * Download file from Telegram
 */
async function downloadTelegramFile(fileId, env) {
  // Get file path
  const fileInfoResponse = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileInfo = await fileInfoResponse.json();

  if (!fileInfo.ok) {
    throw new Error('Failed to get file info from Telegram');
  }

  // Download file
  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
  const fileResponse = await fetch(fileUrl);
  return await fileResponse.arrayBuffer();
}

/**
 * Transcribe audio using Gemini
 */
async function transcribeAudio(audioBuffer, env) {
  // Convert audio to base64
  const base64Audio = arrayBufferToBase64(audioBuffer);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: "audio/ogg",
                data: base64Audio
              }
            },
            {
              text: "Транскрибируй это голосовое сообщение на русском языке. Верни только текст без комментариев."
            }
          ]
        }]
      })
    }
  );

  const data = await response.json();
  if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new Error(`Gemini transcription failed: ${JSON.stringify(data)}`);
  }

  return data.candidates[0].content.parts[0].text;
}

/**
 * Parse voice command for editing/deleting entries
 */
async function parseVoiceCommand(text, env) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Проанализируй команду пользователя и определи намерение:

Команда: "${text}"

Возможные типы команд:
- "edit" - изменить существующую запись (добавить/убрать обходы или события)
- "delete" - удалить запись
- "add_journal" - создать обычную запись журнала (обходы и события)

Примеры:
"Измени запись 2, убери время 21:20" -> edit, entryIndex: 2, action: remove_rounds, rounds: ["21:20"]
"Добавь к записи 1 обход 09:30" -> edit, entryIndex: 1, action: add_rounds, rounds: ["09:30"]
"Удали запись 3" -> delete, entryIndex: 3
"Обходы 09:10, 12:15" -> add_journal (обычная запись)

Верни структурированный JSON согласно схеме.`
          }]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: VOICE_COMMAND_SCHEMA
        }
      })
    }
  );

  const data = await response.json();
  if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new Error(`Voice command parsing failed: ${JSON.stringify(data)}`);
  }

  return JSON.parse(data.candidates[0].content.parts[0].text);
}

/**
 * Convert single start times to intervals (add +10 minutes for end time)
 */
function convertToIntervals(startTimes) {
  return startTimes.map(startTime => {
    const [hours, minutes] = startTime.split(':').map(Number);
    const endMinutes = minutes + 10;

    if (endMinutes < 60) {
      return `${startTime}-${String(hours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}`;
    } else {
      const nextHour = hours + 1;
      const remainingMinutes = endMinutes - 60;
      return `${startTime}-${String(nextHour % 24).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`;
    }
  });
}

/**
 * Parse transcription using Gemini structured output
 */
async function parseTranscription(text, env) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Из следующего текста извлеки:
1. ТОЛЬКО ВРЕМЯ НАЧАЛА обходов (список времен в формате HH:MM, без времени конца)
2. События (что произошло и во сколько)

Примеры:
- "Обходы девять десять, двенадцать пятнадцать" → rounds: ["09:10", "12:15"]
- "Обходы 10:10, 12:25" → rounds: ["10:10", "12:25"]
- Не вводи никакие интервалы сам! Бот автоматически добавит +10 минут для каждого обхода.

Текст: "${text}"

Верни структурированный JSON согласно схеме.`
          }]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: JOURNAL_SCHEMA
        }
      })
    }
  );

  const data = await response.json();
  if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new Error(`Gemini parsing failed: ${JSON.stringify(data)}`);
  }

  const parsed = JSON.parse(data.candidates[0].content.parts[0].text);

  // Convert start times to intervals (add +10 minutes)
  if (parsed.rounds && parsed.rounds.length > 0) {
    parsed.rounds = convertToIntervals(parsed.rounds);
  }

  return parsed;
}

/**
 * Send message to Telegram
 */
async function sendTelegramMessage(chatId, text, env) {
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      })
    }
  );
}

/**
 * Get keyboard menu buttons (persistent menu)
 */
function getMainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: '🎙️ Start' }, { text: '✏️ Edit' }, { text: 'ℹ️ Help' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

/**
 * Send message with persistent menu
 */
async function sendTelegramMessageWithMenu(chatId, text, env) {
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard()
      })
    }
  );
}

/**
 * Send message with inline keyboard buttons
 */
async function sendTelegramMessageWithButtons(chatId, text, buttons, env) {
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        reply_markup: {
          inline_keyboard: buttons
        }
      })
    }
  );
}

/**
 * Answer callback query (button click)
 */
async function answerCallbackQuery(callbackQueryId, text, env) {
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text || '✅'
      })
    }
  );
}

/**
 * Handle callback query (button clicks)
 */
async function handleCallbackQuery(callbackQuery, env) {
  const telegramId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  // Parse callback data - check more specific first
  if (data.startsWith('select_date_')) {
    // Date selected from /start menu
    const date = data.substring(12);
    await handleDateSelected(telegramId, chatId, date, callbackQuery.id, env);
  } else if (data.startsWith('edit_rounds_')) {
    // Edit rounds for specific date
    const date = data.substring(12);
    await startEditRounds(telegramId, chatId, date, callbackQuery.id, env);
  } else if (data.startsWith('edit_events_')) {
    // Edit events for specific date
    const date = data.substring(12);
    await startEditEvents(telegramId, chatId, date, callbackQuery.id, env);
  } else if (data.startsWith('edit_')) {
    // Edit specific date (show options)
    const date = data.substring(5);
    await showEditOptions(telegramId, chatId, date, callbackQuery.id, env);
  }
}

/**
 * Handle date selection from /start menu
 */
async function handleDateSelected(telegramId, chatId, date, callbackQueryId, env) {
  const user = await env.DB.prepare(
    'SELECT surname FROM users WHERE telegram_id = ?'
  ).bind(telegramId).first();

  if (!user) {
    await answerCallbackQuery(callbackQueryId, '❌ Пользователь не найден', env);
    return;
  }

  // Format date for display (2025-12-11 -> 11.12.2025)
  const [year, month, day] = date.split('-');
  const displayDate = `${day}.${month}.${year}`;

  await answerCallbackQuery(callbackQueryId, `✅ Выбрана дата: ${displayDate}`, env);

  const helpText = `📅 Дата: <b>${displayDate}</b>

🎙️ Отправьте голосовое сообщение или текст с информацией:

<b>Пример:</b>
"Обходы 10:10, 12:25, 16:30. Садовники приехали 07:05, уехали 15:40"

<b>Как это работает:</b>
• Назовите только ВРЕМЯ НАЧАЛА обходов (10:10)
• Бот автоматически добавит +10 минут (10:10-10:20)
• События указывайте со временем и описанием

Готово? Отправляй!`;

  await sendTelegramMessageWithMenu(chatId, helpText, env);
}

/**
 * Show edit options (rounds/events/all)
 */
async function showEditOptions(telegramId, chatId, date, callbackQueryId, env) {
  // Get entry
  const entry = await env.DB.prepare(
    'SELECT rounds, events FROM journal WHERE telegram_id = ? AND date = ?'
  ).bind(telegramId, date).first();

  if (!entry) {
    await answerCallbackQuery(callbackQueryId, '❌ Запись не найдена', env);
    return;
  }

  const rounds = JSON.parse(entry.rounds || '[]');
  const events = JSON.parse(entry.events || '[]');

  let message_text = `✏️ Редактирование записи за ${date}\n\n`;
  message_text += `📝 Текущие данные:\n\n`;
  message_text += `🚶 Интервалы обходов:\n`;
  if (rounds.length > 0) {
    rounds.forEach(interval => message_text += `  • ${interval}\n`);
  } else {
    message_text += 'нет\n';
  }
  message_text += `\n📋 События:\n`;
  if (events.length > 0) {
    events.forEach(e => message_text += `  • ${e.time} - ${e.description}\n`);
  } else {
    message_text += 'нет\n';
  }
  message_text += `\nВыберите что изменить:`;

  const buttons = [
    [{ text: '🚶 Обходы', callback_data: `edit_rounds_${date}` }],
    [{ text: '📋 События', callback_data: `edit_events_${date}` }]
  ];

  await answerCallbackQuery(callbackQueryId, '', env);
  await sendTelegramMessageWithButtons(chatId, message_text, buttons, env);
}

/**
 * Start editing rounds
 */
async function startEditRounds(telegramId, chatId, date, callbackQueryId, env) {
  console.log('startEditRounds:', { telegramId, date });

  const entry = await env.DB.prepare(
    'SELECT rounds FROM journal WHERE telegram_id = ? AND date = ?'
  ).bind(telegramId, date).first();

  console.log('Entry found:', entry);

  if (!entry) {
    await answerCallbackQuery(callbackQueryId, `❌ Запись не найдена (${date})`, env);
    await sendTelegramMessage(
      chatId,
      `❌ Debug: Не найдена запись для telegram_id=${telegramId}, date=${date}`,
      env
    );
    return;
  }

  const rounds = JSON.parse(entry.rounds || '[]');

  let message_text = `✏️ Редактирование интервалов обходов за ${date}\n\n`;
  message_text += `Текущие интервалы:\n`;
  if (rounds.length > 0) {
    rounds.forEach(interval => message_text += `  • ${interval}\n`);
  } else {
    message_text += 'нет\n';
  }
  message_text += `\nОтправьте ТОЛЬКО ВРЕМЯ НАЧАЛА обходов в формате:\n`;
  message_text += `rounds: 09:10, 12:15, 16:30\n\n`;
  message_text += `Бот автоматически добавит +10 минут для каждого обхода.`;

  await answerCallbackQuery(callbackQueryId, '✏️ Отправьте новые времена обходов', env);
  await sendTelegramMessage(chatId, message_text, env);
}

/**
 * Start editing events
 */
async function startEditEvents(telegramId, chatId, date, callbackQueryId, env) {
  console.log('startEditEvents:', { telegramId, date });

  const entry = await env.DB.prepare(
    'SELECT events FROM journal WHERE telegram_id = ? AND date = ?'
  ).bind(telegramId, date).first();

  console.log('Entry found:', entry);

  if (!entry) {
    await answerCallbackQuery(callbackQueryId, `❌ Запись не найдена (${date})`, env);
    await sendTelegramMessage(
      chatId,
      `❌ Debug: Не найдена запись для telegram_id=${telegramId}, date=${date}`,
      env
    );
    return;
  }

  const events = JSON.parse(entry.events || '[]');

  let message_text = `✏️ Редактирование событий за ${date}\n\n`;
  message_text += `Текущие события:\n`;
  if (events.length > 0) {
    events.forEach(e => message_text += `  • ${e.time} - ${e.description}\n`);
  } else {
    message_text += 'нет\n';
  }
  message_text += `\nОтправьте новые события в формате:\n`;
  message_text += `events: Садовники 07:05, Ролеты 20:00`;

  await answerCallbackQuery(callbackQueryId, '✏️ Отправьте новые события', env);
  await sendTelegramMessage(chatId, message_text, env);
}

/**
 * Format confirmation message
 */
function formatConfirmation(surname, date, data) {
  let message = `✅ Запись добавлена:\n\n`;
  message += `👤 ${surname}\n`;
  message += `📅 ${date}\n\n`;

  if (data.rounds && data.rounds.length > 0) {
    message += `🚶 Интервалы обходов:\n`;
    data.rounds.forEach(interval => {
      message += `  • ${interval}\n`;
    });
    message += '\n';
  }

  if (data.events && data.events.length > 0) {
    message += `📝 События:\n`;
    data.events.forEach(event => {
      message += `  • ${event.time} - ${event.description}\n`;
    });
  }

  return message;
}

/**
 * Get journal entries (API endpoint)
 */
async function handleGetJournal(env, corsHeaders) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT telegram_id, surname, date, items, rounds, events, created_at
      FROM journal
      ORDER BY date DESC, created_at DESC
      LIMIT 100
    `).all();

    const entries = results.map(row => ({
      surname: row.surname,
      date: row.date,
      items: row.items || '{"pults":true,"tablet":true,"keys":true,"phone":true,"ts_button":true}',
      rounds: JSON.parse(row.rounds || '[]'),
      events: JSON.parse(row.events || '[]'),
      created_at: row.created_at
    }));

    return new Response(JSON.stringify(entries), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
}

/**
 * Convert ArrayBuffer to base64
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
