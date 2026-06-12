// NowPayments backend — Render/Railway kabi hostingga joylash uchun
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

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
app.listen(PORT, () => console.log('Server ishlamoqda: ' + PORT));
