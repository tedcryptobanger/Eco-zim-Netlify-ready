exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  // 1. DIAGNOSTIC GET REQUEST (Visit the URL in a browser to test)
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        ok: true, 
        message: "Netlify Function is running perfectly. You can test the frontend now.",
        env_configured: !!(process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID)
      })
    };
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: 'OK' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
  }

  // 2. TELEGRAM LOGIC
  const BOT_TOKEN = process.env.TG_BOT_TOKEN;
  const CHAT_ID = process.env.TG_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    return { 
      statusCode: 500, headers, 
      body: JSON.stringify({ ok: false, error: 'server_not_configured', message: 'Missing TG_BOT_TOKEN or TG_CHAT_ID in Netlify settings.' }) 
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'bad_json' }) };
  }

  const method = body && body.method;
  const payload = (body && body.payload) || {};

  const ALLOWED = ['sendMessage', 'getUpdates', 'answerCallbackQuery'];
  if (!method || !ALLOWED.includes(method)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
  }

  if (method === 'sendMessage') {
    payload.chat_id = CHAT_ID;
  }

  const timeoutMs = method === 'getUpdates' ? 3500 : 8000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    
    const data = await tgRes.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'upstream_error', details: err.message }) };
  } finally {
    clearTimeout(timer);
  }
};