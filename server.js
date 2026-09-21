const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || process.env.MYSQL_ADDRESS || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USERNAME || process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4'
});

function send(res, code, data, message) {
  res.status(code === 0 ? 200 : 400).json({ code, data: data || null, message: message || '' });
}

function getOpenid(req) {
  return req.get('x-wx-openid') || req.get('X-WX-OPENID') || '';
}

function adminOpenids() {
  return new Set(String(process.env.ADMIN_OPENIDS || '').split(',').map((item) => item.trim()).filter(Boolean));
}

function isAdmin(openid) {
  return adminOpenids().has(openid);
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
}

function orderRow(row) {
  return {
    id: row.id,
    partnerProfileId: row.partner_profile_id ? Number(row.partner_profile_id) : null,
    partnerName: row.partner_name,
    partnerTag: row.partner_tag,
    partnerInitial: row.partner_initial,
    partnerColor: row.partner_color,
    partnerAvatarUrl: row.partner_avatar_url || '',
    partnerGender: row.partner_gender === 'male' ? 'male' : 'female',
    partnerRankText: row.partner_rank_text || '',
    service: row.service,
    startTime: row.start_time,
    quantity: row.quantity,
    unit: row.unit,
    priceMode: row.price_mode,
    totalPrice: Number(row.total_price),
    originalTotalPrice: row.original_total_price === undefined || row.original_total_price === null ? Number(row.total_price) : Number(row.original_total_price),
    catFoodUsed: Number(row.cat_food_used || 0),
    couponDiscount: Number(row.coupon_discount || 0),
    renewFromOrderId: row.renew_from_order_id || ((String(row.remark || '').match(/续自订单\s+(MB[A-Z0-9]+)/) || [])[1] || ''),
    pointsEarned: Number(row.points_earned || 0),
    paymentMethod: row.payment_method,
    remark: row.remark,
    status: row.status,
    serviceStartedAt: formatDate(row.service_started_at),
    serviceCompletedAt: formatDate(row.service_completed_at),
    createdAt: formatDate(row.created_at)
  };
}

function earlySettlementNotice(serviceSeconds, unit) {
  if (unit !== '小时') return '已按原订单服务费用结算';
  if (serviceSeconds < 35 * 60) return '服务不足 35 分钟，已按 30 分钟服务费用结算';
  if (serviceSeconds < 65 * 60) return '服务不足 1 小时 5 分钟，已按 1 小时服务费用结算';
  return '已按原订单服务费用结算';
}

const INITIAL_COIN_BALANCE = 268;

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

async function ensureWallet(executor, openid) {
  await executor.query('INSERT IGNORE INTO user_wallets (openid, coin_balance, cat_food_balance) VALUES (?, ?, 0)', [openid, INITIAL_COIN_BALANCE]);
  const [[wallet]] = await executor.query('SELECT * FROM user_wallets WHERE openid = ?', [openid]);
  return wallet;
}

async function addWalletRecord(executor, openid, values) {
  await executor.query(
    `INSERT INTO wallet_transactions (openid, coin_delta, cat_food_delta, transaction_type, title, amount, order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [openid, money(values.coinDelta), Number(values.catFoodDelta || 0), values.type, values.title, money(values.amount), values.orderId || null]
  );
}

function profileRow(row, openid) {
  return {
    registrationNo: row && row.user_no ? row.user_no : '',
    nickName: row && row.nick_name ? row.nick_name : '',
    avatarUrl: row && row.avatar_url ? row.avatar_url : '',
    gender: row && row.gender ? row.gender : '未知',
    birthDate: row && row.birth_date ? String(row.birth_date).slice(0, 10) : '',
    bio: row && row.bio ? row.bio : '',
    isGuest: !(row && row.nick_name),
    isAdmin: isAdmin(openid)
  };
}

function partnerRow(row, includeOpenid) {
  if (!row) return null;
  const result = {
    id: row.id,
    partnerNo: row.partner_no || '',
    name: row.display_name || '未命名陪陪',
    avatarUrl: row.avatar_url || '',
    initial: (row.display_name || '喵').slice(0, 1),
    gameName: row.game_name || '',
    game: row.game || '无畏契约',
    gender: row.gender === 'male' ? 'male' : 'female',
    level: row.service_level || '娱乐',
    rankText: row.rank_text || '',
    description: row.description || '',
    audioUrl: row.audio_url || '',
    audioDuration: Number(row.audio_duration || 0),
    hourPrice: Number(row.hour_price || 0),
    gamePrice: Number(row.game_price || 0),
    availableTime: row.available_time || '',
    status: row.status || 'pending',
    createdAt: formatDate(row.created_at),
    updatedAt: formatDate(row.updated_at)
  };
  result.tag = `${result.game} · ${result.level}陪陪`;
  result.service = `${result.game}${result.level}陪玩`;
  if (includeOpenid) result.openid = row.openid;
  return result;
}

async function ensureUser(openid) {
  const [[existing]] = await pool.query('SELECT user_no FROM users WHERE openid = ?', [openid]);
  if (existing && existing.user_no) {
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE openid = ?', [openid]);
    return existing.user_no;
  }

  const [sequence] = await pool.query('INSERT INTO user_sequence () VALUES ()');
  const userNo = `MBU${String(sequence.insertId).padStart(6, '0')}`;
  if (existing) {
    await pool.query('UPDATE users SET user_no = ?, last_login_at = NOW() WHERE openid = ? AND user_no IS NULL', [userNo, openid]);
    return userNo;
  }

  try {
    await pool.query('INSERT INTO users (openid, user_no, last_login_at) VALUES (?, ?, NOW())', [openid, userNo]);
    return userNo;
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      const [[row]] = await pool.query('SELECT user_no FROM users WHERE openid = ?', [openid]);
      return row && row.user_no;
    }
    throw error;
  }
}

async function ensurePartnerNo(openid) {
  const [[existing]] = await pool.query('SELECT partner_no FROM partner_profiles WHERE openid = ?', [openid]);
  if (existing && existing.partner_no) return existing.partner_no;
  const [sequence] = await pool.query('INSERT INTO partner_sequence () VALUES ()');
  const partnerNo = `MBP${String(sequence.insertId).padStart(6, '0')}`;
  if (existing) {
    await pool.query('UPDATE partner_profiles SET partner_no = ? WHERE openid = ? AND partner_no IS NULL', [partnerNo, openid]);
    return partnerNo;
  }
  return partnerNo;
}

function requireOpenid(req, res) {
  const value = getOpenid(req);
  if (!value) {
    send(res, 4001, null, '未获取到用户身份');
    return '';
  }
  return value;
}

function requireAdmin(req, res) {
  const value = requireOpenid(req, res);
  if (!value) return '';
  if (!isAdmin(value)) {
    send(res, 4006, null, '无后台访问权限');
    return '';
  }
  return value;
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    send(res, 0, { service: 'miaoban-orders', database: 'connected' });
  } catch (error) {
    send(res, 5001, null, '数据库未连接');
  }
});

app.get('/api/profile', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    console.info('Profile accessed by OpenID:', userOpenid);
    await ensureUser(userOpenid);
    const [[user]] = await pool.query('SELECT * FROM users WHERE openid = ?', [userOpenid]);
    const [[stats]] = await pool.query(
      `SELECT COUNT(*) AS orderCount, SUM(status = 'pending') AS pendingCount,
       SUM(status = 'completed') AS completedCount,
       COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN points_earned ELSE 0 END), 0) AS pointsBalance
       FROM orders WHERE openid = ?`,
      [userOpenid]
    );
    const wallet = await ensureWallet(pool, userOpenid);
    const [[couponStats]] = await pool.query("SELECT COUNT(*) AS couponCount FROM user_coupons WHERE openid = ? AND status = 'unused'", [userOpenid]);
    send(res, 0, {
      profile: profileRow(user, userOpenid),
      stats: {
        orderCount: Number(stats.orderCount || 0),
        pendingCount: Number(stats.pendingCount || 0),
        completedCount: Number(stats.completedCount || 0),
        pointsBalance: Number(wallet.cat_food_balance || 0),
        coinBalance: money(wallet.coin_balance),
        couponCount: Number(couponStats.couponCount || 0)
      }
    });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '用户资料读取失败');
  }
});

app.patch('/api/profile', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const body = req.body || {};
  const nickName = String(body.nickName || '').trim().slice(0, 32);
  const avatarUrl = String(body.avatarUrl || '').trim().slice(0, 512);
  const gender = ['男', '女', '未知'].includes(body.gender) ? body.gender : '未知';
  const birthDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.birthDate || '')) ? body.birthDate : null;
  const bio = String(body.bio || '').trim().slice(0, 160);
  if (!nickName) return send(res, 4002, null, '请填写昵称');
  try {
    await ensureUser(userOpenid);
    await pool.query(
      `UPDATE users SET nick_name = ?, avatar_url = ?, gender = ?, birth_date = ?, bio = ?, last_login_at = NOW()
       WHERE openid = ?`, [nickName, avatarUrl, gender, birthDate, bio, userOpenid]
    );
    const [[user]] = await pool.query('SELECT * FROM users WHERE openid = ?', [userOpenid]);
    send(res, 0, { profile: profileRow(user, userOpenid) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '用户资料保存失败');
  }
});

app.get('/api/partner/me', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    await ensureUser(userOpenid);
    const [[partner]] = await pool.query('SELECT * FROM partner_profiles WHERE openid = ?', [userOpenid]);
    send(res, 0, { partner: partnerRow(partner, false) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '陪陪资料读取失败');
  }
});

async function requireApprovedPartner(req, res) {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return null;
  const [[partner]] = await pool.query("SELECT * FROM partner_profiles WHERE openid = ? AND status = 'approved'", [userOpenid]);
  if (!partner) { send(res, 4031, null, '仅已通过审核的陪玩可使用接单大厅'); return null; }
  return partner;
}

app.get('/api/partner/orders', async (req, res) => {
  try {
    const partner = await requireApprovedPartner(req, res);
    if (!partner) return;
    const [rows] = await pool.query("SELECT * FROM orders WHERE partner_profile_id = ? AND status IN ('pending', 'progress') ORDER BY created_at DESC", [partner.id]);
    send(res, 0, { orders: rows.map(orderRow) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '接单大厅读取失败');
  }
});

app.patch('/api/partner/orders/:id/accept', async (req, res) => {
  try {
    const partner = await requireApprovedPartner(req, res);
    if (!partner) return;
    const [result] = await pool.query("UPDATE orders SET status = 'progress' WHERE id = ? AND partner_profile_id = ? AND status = 'pending'", [req.params.id, partner.id]);
    if (!result.affectedRows) return send(res, 4004, null, '订单已被处理或不存在');
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? AND partner_profile_id = ?', [req.params.id, partner.id]);
    send(res, 0, { order: orderRow(order) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '接单失败');
  }
});

app.patch('/api/partner/orders/:id/start', async (req, res) => {
  try {
    const partner = await requireApprovedPartner(req, res);
    if (!partner) return;
    const [result] = await pool.query("UPDATE orders SET service_started_at = NOW() WHERE id = ? AND partner_profile_id = ? AND status = 'progress' AND service_started_at IS NULL", [req.params.id, partner.id]);
    if (!result.affectedRows) return send(res, 4004, null, '订单未接单、已开始或不存在');
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? AND partner_profile_id = ?', [req.params.id, partner.id]);
    send(res, 0, { order: orderRow(order) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '开始计时失败');
  }
});

app.patch('/api/partner/orders/:id/complete', async (req, res) => {
  let connection;
  try {
    const partner = await requireApprovedPartner(req, res);
    if (!partner) return;
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[current]] = await connection.query(`SELECT *, TIMESTAMPDIFF(SECOND, service_started_at, NOW()) AS service_seconds
      FROM orders WHERE id = ? AND partner_profile_id = ? AND status = 'progress' AND service_started_at IS NOT NULL FOR UPDATE`, [req.params.id, partner.id]);
    if (!current) { await connection.rollback(); return send(res, 4004, null, '订单尚未开始、已结算或不存在'); }
    const serviceSeconds = Number(current.service_seconds || 0);
    const originalPrice = money(current.total_price);
    let settledPrice = originalPrice;
    if (current.unit === '小时' && serviceSeconds < 35 * 60) settledPrice = money(originalPrice / Number(current.quantity) * 0.5);
    else if (current.unit === '小时' && serviceSeconds < 65 * 60) settledPrice = money(originalPrice / Number(current.quantity));
    const refundCoins = money(Math.max(0, originalPrice - settledPrice));
    const catFood = Math.max(0, Math.floor(settledPrice * 0.3));
    await connection.query("UPDATE orders SET status = 'completed', service_completed_at = NOW(), total_price = ?, points_earned = ? WHERE id = ?", [settledPrice, catFood, current.id]);
    await ensureWallet(connection, current.openid);
    await connection.query('UPDATE user_wallets SET coin_balance = coin_balance + ?, cat_food_balance = cat_food_balance + ? WHERE openid = ?', [refundCoins, catFood, current.openid]);
    if (refundCoins > 0) {
      await addWalletRecord(connection, current.openid, { coinDelta: refundCoins, type: 'early_settlement_refund', title: '提前结单返还金币', amount: refundCoins, orderId: current.id });
    }
    if (catFood > 0) await addWalletRecord(connection, current.openid, { catFoodDelta: catFood, type: 'order_cat_food', title: '订单消费赠送猫粮', amount: settledPrice, orderId: current.id });
    await connection.commit();
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? AND partner_profile_id = ?', [req.params.id, partner.id]);
    send(res, 0, {
      order: orderRow(order),
      settlement: {
        serviceSeconds, refundCoins, message: earlySettlementNotice(serviceSeconds, order.unit)
      }
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(error);
    send(res, 5001, null, '订单结算失败');
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/partner/apply', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const body = req.body || {};
  const displayName = String(body.displayName || '').trim().slice(0, 32);
  const avatarUrl = String(body.avatarUrl || '').trim().slice(0, 512);
  const gameName = String(body.gameName || '').trim().slice(0, 32);
  const game = String(body.game || '无畏契约').trim().slice(0, 32);
  const gender = body.gender === 'male' ? 'male' : (body.gender === 'female' ? 'female' : '');
  const level = ['娱乐', '娱技', '技术', '顶尖'].includes(body.level) ? body.level : '';
  const rankText = String(body.rankText || '').trim().slice(0, 32);
  const description = String(body.description || '').trim().slice(0, 160);
  const audioUrl = String(body.audioUrl || '').trim().slice(0, 512);
  const audioDuration = Math.round(Number(body.audioDuration) || 0);
  const hourPrice = Number(body.hourPrice);
  const gamePrice = Number(body.gamePrice);
  const availableTime = String(body.availableTime || '').trim().slice(0, 80);
  if (!displayName || !gameName || !gender || !level || !rankText || !description || !availableTime || !Number.isFinite(hourPrice) || hourPrice <= 0 || !Number.isFinite(gamePrice) || gamePrice <= 0) {
    return send(res, 4002, null, '请完整填写陪陪资料和价格');
  }
  if (!audioUrl || audioDuration < 1 || audioDuration > 12) return send(res, 4002, null, '请录制 1 至 12 秒的介绍语音');
  try {
    await ensureUser(userOpenid);
    const partnerNo = await ensurePartnerNo(userOpenid);
    await pool.query(
      `INSERT INTO partner_profiles (openid, partner_no, display_name, avatar_url, game_name, game, gender, service_level, rank_text, description, audio_url, audio_duration, hour_price, game_price, available_time, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), avatar_url = VALUES(avatar_url), game_name = VALUES(game_name),
       game = VALUES(game), gender = VALUES(gender), service_level = VALUES(service_level), rank_text = VALUES(rank_text), description = VALUES(description),
       audio_url = VALUES(audio_url), audio_duration = VALUES(audio_duration), hour_price = VALUES(hour_price), game_price = VALUES(game_price), available_time = VALUES(available_time), status = 'pending'`,
      [userOpenid, partnerNo, displayName, avatarUrl, gameName, game, gender, level, rankText, description, audioUrl, audioDuration, hourPrice, gamePrice, availableTime]
    );
    const [[partner]] = await pool.query('SELECT * FROM partner_profiles WHERE openid = ?', [userOpenid]);
    send(res, 0, { partner: partnerRow(partner, false) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '陪陪申请提交失败');
  }
});

app.get('/api/partners', async (req, res) => {
  const category = String(req.query.category || '').trim().slice(0, 32);
  const params = [];
  let where = "WHERE status = 'approved'";
  if (category === 'valorant') {
    where += ' AND game = ?';
    params.push('无畏契约');
  }
  try {
    const [rows] = await pool.query(`SELECT * FROM partner_profiles ${where} ORDER BY updated_at DESC LIMIT 30`, params);
    send(res, 0, { partners: rows.map((row) => partnerRow(row, false)) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '陪陪列表读取失败');
  }
});

app.get('/api/partners/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return send(res, 4002, null, '陪陪信息无效');
  try {
    const [[partner]] = await pool.query("SELECT * FROM partner_profiles WHERE id = ? AND status = 'approved'", [id]);
    if (!partner) return send(res, 4004, null, '该陪陪暂不可预约');
    send(res, 0, { partner: partnerRow(partner, false) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '陪陪资料读取失败');
  }
});

app.get('/api/orders', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const [rows] = await pool.query('SELECT * FROM orders WHERE openid = ? ORDER BY created_at DESC', [userOpenid]);
    send(res, 0, { orders: rows.map(orderRow) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '订单读取失败');
  }
});

app.get('/api/orders/:id', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? AND openid = ?', [req.params.id, userOpenid]);
    if (!order) return send(res, 4004, null, '订单不存在或无权查看');
    send(res, 0, { order: orderRow(order) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '订单详情读取失败');
  }
});

app.get('/api/wallet', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const wallet = await ensureWallet(pool, userOpenid);
    const [records] = await pool.query('SELECT * FROM wallet_transactions WHERE openid = ? ORDER BY created_at DESC LIMIT 50', [userOpenid]);
    const [withdrawals] = await pool.query('SELECT * FROM withdrawal_requests WHERE openid = ? ORDER BY created_at DESC LIMIT 20', [userOpenid]);
    send(res, 0, {
      balance: money(wallet.coin_balance),
      catFoodBalance: Number(wallet.cat_food_balance || 0),
      records: records.map((row) => ({ id: row.id, title: row.title, coinDelta: money(row.coin_delta), catFoodDelta: Number(row.cat_food_delta || 0), createdAt: formatDate(row.created_at) })),
      withdrawals: withdrawals.map((row) => ({ id: row.id, amount: money(row.amount), status: row.status, createdAt: formatDate(row.created_at) }))
    });
  } catch (error) { console.error(error); send(res, 5001, null, '金币钱包读取失败'); }
});

app.get('/api/coupons', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const wallet = await ensureWallet(pool, userOpenid);
    const [coupons] = await pool.query("SELECT * FROM user_coupons WHERE openid = ? ORDER BY FIELD(status, 'unused', 'used', 'expired'), created_at DESC", [userOpenid]);
    send(res, 0, { catFoodBalance: Number(wallet.cat_food_balance || 0), coupons: coupons.map((row) => ({ id: Number(row.id), amount: money(row.amount), catFoodCost: Number(row.cat_food_cost), name: `¥${money(row.amount)} 猫粮兑换券`, status: row.status || 'unused', usedOrderId: row.used_order_id || '', createdAt: formatDate(row.created_at), usedAt: formatDate(row.used_at) })) });
  } catch (error) { console.error(error); send(res, 5001, null, '优惠券读取失败'); }
});

app.post('/api/coupons/exchange', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const amount = money(req.body && req.body.amount);
  const costs = { 3: 30, 5: 50, 10: 100 };
  if (!Object.prototype.hasOwnProperty.call(costs, amount)) return send(res, 4002, null, '请选择有效优惠券面额');
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await ensureWallet(connection, userOpenid);
    const [result] = await connection.query('UPDATE user_wallets SET cat_food_balance = cat_food_balance - ? WHERE openid = ? AND cat_food_balance >= ?', [costs[amount], userOpenid, costs[amount]]);
    if (!result.affectedRows) { await connection.rollback(); return send(res, 4002, null, '猫粮余额不足'); }
    const [couponResult] = await connection.query("INSERT INTO user_coupons (openid, amount, cat_food_cost, status) VALUES (?, ?, ?, 'unused')", [userOpenid, amount, costs[amount]]);
    await addWalletRecord(connection, userOpenid, { catFoodDelta: -costs[amount], type: 'coupon_exchange', title: `兑换 ¥${amount} 优惠券`, amount });
    await connection.commit();
    send(res, 0, { coupon: { id: Number(couponResult.insertId), amount, catFoodCost: costs[amount] } });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '优惠券兑换失败'); }
  finally { if (connection) connection.release(); }
});

app.post('/api/wallet/recharge', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const amount = money(req.body && req.body.amount);
  const gifts = { 6: 0, 30: 1, 68: 4, 128: 10 };
  if (!Object.prototype.hasOwnProperty.call(gifts, amount)) return send(res, 4002, null, '请选择有效充值档位');
  try {
    await ensureWallet(pool, userOpenid);
    await pool.query('UPDATE user_wallets SET coin_balance = coin_balance + ?, cat_food_balance = cat_food_balance + ? WHERE openid = ?', [amount, gifts[amount], userOpenid]);
    await addWalletRecord(pool, userOpenid, { coinDelta: amount, catFoodDelta: gifts[amount], type: 'recharge_demo', title: `充值 ¥${amount}`, amount });
    const wallet = await ensureWallet(pool, userOpenid);
    send(res, 0, { balance: money(wallet.coin_balance), catFoodGift: gifts[amount] });
  } catch (error) { console.error(error); send(res, 5001, null, '充值处理失败'); }
});

app.post('/api/wallet/withdrawals', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const amount = money(req.body && req.body.amount);
  if (!amount || amount < 10) return send(res, 4002, null, '单次提现至少 10 金币');
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const walletBefore = await ensureWallet(connection, userOpenid);
    const balanceBefore = money(walletBefore.coin_balance);
    const [result] = await connection.query('UPDATE user_wallets SET coin_balance = coin_balance - ? WHERE openid = ? AND coin_balance >= ?', [amount, userOpenid, amount]);
    if (!result.affectedRows) { await connection.rollback(); return send(res, 4002, null, '金币余额不足'); }
    const balanceAfter = money(balanceBefore - amount);
    await connection.query("INSERT INTO withdrawal_requests (openid, amount, balance_before, balance_after, status) VALUES (?, ?, ?, ?, 'pending')", [userOpenid, amount, balanceBefore, balanceAfter]);
    await addWalletRecord(connection, userOpenid, { coinDelta: -amount, type: 'withdrawal', title: '提现申请（待处理）', amount });
    await connection.commit();
    const wallet = await ensureWallet(pool, userOpenid);
    send(res, 0, { balance: money(wallet.coin_balance), balanceBefore, balanceAfter, message: '提现申请已提交，客服审核后将为你处理。' });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '提现申请失败'); }
  finally { if (connection) connection.release(); }
});

app.get('/api/points', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const [rows] = await pool.query(
      "SELECT id, partner_name, service, total_price, points_earned, status, created_at FROM orders WHERE openid = ? AND status <> 'cancelled' AND points_earned > 0 ORDER BY created_at DESC LIMIT 100",
      [userOpenid]
    );
    const wallet = await ensureWallet(pool, userOpenid);
    const balance = Number(wallet.cat_food_balance || 0);
    send(res, 0, { balance, records: rows.map((item) => ({ id: item.id, partnerName: item.partner_name || '陪陪订单', service: item.service || '', amount: Number(item.total_price || 0), points: Number(item.points_earned || 0), createdAt: formatDate(item.created_at) })) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '猫粮记录读取失败');
  }
});

app.post('/api/orders', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const body = req.body || {};
  const required = ['partnerName', 'startTime', 'quantity', 'unit', 'priceMode', 'totalPrice', 'paymentMethod'];
  if (required.some((key) => body[key] === undefined || body[key] === '')) return send(res, 4002, null, '订单信息不完整');
  const id = `MB${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const originalTotalPrice = money(body.totalPrice);
  const couponId = Number(body.couponId);
  const pointsEarned = 0;
  let connection;
  try {
    await ensureUser(userOpenid);
    const requestedPartnerId = Number(body.partnerId);
    let partnerProfileId = null;
    if (Number.isInteger(requestedPartnerId) && requestedPartnerId > 0) {
      const [[partner]] = await pool.query("SELECT id FROM partner_profiles WHERE id = ? AND status = 'approved'", [requestedPartnerId]);
      if (partner) partnerProfileId = partner.id;
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    let coupon = null;
    if (Number.isInteger(couponId) && couponId > 0) {
      const [[row]] = await connection.query("SELECT * FROM user_coupons WHERE id = ? AND openid = ? AND status = 'unused' FOR UPDATE", [couponId, userOpenid]);
      if (!row) { await connection.rollback(); return send(res, 4002, null, '优惠券不可用或已使用'); }
      coupon = row;
    }
    const couponDiscount = money(Math.min(originalTotalPrice, coupon ? coupon.amount : 0));
    const totalPrice = money(originalTotalPrice - couponDiscount);
    const catFoodUsed = coupon ? Number(coupon.cat_food_cost || 0) : 0;
    await connection.query(
      `INSERT INTO orders (id, openid, partner_profile_id, partner_name, partner_tag, partner_initial, partner_color, partner_avatar_url, partner_gender, partner_rank_text, service,
        start_time, quantity, unit, price_mode, total_price, original_total_price, cat_food_used, coupon_discount, coupon_id, points_earned, payment_method, remark, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [id, userOpenid, partnerProfileId, body.partnerName, body.partnerTag || '', body.partnerInitial || '', body.partnerColor || '',
        String(body.partnerAvatarUrl || '').slice(0, 512), body.partnerGender === 'male' ? 'male' : 'female', String(body.partnerRankText || '').slice(0, 32),
        body.service || '', body.startTime, Number(body.quantity), body.unit, body.priceMode,
        totalPrice, originalTotalPrice, catFoodUsed, couponDiscount, coupon ? coupon.id : null, pointsEarned, body.paymentMethod, body.remark || '']
    );
    if (coupon) await connection.query("UPDATE user_coupons SET status = 'used', used_order_id = ?, used_at = NOW() WHERE id = ?", [id, coupon.id]);
    await connection.commit();
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? AND openid = ?', [id, userOpenid]);
    send(res, 0, { order: orderRow(order) });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(error);
    send(res, 5001, null, '订单创建失败');
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/orders/:id/renew', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const requestedQuantity = Math.floor(Number((req.body || {}).quantity));
  const requestedUnit = (req.body || {}).unit === '局' ? '局' : '小时';
  if (!Number.isFinite(requestedQuantity) || requestedQuantity < 1) return send(res, 4002, null, '请输入有效的续单数量');
  let connection;
  try {
    const [[source]] = await pool.query("SELECT * FROM orders WHERE id = ? AND openid = ? AND status = 'progress' AND service_completed_at IS NULL", [req.params.id, userOpenid]);
    if (!source) return send(res, 4004, null, '仅未结束的进行中订单可以续单');
    const renewUnit = requestedUnit;
    const maxQuantity = renewUnit === '局' ? 99 : 24;
    const quantity = Math.min(requestedQuantity, maxQuantity);
    const sourceQuantity = Math.max(1, Number(source.quantity || 1));
    const baseAmount = Number(source.original_total_price === null || source.original_total_price === undefined ? source.total_price : source.original_total_price);
    const unitPrice = money(baseAmount / sourceQuantity);
    const totalPrice = money(unitPrice * quantity);
    const id = `MB${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO orders (id, openid, partner_profile_id, partner_name, partner_tag, partner_initial, partner_color, partner_avatar_url, partner_gender, partner_rank_text, service,
        start_time, quantity, unit, price_mode, total_price, original_total_price, cat_food_used, coupon_discount, coupon_id, points_earned, payment_method, remark, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '立即开始', ?, ?, ?, ?, ?, 0, 0, NULL, 0, ?, ?, 'pending')`,
      [id, userOpenid, source.partner_profile_id, source.partner_name, source.partner_tag, source.partner_initial, source.partner_color, source.partner_avatar_url, source.partner_gender, source.partner_rank_text, source.service,
        quantity, renewUnit, renewUnit === '局' ? 'game' : 'hour', totalPrice, totalPrice, source.payment_method, `续自订单 ${source.id} · 按${renewUnit}续单`]
    );
    await connection.commit();
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? AND openid = ?', [id, userOpenid]);
    send(res, 0, { order: orderRow(order) });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '续单创建失败'); }
  finally { if (connection) connection.release(); }
});

app.patch('/api/orders/:id/cancel', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
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

app.post('/api/orders/:id/refund-direct-disabled', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[order]] = await connection.query(
      "SELECT * FROM orders WHERE id = ? AND openid = ? AND status IN ('pending', 'progress', 'completed') FOR UPDATE",
      [req.params.id, userOpenid]
    );
    if (!order) { await connection.rollback(); return send(res, 4004, null, '订单不存在、已取消或已退款'); }
    const refundAmount = money(order.total_price);
    const catFoodToDeduct = Math.max(0, Number(order.points_earned || 0));
    await ensureWallet(connection, userOpenid);
    const [[wallet]] = await connection.query('SELECT * FROM user_wallets WHERE openid = ? FOR UPDATE', [userOpenid]);
    if (Number(wallet.cat_food_balance || 0) < catFoodToDeduct) {
      await connection.rollback();
      return send(res, 4002, null, `猫粮余额不足，需扣回 ${catFoodToDeduct} 猫粮后才能退款`);
    }
    await connection.query(
      "UPDATE orders SET status = 'cancelled', remark = CONCAT(COALESCE(remark, ''), ?) WHERE id = ?",
      [` [已退款：¥${refundAmount}，扣回${catFoodToDeduct}猫粮]`, order.id]
    );
    await connection.query('UPDATE user_wallets SET coin_balance = coin_balance + ?, cat_food_balance = cat_food_balance - ? WHERE openid = ?', [refundAmount, catFoodToDeduct, userOpenid]);
    await addWalletRecord(connection, userOpenid, { coinDelta: refundAmount, catFoodDelta: -catFoodToDeduct, type: 'order_refund', title: '订单退款（返还金币、扣回猫粮）', amount: refundAmount, orderId: order.id });
    await connection.commit();
    const [[updatedOrder]] = await pool.query('SELECT * FROM orders WHERE id = ? AND openid = ?', [order.id, userOpenid]);
    send(res, 0, { order: orderRow(updatedOrder), refundAmount, catFoodToDeduct });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(error);
    send(res, 5001, null, '订单退款失败');
  } finally { if (connection) connection.release(); }
});

app.post('/api/orders/:id/refund-requests', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const reason = String((req.body || {}).reason || '').trim().slice(0, 300);
  const evidence = Array.isArray((req.body || {}).evidence) ? (req.body || {}).evidence.map((item) => String(item || '').slice(0, 512)).filter(Boolean).slice(0, 3) : [];
  if (reason.length < 5) return send(res, 4002, null, '请填写至少 5 个字的退款理由');
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[order]] = await connection.query("SELECT * FROM orders WHERE id = ? AND openid = ? AND status <> 'cancelled' FOR UPDATE", [req.params.id, userOpenid]);
    if (!order) { await connection.rollback(); return send(res, 4004, null, '订单不存在、已取消或已退款'); }
    const [[existing]] = await connection.query("SELECT id FROM refund_requests WHERE order_id = ? AND status = 'pending' FOR UPDATE", [order.id]);
    if (existing) { await connection.rollback(); return send(res, 4002, null, '该订单已有待处理退款申请'); }
    const [result] = await connection.query("INSERT INTO refund_requests (order_id, openid, refund_amount, cat_food_to_deduct, reason, evidence_json, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')", [order.id, userOpenid, money(order.total_price), Math.max(0, Number(order.points_earned || 0)), reason, JSON.stringify(evidence)]);
    await connection.commit();
    send(res, 0, { id: Number(result.insertId), orderId: order.id, refundAmount: money(order.total_price), catFoodToDeduct: Math.max(0, Number(order.points_earned || 0)) });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(error);
    send(res, 5001, null, '退款申请提交失败');
  } finally { if (connection) connection.release(); }
});

function refundRequestRow(row) {
  let evidence = [];
  let rejectEvidence = [];
  try { evidence = JSON.parse(row.evidence_json || '[]'); } catch (_) { evidence = []; }
  try { rejectEvidence = JSON.parse(row.reject_evidence_json || '[]'); } catch (_) { rejectEvidence = []; }
  return { ...orderRow(row), refund: { id: Number(row.refund_id), status: row.refund_status, amount: money(row.refund_amount), reason: row.reason || '', rejectReason: row.reject_reason || '', evidence: Array.isArray(evidence) ? evidence : [], rejectEvidence: Array.isArray(rejectEvidence) ? rejectEvidence : [], createdAt: formatDate(row.refund_created_at), reviewedAt: formatDate(row.reviewed_at), catFoodToDeduct: Number(row.cat_food_to_deduct || 0) } };
}

app.get('/api/refund-requests', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const [rows] = await pool.query(`SELECT o.*, r.id AS refund_id, r.status AS refund_status, r.refund_amount, r.cat_food_to_deduct, r.reason, r.reject_reason, r.reject_evidence_json, r.evidence_json, r.created_at AS refund_created_at, r.reviewed_at FROM refund_requests r JOIN orders o ON o.id = r.order_id WHERE r.openid = ? AND r.status IN ('pending', 'rejected', 'refunded') ORDER BY r.created_at DESC`, [userOpenid]);
    send(res, 0, { refunds: rows.map(refundRequestRow) });
  } catch (error) { console.error(error); send(res, 5001, null, '退款订单读取失败'); }
});

app.get('/api/refund-requests/:id', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return send(res, 4002, null, '退款申请无效');
  try {
    const [[row]] = await pool.query(`SELECT o.*, r.id AS refund_id, r.status AS refund_status, r.refund_amount, r.cat_food_to_deduct, r.reason, r.reject_reason, r.reject_evidence_json, r.evidence_json, r.created_at AS refund_created_at, r.reviewed_at FROM refund_requests r JOIN orders o ON o.id = r.order_id WHERE r.id = ? AND r.openid = ?`, [id, userOpenid]);
    if (!row) return send(res, 4004, null, '退款申请不存在');
    send(res, 0, { refund: refundRequestRow(row) });
  } catch (error) { console.error(error); send(res, 5001, null, '退款详情读取失败'); }
});

app.get('/api/admin/summary', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [[users]] = await pool.query(
      `SELECT COUNT(*) AS totalUsers, SUM(DATE(created_at) = CURDATE()) AS todayNew,
       SUM(created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)) AS weekNew FROM users`
    );
    const [[orders]] = await pool.query(
      `SELECT COUNT(*) AS orderCount, SUM(status = 'pending') AS pendingCount,
       COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_price ELSE 0 END), 0) AS revenue FROM orders`
    );
    const [[partners]] = await pool.query(
      "SELECT COUNT(*) AS totalPartners, SUM(status = 'pending') AS pendingPartners, SUM(status = 'approved') AS approvedPartners FROM partner_profiles"
    );
    const [[withdrawals]] = await pool.query("SELECT COUNT(*) AS pendingWithdrawals FROM withdrawal_requests WHERE status = 'pending'");
    const [[refunds]] = await pool.query("SELECT COUNT(*) AS pendingRefunds FROM refund_requests WHERE status = 'pending'");
    send(res, 0, {
      totalUsers: Number(users.totalUsers || 0), todayNew: Number(users.todayNew || 0), weekNew: Number(users.weekNew || 0),
      orderCount: Number(orders.orderCount || 0), pendingCount: Number(orders.pendingCount || 0), revenue: Number(orders.revenue || 0),
      totalPartners: Number(partners.totalPartners || 0), pendingPartners: Number(partners.pendingPartners || 0), approvedPartners: Number(partners.approvedPartners || 0),
      pendingWithdrawals: Number(withdrawals.pendingWithdrawals || 0),
      pendingRefunds: Number(refunds.pendingRefunds || 0)
    });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '运营数据读取失败');
  }
});

app.get('/api/admin/withdrawals', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [rows] = await pool.query(`SELECT w.*, u.user_no, u.nick_name FROM withdrawal_requests w
      LEFT JOIN users u ON u.openid = w.openid ORDER BY FIELD(w.status, 'pending', 'approved', 'paid', 'rejected'), w.created_at DESC LIMIT 100`);
    send(res, 0, { withdrawals: rows.map((row) => ({ id: Number(row.id), openid: row.openid, userNo: row.user_no || '', nickName: row.nick_name || '未完善资料用户', amount: money(row.amount), balanceBefore: row.balance_before === null ? null : money(row.balance_before), balanceAfter: row.balance_after === null ? null : money(row.balance_after), status: row.status, createdAt: formatDate(row.created_at) })) });
  } catch (error) { console.error(error); send(res, 5001, null, '提现审核列表读取失败'); }
});

app.get('/api/admin/withdrawals/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return send(res, 4002, null, '提现申请无效');
  try {
    const [[row]] = await pool.query(`SELECT w.*, u.user_no, u.nick_name, u.avatar_url FROM withdrawal_requests w
      LEFT JOIN users u ON u.openid = w.openid WHERE w.id = ?`, [id]);
    if (!row) return send(res, 4004, null, '提现申请不存在');
    send(res, 0, { withdrawal: { id: Number(row.id), openid: row.openid, userNo: row.user_no || '', nickName: row.nick_name || '未完善资料用户', avatarUrl: row.avatar_url || '', amount: money(row.amount), balanceBefore: row.balance_before === null ? null : money(row.balance_before), balanceAfter: row.balance_after === null ? null : money(row.balance_after), status: row.status, createdAt: formatDate(row.created_at), updatedAt: formatDate(row.updated_at) } });
  } catch (error) { console.error(error); send(res, 5001, null, '提现详情读取失败'); }
});

app.patch('/api/admin/withdrawals/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  const status = String((req.body || {}).status || '');
  if (!Number.isInteger(id) || id <= 0 || !['approved', 'rejected', 'paid'].includes(status)) return send(res, 4002, null, '审核状态无效');
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[withdrawal]] = await connection.query('SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE', [id]);
    if (!withdrawal) { await connection.rollback(); return send(res, 4004, null, '提现申请不存在'); }
    if (status === 'rejected') {
      if (withdrawal.status !== 'pending') { await connection.rollback(); return send(res, 4002, null, '仅审核中的申请可以驳回'); }
      await ensureWallet(connection, withdrawal.openid);
      await connection.query('UPDATE user_wallets SET coin_balance = coin_balance + ? WHERE openid = ?', [withdrawal.amount, withdrawal.openid]);
      await addWalletRecord(connection, withdrawal.openid, { coinDelta: withdrawal.amount, type: 'withdrawal_rejected', title: '提现驳回返还金币', amount: withdrawal.amount });
    } else if (status === 'approved' && withdrawal.status !== 'pending') {
      await connection.rollback(); return send(res, 4002, null, '仅审核中的申请可以通过');
    } else if (status === 'paid' && withdrawal.status !== 'approved') {
      await connection.rollback(); return send(res, 4002, null, '请先通过审核后再标记已打款');
    }
    await connection.query('UPDATE withdrawal_requests SET status = ? WHERE id = ?', [status, id]);
    await connection.commit();
    send(res, 0, { id, status });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '提现审核处理失败'); }
  finally { if (connection) connection.release(); }
});

app.get('/api/admin/refund-requests', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [rows] = await pool.query(`SELECT r.*, u.user_no, u.nick_name, u.avatar_url,
      o.partner_name, o.payment_method, o.unit, o.quantity, o.total_price AS order_total_price,
      o.service_started_at, o.service_completed_at
      FROM refund_requests r
      LEFT JOIN users u ON u.openid = r.openid
      LEFT JOIN orders o ON o.id = r.order_id
      ORDER BY FIELD(r.status, 'pending', 'approved', 'rejected', 'refunded'), r.created_at DESC LIMIT 100`);
    send(res, 0, { refunds: rows.map((row) => {
      let evidence = []; let rejectEvidence = [];
      try { evidence = JSON.parse(row.evidence_json || '[]'); } catch (_) { evidence = []; }
      try { rejectEvidence = JSON.parse(row.reject_evidence_json || '[]'); } catch (_) { rejectEvidence = []; }
      return {
        id: Number(row.id), orderId: row.order_id, openid: row.openid, userNo: row.user_no || '', nickName: row.nick_name || '未完善资料用户', avatarUrl: row.avatar_url || '',
        partnerName: row.partner_name || '—', paymentMethod: row.payment_method || '—', unit: row.unit || '', quantity: Number(row.quantity || 0),
        orderTotalPrice: money(row.order_total_price), refundAmount: money(row.refund_amount), catFoodToDeduct: Number(row.cat_food_to_deduct || 0),
        reason: row.reason || '', rejectReason: row.reject_reason || '', evidence: Array.isArray(evidence) ? evidence : [], rejectEvidence: Array.isArray(rejectEvidence) ? rejectEvidence : [], status: row.status,
        createdAt: formatDate(row.created_at), reviewedAt: formatDate(row.reviewed_at), serviceStartedAt: formatDate(row.service_started_at), serviceCompletedAt: formatDate(row.service_completed_at)
      };
    }) });
  } catch (error) { console.error(error); send(res, 5001, null, '退款审核列表读取失败'); }
});

app.get('/api/admin/refund-requests/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return send(res, 4002, null, '退款申请无效');
  try {
    const [[row]] = await pool.query(`SELECT r.*, u.user_no, u.nick_name, u.avatar_url, o.partner_name, o.payment_method, o.unit, o.quantity, o.total_price AS order_total_price, o.service_started_at, o.service_completed_at FROM refund_requests r LEFT JOIN users u ON u.openid = r.openid LEFT JOIN orders o ON o.id = r.order_id WHERE r.id = ?`, [id]);
    if (!row) return send(res, 4004, null, '退款申请不存在');
    let evidence = []; let rejectEvidence = [];
    try { evidence = JSON.parse(row.evidence_json || '[]'); } catch (_) { evidence = []; }
    try { rejectEvidence = JSON.parse(row.reject_evidence_json || '[]'); } catch (_) { rejectEvidence = []; }
    send(res, 0, { refund: { id: Number(row.id), orderId: row.order_id, openid: row.openid, userNo: row.user_no || '', nickName: row.nick_name || '未完善资料用户', avatarUrl: row.avatar_url || '', partnerName: row.partner_name || '—', paymentMethod: row.payment_method || '—', unit: row.unit || '', quantity: Number(row.quantity || 0), orderTotalPrice: money(row.order_total_price), refundAmount: money(row.refund_amount), catFoodToDeduct: Number(row.cat_food_to_deduct || 0), reason: row.reason || '', rejectReason: row.reject_reason || '', evidence: Array.isArray(evidence) ? evidence : [], rejectEvidence: Array.isArray(rejectEvidence) ? rejectEvidence : [], status: row.status, createdAt: formatDate(row.created_at), reviewedAt: formatDate(row.reviewed_at) } });
  } catch (error) { console.error(error); send(res, 5001, null, '退款审核详情读取失败'); }
});

app.patch('/api/admin/refund-requests/:id/status', async (req, res) => {
  const reviewerOpenid = requireAdmin(req, res);
  if (!reviewerOpenid) return;
  const id = Number(req.params.id);
  const status = String((req.body || {}).status || '');
  const rejectReason = String((req.body || {}).reason || '').trim().slice(0, 300);
  const rejectEvidence = Array.isArray((req.body || {}).evidence) ? (req.body || {}).evidence.map((item) => String(item || '').slice(0, 512)).filter(Boolean).slice(0, 3) : [];
  if (!Number.isInteger(id) || id <= 0 || !['approved', 'rejected'].includes(status)) return send(res, 4002, null, '退款审核状态无效');
  if (status === 'rejected' && !rejectReason) return send(res, 4002, null, '请填写拒绝退款原因');
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[refund]] = await connection.query('SELECT * FROM refund_requests WHERE id = ? FOR UPDATE', [id]);
    if (!refund) { await connection.rollback(); return send(res, 4004, null, '退款申请不存在'); }
    if (refund.status !== 'pending') { await connection.rollback(); return send(res, 4002, null, '该退款申请已处理'); }
    if (status === 'rejected') {
      await connection.query("UPDATE refund_requests SET status = 'rejected', reject_reason = ?, reject_evidence_json = ?, reviewer_openid = ?, reviewed_at = NOW() WHERE id = ?", [rejectReason, JSON.stringify(rejectEvidence), reviewerOpenid, id]);
      await connection.commit();
      return send(res, 0, { id, status: 'rejected', rejectReason, notice: '拒绝原因已记录，请通过首页同一企微客服会话告知用户。' });
    }
    const [[order]] = await connection.query(`SELECT *, TIMESTAMPDIFF(SECOND, service_started_at, COALESCE(service_completed_at, NOW())) AS service_seconds
      FROM orders WHERE id = ? AND openid = ? FOR UPDATE`, [refund.order_id, refund.openid]);
    if (!order || order.status === 'cancelled') { await connection.rollback(); return send(res, 4004, null, '订单不存在或已退款'); }
    let refundAmount = 0;
    const seconds = Math.max(0, Number(order.service_seconds || 0));
    if (order.unit === '小时') {
      if (!order.service_started_at || seconds < 28 * 60) { await connection.rollback(); return send(res, 4002, null, '服务时长不足 28 分钟，不满足退款规则'); }
      if (seconds > 60 * 60) { await connection.rollback(); return send(res, 4002, null, '服务时长已超过 1 小时，请人工协商处理'); }
      const hourlyPrice = money(Number(order.original_total_price === null ? order.total_price : order.original_total_price) / Math.max(1, Number(order.quantity || 1)));
      refundAmount = money(hourlyPrice * (seconds < 57 * 60 ? 0.5 : 1));
    } else {
      refundAmount = money(order.total_price);
    }
    const catFoodToDeduct = Math.max(0, Number(order.points_earned || 0));
    await ensureWallet(connection, refund.openid);
    const [[wallet]] = await connection.query('SELECT * FROM user_wallets WHERE openid = ? FOR UPDATE', [refund.openid]);
    if (Number(wallet.cat_food_balance || 0) < catFoodToDeduct) { await connection.rollback(); return send(res, 4002, null, `用户猫粮余额不足，需扣回 ${catFoodToDeduct} 猫粮`); }
    await connection.query("UPDATE orders SET status = 'cancelled', remark = CONCAT(COALESCE(remark, ''), ?) WHERE id = ?", [` [订单退款：¥${refundAmount}，原路退回（演示），扣回${catFoodToDeduct}猫粮]`, order.id]);
    await connection.query('UPDATE user_wallets SET coin_balance = coin_balance + ?, cat_food_balance = cat_food_balance - ? WHERE openid = ?', [refundAmount, catFoodToDeduct, refund.openid]);
    await addWalletRecord(connection, refund.openid, { coinDelta: refundAmount, catFoodDelta: -catFoodToDeduct, type: 'order_refund', title: '订单退款（原路退款演示）', amount: refundAmount, orderId: order.id });
    await connection.query("UPDATE refund_requests SET status = 'refunded', refund_amount = ?, cat_food_to_deduct = ?, reviewer_openid = ?, reviewed_at = NOW() WHERE id = ?", [refundAmount, catFoodToDeduct, reviewerOpenid, id]);
    await connection.commit();
    send(res, 0, { id, status: 'refunded', refundAmount, catFoodToDeduct, refundRoute: order.payment_method || '原支付路径（演示）' });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '退款审核处理失败'); }
  finally { if (connection) connection.release(); }
});

app.get('/api/admin/partners', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const keyword = String(req.query.keyword || '').trim().slice(0, 32);
  const status = ['pending', 'approved', 'rejected', 'offline'].includes(req.query.status) ? req.query.status : '';
  const clauses = [];
  const params = [];
  if (keyword) {
    clauses.push('(partner_no LIKE ? OR display_name LIKE ? OR game_name LIKE ? OR openid LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  try {
    const [rows] = await pool.query(`SELECT * FROM partner_profiles ${where} ORDER BY FIELD(status, 'pending', 'approved', 'offline', 'rejected'), updated_at DESC LIMIT 100`, params);
    send(res, 0, { partners: rows.map((row) => partnerRow(row, true)) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '陪陪审核列表读取失败');
  }
});

app.patch('/api/admin/partners/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  const status = String((req.body || {}).status || '');
  if (!Number.isInteger(id) || id <= 0 || !['approved', 'rejected', 'offline'].includes(status)) return send(res, 4002, null, '审核状态无效');
  try {
    const [result] = await pool.query('UPDATE partner_profiles SET status = ? WHERE id = ?', [status, id]);
    if (!result.affectedRows) return send(res, 4004, null, '陪陪资料不存在');
    const [[partner]] = await pool.query('SELECT * FROM partner_profiles WHERE id = ?', [id]);
    send(res, 0, { partner: partnerRow(partner, true) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '审核状态更新失败');
  }
});

app.get('/api/admin/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const keyword = String(req.query.keyword || '').trim().slice(0, 32);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 30));
  const where = keyword ? 'WHERE u.nick_name LIKE ? OR u.user_no LIKE ? OR u.openid LIKE ?' : '';
  const params = keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [];
  try {
    const [[totalRow]] = await pool.query(`SELECT COUNT(*) AS total FROM users u ${where}`, params);
    const [rows] = await pool.query(
      `SELECT u.openid, u.user_no, u.nick_name, u.avatar_url, u.gender, u.birth_date, u.bio, u.created_at, u.last_login_at,
       COUNT(o.id) AS order_count, COALESCE(SUM(CASE WHEN o.status <> 'cancelled' THEN o.total_price ELSE 0 END), 0) AS total_spent,
       MAX(COALESCE(w.coin_balance, 268)) AS coin_balance,
       MAX(COALESCE(w.cat_food_balance, 0)) AS cat_food_balance,
       (SELECT COUNT(*) FROM user_coupons c WHERE c.openid = u.openid AND c.status = 'unused') AS coupon_balance
       FROM users u LEFT JOIN orders o ON u.openid = o.openid LEFT JOIN user_wallets w ON u.openid = w.openid ${where}
       GROUP BY u.openid ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    send(res, 0, {
      total: Number(totalRow.total || 0), page, pageSize,
      users: rows.map((row) => ({
        openid: row.openid, registrationNo: row.user_no || '', nickName: row.nick_name || '未完善资料用户', avatarUrl: row.avatar_url || '', gender: row.gender || '未知',
        birthDate: row.birth_date ? String(row.birth_date).slice(0, 10) : '', bio: row.bio || '',
        createdAt: formatDate(row.created_at), lastLoginAt: formatDate(row.last_login_at),
        orderCount: Number(row.order_count || 0), totalSpent: Number(row.total_spent || 0), coinBalance: money(row.coin_balance), catFoodBalance: Number(row.cat_food_balance || 0), couponBalance: Number(row.coupon_balance || 0)
      }))
    });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '用户列表读取失败');
  }
});

app.get('/api/admin/users/:openid/detail', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const openid = String(req.params.openid || '').trim();
  if (!openid) return send(res, 4002, null, '用户标识无效');
  try {
    const [[user]] = await pool.query('SELECT * FROM users WHERE openid = ?', [openid]);
    if (!user) return send(res, 4004, null, '用户不存在');
    const wallet = await ensureWallet(pool, openid);
    const [orders] = await pool.query('SELECT * FROM orders WHERE openid = ? ORDER BY created_at DESC LIMIT 200', [openid]);
    const [withdrawals] = await pool.query('SELECT * FROM withdrawal_requests WHERE openid = ? ORDER BY created_at DESC LIMIT 100', [openid]);
    const [walletRecords] = await pool.query('SELECT * FROM wallet_transactions WHERE openid = ? ORDER BY created_at DESC LIMIT 200', [openid]);
    const [coupons] = await pool.query('SELECT * FROM user_coupons WHERE openid = ? ORDER BY created_at DESC LIMIT 100', [openid]);
    send(res, 0, {
      user: {
        openid: user.openid, registrationNo: user.user_no || '', nickName: user.nick_name || '未完善资料用户', avatarUrl: user.avatar_url || '', gender: user.gender || '未知',
        birthDate: user.birth_date ? String(user.birth_date).slice(0, 10) : '', bio: user.bio || '', createdAt: formatDate(user.created_at), lastLoginAt: formatDate(user.last_login_at),
        coinBalance: money(wallet.coin_balance), catFoodBalance: Number(wallet.cat_food_balance || 0), couponBalance: coupons.filter((row) => row.status === 'unused').length
      },
      orders: orders.map(orderRow),
      withdrawals: withdrawals.map((row) => ({ id: Number(row.id), amount: money(row.amount), balanceBefore: row.balance_before === null ? null : money(row.balance_before), balanceAfter: row.balance_after === null ? null : money(row.balance_after), status: row.status, createdAt: formatDate(row.created_at) })),
      walletRecords: walletRecords.map((row) => ({ id: Number(row.id), title: row.title, transactionType: row.transaction_type, coinDelta: money(row.coin_delta), catFoodDelta: Number(row.cat_food_delta || 0), amount: money(row.amount), orderId: row.order_id || '', createdAt: formatDate(row.created_at) })),
      coupons: coupons.map((row) => ({ id: Number(row.id), amount: money(row.amount), catFoodCost: Number(row.cat_food_cost), status: row.status, createdAt: formatDate(row.created_at), usedAt: formatDate(row.used_at) })),
      lotteryRecords: []
    });
  } catch (error) { console.error(error); send(res, 5001, null, '用户详情读取失败'); }
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError) return send(res, 4003, null, '请求数据格式错误');
  next(error);
});

app.listen(process.env.PORT || 80, () => console.log('Miaoban orders service started'));
