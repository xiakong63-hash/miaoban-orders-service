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
    pointsEarned: Number(row.points_earned || 0),
    paymentMethod: row.payment_method,
    remark: row.remark,
    status: row.status,
    serviceStartedAt: formatDate(row.service_started_at),
    createdAt: formatDate(row.created_at)
  };
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
    send(res, 0, {
      profile: profileRow(user, userOpenid),
      stats: {
        orderCount: Number(stats.orderCount || 0),
        pendingCount: Number(stats.pendingCount || 0),
        completedCount: Number(stats.completedCount || 0),
        pointsBalance: Number(stats.pointsBalance || 0)
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

app.get('/api/points', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const [rows] = await pool.query(
      "SELECT id, partner_name, service, total_price, points_earned, status, created_at FROM orders WHERE openid = ? AND status <> 'cancelled' AND points_earned > 0 ORDER BY created_at DESC LIMIT 100",
      [userOpenid]
    );
    const balance = rows.reduce((total, item) => total + Number(item.points_earned || 0), 0);
    send(res, 0, { balance, records: rows.map((item) => ({ id: item.id, partnerName: item.partner_name || '陪陪订单', service: item.service || '', amount: Number(item.total_price || 0), points: Number(item.points_earned || 0), createdAt: formatDate(item.created_at) })) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '积分记录读取失败');
  }
});

app.post('/api/orders', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const body = req.body || {};
  const required = ['partnerName', 'startTime', 'quantity', 'unit', 'priceMode', 'totalPrice', 'paymentMethod'];
  if (required.some((key) => body[key] === undefined || body[key] === '')) return send(res, 4002, null, '订单信息不完整');
  const id = `MB${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const pointsEarned = Math.max(0, Math.floor(Number(body.totalPrice) || 0));
  try {
    await ensureUser(userOpenid);
    const requestedPartnerId = Number(body.partnerId);
    let partnerProfileId = null;
    if (Number.isInteger(requestedPartnerId) && requestedPartnerId > 0) {
      const [[partner]] = await pool.query("SELECT id FROM partner_profiles WHERE id = ? AND status = 'approved'", [requestedPartnerId]);
      if (partner) partnerProfileId = partner.id;
    }
    await pool.query(
      `INSERT INTO orders (id, openid, partner_profile_id, partner_name, partner_tag, partner_initial, partner_color, partner_avatar_url, partner_gender, partner_rank_text, service,
        start_time, quantity, unit, price_mode, total_price, points_earned, payment_method, remark, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [id, userOpenid, partnerProfileId, body.partnerName, body.partnerTag || '', body.partnerInitial || '', body.partnerColor || '',
        String(body.partnerAvatarUrl || '').slice(0, 512), body.partnerGender === 'male' ? 'male' : 'female', String(body.partnerRankText || '').slice(0, 32),
        body.service || '', body.startTime, Number(body.quantity), body.unit, body.priceMode,
        Number(body.totalPrice), pointsEarned, body.paymentMethod, body.remark || '']
    );
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? AND openid = ?', [id, userOpenid]);
    send(res, 0, { order: orderRow(order) });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '订单创建失败');
  }
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
    send(res, 0, {
      totalUsers: Number(users.totalUsers || 0), todayNew: Number(users.todayNew || 0), weekNew: Number(users.weekNew || 0),
      orderCount: Number(orders.orderCount || 0), pendingCount: Number(orders.pendingCount || 0), revenue: Number(orders.revenue || 0),
      totalPartners: Number(partners.totalPartners || 0), pendingPartners: Number(partners.pendingPartners || 0), approvedPartners: Number(partners.approvedPartners || 0)
    });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '运营数据读取失败');
  }
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
       COUNT(o.id) AS order_count, COALESCE(SUM(CASE WHEN o.status <> 'cancelled' THEN o.total_price ELSE 0 END), 0) AS total_spent
       FROM users u LEFT JOIN orders o ON u.openid = o.openid ${where}
       GROUP BY u.openid ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    send(res, 0, {
      total: Number(totalRow.total || 0), page, pageSize,
      users: rows.map((row) => ({
        openid: row.openid, registrationNo: row.user_no || '', nickName: row.nick_name || '未完善资料用户', avatarUrl: row.avatar_url || '', gender: row.gender || '未知',
        birthDate: row.birth_date ? String(row.birth_date).slice(0, 10) : '', bio: row.bio || '',
        createdAt: formatDate(row.created_at), lastLoginAt: formatDate(row.last_login_at),
        orderCount: Number(row.order_count || 0), totalSpent: Number(row.total_spent || 0)
      }))
    });
  } catch (error) {
    console.error(error);
    send(res, 5001, null, '用户列表读取失败');
  }
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError) return send(res, 4003, null, '请求数据格式错误');
  next(error);
});

app.listen(process.env.PORT || 80, () => console.log('Miaoban orders service started'));
