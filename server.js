// NowPayments backend — Render/Railway
// Node >= 18 kerak (fetch built-in)
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');

const app = express();

// CORS — barcha originlardan ruxsat (sayt va bot uchun)
app.use(cors({ origin: '*' }));
app.use(express.json());

const NP_API_KEY  = process.env.NP_API_KEY  || 'QBTJMDG-XAD4QRV-KM75PY8-5VWSJ42';
const NP_BASE     = 'https://api.nowpayments.io/v1';
const ADMIN_KEY   = process.env.ADMIN_KEY   || 'lux_admin_secret_2026';
const PROMO_FILE  = './promos.json';

// ── YORDAMCHI ──
function loadPromos() {
  try { return JSON.parse(fs.readFileSync(PROMO_FILE, 'utf8')); }
  catch { return {}; }
}
function savePromos(p) {
  fs.writeFileSync(PROMO_FILE, JSON.stringify(p, null, 2));
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LuxPay Backend port ${PORT} da ishlamoqda`));

// ── Stars Invoice — bot orqali native Telegram Stars invoice ──
app.post('/api/stars-invoice', async (req, res) => {
  try {
    const { user_id, stars, amount_uzs, username } = req.body || {};
    if(!stars || stars < 1) return res.status(400).json({ error: 'stars kerak' });

    // Bot orqali invoice yuborish
    // Agar user_id bot da ro'yxatdan o'tgan bo'lsa — to'g'ridan-to'g'ri invoice yuboramiz
    if(user_id) {
      const invoiceRes = await fetch(`${TG_API}/sendInvoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: user_id,
          title: 'LuxAccounts — Balans to\'ldirish',
          description: `+${Math.round(Number(stars)*130).toLocaleString('ru-RU')} UZS balansingizga qo'shiladi`,
          payload: `topup_${user_id}_${Date.now()}`,
          currency: 'XTR',  // Telegram Stars
          prices: [{ label: 'Balans to\'ldirish', amount: Number(stars) }],
          provider_token: ''  // Stars uchun bo'sh
        })
      });
      const invData = await invoiceRes.json();
      if(invData.ok) {
        // Admin ga ham xabar
        await tgSend(
          `⭐ *Stars Invoice yuborildi!*\n👤 @${username||'?'} (${user_id})\n` +
          `⭐ ${stars} Stars → +${Math.round(stars*130).toLocaleString('ru-RU')} UZS`
        );
        return res.json({ ok: true, sent: true });
      }
    }
    // Fallback: admin ga xabar yuborib, linki qaytarish
    await tgSend(
      `⭐ *Stars to'lov so'rovi!*\n👤 @${username||'?'}\n` +
      `⭐ ${stars} Stars\n💰 ~${Math.round(stars*130).toLocaleString('ru-RU')} UZS\n\n` +
      `_Foydalanuvchiga /pay_${stars} komandasini yuboring_`
    );
    res.json({ ok: true, sent: false });
  } catch(e) {
    console.error('stars-invoice:', e.message);
    res.status(500).json({ error: e.message });
  }
});
