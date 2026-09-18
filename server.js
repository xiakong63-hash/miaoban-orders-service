const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

const dbConfig = {
  host: process.env.MYSQL_HOST || process.env.MYSQL_ADDRESS || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USERNAME || process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4'
};

const pool = mysql.createPool(dbConfig);
const validStatuses = new Set(['pending', 'progress', 'completed', 'cancelled']);

function send(res, code, data, message) {
  res.status(code === 0 ? 200 : 400).json({ code, data: data || null, message: message || '' });
}

function openid(req) {
  return req.get('x-wx-openid') || req.get('X-WX-OPENID') || '';
}

function orderRow(row) {
  return {
    id: row.id,
    partnerName: row.partner_name,
    partnerTag: row.partner_tag,
    partnerInitial: row.partner_initial,
    partnerColor: row.partner_color,
    service: row.service,
    startTime: row.start_time,
    quantity: row.quantity,
    unit: row.unit,
    priceMode: row.price_mode,
    totalPrice: Number(row.total_price),
    paymentMethod: row.payment_method,
    remark: row.remark,
    status: row.status,
    createdAt: new Date(row.created_at).toLocaleString('zh-CN', { hour12: false })
  };
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    send(res, 0, { service: 'miaoban-orders', database: 'connected' });
  } catch (error) {
    send(res, 5001, null, '数据库未连接');
  }
});

app.get('/api/orders', async (req, res) => {
  const userOpenid = openid(req);
  if (!userOpenid) return send(res, 4001, null, '未获取到用户身份');
  try {
    const [rows] = await pool.query(
      'SELECT * FROM orders WHERE openid = ? ORDER BY created_at DESC',
      [userOpenid]
    );
    send(res, 0, { orders: rows.map(orderRow) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '订单读取失败');
  }
});

app.post('/api/orders', async (req, res) => {
  const userOpenid = openid(req);
  if (!userOpenid) return send(res, 4001, null, '未获取到用户身份');
  const body = req.body || {};
  const required = ['partnerName', 'startTime', 'quantity', 'unit', 'priceMode', 'totalPrice', 'paymentMethod'];
  if (required.some((key) => body[key] === undefined || body[key] === '')) {
    return send(res, 4002, null, '订单信息不完整');
  }
  const id = `MB${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const order = { ...body, id, status: 'pending' };
  try {
    await pool.query(
      `INSERT INTO orders (id, openid, partner_name, partner_tag, partner_initial, partner_color, service,
        start_time, quantity, unit, price_mode, total_price, payment_method, remark, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userOpenid, order.partnerName, order.partnerTag || '', order.partnerInitial || '', order.partnerColor || '',
        order.service || '', order.startTime, Number(order.quantity), order.unit, order.priceMode,
        Number(order.totalPrice), order.paymentMethod, order.remark || '', 'pending']
    );
    const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND openid = ?', [id, userOpenid]);
    send(res, 0, { order: orderRow(rows[0]) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '订单创建失败');
  }
});

app.patch('/api/orders/:id/cancel', async (req, res) => {
  const userOpenid = openid(req);
  if (!userOpenid) return send(res, 4001, null, '未获取到用户身份');
  try {
    const [result] = await pool.query(
      "UPDATE orders SET status = 'cancelled' WHERE id = ? AND openid = ? AND status IN ('pending', 'progress')",
      [req.params.id, userOpenid]
    );
    if (!result.affectedRows) return send(res, 4004, null, '订单不存在或当前不可取消');
    send(res, 0, { id: req.params.id, status: 'cancelled' });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '订单取消失败');
  }
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError) return send(res, 4003, null, '请求数据格式错误');
  next(error);
});

app.listen(process.env.PORT || 80, () => console.log('Miaoban orders service started'));
