// NowPayments backend — Render/Railway
// Node >= 18 kerak (fetch built-in)
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');

const app = express();

// CORS — barcha originlardan ruxsat (sayt va bot uchun)
app.use(cors({ origin: '*' }));
// Webhook uchun raw body saqlaymiz (signature verify kerak)
app.use((req, res, next) => {
  if (req.path === '/api/np-webhook') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => data += chunk);
    req.on('end', () => { req.rawBody = data; req.body = JSON.parse(data || '{}'); next(); });
  } else {
    express.json()(req, res, next);
  }
});

const NP_API_KEY  = process.env.NP_API_KEY  || 'QBTJMDG-XAD4QRV-KM75PY8-5VWSJ42';
const NP_BASE     = 'https://api.nowpayments.io/v1';
const ADMIN_KEY   = process.env.ADMIN_KEY   || 'lux_admin_secret_2026';
// NowPayments IPN (webhook) secret — NowPayments dashboard > Store settings > IPN Secret
// Render'da environment variable sifatida qo'ying: NP_IPN_SECRET
const NP_IPN_SECRET = process.env.NP_IPN_SECRET || '';
const crypto = require('crypto');
const PROMO_FILE  = './promos.json';
const ORDERS_FILE = './web_orders.json';
const TOPUPS_FILE = './topup_requests.json';
const USERS_FILE  = './users.json';   // balanslarni server tomonida saqlash uchun

// Telegram — saytdan kelgan xabarlarni va buyurtmalarni botga yuborish uchun
// (browser'dan to'g'ridan-to'g'ri api.telegram.org ga so'rov CORS tomonidan bloklanadi,
//  shuning uchun bu so'rovlar shu backend orqali serverdan yuboriladi)
const BOT_TOKEN  = process.env.BOT_TOKEN  || '8642617336:AAHVxyn2dT8C_FgVLQf0Pz85ZP-IWanF_dw';
const ADMIN_ID   = process.env.ADMIN_ID   || '8383029735';
const TG_API     = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── YORDAMCHI ──
function loadPromos() {
  try { return JSON.parse(fs.readFileSync(PROMO_FILE, 'utf8')); }
  catch { return {}; }
}
function savePromos(p) {
  fs.writeFileSync(PROMO_FILE, JSON.stringify(p, null, 2));
}
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveOrders(o) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(o, null, 2));
}
function nextOrderId(orders) {
  const ids = Object.keys(orders).map(Number).filter(n => !isNaN(n));
  return String((ids.length ? Math.max(...ids) : 1000) + 1);
}
function loadTopups() {
  try { return JSON.parse(fs.readFileSync(TOPUPS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveTopups(t) {
  fs.writeFileSync(TOPUPS_FILE, JSON.stringify(t, null, 2));
}
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveUsers(u) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
}
async function tgSend(text, extra = {}) {
  try {
    const r = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_ID, text, parse_mode: 'Markdown', ...extra })
    });
    return await r.json();
  } catch (e) {
    console.error('tgSend:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.send('LuxPay Backend ishlamoqda ✅'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── 1. NowPayments Invoice yaratish ──
app.post('/api/create-invoice', async (req, res) => {
  try {
    const { price_amount, price_currency, order_id, order_description, success_url, cancel_url } = req.body;
    if(!price_amount) return res.status(400).json({ error: 'price_amount kerak' });

    const r = await fetch(`${NP_BASE}/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': NP_API_KEY },
      body: JSON.stringify({
        price_amount,
        price_currency: price_currency || 'usd',
        order_id: order_id || ('order_' + Date.now()),
        order_description: order_description || 'LuxAccounts payment',
        success_url: success_url || 'https://luxaccounts.uz',
        cancel_url:  cancel_url  || 'https://luxaccounts.uz'
      })
    });
    const data = await r.json();
    if(!r.ok) throw new Error(data.message || 'NowPayments xatosi');
    res.json(data);
  } catch(e) {
    console.error('create-invoice:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 2. To'lov holatini tekshirish ──
app.get('/api/payment-status/:id', async (req, res) => {
  try {
    const r = await fetch(`${NP_BASE}/payment/${req.params.id}`, {
      headers: { 'x-api-key': NP_API_KEY }
    });
    const data = await r.json();
    if(!r.ok) throw new Error(data.message || 'Status xatosi');
    res.json(data);
  } catch(e) {
    console.error('payment-status:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 3. Promokod qo'shish (faqat admin) ──
app.post('/api/promo', (req, res) => {
  const { admin_key, code, amount, limit } = req.body;
  if(admin_key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  if(!code || !amount || !limit) return res.status(400).json({ error: 'code, amount, limit kerak' });

  const promos = loadPromos();
  const key = code.trim().toUpperCase();
  if(promos[key]) return res.status(409).json({ error: 'Bu kod allaqachon mavjud' });

  promos[key] = {
    amount:   Number(amount),
    limit:    Number(limit),
    used:     0,
    used_by:  [],
    created:  new Date().toISOString()
  };
  savePromos(promos);
  res.json({ ok: true, code: key, ...promos[key] });
});

// ── 4. Promokod ishlatish ──
app.post('/api/promo/:code/redeem', (req, res) => {
  const promos = loadPromos();
  const key    = req.params.code.trim().toUpperCase();
  const userId = req.body?.user_id || req.ip;   // kim ishlatayotgani
  const promo  = promos[key];

  if(!promo) return res.status(404).json({ error: 'Promokod topilmadi' });
  if(promo.used >= promo.limit) return res.status(410).json({ error: 'Promokod tugagan' });

  // Bir foydalanuvchi bir marta ishlatsin
  if(promo.used_by && promo.used_by.includes(String(userId))) {
    return res.status(409).json({ error: 'Siz bu promokodni allaqachon ishlatgansiz' });
  }

  promo.used += 1;
  if(!promo.used_by) promo.used_by = [];
  promo.used_by.push(String(userId));
  savePromos(promos);

  res.json({ ok: true, amount: promo.amount, remaining: promo.limit - promo.used });
});

// ── 5. Promokodlar ro'yxati (admin) ──
app.get('/api/promos', (req, res) => {
  if(req.query.admin_key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  res.json(loadPromos());
});

// ── 6. Saytdan kelgan xabarni Telegramga yuborish (CORS-siz) ──
app.post('/api/notify', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text kerak' });
  const result = await tgSend(text);
  if (!result.ok) return res.status(502).json({ error: result.description || result.error || 'Telegram xatosi' });
  res.json({ ok: true });
});

// ── 7. Saytdan kelgan buyurtmani qabul qilish va botga yuborish ──
// Bot bilan bitta umumiy buyurtmalar bazasi: bot.py shu /api/orders dan o'qiydi/yozadi
app.post('/api/order', async (req, res) => {
  try {
    const {
      user_id, user_name, username, oyun, donat_tur, donat_miqdor,
      narx_uzs, player_id, source
    } = req.body || {};

    const orders = loadOrders();
    const order_id = nextOrderId(orders);
    const order = {
      id: order_id,
      user_id: user_id || null,
      user_name: user_name || 'Mehmon',
      username: username || 'yoq',
      oyun: oyun || '—',
      donat_tur: donat_tur || '—',
      donat_miqdor: donat_miqdor || '—',
      narx_uzs: Number(narx_uzs) || 0,
      player_id: player_id || '—',
      status: 'kutilmoqda',
      source: source || 'site',
      sana: new Date().toISOString()
    };
    orders[order_id] = order;
    saveOrders(orders);

    const text =
      `🆕 *Yangi buyurtma #${order_id}* (saytdan)\n\n` +
      `👤 ${order.user_name} (@${order.username})\n` +
      `🆔 TG ID: \`${order.user_id || '—'}\`\n` +
      `🎮 ${order.oyun} | 💎 ${order.donat_miqdor}\n` +
      `🕹 Player ID: ${order.player_id}\n` +
      `💰 ${order.narx_uzs.toLocaleString('ru-RU')} UZS\n` +
      `📅 ${order.sana}`;

    const kb = {
      inline_keyboard: [[
        { text: '✅ Tasdiqlash', callback_data: `confirm_${order_id}` },
        { text: '❌ Bekor',      callback_data: `cancel_${order_id}` }
      ]]
    };
    await tgSend(text, { reply_markup: kb });

    res.json({ ok: true, order_id });
  } catch (e) {
    console.error('create-order:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 8. Buyurtmalar ro'yxati (bot.py shundan o'qiydi) ──
app.get('/api/orders', (req, res) => {
  res.json(loadOrders());
});

// ── 9. Buyurtma holatini yangilash (bot.py admin tugmasi bosganda) ──
app.post('/api/orders/:id/status', (req, res) => {
  const { admin_key, status } = req.body || {};
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  if (!['tasdiqlangan', 'bekor_qilingan', 'kutilmoqda'].includes(status)) {
    return res.status(400).json({ error: 'status xato' });
  }
  const orders = loadOrders();
  const order = orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'topilmadi' });
  order.status = status;
  saveOrders(orders);
  res.json({ ok: true, order });
});
// ── NowPayments IPN Webhook ──────────────────────────────────────────────────
// NowPayments dashboard > Store Settings > IPN Callback URL:
//   https://nowpayments-backend-vfdw.onrender.com/api/np-webhook
// NowPayments dashboard > Store Settings > IPN Secret: (shu yerda environment variable)
//
// Oqim:
//  1. Inson Stars/TON to'laydi
//  2. NowPayments → POST /api/np-webhook yuboradi
//  3. Server signature verify qiladi
//  4. order_id'dan user_id oladi (format: "topup_USERID_TIMESTAMP")
//  5. Foydalanuvchi balansini yangilaydi
//  6. Sizga botda xabar yuboradi: "✅ +50,000 UZS — Abdulloh to'ladi"
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/np-webhook', async (req, res) => {
  // 1. Signature tekshirish (NP_IPN_SECRET sozlangan bo'lsa)
  if (NP_IPN_SECRET) {
    const sig = req.headers['x-nowpayments-sig'];
    if (!sig) return res.status(401).json({ error: 'signature yo\'q' });

    // NowPayments: HMAC-SHA512 of sorted JSON body
    try {
      const sorted = JSON.stringify(
        Object.keys(req.body).sort().reduce((acc, k) => { acc[k] = req.body[k]; return acc; }, {})
      );
      const expected = crypto.createHmac('sha512', NP_IPN_SECRET)
        .update(sorted).digest('hex');
      if (sig !== expected) {
        console.warn('Webhook signature xato!');
        return res.status(403).json({ error: 'signature xato' });
      }
    } catch(e) {
      return res.status(400).json({ error: 'signature verify xatosi' });
    }
  }

  const { payment_status, order_id, price_amount, actually_paid,
          pay_currency, payment_id } = req.body;

  // 2. Faqat tasdiqlangan to'lovlarni qabul qilish
  const finished = ['finished', 'confirmed', 'sending', 'partially_paid'];
  if (!finished.includes(payment_status)) {
    console.log(`Webhook: ${order_id} status=${payment_status} — kutilmoqda`);
    return res.json({ ok: true, ignored: true });
  }

  // 3. order_id formatidan user_id va amount_uzs ni olish
  // Format: "topup_USERID_TIMESTAMP"  (startNowPaymentsTopup da shunday yasalgan)
  const parts = (order_id || '').split('_');
  const userId = parts[1] || null;
  // price_amount USD da → UZS ga o'girish
  const NP_USD_RATE = 12700;
  const amtUzs = Math.round(parseFloat(price_amount || 0) * NP_USD_RATE);

  if (!userId || amtUzs < 100) {
    console.warn('Webhook: userId yoki summa topilmadi', { order_id, price_amount });
    return res.status(400).json({ error: 'order_id yoki summa noto\'g\'ri' });
  }

  // 4. Server tomonida balansni yangilash
  const users = loadUsers();
  if (!users[userId]) users[userId] = { balance: 0 };
  users[userId].balance = (users[userId].balance || 0) + amtUzs;
  const newBalance = users[userId].balance;
  saveUsers(users);

  // 5. Ikki marta ishlanmasligi uchun payment_id ni tekshirish
  const paidKey = `paid_${payment_id}`;
  const existing = loadOrders();
  if (existing[paidKey]) {
    console.log(`Webhook: ${payment_id} allaqachon ishlangan`);
    return res.json({ ok: true, duplicate: true });
  }
  existing[paidKey] = { processed: true, order_id, amtUzs, userId, sana: new Date().toISOString() };
  saveOrders(existing);

  // 6. Sizga Telegram orqali xabar
  const text =
    `✅ *NowPayments to'lov qabul qilindi!*\n\n` +
    `🆔 Order: \`${order_id}\`\n` +
    `💰 *+${amtUzs.toLocaleString('ru-RU')} UZS*\n` +
    `💎 ${actually_paid} ${(pay_currency||'').toUpperCase()}\n` +
    `👤 User ID: \`${userId}\`\n` +
    `💼 Yangi balans: ${newBalance.toLocaleString('ru-RU')} UZS\n` +
    `🔢 Payment ID: ${payment_id}`;
  await tgSend(text);

  console.log(`Webhook OK: +${amtUzs} UZS → user ${userId}`);
  res.json({ ok: true, amtUzs, newBalance });
});

// ── Balansni webhook orqali sinxronlash (sayt yuklanganida tekshiradi) ────────
// Sayt localStorage balansini server bilan solishtiradi.
// Agar server yangilangan bo'lsa (webhook kelgan), server balansi ishlatiladi.
// ── Balansga qo'shish (Stars to'lovi kelganda bot shu endpoint ni chaqiradi) ──
app.post('/api/user/:id/balance/add', (req, res) => {
  const { admin_key, amount } = req.body || {};
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  const users = loadUsers();
  if (!users[req.params.id]) users[req.params.id] = { balance: 0 };
  users[req.params.id].balance = (users[req.params.id].balance || 0) + Number(amount);
  saveUsers(users);
  const newBalance = users[req.params.id].balance;
  console.log(`Balance +${amount} → user ${req.params.id} → total: ${newBalance}`);
  res.json({ ok: true, balance: newBalance });
});

app.get('/api/user/:id/balance', (req, res) => {
  const users = loadUsers();
  const u = users[req.params.id];
  res.json({ balance: u?.balance || 0 });
});
app.post('/api/topup/request', async (req, res) => {
  try {
    const { user_id, user_name, username, amount_uzs, method } = req.body || {};
    if (!user_id || !amount_uzs) return res.status(400).json({ error: 'user_id va amount_uzs kerak' });

    const topups = loadTopups();
    const topup_id = 'T' + Date.now();
    const topup = {
      id: topup_id,
      user_id, user_name: user_name || '—', username: username || '—',
      amount_uzs: Number(amount_uzs),
      method: method || 'card',
      status: 'kutilmoqda',
      sana: new Date().toISOString()
    };
    topups[topup_id] = topup;
    saveTopups(topups);

    const text =
      `💳 *Balans to'ldirish so'rovi #${topup_id}*\n\n` +
      `👤 ${topup.user_name} (@${topup.username})\n` +
      `🆔 TG ID: \`${user_id}\`\n` +
      `💰 Miqdor: *${Number(amount_uzs).toLocaleString('ru-RU')} UZS*\n` +
      `🏦 Usul: ${method}\n` +
      `📅 ${topup.sana}\n\n` +
      `_Foydalanuvchi chekni yuborishini kuting, keyin tasdiqlang:_`;

    const kb = {
      inline_keyboard: [[
        { text: '✅ Balansga qo\'sh', callback_data: `topup_confirm_${topup_id}` },
        { text: '❌ Rad et',           callback_data: `topup_cancel_${topup_id}` }
      ]]
    };
    await tgSend(text, { reply_markup: kb });
    res.json({ ok: true, topup_id });
  } catch (e) {
    console.error('topup/request:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 11. Admin tomonidan to'lovni tasdiqlash / rad etish (bot inline button) ──
app.post('/api/topup/:id/confirm', async (req, res) => {
  const { admin_key, action } = req.body || {};
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  const topups = loadTopups();
  const t = topups[req.params.id];
  if (!t) return res.status(404).json({ error: 'topilmadi' });

  if (action === 'confirm') {
    t.status = 'tasdiqlangan';
    // Server tomonida user balansini yangilash (keyingi sessiyada sinxronlash uchun)
    const users = loadUsers();
    if (!users[t.user_id]) users[t.user_id] = { balance: 0 };
    users[t.user_id].balance = (users[t.user_id].balance || 0) + t.amount_uzs;
    saveUsers(users);
    saveTopups(topups);
    res.json({ ok: true, new_balance: users[t.user_id].balance });
  } else {
    t.status = 'rad_etilgan';
    saveTopups(topups);
    res.json({ ok: true });
  }
});

app.post('/api/user/:id/balance', (req, res) => {
  const { admin_key, balance } = req.body || {};
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  const users = loadUsers();
  if (!users[req.params.id]) users[req.params.id] = {};
  users[req.params.id].balance = Number(balance);
  saveUsers(users);
  res.json({ ok: true, balance: users[req.params.id].balance });
});

// ── 13. Pul chiqarish so'rovi ──
app.post('/api/withdraw/request', async (req, res) => {
  try {
    const { user_id, user_name, username, amount_uzs, card, card_owner, bank } = req.body || {};
    if (!user_id || !amount_uzs || !card) return res.status(400).json({ error: 'maydonlar to\'liq emas' });

    const text =
      `💸 *PUL CHIQARISH SO'ROVI!*\n\n` +
      `👤 ${user_name || '—'} (@${username || '—'})\n` +
      `🆔 TG ID: \`${user_id}\`\n\n` +
      `💰 Miqdor: *${Number(amount_uzs).toLocaleString('ru-RU')} UZS*\n` +
      `💳 Karta: \`${card}\`\n` +
      `👤 Egasi: ${card_owner || '—'}\n` +
      `🏦 Bank: ${bank || '—'}\n\n` +
      `📅 ${new Date().toLocaleString('ru-RU')}`;
    await tgSend(text);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LuxPay Backend port ${PORT} da ishlamoqda`));
