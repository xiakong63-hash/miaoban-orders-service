const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');
const { FUN_COUPON_WEEKLY_LIMIT, weeklyFunCouponUsage } = require('./fun-coupon-limit');
const PARTNER_GIFTS = require('./gift-catalog');
const MEMBERSHIP_DEMO_ENABLED = process.env.MEMBERSHIP_DEMO_ENABLED === 'true';

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

function discountLabel(rate) {
  return Number((Number(rate) * 10).toFixed(1));
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

async function hasCoinOrderPayment(executor, openid, orderId) {
  const [[payment]] = await executor.query("SELECT id FROM wallet_transactions WHERE openid = ? AND order_id = ? AND transaction_type = 'order_payment' AND coin_delta < 0 LIMIT 1", [openid, orderId]);
  return !!payment;
}

const MEMBERSHIP_PLANS = {
  vip: { tier: 'vip', name: 'VIP会员', badge: 'VIP', price: 388, catFood: 388, monthlyCoupons: 2, monthlyRate: 0.95, monthlyCap: 25, quarterlyRate: 0.9, quarterlyCap: 35, birthdayGift: 200, rescheduleCount: 2, crown: '每年 3 天个冠体验' },
  svip: { tier: 'svip', name: 'SVIP会员', badge: 'SVIP', price: 888, catFood: 888, monthlyCoupons: 3, monthlyRate: 0.9, monthlyCap: 35, quarterlyRate: 0.88, quarterlyCap: 50, birthdayGift: 500, rescheduleCount: 4, crown: '每年 15 天个冠 + 3 天群冠' }
};

const LUCKY_PRIZES = [
  { key: 'small_food', name: '小猫粮包', probability: 33, type: 'cat_food', catFood: 25, desc: '返还 25 猫粮，并获得随机趣味任务资格', special: false, expiresDays: 0 },
  { key: 'medium_food', name: '中猫粮包', probability: 25, type: 'cat_food', catFood: 50, desc: '返还 50 猫粮', special: false, expiresDays: 0 },
  { key: 'large_food', name: '大猫粮包', probability: 18, type: 'cat_food', catFood: 100, desc: '返还 100 猫粮', special: false, expiresDays: 0 },
  { key: 'coupon_98', name: '9.8折券', probability: 10, type: 'coupon', rate: 0.98, maxDiscount: 10, desc: '单笔最高优惠 10 金币', special: true, expiresDays: 7 },
  { key: 'coupon_95', name: '9.5折券', probability: 7, type: 'coupon', rate: 0.95, maxDiscount: 20, desc: '单笔最高优惠 20 金币', special: true, expiresDays: 7 },
  { key: 'coupon_90', name: '9折券', probability: 3.5, type: 'coupon', rate: 0.9, maxDiscount: 25, desc: '单笔最高优惠 25 金币', special: true, expiresDays: 7 },
  { key: 'fun_coupon', name: '趣味单体验券', probability: 2, type: 'coupon', rate: 1, maxDiscount: 10, desc: '趣味单减免 10 金币', special: true, expiresDays: 7 },
  { key: 'activity_entry', name: '活动报名资格', probability: 1, type: 'activity', desc: '可报名当期指定活动', special: true, expiresDays: 30 },
  { key: 'crown_trial', name: '个冠体验券', probability: 0.5, type: 'crown', desc: '30 天内可激活，激活后享受 3 天个冠体验', special: true, expiresDays: 30 }
];

const CAT_FOOD_COUPON_OPTIONS = [
  { key: '50_5', threshold: 50, amount: 5, cost: 50 }, { key: '100_10', threshold: 100, amount: 10, cost: 100 },
  { key: '200_20', threshold: 200, amount: 20, cost: 190 }, { key: '300_30', threshold: 300, amount: 30, cost: 270 },
  { key: '500_50', threshold: 500, amount: 50, cost: 425 }, { key: '800_80', threshold: 800, amount: 80, cost: 640 },
  { key: '1200_120', threshold: 1200, amount: 120, cost: 900 }
];

const COUPON_ELIGIBLE_FUN_SERVICES = new Set(
  String(process.env.COUPON_ELIGIBLE_FUN_SERVICES || '').split(',').map((service) => service.trim()).filter(Boolean)
);

function couponOrderError(coupon, scene, service, paymentMethod, unit, quantity) {
  const orderScene = /趣味/.test(service) ? 'fun' : String(scene || 'regular');
  if (['special', 'group', 'agent', 'activity', 'membership', 'gift', 'crown', 'event'].includes(orderScene) ||
      /特价|拼单|代付|活动价|会员费|礼物订单|冠名权益|活动报名/.test(service)) {
    return '该订单类型不可使用优惠券';
  }
  if (orderScene === 'fun' && coupon.coupon_name !== '趣味单体验券' && !COUPON_ELIGIBLE_FUN_SERVICES.has(service)) {
    return '该趣味单尚未公告支持优惠券';
  }
  if (coupon.coupon_name === '趣味单体验券' && orderScene !== 'fun') return '趣味单体验券仅限趣味单使用';
  if (/赠送余额/.test(paymentMethod)) return '预存赠送余额不可与优惠券叠加使用';
  if (unit === '小时' && Number(quantity) < 1) return '按时长订单满 60 分钟才可使用优惠券';
  return '';
}

const GROWTH_LEVELS = [
  { key: 'iron', name: '萌爪黑铁', threshold: 0, reward: 0, freeLucky: 0 }, { key: 'bronze', name: '小爪青铜', threshold: 500, reward: 50, freeLucky: 0 },
  { key: 'silver', name: '月光白银', threshold: 1500, reward: 100, freeLucky: 0 }, { key: 'gold', name: '蜂蜜黄金', threshold: 3000, reward: 200, freeLucky: 1 },
  { key: 'platinum', name: '云朵铂金', threshold: 6000, reward: 300, freeLucky: 1 }, { key: 'diamond', name: '星钻钻石', threshold: 10000, reward: 500, freeLucky: 2 },
  { key: 'mythic', name: '王冠神话', threshold: 20000, reward: 1000, freeLucky: 3 }
];

function growthLevel(points) { return GROWTH_LEVELS.filter((item) => Number(points || 0) >= item.threshold).pop() || GROWTH_LEVELS[0]; }

async function ensureGrowth(executor, openid) { await executor.query('INSERT IGNORE INTO user_growth (openid, growth_points) VALUES (?, 0)', [openid]); const [[row]] = await executor.query('SELECT * FROM user_growth WHERE openid = ?', [openid]); return row; }

async function queueGrowth(executor, openid, points, type, title, orderId, delayHours = 24) {
  const value = Math.max(0, Math.floor(Number(points || 0))); if (!value) return;
  await ensureGrowth(executor, openid);
  await executor.query("INSERT INTO growth_transactions (openid, growth_delta, transaction_type, title, order_id, available_at, status) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), 'pending')", [openid, value, type, title, orderId || null, delayHours]);
}

async function settleGrowth(executor, openid) {
  const growth = await ensureGrowth(executor, openid);
  const [pending] = await executor.query("SELECT * FROM growth_transactions WHERE openid = ? AND status = 'pending' AND available_at <= NOW() FOR UPDATE", [openid]);
  const delta = pending.reduce((sum, item) => sum + Number(item.growth_delta || 0), 0);
  if (pending.length) await executor.query("UPDATE growth_transactions SET status = 'credited', credited_at = NOW() WHERE openid = ? AND status = 'pending' AND available_at <= NOW()", [openid]);
  const points = Number(growth.growth_points || 0) + delta;
  if (delta) await executor.query('UPDATE user_growth SET growth_points = ? WHERE openid = ?', [points, openid]);
  const rewards = [];
  for (const level of GROWTH_LEVELS.filter((item) => item.reward && points >= item.threshold)) {
    const [insert] = await executor.query('INSERT IGNORE INTO growth_level_rewards (openid, level_key) VALUES (?, ?)', [openid, level.key]);
    if (insert.affectedRows) { await ensureWallet(executor, openid); await executor.query('UPDATE user_wallets SET cat_food_balance = cat_food_balance + ? WHERE openid = ?', [level.reward, openid]); await addWalletRecord(executor, openid, { catFoodDelta: level.reward, type: 'growth_level_reward', title: `${level.name}升级奖励`, amount: 0 }); rewards.push(level); }
  }
  return { points, pendingPoints: pending.length ? 0 : 0, rewards };
}

function growthView(points, pendingPoints) { const level = growthLevel(points); const next = GROWTH_LEVELS.find((item) => item.threshold > points); return { points, pendingPoints, level: level.name, levelKey: level.key, badge: level.name, nextLevel: next ? next.name : '已达最高等级', nextThreshold: next ? next.threshold : points, toNext: next ? Math.max(0, next.threshold - points) : 0, progress: next ? Math.max(0, points - level.threshold) : 0, progressTotal: next ? next.threshold - level.threshold : 1, freeLucky: level.freeLucky, benefits: { iron: ['基础点单、礼物赠送与活动参与', '可参与猫爪好运转盘'], bronze: ['升级奖励 50 猫粮', '每月 1 次等级专属小活动'], silver: ['升级奖励 100 猫粮', '活动提前 12 小时报名、每月 1 次偏好推荐'], gold: ['升级奖励 200 猫粮', '每月 1 次转盘免费机会与优先匹配'], platinum: ['升级奖励 300 猫粮', '专属头像框、每年 1 次 3 天个冠体验'], diamond: ['升级奖励 500 猫粮', '每月 2 次免费转盘、专属客服对接'], mythic: ['升级奖励 1000 猫粮', '每月 3 次免费转盘、群内展示位与专属活动'] }[level.key] || [] }; }

function pickLuckyPrize(guaranteed) {
  const pool = guaranteed ? LUCKY_PRIZES.filter((item) => item.special) : LUCKY_PRIZES;
  const total = pool.reduce((sum, item) => sum + item.probability, 0);
  let needle = Math.random() * total;
  for (const prize of pool) { needle -= prize.probability; if (needle <= 0) return prize; }
  return pool[pool.length - 1];
}

function luckyDayKey(value) { const now = value ? new Date(value) : new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }

function luckyDrawRow(row) {
  return { id: Number(row.id), prizeKey: row.prize_key, prizeName: row.prize_name, prizeType: row.prize_type, description: row.prize_description, drawSource: row.draw_source, createdAt: formatDate(row.created_at), expiresAt: row.expires_at ? formatDate(row.expires_at) : '' };
}

function cycleKeys() {
  const now = new Date();
  const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  return { month, quarter: `${now.getFullYear()}Q${Math.floor(now.getMonth() / 3) + 1}`, year: now.getFullYear() };
}

function couponRow(row) {
  const rate = Number(row.discount_rate || 0);
  const cap = money(row.max_discount);
  const isDiscount = row.coupon_type === 'discount' && rate > 0 && rate < 1;
  const couponName = isDiscount ? String(row.coupon_name || '').replace(/(98|95|90|88)折/g, (_match, percent) => `${discountLabel(Number(percent) / 100)}折`) : row.coupon_name;
  return {
    id: Number(row.id), amount: money(row.amount), catFoodCost: Number(row.cat_food_cost || 0), couponType: isDiscount ? 'discount' : 'fixed', discountRate: rate, maxDiscount: cap,
    name: couponName || (isDiscount ? `${discountLabel(rate)}折券` : `${money(row.amount)} 金币猫粮兑换券`), displayValue: isDiscount ? `${discountLabel(rate)}折` : `${money(row.amount)} 金币`,
    description: isDiscount ? `${discountLabel(rate)}折 · 单笔最高优惠 ${cap} 金币` : (Number(row.min_order_amount || 0) ? `满 ${money(row.min_order_amount)} 金币可用` : `面额 ${money(row.amount)} 金币`), minOrderAmount: money(row.min_order_amount),
    status: row.status || 'unused', usedOrderId: row.used_order_id || '', createdAt: formatDate(row.created_at), usedAt: formatDate(row.used_at), expiresAt: formatDate(row.expires_at)
  };
}

async function issueMembershipCoupon(executor, openid, rate, maxDiscount, name, source) {
    await executor.query("INSERT INTO user_coupons (openid, amount, cat_food_cost, coupon_type, discount_rate, max_discount, coupon_name, source, status, expires_at) VALUES (?, 0, 0, 'discount', ?, ?, ?, ?, 'unused', NULL)", [openid, rate, maxDiscount, name, source]);
}

async function issueRecurringMembershipCoupons(executor, membership) {
  const plan = MEMBERSHIP_PLANS[membership.tier];
  if (!plan) return 0;
  const cycles = cycleKeys();
  let granted = 0;
  if (membership.monthly_coupon_cycle !== cycles.month) {
    for (let index = 0; index < plan.monthlyCoupons; index += 1) await issueMembershipCoupon(executor, membership.openid, plan.monthlyRate, plan.monthlyCap, `${plan.name}${discountLabel(plan.monthlyRate)}折月券`, 'membership_monthly');
    membership.monthly_coupon_cycle = cycles.month;
    granted += plan.monthlyCoupons;
  }
  if (membership.quarterly_coupon_cycle !== cycles.quarter) {
    await issueMembershipCoupon(executor, membership.openid, plan.quarterlyRate, plan.quarterlyCap, `${plan.name}${discountLabel(plan.quarterlyRate)}折季度券`, 'membership_quarterly');
    membership.quarterly_coupon_cycle = cycles.quarter;
    granted += 1;
  }
  await executor.query('UPDATE user_memberships SET monthly_coupon_cycle = ?, quarterly_coupon_cycle = ? WHERE openid = ?', [membership.monthly_coupon_cycle, membership.quarterly_coupon_cycle, membership.openid]);
  return granted;
}

async function upgradeMembershipCoupons(executor, openid) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const svip = MEMBERSHIP_PLANS.svip;
  const [monthly] = await executor.query("SELECT id, status FROM user_coupons WHERE openid = ? AND source = 'membership_monthly' AND created_at >= ? FOR UPDATE", [openid, monthStart]);
  const [quarterly] = await executor.query("SELECT id, status FROM user_coupons WHERE openid = ? AND source = 'membership_quarterly' AND created_at >= ? FOR UPDATE", [openid, quarterStart]);
  await executor.query("UPDATE user_coupons SET discount_rate = ?, max_discount = ?, coupon_name = ? WHERE openid = ? AND source = 'membership_monthly' AND status = 'unused' AND created_at >= ?", [svip.monthlyRate, svip.monthlyCap, `${svip.name}${discountLabel(svip.monthlyRate)}折月券`, openid, monthStart]);
  await executor.query("UPDATE user_coupons SET discount_rate = ?, max_discount = ?, coupon_name = ? WHERE openid = ? AND source = 'membership_quarterly' AND status = 'unused' AND created_at >= ?", [svip.quarterlyRate, svip.quarterlyCap, `${svip.name}${discountLabel(svip.quarterlyRate)}折季度券`, openid, quarterStart]);
  let granted = 0;
  for (let index = monthly.length; index < svip.monthlyCoupons; index += 1) {
    await issueMembershipCoupon(executor, openid, svip.monthlyRate, svip.monthlyCap, `${svip.name}${discountLabel(svip.monthlyRate)}折月券`, 'membership_monthly');
    granted += 1;
  }
  if (!quarterly.length) {
    await issueMembershipCoupon(executor, openid, svip.quarterlyRate, svip.quarterlyCap, `${svip.name}${discountLabel(svip.quarterlyRate)}折季度券`, 'membership_quarterly');
    granted += 1;
  }
  return granted;
}

function membershipView(row) {
  if (!row || !MEMBERSHIP_PLANS[row.tier]) return { active: false };
  const plan = MEMBERSHIP_PLANS[row.tier];
  const expires = new Date(row.expires_at);
  const active = expires.getTime() > Date.now();
  const daysLeft = active ? Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86400000)) : 0;
  const cycles = cycleKeys();
  return {
    active, tier: plan.tier, name: plan.name, badge: plan.badge, expiresAt: active ? expires.toLocaleDateString('zh-CN') : '', daysLeft, birthdayGift: plan.birthdayGift,
    birthdayEligible: false, birthdayMessage: active ? '生日月可领取专属猫粮福利' : '',
    benefits: active ? [
      { icon: '粮', title: `入会赠 ${plan.catFood} 猫粮`, desc: '升级时仅补发两档差额' },
      { icon: '券', title: `每月 ${plan.monthlyCoupons} 张 ${discountLabel(plan.monthlyRate)}折券`, desc: `单笔最高优惠 ${plan.monthlyCap} 金币` },
      { icon: '季', title: `每季度 1 张 ${discountLabel(plan.quarterlyRate)}折券`, desc: `单笔最高优惠 ${plan.quarterlyCap} 金币` },
      { icon: '优', title: '点单优先匹配', desc: plan.tier === 'svip' ? '优先匹配并优先安排' : '优先匹配服务陪玩' },
      { icon: '窝', title: plan.tier === 'svip' ? '专属小窝、SVIP身份标识' : '专属小窝或会员身份标识', desc: `每年可申请 ${plan.rescheduleCount} 次改期或换陪` },
      { icon: '生', title: `生日月赠送 ${plan.birthdayGift} 猫粮`, desc: '生日当月可在此页面领取一次' },
      { icon: '冠', title: plan.crown, desc: plan.tier === 'svip' ? '累计完成指定消费次数后可额外领取 1 张9折券' : '会员专属冠名体验' }
    ] : [], cycles
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
    serviceItems: parsePartnerServiceItems(row.service_items),
    status: row.status || 'pending',
    createdAt: formatDate(row.created_at),
    updatedAt: formatDate(row.updated_at)
  };
  result.tag = `${result.game} · ${result.level}陪陪`;
  result.service = `${result.game}${result.level}陪玩`;
  result.serviceItemNames = result.serviceItems.map((id) => PARTNER_SERVICE_NAMES[id]);
  if (includeOpenid) result.openid = row.openid;
  return result;
}

const PARTNER_SERVICE_IDS = new Set(['val-fun-silent', 'val-fun-dialect', 'val-fun-ace', 'val-fun-duo', 'val-fun-lines', 'val-fun-contract', 'fun-steam', 'lei-watch', 'lei-live', 'teaching-basic', 'teaching-custom', 'lei-voice', 'lei-sleep', 'lei-text']);
const PARTNER_SERVICE_NAMES = { 'val-fun-silent': '静音雷达局', 'val-fun-dialect': '方言捕捉局', 'val-fun-ace': '王牌加时局', 'val-fun-duo': '特工搭档局', 'val-fun-lines': '特工台词局', 'val-fun-contract': '猫猫平行宇宙局', 'fun-steam': 'Steam 联机', 'lei-watch': '一起看影视', 'lei-live': '直播陪看', 'teaching-basic': '基础教学', 'teaching-custom': '自定义教学与复盘', 'lei-voice': '语音聊天', 'lei-sleep': '哄睡陪伴', 'lei-text': '文字陪聊' };
function parsePartnerServiceItems(value) {
  try {
    const items = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(items) ? items.filter((id) => PARTNER_SERVICE_IDS.has(id)) : [];
  } catch (_) { return []; }
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
    const paidWithCoins = await hasCoinOrderPayment(connection, current.openid, current.id);
    const refundCoins = paidWithCoins ? money(Math.max(0, originalPrice - settledPrice)) : 0;
    // 演示订单未实扣金币，不应产生消费猫粮或成长值。
    const catFood = paidWithCoins ? Math.max(0, Math.floor(settledPrice * 0.3)) : 0;
    await connection.query("UPDATE orders SET status = 'completed', service_completed_at = NOW(), total_price = ?, points_earned = ? WHERE id = ?", [settledPrice, catFood, current.id]);
    await ensureWallet(connection, current.openid);
    await connection.query('UPDATE user_wallets SET coin_balance = coin_balance + ?, cat_food_balance = cat_food_balance + ? WHERE openid = ?', [refundCoins, catFood, current.openid]);
    if (refundCoins > 0) {
      await addWalletRecord(connection, current.openid, { coinDelta: refundCoins, type: 'early_settlement_refund', title: '提前结单返还金币', amount: refundCoins, orderId: current.id });
    }
    if (catFood > 0) await addWalletRecord(connection, current.openid, { catFoodDelta: catFood, type: 'order_cat_food', title: '订单消费赠送猫粮', amount: settledPrice, orderId: current.id });
    if (paidWithCoins) await queueGrowth(connection, current.openid, settledPrice, 'order_consumption', '有效订单消费成长值', current.id, 24);
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
  const serviceItems = body.serviceItems === undefined ? [] : body.serviceItems;
  if (!Array.isArray(serviceItems) || serviceItems.length > PARTNER_SERVICE_IDS.size || new Set(serviceItems).size !== serviceItems.length || serviceItems.some((id) => !PARTNER_SERVICE_IDS.has(id))) return send(res, 4002, null, '可接项目选择无效');
  if (!displayName || !gameName || !gender || !level || !rankText || !description || !availableTime || !Number.isFinite(hourPrice) || hourPrice <= 0 || !Number.isFinite(gamePrice) || gamePrice <= 0) {
    return send(res, 4002, null, '请完整填写陪陪资料和价格');
  }
  if (!audioUrl || audioDuration < 1 || audioDuration > 12) return send(res, 4002, null, '请上传 1 至 12 秒介绍语音');
  try {
    await ensureUser(userOpenid);
    const partnerNo = await ensurePartnerNo(userOpenid);
    await pool.query(
      `INSERT INTO partner_profiles (openid, partner_no, display_name, avatar_url, game_name, game, gender, service_level, rank_text, description, audio_url, audio_duration, hour_price, game_price, available_time, service_items, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), avatar_url = VALUES(avatar_url), game_name = VALUES(game_name),
       game = VALUES(game), gender = VALUES(gender), service_level = VALUES(service_level), rank_text = VALUES(rank_text), description = VALUES(description),
       audio_url = VALUES(audio_url), audio_duration = VALUES(audio_duration), hour_price = VALUES(hour_price), game_price = VALUES(game_price), available_time = VALUES(available_time), service_items = VALUES(service_items), status = 'pending'`,
      [userOpenid, partnerNo, displayName, avatarUrl, gameName, game, gender, level, rankText, description, audioUrl, audioDuration, hourPrice, gamePrice, availableTime, JSON.stringify(serviceItems)]
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
  const serviceItem = String(req.query.serviceItem || '').trim();
  if (serviceItem && !PARTNER_SERVICE_IDS.has(serviceItem)) return send(res, 4002, null, '服务项目无效');
  const params = [];
  let where = "WHERE status = 'approved'";
  if (category === 'valorant') {
    where += ' AND game = ?';
    params.push('无畏契约');
  }
  if (serviceItem) { where += ' AND JSON_CONTAINS(service_items, JSON_QUOTE(?))'; params.push(serviceItem); }
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

app.get('/api/follows', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const [rows] = await pool.query('SELECT p.* FROM partner_follows f JOIN partner_profiles p ON p.id = f.partner_profile_id WHERE f.openid = ? ORDER BY f.created_at DESC LIMIT 100', [userOpenid]);
    send(res, 0, { partners: rows.map((row) => partnerRow(row, false)) });
  } catch (error) { console.error(error); send(res, 5001, null, '我的关注读取失败'); }
});

app.get('/api/partners/:id/follow', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return send(res, 4002, null, '陪陪信息无效');
  try {
    const [[row]] = await pool.query('SELECT 1 AS followed FROM partner_follows WHERE openid = ? AND partner_profile_id = ?', [userOpenid, id]);
    send(res, 0, { followed: !!row });
  } catch (error) { console.error(error); send(res, 5001, null, '关注状态读取失败'); }
});

app.post('/api/partners/:id/follow', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const id = Number(req.params.id);
  const followed = (req.body || {}).followed;
  if (!Number.isInteger(id) || id <= 0 || typeof followed !== 'boolean') return send(res, 4002, null, '关注信息无效');
  try {
    if (followed) {
      const [[partner]] = await pool.query("SELECT id FROM partner_profiles WHERE id = ? AND status = 'approved'", [id]);
      if (!partner) return send(res, 4004, null, '该陪陪暂不可关注');
      await ensureUser(userOpenid);
      await pool.query('INSERT IGNORE INTO partner_follows (openid, partner_profile_id) VALUES (?, ?)', [userOpenid, id]);
    } else {
      await pool.query('DELETE FROM partner_follows WHERE openid = ? AND partner_profile_id = ?', [userOpenid, id]);
    }
    send(res, 0, { followed });
  } catch (error) { console.error(error); send(res, 5001, null, '关注操作失败'); }
});

app.get('/api/partners/:id/showcase', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return send(res, 4002, null, '陪玩信息无效');
  try {
    const [[partner]] = await pool.query("SELECT * FROM partner_profiles WHERE id = ? AND status = 'approved'", [id]);
    if (!partner) return send(res, 4004, null, '该陪玩暂不可展示');
    const [posts] = await pool.query('SELECT id, content, created_at FROM partner_posts WHERE partner_profile_id = ? ORDER BY created_at DESC LIMIT 20', [id]);
    const [comments] = await pool.query('SELECT id, nick_name, content, score, created_at FROM partner_comments WHERE partner_profile_id = ? ORDER BY created_at DESC LIMIT 30', [id]);
    const [[giftCount]] = await pool.query("SELECT COUNT(*) AS total FROM partner_gifts WHERE partner_profile_id = ? AND status = 'valid'", [id]);
    send(res, 0, { partner: partnerRow(partner, false), posts: posts.map((x) => ({ id: Number(x.id), content: x.content, createdAt: formatDate(x.created_at) })), comments: comments.map((x) => ({ id: Number(x.id), nickName: x.nick_name, content: x.content, score: Number(x.score), createdAt: formatDate(x.created_at) })), giftCount: Number(giftCount.total || 0) });
  } catch (error) { console.error(error); send(res, 5001, null, '陪玩展示资料读取失败'); }
});

app.post('/api/partners/:id/gifts', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const id = Number(req.params.id);
  const body = req.body || {};
  const gift = PARTNER_GIFTS.find((item) => item.key === String(body.giftKey || ''));
  if (!Number.isInteger(id) || id <= 0 || !gift) return send(res, 4002, null, '礼物信息无效');
  const blessing = gift.cost >= 500 ? String(body.blessing || '').trim() : '';
  if (blessing.length > 80 || /(?:https?:\/\/|www\.|\b1[3-9]\d{9}\b|微信号|加我微信|vx[:：]|辱骂)/i.test(blessing)) return send(res, 4002, null, '祝福语包含不合适内容，请修改后重试');
  const broadcastOptIn = gift.cost >= 1000 && body.broadcastOptIn === true ? 1 : 0;
  let connection;
  try {
    await ensureUser(userOpenid);
    connection = await pool.getConnection(); await connection.beginTransaction();
    const [[partner]] = await connection.query("SELECT id, display_name FROM partner_profiles WHERE id = ? AND status = 'approved' FOR UPDATE", [id]);
    if (!partner) { await connection.rollback(); return send(res, 4004, null, '该陪玩暂不可赠送礼物'); }
    const [[donor]] = await connection.query('SELECT nick_name FROM users WHERE openid = ?', [userOpenid]);
    await ensureWallet(connection, userOpenid);
    const [[wallet]] = await connection.query('SELECT * FROM user_wallets WHERE openid = ? FOR UPDATE', [userOpenid]);
    const [deduct] = await connection.query('UPDATE user_wallets SET coin_balance = coin_balance - ? WHERE openid = ? AND coin_balance >= ?', [gift.cost, userOpenid, gift.cost]);
    if (!deduct.affectedRows) { await connection.rollback(); return send(res, 4002, null, `金币不足，还需 ${Math.max(0, gift.cost - Number(wallet.coin_balance || 0))} 金币`); }
    const [giftResult] = await connection.query('INSERT INTO partner_gifts (partner_profile_id, openid, gift_key, gift_name, cat_food_cost, coin_cost, donor_nick_name, recipient_name, blessing, broadcast_opt_in) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)', [id, userOpenid, gift.key, gift.name, gift.cost, (donor && donor.nick_name) || '喵伴用户', partner.display_name || '陪陪', blessing, broadcastOptIn]);
    const giftNo = `MG${String(giftResult.insertId).padStart(8, '0')}`;
    await addWalletRecord(connection, userOpenid, { coinDelta: -gift.cost, type: 'partner_gift', title: `赠送陪玩礼物：${gift.name}`, amount: gift.cost, orderId: giftNo });
    await queueGrowth(connection, userOpenid, gift.cost, 'gift_consumption', `赠送礼物：${gift.name}`, giftNo, 24);
    await connection.commit(); send(res, 0, { giftName: gift.name, giftNo, coinBalance: money(Number(wallet.coin_balance || 0) - gift.cost) });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '赠送礼物失败'); }
  finally { if (connection) connection.release(); }
});

app.get('/api/gifts/mine', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const [rows] = await pool.query('SELECT g.*, r.status AS refund_status, r.review_note FROM partner_gifts g LEFT JOIN gift_refund_requests r ON r.gift_id = g.id WHERE g.openid = ? ORDER BY g.created_at DESC LIMIT 100', [userOpenid]);
    send(res, 0, { gifts: rows.map((row) => ({ id: Number(row.id), giftNo: `MG${String(row.id).padStart(8, '0')}`, donorName: row.donor_nick_name || '喵伴用户', recipientName: row.recipient_name || '陪陪', giftName: row.gift_name, amount: Number(row.coin_cost || 0), createdAt: formatDate(row.created_at), blessing: row.blessing || '', broadcastOptIn: !!row.broadcast_opt_in, status: row.status, refundStatus: row.refund_status || '', reviewNote: row.review_note || '', canRequestRefund: row.status === 'valid' && !row.refund_status && Date.now() - new Date(row.created_at).getTime() <= 24 * 3600000 })) });
  } catch (error) { console.error(error); send(res, 5001, null, '礼物订单读取失败'); }
});

app.get('/api/gifts/progress', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  try {
    const [[totals]] = await pool.query("SELECT COALESCE(SUM(CASE WHEN created_at >= ? THEN coin_cost ELSE 0 END), 0) AS month_total, COALESCE(SUM(CASE WHEN created_at >= ? THEN coin_cost ELSE 0 END), 0) AS quarter_total FROM partner_gifts WHERE openid = ? AND status = 'valid'", [monthStart, quarterStart, userOpenid]);
    send(res, 0, { monthTotal: Number(totals.month_total || 0), quarterTotal: Number(totals.quarter_total || 0), monthLabel: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`, quarterLabel: `${now.getFullYear()} 年第 ${Math.floor(now.getMonth() / 3) + 1} 季度` });
  } catch (error) { console.error(error); send(res, 5001, null, '累计进度读取失败'); }
});

app.post('/api/gifts/:id/refund-request', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const id = Number(req.params.id);
  const reason = String((req.body || {}).reason || '').trim();
  if (!Number.isInteger(id) || id <= 0 || reason.length < 5 || reason.length > 300) return send(res, 4002, null, '请填写至少 5 个字的申请原因');
  try {
    const [[gift]] = await pool.query('SELECT id, created_at, status FROM partner_gifts WHERE id = ? AND openid = ?', [id, userOpenid]);
    if (!gift || gift.status !== 'valid') return send(res, 4004, null, '礼物订单不存在或已失效');
    if (Date.now() - new Date(gift.created_at).getTime() > 24 * 3600000) return send(res, 4002, null, '已超过 24 小时申请期限');
    await pool.query('INSERT INTO gift_refund_requests (gift_id, openid, reason) VALUES (?, ?, ?)', [id, userOpenid, reason]);
    send(res, 0, { status: 'pending' });
  } catch (error) { if (error.code === 'ER_DUP_ENTRY') return send(res, 4002, null, '该礼物已提交过售后申请'); console.error(error); send(res, 5001, null, '售后申请提交失败'); }
});

app.get('/api/admin/gift-refund-requests/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return send(res, 4002, null, '礼物售后编号无效');
  try {
    const [[row]] = await pool.query('SELECT r.*, g.gift_name, g.coin_cost, g.donor_nick_name, g.recipient_name, g.created_at AS gift_created_at, g.status AS gift_status FROM gift_refund_requests r JOIN partner_gifts g ON g.id = r.gift_id WHERE r.id = ?', [id]);
    if (!row) return send(res, 4004, null, '礼物售后申请不存在');
    send(res, 0, { request: { id: Number(row.id), giftId: Number(row.gift_id), giftNo: `MG${String(row.gift_id).padStart(8, '0')}`, giftName: row.gift_name, amount: Number(row.coin_cost), donorName: row.donor_nick_name, recipientName: row.recipient_name, reason: row.reason, status: row.status, giftStatus: row.gift_status, reviewNote: row.review_note || '', reviewerOpenid: row.reviewer_openid || '', giftCreatedAt: formatDate(row.gift_created_at), createdAt: formatDate(row.created_at), reviewedAt: formatDate(row.reviewed_at) } });
  } catch (error) { console.error(error); send(res, 5001, null, '礼物售后详情读取失败'); }
});

app.patch('/api/admin/gift-refund-requests/:id/status', async (req, res) => {
  const reviewerOpenid = requireAdmin(req, res);
  if (!reviewerOpenid) return;
  const id = Number(req.params.id);
  const status = String((req.body || {}).status || '');
  const note = String((req.body || {}).note || '').trim().slice(0, 300);
  if (!Number.isInteger(id) || id <= 0 || !['rejected', 'refunded'].includes(status) || note.length < 5) return send(res, 4002, null, '请选择结果并填写至少 5 个字的核实说明');
  let connection;
  try {
    connection = await pool.getConnection(); await connection.beginTransaction();
    const [[claim]] = await connection.query('SELECT * FROM gift_refund_requests WHERE id = ? FOR UPDATE', [id]);
    if (!claim || claim.status !== 'pending') { await connection.rollback(); return send(res, 4002, null, '礼物售后申请不存在或已处理'); }
    const [[gift]] = await connection.query('SELECT * FROM partner_gifts WHERE id = ? FOR UPDATE', [claim.gift_id]);
    if (!gift || gift.status !== 'valid') { await connection.rollback(); return send(res, 4002, null, '礼物订单已失效，不能重复处理'); }
    if (status === 'refunded') {
      const giftNo = `MG${String(gift.id).padStart(8, '0')}`;
      const [[debit]] = await connection.query("SELECT id FROM wallet_transactions WHERE openid = ? AND order_id = ? AND transaction_type = 'partner_gift' AND coin_delta < 0 LIMIT 1", [gift.openid, giftNo]);
      if (!debit) { await connection.rollback(); return send(res, 4002, null, '未找到礼物扣款流水，请人工核实，不能自动退金币'); }
      await ensureWallet(connection, gift.openid);
      await connection.query('UPDATE user_wallets SET coin_balance = coin_balance + ? WHERE openid = ?', [gift.coin_cost, gift.openid]);
      await addWalletRecord(connection, gift.openid, { coinDelta: Number(gift.coin_cost), type: 'partner_gift_refund', title: `礼物退款：${gift.gift_name}`, amount: Number(gift.coin_cost), orderId: giftNo });
      const [growthRows] = await connection.query("SELECT id, growth_delta, status FROM growth_transactions WHERE openid = ? AND order_id = ? AND transaction_type = 'gift_consumption' FOR UPDATE", [gift.openid, giftNo]);
      const credited = growthRows.filter((row) => row.status === 'credited').reduce((sum, row) => sum + Number(row.growth_delta || 0), 0);
      if (credited > 0) {
        await ensureGrowth(connection, gift.openid);
        await connection.query('UPDATE user_growth SET growth_points = GREATEST(0, growth_points - ?) WHERE openid = ?', [credited, gift.openid]);
      }
      await connection.query("UPDATE growth_transactions SET status = 'reversed' WHERE openid = ? AND order_id = ? AND transaction_type = 'gift_consumption' AND status IN ('pending', 'credited')", [gift.openid, giftNo]);
      await connection.query("UPDATE partner_gifts SET status = 'refunded', refunded_at = NOW() WHERE id = ?", [gift.id]);
    }
    await connection.query('UPDATE gift_refund_requests SET status = ?, review_note = ?, reviewer_openid = ?, reviewed_at = NOW() WHERE id = ?', [status, note, reviewerOpenid, id]);
    await connection.commit();
    send(res, 0, { id, status, amount: status === 'refunded' ? Number(gift.coin_cost) : 0 });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '礼物售后处理失败'); }
  finally { if (connection) connection.release(); }
});

app.post('/api/partners/:id/comments', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const id = Number(req.params.id); const content = String((req.body || {}).content || '').trim().slice(0, 240); const score = Math.max(1, Math.min(5, Number((req.body || {}).score) || 5));
  if (!Number.isInteger(id) || id <= 0 || content.length < 2) return send(res, 4002, null, '请填写至少 2 个字的评论');
  try {
    const [[partner]] = await pool.query("SELECT id FROM partner_profiles WHERE id = ? AND status = 'approved'", [id]);
    if (!partner) return send(res, 4004, null, '该陪玩暂不可评论');
    await ensureUser(userOpenid); const [[user]] = await pool.query('SELECT nick_name FROM users WHERE openid = ?', [userOpenid]);
    const [result] = await pool.query('INSERT INTO partner_comments (partner_profile_id, openid, nick_name, content, score) VALUES (?, ?, ?, ?, ?)', [id, userOpenid, (user && user.nick_name) || '喵伴用户', content, score]);
    send(res, 0, { comment: { id: Number(result.insertId), nickName: (user && user.nick_name) || '喵伴用户', content, score, createdAt: formatDate(new Date()) } });
  } catch (error) { console.error(error); send(res, 5001, null, '提交评论失败'); }
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

app.post('/api/admin/lucky-wheel/task-reward', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const openid = String((req.body || {}).openid || '').trim();
  if (!openid) return send(res, 4002, null, '缺少用户标识');
  try {
    await pool.query("INSERT INTO lucky_draw_states (openid, draw_date, task_free_draws) VALUES (?, NULL, 1) ON DUPLICATE KEY UPDATE task_free_draws = task_free_draws + 1", [openid]);
    send(res, 0, { openid, granted: 1 });
  } catch (error) { console.error(error); send(res, 5001, null, '趣味任务抽奖资格发放失败'); }
});

app.get('/api/lucky-wheel', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const wallet = await ensureWallet(pool, userOpenid);
    await pool.query('INSERT IGNORE INTO lucky_draw_states (openid, draw_date) VALUES (?, NULL)', [userOpenid]);
    const [[state]] = await pool.query('SELECT * FROM lucky_draw_states WHERE openid = ?', [userOpenid]);
    const [[membershipRow]] = await pool.query('SELECT * FROM user_memberships WHERE openid = ?', [userOpenid]);
    const membership = membershipView(membershipRow);
    const growthRow = await ensureGrowth(pool, userOpenid);
    const growthFree = growthLevel(growthRow.growth_points).freeLucky;
    const month = cycleKeys().month;
    const freeTotal = Math.max(membership.active ? (membership.tier === 'svip' ? 2 : 1) : 0, growthFree);
    const freeUsed = state.monthly_free_cycle === month ? Number(state.monthly_free_used || 0) : 0;
    const todayDraws = state.draw_date && luckyDayKey(state.draw_date) === luckyDayKey() ? Number(state.daily_draw_count || 0) : 0;
    const [history] = await pool.query('SELECT * FROM lucky_draws WHERE openid = ? ORDER BY created_at DESC LIMIT 20', [userOpenid]);
    send(res, 0, { catFoodBalance: Number(wallet.cat_food_balance || 0), todayDraws, remainingToday: Math.max(0, 3 - todayDraws), membershipFreeAvailable: Math.max(0, freeTotal - freeUsed), taskFreeAvailable: Number(state.task_free_draws || 0), guaranteeProgress: Math.min(10, Number(state.non_special_streak || 0)), membership: membership.active ? membership.name : '', prizes: LUCKY_PRIZES.map(({ key, name, probability, desc }) => ({ key, name, probability, desc })), history: history.map(luckyDrawRow) });
  } catch (error) { console.error(error); send(res, 5001, null, '转盘信息读取失败，请确认已执行会员与转盘数据库脚本'); }
});

app.post('/api/lucky-wheel/draw', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  let connection;
  try {
    connection = await pool.getConnection(); await connection.beginTransaction();
    await ensureWallet(connection, userOpenid);
    await connection.query('INSERT IGNORE INTO lucky_draw_states (openid, draw_date) VALUES (?, NULL)', [userOpenid]);
    const [[state]] = await connection.query('SELECT * FROM lucky_draw_states WHERE openid = ? FOR UPDATE', [userOpenid]);
    const [[membershipRow]] = await connection.query('SELECT * FROM user_memberships WHERE openid = ?', [userOpenid]);
    const membership = membershipView(membershipRow);
    const growthRow = await ensureGrowth(connection, userOpenid);
    const growthFree = growthLevel(growthRow.growth_points).freeLucky;
    const today = luckyDayKey();
    const usedToday = state.draw_date && luckyDayKey(state.draw_date) === today ? Number(state.daily_draw_count || 0) : 0;
    if (usedToday >= 3) { await connection.rollback(); return send(res, 4002, null, '今日抽奖次数已用完，每日最多 3 次'); }
    const month = cycleKeys().month;
    const freeTotal = Math.max(membership.active ? (membership.tier === 'svip' ? 2 : 1) : 0, growthFree);
    let monthlyFreeUsed = state.monthly_free_cycle === month ? Number(state.monthly_free_used || 0) : 0;
    let taskFreeDraws = Number(state.task_free_draws || 0);
    let drawSource = 'cat_food';
    if (monthlyFreeUsed < freeTotal) { drawSource = 'membership_free'; monthlyFreeUsed += 1; }
    else if (taskFreeDraws > 0) { drawSource = 'task_free'; taskFreeDraws -= 1; }
    else {
      const [deduct] = await connection.query('UPDATE user_wallets SET cat_food_balance = cat_food_balance - 100 WHERE openid = ? AND cat_food_balance >= 100', [userOpenid]);
      if (!deduct.affectedRows) { await connection.rollback(); return send(res, 4002, null, '猫粮不足，本次抽奖需要 100 猫粮'); }
      await addWalletRecord(connection, userOpenid, { catFoodDelta: -100, type: 'lucky_draw_cost', title: '猫爪好运转盘抽奖', amount: 0 });
    }
    const prize = pickLuckyPrize(Number(state.non_special_streak || 0) >= 9);
    let expiresAt = null;
    if (prize.expiresDays) { const expires = new Date(Date.now() + prize.expiresDays * 86400000); expiresAt = expires; }
    if (prize.type === 'cat_food') {
      await connection.query('UPDATE user_wallets SET cat_food_balance = cat_food_balance + ? WHERE openid = ?', [prize.catFood, userOpenid]);
      await addWalletRecord(connection, userOpenid, { catFoodDelta: prize.catFood, type: 'lucky_draw_reward', title: `转盘奖励：${prize.name}`, amount: 0 });
    } else if (prize.type === 'coupon') {
      const couponName = prize.key === 'fun_coupon' ? prize.name : `${prize.name}（转盘奖励）`;
      if (prize.key === 'fun_coupon') await connection.query("INSERT INTO user_coupons (openid, amount, cat_food_cost, coupon_type, discount_rate, max_discount, coupon_name, source, status, expires_at) VALUES (?, 10, 0, 'fixed', NULL, 10, ?, 'lucky_wheel', 'unused', DATE_ADD(NOW(), INTERVAL 7 DAY))", [userOpenid, couponName]);
      else await connection.query("INSERT INTO user_coupons (openid, amount, cat_food_cost, coupon_type, discount_rate, max_discount, coupon_name, source, status, expires_at) VALUES (?, 0, 0, 'discount', ?, ?, ?, 'lucky_wheel', 'unused', DATE_ADD(NOW(), INTERVAL 7 DAY))", [userOpenid, prize.rate, prize.maxDiscount, couponName]);
    }
    const nonSpecialStreak = prize.special ? 0 : Number(state.non_special_streak || 0) + 1;
    await connection.query(`UPDATE lucky_draw_states SET draw_date = ?, daily_draw_count = ?, monthly_free_cycle = ?, monthly_free_used = ?, task_free_draws = ?, non_special_streak = ? WHERE openid = ?`, [today, usedToday + 1, month, monthlyFreeUsed, taskFreeDraws, nonSpecialStreak, userOpenid]);
    await connection.query('INSERT INTO lucky_draws (openid, prize_key, prize_name, prize_type, prize_description, draw_source, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [userOpenid, prize.key, prize.name, prize.type, prize.desc, drawSource, expiresAt]);
    await connection.commit();
    const wallet = await ensureWallet(pool, userOpenid);
    send(res, 0, { prize: { ...prize, expiresAt: expiresAt ? formatDate(expiresAt) : '' }, drawSource, catFoodBalance: Number(wallet.cat_food_balance || 0), remainingToday: Math.max(0, 2 - usedToday), guaranteeProgress: Math.min(10, nonSpecialStreak) });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '抽奖失败，请稍后重试'); }
  finally { if (connection) connection.release(); }
});

app.get('/api/growth', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  let connection;
  try {
    connection = await pool.getConnection(); await connection.beginTransaction();
    const settled = await settleGrowth(connection, userOpenid);
    const [[pending]] = await connection.query("SELECT COALESCE(SUM(growth_delta), 0) AS total FROM growth_transactions WHERE openid = ? AND status = 'pending'", [userOpenid]);
    await connection.commit();
    send(res, 0, { growth: growthView(settled.points, Number(pending.total || 0)), rewards: settled.rewards.map((item) => ({ name: item.name, catFood: item.reward })) });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '成长等级读取失败，请确认已执行成长系统数据库脚本'); }
  finally { if (connection) connection.release(); }
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
    await pool.query("UPDATE user_coupons SET status = 'expired' WHERE openid = ? AND status = 'unused' AND expires_at IS NOT NULL AND expires_at <= NOW()", [userOpenid]);
    const [coupons] = await pool.query("SELECT * FROM user_coupons WHERE openid = ? ORDER BY FIELD(status, 'unused', 'used', 'expired'), created_at DESC", [userOpenid]);
    const funWeeklyUsed = await weeklyFunCouponUsage(pool, userOpenid);
    send(res, 0, { catFoodBalance: Number(wallet.cat_food_balance || 0), coupons: coupons.map(couponRow), exchangeOptions: CAT_FOOD_COUPON_OPTIONS, funWeeklyUsed, funWeeklyLimit: FUN_COUPON_WEEKLY_LIMIT });
  } catch (error) { console.error(error); send(res, 5001, null, '优惠券读取失败'); }
});

app.get('/api/membership', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const [[row]] = await pool.query('SELECT * FROM user_memberships WHERE openid = ?', [userOpenid]);
    const membership = membershipView(row);
    if (membership.active) {
      await issueRecurringMembershipCoupons(pool, row);
      const [[user]] = await pool.query('SELECT birth_date FROM users WHERE openid = ?', [userOpenid]);
      const birthDate = user && user.birth_date ? new Date(user.birth_date) : null;
      const cycles = cycleKeys();
      if (birthDate && birthDate.getMonth() === new Date().getMonth()) {
        membership.birthdayEligible = Number(row.birthday_gift_year || 0) !== cycles.year;
        membership.birthdayMessage = membership.birthdayEligible ? `生日月可领取 ${membership.birthdayGift} 猫粮` : '本年度生日月福利已领取';
      } else membership.birthdayMessage = '生日月可领取专属猫粮福利';
    }
    send(res, 0, { membership, purchaseEnabled: MEMBERSHIP_DEMO_ENABLED, plans: Object.values(MEMBERSHIP_PLANS).map((plan) => ({ tier: plan.tier, name: plan.name, badge: plan.badge, price: plan.price, highlights: [`赠 ${plan.catFood} 猫粮`, `每月 ${plan.monthlyCoupons} 张${discountLabel(plan.monthlyRate)}折券`, `季度 ${discountLabel(plan.quarterlyRate)}折券`, plan.tier === 'svip' ? '优先安排服务' : '优先匹配服务', `生日月赠 ${plan.birthdayGift} 猫粮`, `可申请 ${plan.rescheduleCount} 次改期或换陪`, plan.crown, ...(plan.tier === 'svip' ? ['完成指定消费次数额外领9折券'] : [])] })) });
  } catch (error) { console.error(error); send(res, 5001, null, '会员信息读取失败，请确认已执行会员数据库脚本'); }
});

app.post('/api/membership/subscribe', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  if (!MEMBERSHIP_DEMO_ENABLED) return send(res, 4003, null, '会员开通暂未接入支付，请联系客服');
  const tier = String((req.body || {}).tier || '');
  const plan = MEMBERSHIP_PLANS[tier];
  if (!plan) return send(res, 4002, null, '请选择有效会员套餐');
  let connection;
  try {
    await ensureUser(userOpenid);
    connection = await pool.getConnection(); await connection.beginTransaction();
    await ensureWallet(connection, userOpenid);
    const [[currentMembership]] = await connection.query('SELECT * FROM user_memberships WHERE openid = ? FOR UPDATE', [userOpenid]);
    const currentActive = membershipView(currentMembership).active;
    if (currentActive && currentMembership.tier === 'svip' && tier === 'vip') {
      await connection.rollback();
      return send(res, 4002, null, 'SVIP有效期内不能开通VIP，请选择续费SVIP');
    }
    const upgrading = currentActive && currentMembership.tier === 'vip' && tier === 'svip';
    const chargedAmount = upgrading ? MEMBERSHIP_PLANS.svip.price - MEMBERSHIP_PLANS.vip.price : plan.price;
    const grantedCatFood = upgrading ? MEMBERSHIP_PLANS.svip.catFood - MEMBERSHIP_PLANS.vip.catFood : plan.catFood;
    let membership;
    let grantedCoupons;
    if (upgrading) {
      await connection.query('UPDATE user_memberships SET tier = ? WHERE openid = ?', [tier, userOpenid]);
      grantedCoupons = await upgradeMembershipCoupons(connection, userOpenid);
      const cycles = cycleKeys();
      await connection.query('UPDATE user_memberships SET monthly_coupon_cycle = ?, quarterly_coupon_cycle = ? WHERE openid = ?', [cycles.month, cycles.quarter, userOpenid]);
      membership = { ...currentMembership, tier, monthly_coupon_cycle: cycles.month, quarterly_coupon_cycle: cycles.quarter };
    } else {
      if (!currentMembership) {
        await connection.query("INSERT INTO user_memberships (openid, tier, started_at, expires_at, monthly_coupon_cycle, quarterly_coupon_cycle) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 YEAR), '', '')", [userOpenid, tier]);
      } else if (currentActive && currentMembership.tier === tier) {
        await connection.query('UPDATE user_memberships SET expires_at = DATE_ADD(expires_at, INTERVAL 1 YEAR) WHERE openid = ?', [userOpenid]);
      } else {
        await connection.query("UPDATE user_memberships SET tier = ?, started_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 1 YEAR), monthly_coupon_cycle = '', quarterly_coupon_cycle = '' WHERE openid = ?", [tier, userOpenid]);
      }
      const [[updatedMembership]] = await connection.query('SELECT * FROM user_memberships WHERE openid = ? FOR UPDATE', [userOpenid]);
      membership = updatedMembership;
      grantedCoupons = await issueRecurringMembershipCoupons(connection, membership);
    }
    await connection.query('UPDATE user_wallets SET cat_food_balance = cat_food_balance + ? WHERE openid = ?', [grantedCatFood, userOpenid]);
    await addWalletRecord(connection, userOpenid, { catFoodDelta: grantedCatFood, type: upgrading ? 'membership_upgrade' : 'membership_join', title: upgrading ? 'VIP补差价升级SVIP猫粮差额' : `${plan.name}入会赠送猫粮`, amount: chargedAmount });
    await queueGrowth(connection, userOpenid, chargedAmount, 'membership_purchase', upgrading ? 'VIP补差价升级SVIP成长值' : `${plan.name}会员购买成长值`, null, 0);
    await settleGrowth(connection, userOpenid);
    await connection.commit();
    send(res, 0, { membership: membershipView(membership), chargedAmount, upgraded: upgrading, grantedCatFood, grantedCoupons });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '会员开通失败，请确认已执行会员数据库脚本'); }
  finally { if (connection) connection.release(); }
});

app.post('/api/membership/birthday-gift', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  let connection;
  try {
    connection = await pool.getConnection(); await connection.beginTransaction();
    const [[membership]] = await connection.query('SELECT * FROM user_memberships WHERE openid = ? FOR UPDATE', [userOpenid]);
    const view = membershipView(membership);
    if (!view.active) { await connection.rollback(); return send(res, 4002, null, '请先开通有效会员'); }
    const [[user]] = await connection.query('SELECT birth_date FROM users WHERE openid = ?', [userOpenid]);
    if (!user || !user.birth_date || new Date(user.birth_date).getMonth() !== new Date().getMonth()) { await connection.rollback(); return send(res, 4002, null, '仅限已完善生日信息的生日月会员领取'); }
    const year = cycleKeys().year;
    if (Number(membership.birthday_gift_year || 0) === year) { await connection.rollback(); return send(res, 4002, null, '本年度生日月福利已领取'); }
    await ensureWallet(connection, userOpenid);
    await connection.query('UPDATE user_wallets SET cat_food_balance = cat_food_balance + ? WHERE openid = ?', [view.birthdayGift, userOpenid]);
    await connection.query('UPDATE user_memberships SET birthday_gift_year = ? WHERE openid = ?', [year, userOpenid]);
    await addWalletRecord(connection, userOpenid, { catFoodDelta: view.birthdayGift, type: 'membership_birthday', title: `${view.name}生日月福利`, amount: 0 });
    await connection.commit(); send(res, 0, { catFood: view.birthdayGift });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '生日月福利领取失败'); }
  finally { if (connection) connection.release(); }
});

app.post('/api/coupons/exchange', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const key = String((req.body || {}).key || '');
  const option = CAT_FOOD_COUPON_OPTIONS.find((item) => item.key === key);
  if (!option) return send(res, 4002, null, '请选择有效的猫粮优惠券');
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await ensureWallet(connection, userOpenid);
    const [result] = await connection.query('UPDATE user_wallets SET cat_food_balance = cat_food_balance - ? WHERE openid = ? AND cat_food_balance >= ?', [option.cost, userOpenid, option.cost]);
    if (!result.affectedRows) { await connection.rollback(); return send(res, 4002, null, '猫粮余额不足'); }
    const [couponResult] = await connection.query("INSERT INTO user_coupons (openid, amount, min_order_amount, cat_food_cost, coupon_type, coupon_name, source, status, expires_at) VALUES (?, ?, ?, ?, 'fixed', ?, 'cat_food_exchange', 'unused', DATE_ADD(NOW(), INTERVAL 7 DAY))", [userOpenid, option.amount, option.threshold, option.cost, `满${option.threshold}减${option.amount}猫粮券`]);
    await addWalletRecord(connection, userOpenid, { catFoodDelta: -option.cost, type: 'coupon_exchange', title: `兑换满${option.threshold}减${option.amount}优惠券`, amount: option.amount });
    await connection.commit();
    send(res, 0, { coupon: { id: Number(couponResult.insertId), amount: option.amount, minOrderAmount: option.threshold, catFoodCost: option.cost } });
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
    const [walletRows] = await pool.query("SELECT id, title, transaction_type, cat_food_delta, amount, order_id, created_at FROM wallet_transactions WHERE openid = ? AND cat_food_delta <> 0 ORDER BY created_at DESC LIMIT 100", [userOpenid]);
    const [rows] = walletRows.length ? [walletRows] : await pool.query("SELECT id, partner_name, service, total_price, points_earned, status, created_at FROM orders WHERE openid = ? AND status <> 'cancelled' AND points_earned > 0 ORDER BY created_at DESC LIMIT 100", [userOpenid]);
    const wallet = await ensureWallet(pool, userOpenid);
    const balance = Number(wallet.cat_food_balance || 0);
    send(res, 0, { balance, records: rows.map((item) => ({ id: item.id, recordNo: item.cat_food_delta === undefined ? String(item.id) : `ML${String(item.id).padStart(8, '0')}`, orderId: item.order_id || '', partnerName: item.title || item.partner_name || '陪陪订单', service: item.transaction_type || item.service || '订单消费', amount: Number(item.amount || item.total_price || 0), points: Number(item.cat_food_delta === undefined ? item.points_earned : item.cat_food_delta || 0), createdAt: formatDate(item.created_at) })) });
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
  const orderQuantity = Number(body.quantity);
  const valorantFunModes = { 'val-fun-silent': ['静音雷达局', 65], 'val-fun-dialect': ['方言捕捉局', 65], 'val-fun-ace': ['王牌加时局', 65], 'val-fun-duo': ['特工搭档局', 60], 'val-fun-lines': ['特工台词局', 60], 'val-fun-contract': ['猫猫平行宇宙局', 65] };
  const funMode = valorantFunModes[body.funId];
  const serviceItem = String(body.serviceItem || '');
  if (serviceItem && !PARTNER_SERVICE_IDS.has(serviceItem)) return send(res, 4002, null, '服务项目无效');
  if (serviceItem && (!!valorantFunModes[serviceItem] !== !!funMode || (funMode && body.funId !== serviceItem))) return send(res, 4002, null, '趣味单项目不一致');
  if (!Number.isInteger(orderQuantity) || orderQuantity < 1 || !['小时', '局'].includes(body.unit) ||
      (body.unit === '小时' ? body.priceMode !== 'hour' : body.priceMode !== 'game') || originalTotalPrice <= 0) {
    return send(res, 4002, null, '下单数量或服务原价无效');
  }
  if (body.funId && (!funMode || body.service !== `无畏契约趣味单·${funMode[0]}` || body.unit !== '小时' || body.priceMode !== 'hour' || originalTotalPrice !== money(funMode[1] * orderQuantity))) {
    return send(res, 4002, null, '趣味单玩法或金额无效，请重新选择');
  }
  const pointsEarned = 0;
  let connection;
  try {
    await ensureUser(userOpenid);
    const requestedPartnerId = Number(body.partnerId);
    let partnerProfileId = null;
    let partnerPrice = null;
    if (Number.isInteger(requestedPartnerId) && requestedPartnerId > 0) {
      const [[partner]] = await pool.query("SELECT id, game, service_level, service_items, hour_price, game_price FROM partner_profiles WHERE id = ? AND status = 'approved'", [requestedPartnerId]);
      if (partner) {
        const approvedItems = parsePartnerServiceItems(partner.service_items);
        if ((serviceItem && !approvedItems.includes(serviceItem)) || (funMode && !approvedItems.includes(body.funId))) return send(res, 4002, null, '该陪陪暂未提供此项目');
        if (serviceItem && !funMode && (body.service !== PARTNER_SERVICE_NAMES[serviceItem] || body.unit !== '小时')) return send(res, 4002, null, '服务项目或计费方式不一致');
        if (!serviceItem && !funMode && body.service !== `${partner.game}${partner.service_level}陪玩`) return send(res, 4002, null, '陪陪服务类型不一致');
        partnerProfileId = partner.id;
        partnerPrice = money((funMode ? funMode[1] : (body.unit === '小时' ? partner.hour_price : partner.game_price)) * orderQuantity);
      }
      else return send(res, 4002, null, '陪陪已下架，请返回重新选择');
    }
    if (partnerPrice !== null && originalTotalPrice !== partnerPrice) {
      return send(res, 4002, null, '服务原价已变化，请返回重新选择');
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    if (couponId > 0) await connection.query('SELECT openid FROM users WHERE openid = ? FOR UPDATE', [userOpenid]);
    let coupon = null;
    if (Number.isInteger(couponId) && couponId > 0) {
      const [[row]] = await connection.query("SELECT * FROM user_coupons WHERE id = ? AND openid = ? AND status = 'unused' AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE", [couponId, userOpenid]);
      if (!row) { await connection.rollback(); return send(res, 4002, null, '优惠券不可用或已使用'); }
      const couponError = couponOrderError(row, body.orderScene, String(body.service || ''), String(body.paymentMethod || ''), body.unit, body.quantity);
      if (couponError) { await connection.rollback(); return send(res, 4002, null, couponError); }
      if (/趣味/.test(String(body.service || '')) && await weeklyFunCouponUsage(connection, userOpenid) >= FUN_COUPON_WEEKLY_LIMIT) {
        await connection.rollback(); return send(res, 4002, null, '本周趣味单已使用 2 张优惠券，下周可继续使用');
      }
      if (Number(row.min_order_amount || 0) > originalTotalPrice) { await connection.rollback(); return send(res, 4002, null, `该优惠券需订单原价满 ${money(row.min_order_amount)} 金币才可使用`); }
      coupon = row;
    }
    const couponDiscount = money(!coupon ? 0 : (coupon.coupon_type === 'discount' && Number(coupon.discount_rate || 0) > 0 && Number(coupon.discount_rate || 0) < 1
      ? Math.min(originalTotalPrice * (1 - Number(coupon.discount_rate)), Number(coupon.max_discount || 0))
      : Math.min(originalTotalPrice, coupon.amount)));
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
  const couponId = Number((req.body || {}).couponId);
  if (!Number.isFinite(requestedQuantity) || requestedQuantity < 1) return send(res, 4002, null, '请输入有效的续单数量');
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    if (couponId > 0) await connection.query('SELECT openid FROM users WHERE openid = ? FOR UPDATE', [userOpenid]);
    const [[source]] = await connection.query("SELECT * FROM orders WHERE id = ? AND openid = ? AND ((status = 'progress' AND service_completed_at IS NULL) OR (status = 'completed' AND service_completed_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR))) FOR UPDATE", [req.params.id, userOpenid]);
    if (!source) { await connection.rollback(); return send(res, 4004, null, '续单需在原订单结束后 24 小时内发起'); }
    const renewUnit = requestedUnit;
    const maxQuantity = renewUnit === '局' ? 99 : 24;
    const quantity = Math.min(requestedQuantity, maxQuantity);
    const sourceQuantity = Math.max(1, Number(source.quantity || 1));
    const baseAmount = Number(source.original_total_price === null || source.original_total_price === undefined ? source.total_price : source.original_total_price);
    const unitPrice = money(baseAmount / sourceQuantity);
    const totalPrice = money(unitPrice * quantity);
    const id = `MB${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    let coupon = null;
    let couponDiscount = 0;
    if (Number.isInteger(couponId) && couponId > 0) {
      if (source.status !== 'completed' || !source.service_completed_at) { await connection.rollback(); return send(res, 4002, null, '原订单正常结单后才可使用续单优惠券'); }
      const [[pendingRefund]] = await connection.query("SELECT id FROM refund_requests WHERE order_id = ? AND status = 'pending' LIMIT 1 FOR UPDATE", [source.id]);
      if (pendingRefund) { await connection.rollback(); return send(res, 4002, null, '原订单处于售后中，暂不可使用续单优惠券'); }
      const [[usedRenewCoupon]] = await connection.query("SELECT id FROM orders WHERE (renew_from_order_id = ? OR (renew_from_order_id IS NULL AND remark LIKE ?)) AND coupon_id IS NOT NULL LIMIT 1 FOR UPDATE", [source.id, '续自订单 ' + source.id + ' ·%']);
      if (usedRenewCoupon) { await connection.rollback(); return send(res, 4002, null, '每个原订单仅限使用 1 张续单优惠券'); }
      const [[row]] = await connection.query("SELECT * FROM user_coupons WHERE id = ? AND openid = ? AND status = 'unused' AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE", [couponId, userOpenid]);
      if (!row) { await connection.rollback(); return send(res, 4002, null, '优惠券不可用或已过期'); }
      const couponError = couponOrderError(row, /趣味/.test(source.service) ? 'fun' : 'regular', String(source.service || ''), String(source.payment_method || ''), renewUnit, quantity);
      if (couponError) { await connection.rollback(); return send(res, 4002, null, couponError); }
      if (/趣味/.test(String(source.service || '')) && await weeklyFunCouponUsage(connection, userOpenid) >= FUN_COUPON_WEEKLY_LIMIT) {
        await connection.rollback(); return send(res, 4002, null, '本周趣味单已使用 2 张优惠券，下周可继续使用');
      }
      if (Number(row.min_order_amount || 0) > totalPrice) { await connection.rollback(); return send(res, 4002, null, `该优惠券需续单原价满 ${money(row.min_order_amount)} 金币才可使用`); }
      if (renewUnit === '小时' && quantity < 1) { await connection.rollback(); return send(res, 4002, null, '按时长续单满 60 分钟才可使用优惠券'); }
      coupon = row;
      couponDiscount = money(row.coupon_type === 'discount' && Number(row.discount_rate || 0) > 0 && Number(row.discount_rate || 0) < 1 ? Math.min(totalPrice * (1 - Number(row.discount_rate)), Number(row.max_discount || 0)) : Math.min(totalPrice, Number(row.amount || 0)));
    }
    const payablePrice = money(totalPrice - couponDiscount);
    await connection.query(
      `INSERT INTO orders (id, openid, partner_profile_id, partner_name, partner_tag, partner_initial, partner_color, partner_avatar_url, partner_gender, partner_rank_text, service,
        start_time, quantity, unit, price_mode, total_price, original_total_price, cat_food_used, coupon_discount, coupon_id, renew_from_order_id, points_earned, payment_method, remark, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '立即开始', ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, 'pending')`,
      [id, userOpenid, source.partner_profile_id, source.partner_name, source.partner_tag, source.partner_initial, source.partner_color, source.partner_avatar_url, source.partner_gender, source.partner_rank_text, source.service,
         quantity, renewUnit, renewUnit === '局' ? 'game' : 'hour', payablePrice, totalPrice, couponDiscount, coupon ? coupon.id : null, source.id, source.payment_method, `续自订单 ${source.id} · 按${renewUnit}续单`]
    );
    if (coupon) await connection.query("UPDATE user_coupons SET status = 'used', used_order_id = ?, used_at = NOW() WHERE id = ?", [id, coupon.id]);
    await connection.commit();
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? AND openid = ?', [id, userOpenid]);
    send(res, 0, { order: orderRow(order) });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '续单创建失败'); }
  finally { if (connection) connection.release(); }
});

app.patch('/api/orders/:id/cancel', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[order]] = await connection.query(
      "SELECT * FROM orders WHERE id = ? AND openid = ? AND status IN ('pending', 'progress') FOR UPDATE",
      [req.params.id, userOpenid]
    );
    if (!order) { await connection.rollback(); return send(res, 4004, null, '订单不存在或当前不可取消'); }
    await connection.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [order.id]);
    let couponReturned = false;
    if (order.coupon_id && !order.service_started_at) {
      const [result] = await connection.query(
        "UPDATE user_coupons SET status = 'unused', used_order_id = NULL, used_at = NULL WHERE id = ? AND openid = ? AND status = 'used' AND used_order_id = ? AND (expires_at IS NULL OR expires_at > NOW())",
        [order.coupon_id, userOpenid, order.id]
      );
      couponReturned = result.affectedRows > 0;
    }
    await connection.commit();
    send(res, 0, { id: order.id, status: 'cancelled', couponReturned });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(error);
    send(res, 5001, null, '订单取消失败');
  } finally { if (connection) connection.release(); }
});

app.post('/api/orders/:id/refund-direct-disabled', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  return send(res, 4003, null, '直接退款暂未开放，请提交售后申请并由店铺核实付款记录');
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
  return { ...orderRow(row), refund: { id: Number(row.refund_id), status: row.refund_status, amount: money(row.refund_amount), reason: row.reason || '', rejectReason: row.reject_reason || '', resolutionNote: row.resolution_note || '', externalReference: row.external_reference || '', evidence: Array.isArray(evidence) ? evidence : [], rejectEvidence: Array.isArray(rejectEvidence) ? rejectEvidence : [], createdAt: formatDate(row.refund_created_at), reviewedAt: formatDate(row.reviewed_at), catFoodToDeduct: Number(row.cat_food_to_deduct || 0) } };
}

app.get('/api/refund-requests', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  try {
    const [rows] = await pool.query(`SELECT o.*, r.id AS refund_id, r.status AS refund_status, r.refund_amount, r.cat_food_to_deduct, r.reason, r.reject_reason, r.reject_evidence_json, r.evidence_json, r.resolution_note, r.external_reference, r.created_at AS refund_created_at, r.reviewed_at FROM refund_requests r JOIN orders o ON o.id = r.order_id WHERE r.openid = ? AND r.status IN ('pending', 'rejected', 'refunded', 'unpaid_closed', 'external_refunded') ORDER BY r.created_at DESC`, [userOpenid]);
    send(res, 0, { refunds: rows.map(refundRequestRow) });
  } catch (error) { console.error(error); send(res, 5001, null, '退款订单读取失败'); }
});

app.get('/api/refund-requests/:id', async (req, res) => {
  const userOpenid = requireOpenid(req, res);
  if (!userOpenid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return send(res, 4002, null, '退款申请无效');
  try {
    const [[row]] = await pool.query(`SELECT o.*, r.id AS refund_id, r.status AS refund_status, r.refund_amount, r.cat_food_to_deduct, r.reason, r.reject_reason, r.reject_evidence_json, r.evidence_json, r.resolution_note, r.external_reference, r.created_at AS refund_created_at, r.reviewed_at FROM refund_requests r JOIN orders o ON o.id = r.order_id WHERE r.id = ? AND r.openid = ?`, [id, userOpenid]);
    if (!row) return send(res, 4004, null, '退款申请不存在');
    send(res, 0, { refund: refundRequestRow(row) });
  } catch (error) { console.error(error); send(res, 5001, null, '退款详情读取失败'); }
});

app.get('/api/admin/order-ledger', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const type = String(req.query.type || 'service');
  if (!['service', 'gift', 'membership', 'recharge'].includes(type)) return send(res, 4002, null, '记录类型无效');
  const keyword = String(req.query.keyword || '').trim().slice(0, 64);
  const pendingOnly = type === 'gift' && req.query.pendingOnly === '1';
  const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  try {
    let records; let total = 0;
    if (type === 'service') {
      const where = keyword ? 'WHERE (o.id LIKE ? OR u.nick_name LIKE ? OR o.partner_name LIKE ? OR o.openid LIKE ?)' : '';
      const params = keyword ? Array(4).fill(`%${keyword}%`) : [];
      const [[count]] = await pool.query(`SELECT COUNT(*) AS total FROM orders o LEFT JOIN users u ON u.openid = o.openid ${where}`, params);
      total = Number(count.total || 0);
      const [rows] = await pool.query(`SELECT o.*, u.nick_name FROM orders o LEFT JOIN users u ON u.openid = o.openid ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
      records = rows.map((row) => ({ id: row.id, title: row.service || '陪玩服务', userName: row.nick_name || '喵伴用户', partnerName: row.partner_name || '—', amount: money(row.total_price), status: row.status, paymentMethod: row.payment_method || '', relatedOrderId: row.renew_from_order_id || '', createdAt: formatDate(row.created_at) }));
    } else if (type === 'gift') {
      const giftId = /^MG0*(\d+)$/i.exec(keyword);
      const giftFilters = [];
      if (keyword) giftFilters.push('(CAST(g.id AS CHAR) = ? OR g.donor_nick_name LIKE ? OR g.recipient_name LIKE ? OR g.gift_name LIKE ? OR g.openid LIKE ?)');
      if (pendingOnly) giftFilters.push("r.status = 'pending'");
      const where = giftFilters.length ? `WHERE ${giftFilters.join(' AND ')}` : '';
      const params = keyword ? [giftId ? giftId[1] : keyword, ...Array(4).fill(`%${keyword}%`)] : [];
      const [[count]] = await pool.query(`SELECT COUNT(*) AS total FROM partner_gifts g LEFT JOIN gift_refund_requests r ON r.gift_id = g.id ${where}`, params);
      total = Number(count.total || 0);
      const [rows] = await pool.query(`SELECT g.*, r.id AS refund_request_id, r.status AS refund_status FROM partner_gifts g LEFT JOIN gift_refund_requests r ON r.gift_id = g.id ${where} ORDER BY g.created_at DESC, g.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
      records = rows.map((row) => ({ id: `MG${String(row.id).padStart(8, '0')}`, title: row.gift_name, userName: row.donor_nick_name || '喵伴用户', partnerName: row.recipient_name || '陪陪', amount: money(row.coin_cost), status: row.status, refundStatus: row.refund_status || '', refundRequestId: row.refund_request_id || null, paymentMethod: '金币支付', createdAt: formatDate(row.created_at) }));
    } else {
      const transactionType = type === 'membership' ? ['membership_join', 'membership_upgrade'] : ['recharge_demo'];
      const where = keyword ? ' AND (CAST(t.id AS CHAR) = ? OR t.title LIKE ? OR u.nick_name LIKE ? OR t.openid LIKE ?)' : '';
      const params = keyword ? [keyword.replace(/^WT/i, ''), ...Array(3).fill(`%${keyword}%`)] : [];
      const [[count]] = await pool.query(`SELECT COUNT(*) AS total FROM wallet_transactions t LEFT JOIN users u ON u.openid = t.openid WHERE t.transaction_type IN (?)${where}`, [transactionType, ...params]);
      total = Number(count.total || 0);
      const [rows] = await pool.query(`SELECT t.id, t.title, t.amount, t.transaction_type, t.created_at, u.nick_name FROM wallet_transactions t LEFT JOIN users u ON u.openid = t.openid WHERE t.transaction_type IN (?)${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`, [transactionType, ...params, pageSize, offset]);
      records = rows.map((row) => ({ id: `WT${row.id}`, title: row.title, userName: row.nick_name || '喵伴用户', partnerName: '', amount: money(row.amount), status: 'demo', paymentMethod: '演示记录，非付款凭证', createdAt: formatDate(row.created_at) }));
    }
    send(res, 0, { type, records, page, pageSize, total, hasMore: offset + records.length < total });
  } catch (error) { console.error(error); send(res, 5001, null, '运营记录读取失败，请确认已执行对应数据库脚本'); }
});

app.get('/api/admin/order-ledger/service/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [[order]] = await pool.query('SELECT o.*, u.nick_name, u.user_no FROM orders o LEFT JOIN users u ON u.openid = o.openid WHERE o.id = ?', [req.params.id]);
    if (!order) return send(res, 4004, null, '服务订单不存在');
    const [refunds] = await pool.query('SELECT id, status, refund_amount, reason, resolution_note, external_reference, created_at, reviewed_at FROM refund_requests WHERE order_id = ? ORDER BY created_at DESC', [order.id]);
    const [walletRecords] = await pool.query('SELECT id, transaction_type, coin_delta, cat_food_delta, title, created_at FROM wallet_transactions WHERE order_id = ? ORDER BY created_at DESC', [order.id]);
    send(res, 0, { order: { id: order.id, userName: order.nick_name || '喵伴用户', userNo: order.user_no || '', partnerName: order.partner_name || '—', service: order.service || '', status: order.status, amount: money(order.total_price), paymentMethod: order.payment_method || '', createdAt: formatDate(order.created_at), startedAt: formatDate(order.service_started_at), completedAt: formatDate(order.service_completed_at), couponId: order.coupon_id || null, catFoodEarned: Number(order.points_earned || 0) }, refunds: refunds.map((row) => ({ id: Number(row.id), status: row.status, amount: money(row.refund_amount), reason: row.reason || '', note: row.resolution_note || '', reference: row.external_reference || '', createdAt: formatDate(row.created_at), reviewedAt: formatDate(row.reviewed_at) })), walletRecords: walletRecords.map((row) => ({ id: Number(row.id), type: row.transaction_type, title: row.title, coinDelta: Number(row.coin_delta || 0), catFoodDelta: Number(row.cat_food_delta || 0), createdAt: formatDate(row.created_at) })) });
  } catch (error) { console.error(error); send(res, 5001, null, '服务订单详情读取失败'); }
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
       SUM(status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS stalePendingCount,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN total_price ELSE 0 END), 0) AS revenue FROM orders`
    );
    const [[partners]] = await pool.query(
      "SELECT COUNT(*) AS totalPartners, SUM(status = 'pending') AS pendingPartners, SUM(status = 'approved') AS approvedPartners FROM partner_profiles"
    );
    const [[withdrawals]] = await pool.query("SELECT COUNT(*) AS pendingWithdrawals FROM withdrawal_requests WHERE status = 'pending'");
    const [[refunds]] = await pool.query("SELECT COUNT(*) AS pendingRefunds FROM refund_requests WHERE status = 'pending'");
    const [[giftRefunds]] = await pool.query("SELECT COUNT(*) AS pendingGiftRefunds FROM gift_refund_requests WHERE status = 'pending'");
    send(res, 0, {
      totalUsers: Number(users.totalUsers || 0), todayNew: Number(users.todayNew || 0), weekNew: Number(users.weekNew || 0),
      orderCount: Number(orders.orderCount || 0), pendingCount: Number(orders.pendingCount || 0), stalePendingCount: Number(orders.stalePendingCount || 0), revenue: Number(orders.revenue || 0),
      totalPartners: Number(partners.totalPartners || 0), pendingPartners: Number(partners.pendingPartners || 0), approvedPartners: Number(partners.approvedPartners || 0),
      pendingWithdrawals: Number(withdrawals.pendingWithdrawals || 0),
      pendingRefunds: Number(refunds.pendingRefunds || 0), pendingGiftRefunds: Number(giftRefunds.pendingGiftRefunds || 0)
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
      ORDER BY FIELD(r.status, 'pending', 'approved', 'rejected', 'refunded', 'unpaid_closed', 'external_refunded'), r.created_at DESC LIMIT 100`);
    send(res, 0, { refunds: rows.map((row) => {
      let evidence = []; let rejectEvidence = [];
      try { evidence = JSON.parse(row.evidence_json || '[]'); } catch (_) { evidence = []; }
      try { rejectEvidence = JSON.parse(row.reject_evidence_json || '[]'); } catch (_) { rejectEvidence = []; }
      return {
        id: Number(row.id), orderId: row.order_id, openid: row.openid, userNo: row.user_no || '', nickName: row.nick_name || '未完善资料用户', avatarUrl: row.avatar_url || '',
        partnerName: row.partner_name || '—', paymentMethod: row.payment_method || '—', unit: row.unit || '', quantity: Number(row.quantity || 0),
        orderTotalPrice: money(row.order_total_price), refundAmount: money(row.refund_amount), catFoodToDeduct: Number(row.cat_food_to_deduct || 0),
        reason: row.reason || '', rejectReason: row.reject_reason || '', resolutionNote: row.resolution_note || '', externalReference: row.external_reference || '', evidence: Array.isArray(evidence) ? evidence : [], rejectEvidence: Array.isArray(rejectEvidence) ? rejectEvidence : [], status: row.status,
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
    send(res, 0, { refund: { id: Number(row.id), orderId: row.order_id, openid: row.openid, userNo: row.user_no || '', nickName: row.nick_name || '未完善资料用户', avatarUrl: row.avatar_url || '', partnerName: row.partner_name || '—', paymentMethod: row.payment_method || '—', unit: row.unit || '', quantity: Number(row.quantity || 0), orderTotalPrice: money(row.order_total_price), refundAmount: money(row.refund_amount), catFoodToDeduct: Number(row.cat_food_to_deduct || 0), reason: row.reason || '', rejectReason: row.reject_reason || '', resolutionNote: row.resolution_note || '', externalReference: row.external_reference || '', evidence: Array.isArray(evidence) ? evidence : [], rejectEvidence: Array.isArray(rejectEvidence) ? rejectEvidence : [], status: row.status, createdAt: formatDate(row.created_at), reviewedAt: formatDate(row.reviewed_at) } });
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
    if (!await hasCoinOrderPayment(connection, refund.openid, order.id)) { await connection.rollback(); return send(res, 4002, null, '该订单没有金币扣款流水，不能自动返还金币；请人工核实实际付款渠道'); }
    let refundAmount = 0;
    const paidAmount = money(order.total_price);
    const originalAmount = money(order.original_total_price === null ? order.total_price : order.original_total_price);
    const seconds = Math.max(0, Number(order.service_seconds || 0));
    if (!order.service_started_at) {
      refundAmount = paidAmount;
    } else if (order.unit === '小时') {
      if (seconds < 28 * 60) { await connection.rollback(); return send(res, 4002, null, '服务时长不足 28 分钟，不满足退款规则'); }
      if (seconds > 60 * 60) { await connection.rollback(); return send(res, 4002, null, '服务时长已超过 1 小时，请人工协商处理'); }
      const hourlyPrice = money(originalAmount / Math.max(1, Number(order.quantity || 1)));
      const grossRefund = money(hourlyPrice * (seconds < 57 * 60 ? 0.5 : 1));
      refundAmount = money(Math.min(paidAmount, grossRefund * (originalAmount > 0 ? paidAmount / originalAmount : 0)));
    } else {
      await connection.rollback();
      return send(res, 4002, null, '按局订单已开始服务，需核对已完成局数后人工计算退款金额');
    }
    const catFoodToDeduct = Math.max(0, Number(order.points_earned || 0));
    await ensureWallet(connection, refund.openid);
    const [[wallet]] = await connection.query('SELECT * FROM user_wallets WHERE openid = ? FOR UPDATE', [refund.openid]);
    if (Number(wallet.cat_food_balance || 0) < catFoodToDeduct) { await connection.rollback(); return send(res, 4002, null, `用户猫粮余额不足，需扣回 ${catFoodToDeduct} 猫粮`); }
    await connection.query("UPDATE orders SET status = 'cancelled', remark = CONCAT(COALESCE(remark, ''), ?) WHERE id = ?", [` [订单退款：${refundAmount} 金币，原路退回（演示），扣回${catFoodToDeduct}猫粮]`, order.id]);
    let couponReturned = false;
    if (order.coupon_id && !order.service_started_at) {
      const [couponResult] = await connection.query(
        "UPDATE user_coupons SET status = 'unused', used_order_id = NULL, used_at = NULL WHERE id = ? AND openid = ? AND status = 'used' AND used_order_id = ? AND (expires_at IS NULL OR expires_at > NOW())",
        [order.coupon_id, refund.openid, order.id]
      );
      couponReturned = couponResult.affectedRows > 0;
    }
    await connection.query('UPDATE user_wallets SET coin_balance = coin_balance + ?, cat_food_balance = cat_food_balance - ? WHERE openid = ?', [refundAmount, catFoodToDeduct, refund.openid]);
    await addWalletRecord(connection, refund.openid, { coinDelta: refundAmount, catFoodDelta: -catFoodToDeduct, type: 'order_refund', title: '订单退款（原路退款演示）', amount: refundAmount, orderId: order.id });
    await connection.query("UPDATE refund_requests SET status = 'refunded', refund_amount = ?, cat_food_to_deduct = ?, reviewer_openid = ?, reviewed_at = NOW() WHERE id = ?", [refundAmount, catFoodToDeduct, reviewerOpenid, id]);
    await connection.commit();
    send(res, 0, { id, status: 'refunded', refundAmount, catFoodToDeduct, couponReturned, refundRoute: order.payment_method || '原支付路径（演示）' });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '退款审核处理失败'); }
  finally { if (connection) connection.release(); }
});

// 人工结案只记录已核实的结果，绝不凭订单金额生成金币退款。
app.patch('/api/admin/refund-requests/:id/manual-resolution', async (req, res) => {
  const reviewerOpenid = requireAdmin(req, res);
  if (!reviewerOpenid) return;
  const id = Number(req.params.id);
  const status = String((req.body || {}).status || '');
  const note = String((req.body || {}).note || '').trim().slice(0, 300);
  const reference = String((req.body || {}).reference || '').trim().slice(0, 100);
  const amount = Number((req.body || {}).amount);
  if (!Number.isInteger(id) || id <= 0 || !['unpaid_closed', 'external_refunded'].includes(status) || note.length < 5) return send(res, 4002, null, '请选择人工处理结果并填写至少 5 个字的核实说明');
  if (status === 'external_refunded' && (!reference || !Number.isFinite(amount) || amount <= 0)) return send(res, 4002, null, '原渠道退款需填写实际退款金额和凭证编号');
  let connection;
  try {
    connection = await pool.getConnection(); await connection.beginTransaction();
    const [[refund]] = await connection.query('SELECT * FROM refund_requests WHERE id = ? FOR UPDATE', [id]);
    if (!refund || refund.status !== 'pending') { await connection.rollback(); return send(res, 4002, null, '退款申请不存在或已处理'); }
    const [[order]] = await connection.query('SELECT * FROM orders WHERE id = ? AND openid = ? FOR UPDATE', [refund.order_id, refund.openid]);
    if (!order || order.status === 'cancelled') { await connection.rollback(); return send(res, 4002, null, '订单不存在或已取消'); }
    if (await hasCoinOrderPayment(connection, refund.openid, order.id)) { await connection.rollback(); return send(res, 4002, null, '存在金币实扣流水，请使用正常退款审核，不能人工结案'); }
    if (status === 'unpaid_closed' && (reference || Number.isFinite(amount) && amount > 0)) { await connection.rollback(); return send(res, 4002, null, '未付款结案不能填写退款金额或退款凭证'); }
    if (status === 'external_refunded' && money(amount) !== money(order.total_price)) { await connection.rollback(); return send(res, 4002, null, '目前仅支持全额原渠道退款结案；部分退款请继续人工协商，不要取消整单'); }
    const catFood = Math.max(0, Number(order.points_earned || 0));
    await ensureWallet(connection, refund.openid);
    const [[wallet]] = await connection.query('SELECT cat_food_balance FROM user_wallets WHERE openid = ? FOR UPDATE', [refund.openid]);
    if (catFood > Number(wallet.cat_food_balance || 0)) { await connection.rollback(); return send(res, 4002, null, `猫粮余额不足以扣回 ${catFood}，请先人工处理权益后结案`); }
    if (catFood) {
      await connection.query('UPDATE user_wallets SET cat_food_balance = cat_food_balance - ? WHERE openid = ?', [catFood, refund.openid]);
      await addWalletRecord(connection, refund.openid, { catFoodDelta: -catFood, type: 'order_reward_reversal', title: '订单人工结案扣回猫粮', amount: 0, orderId: order.id });
    }
    const [growthRows] = await connection.query("SELECT id, growth_delta, status FROM growth_transactions WHERE openid = ? AND order_id = ? AND transaction_type = 'order_consumption' FOR UPDATE", [refund.openid, order.id]);
    const credited = growthRows.filter((row) => row.status === 'credited').reduce((sum, row) => sum + Number(row.growth_delta || 0), 0);
    if (credited) {
      await ensureGrowth(connection, refund.openid);
      await connection.query('UPDATE user_growth SET growth_points = GREATEST(0, growth_points - ?) WHERE openid = ?', [credited, refund.openid]);
    }
    await connection.query("UPDATE growth_transactions SET status = 'reversed' WHERE openid = ? AND order_id = ? AND transaction_type = 'order_consumption' AND status IN ('pending', 'credited')", [refund.openid, order.id]);
    if (order.coupon_id && !order.service_started_at) await connection.query("UPDATE user_coupons SET status = 'unused', used_order_id = NULL, used_at = NULL WHERE id = ? AND openid = ? AND status = 'used' AND used_order_id = ? AND (expires_at IS NULL OR expires_at > NOW())", [order.coupon_id, refund.openid, order.id]);
    await connection.query("UPDATE orders SET status = 'cancelled', points_earned = 0 WHERE id = ?", [order.id]);
    await connection.query('UPDATE refund_requests SET status = ?, refund_amount = ?, cat_food_to_deduct = ?, resolution_note = ?, external_reference = ?, reviewer_openid = ?, reviewed_at = NOW() WHERE id = ?', [status, status === 'external_refunded' ? money(amount) : 0, catFood, note, reference, reviewerOpenid, id]);
    await connection.commit();
    send(res, 0, { id, status, refundAmount: status === 'external_refunded' ? money(amount) : 0, catFoodToDeduct: catFood });
  } catch (error) { if (connection) await connection.rollback(); console.error(error); send(res, 5001, null, '人工结案失败'); }
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

app.get('/api/admin/partners/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return send(res, 4002, null, '陪玩资料无效');
  try {
    const [[partner]] = await pool.query('SELECT * FROM partner_profiles WHERE id = ?', [id]);
    if (!partner) return send(res, 4004, null, '陪玩资料不存在');
    send(res, 0, { partner: partnerRow(partner, true) });
  } catch (error) { console.error(error); send(res, 5001, null, '陪玩资料读取失败'); }
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
       COUNT(o.id) AS order_count, COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total_price ELSE 0 END), 0) AS total_spent,
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
