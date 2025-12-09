/**
 * Cloudflare Worker for Equipment Journal Telegram Bot
 */

// JSON Schema for Gemini structured output
const JOURNAL_SCHEMA = {
  type: "object",
  properties: {
    rounds: {
      type: "array",
      description: "List of round times in HH:MM format",
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

    return new Response('Not found', { status: 404 });
  }
};

/**
 * Handle Telegram webhook
 */
async function handleTelegramWebhook(request, env) {
  try {
    const update = await request.json();

    // Handle voice message
    if (update.message?.voice) {
      await handleVoiceMessage(update.message, env);
    }

    // Handle /start command - user registration
    if (update.message?.text?.startsWith('/start')) {
      await handleStartCommand(update.message, env);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Webhook error:', error);
    return new Response('Error', { status: 500 });
  }
}

/**
 * Handle /start command - register user
 */
async function handleStartCommand(message, env) {
  const telegramId = message.from.id;
  const chatId = message.chat.id;

  // Check if user already registered
  const existing = await env.DB.prepare(
    'SELECT surname FROM users WHERE telegram_id = ?'
  ).bind(telegramId).first();

  if (existing) {
    await sendTelegramMessage(
      chatId,
      `Вы уже зарегистрированы как: ${existing.surname}\n\nПросто отправьте голосовое сообщение с информацией об обходах и событиях.`,
      env
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    'Добро пожаловать! Введите вашу фамилию для регистрации:',
    env
  );
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
    const voiceFileId = message.voice.file_id;
    const audioBuffer = await downloadTelegramFile(voiceFileId, env);

    // Step 2: Transcribe with Gemini (supports audio input)
    const transcription = await transcribeAudio(audioBuffer, env);

    // Step 3: Parse transcription with Gemini structured output
    const parsedData = await parseTranscription(transcription, env);

    // Step 4: Save to database
    const today = new Date().toISOString().split('T')[0];
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

    // Send confirmation
    const confirmation = formatConfirmation(user.surname, today, parsedData);
    await sendTelegramMessage(chatId, confirmation, env);

  } catch (error) {
    console.error('Voice processing error:', error);
    await sendTelegramMessage(
      chatId,
      'Ошибка обработки голосового сообщения. Попробуйте еще раз.',
      env
    );
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
    throw new Error('Gemini transcription failed');
  }

  return data.candidates[0].content.parts[0].text;
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
1. Время обходов (список времен в формате HH:MM)
2. События (что произошло и во сколько)

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
    throw new Error('Gemini parsing failed');
  }

  return JSON.parse(data.candidates[0].content.parts[0].text);
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
 * Format confirmation message
 */
function formatConfirmation(surname, date, data) {
  let message = `✅ Запись добавлена:\n\n`;
  message += `👤 ${surname}\n`;
  message += `📅 ${date}\n\n`;

  if (data.rounds && data.rounds.length > 0) {
    message += `🚶 Обходы:\n${data.rounds.join(', ')}\n\n`;
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
      SELECT telegram_id, surname, date, rounds, events, created_at
      FROM journal
      ORDER BY date DESC, created_at DESC
      LIMIT 100
    `).all();

    const entries = results.map(row => ({
      surname: row.surname,
      date: row.date,
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
