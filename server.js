// NowPayments backend — Render/Railway kabi hostingga joylash uchun
const express = require('express');
const cors = require('cors');
// Node 18+ da fetch o'zida bor, node-fetch kerak emas

const app = express();
app.use(cors());
app.use(express.json());

const NP_API_KEY = process.env.NP_API_KEY || 'QBTJMDG-XAD4QRV-KM75PY8-5VWSJ42';
const NP_BASE = 'https://api.nowpayments.io/v1';

// 1) Invoice yaratish
app.post('/api/create-invoice', async (req, res) => {
  try {
    const { price_amount, price_currency, order_id, order_description } = req.body;
    const r = await fetch(`${NP_BASE}/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': NP_API_KEY },
      body: JSON.stringify({
        price_amount,
        price_currency: price_currency || 'usd',
        order_id,
        order_description,
        success_url: req.body.success_url,
        cancel_url: req.body.cancel_url
      })
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2) To'lov holatini tekshirish
app.get('/api/payment-status/:id', async (req, res) => {
  try {
    const r = await fetch(`${NP_BASE}/payment/${req.params.id}`, {
      headers: { 'x-api-key': NP_API_KEY }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;

// ════════════════════════════
// PROMOKODLAR (oddiy JSON fayl orqali saqlanadi)
// ════════════════════════════
const fs = require('fs');
const PROMO_FILE = './promos.json';
const ADMIN_KEY = process.env.ADMIN_KEY || 'lux_admin_secret_2026';

function loadPromos(){
  try{ return JSON.parse(fs.readFileSync(PROMO_FILE,'utf8')); } catch(e){ return {}; }
}
function savePromos(p){
  fs.writeFileSync(PROMO_FILE, JSON.stringify(p, null, 2));
}

// Promokod qo'shish (faqat bot/admin, ADMIN_KEY orqali)
app.post('/api/promo', (req, res) => {
  const { admin_key, code, amount, limit } = req.body;
  if(admin_key !== ADMIN_KEY) return res.status(403).json({error:'forbidden'});
  if(!code || !amount || !limit) return res.status(400).json({error:'code, amount, limit kerak'});
  const promos = loadPromos();
  const key = code.trim().toUpperCase();
  promos[key] = { amount: Number(amount), limit: Number(limit), used: 0 };
  savePromos(promos);
  res.json({ ok:true, code:key, ...promos[key] });
});

// Promokodni ishlatish (sayt chaqiradi)
app.post('/api/promo/:code/redeem', (req, res) => {
  const promos = loadPromos();
  const key = req.params.code.trim().toUpperCase();
  const promo = promos[key];
  if(!promo) return res.status(404).json({error:'Promokod topilmadi'});
  if(promo.used >= promo.limit) return res.status(410).json({error:'Promokod mavjud emas'});
  promo.used += 1;
  savePromos(promos);
  res.json({ ok:true, amount: promo.amount, remaining: promo.limit - promo.used });
});

app.listen(PORT, () => console.log('Server ishlamoqda: ' + PORT));
