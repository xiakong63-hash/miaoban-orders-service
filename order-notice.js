const TEMPLATE_ID = 'XwyMFiXsRSAzdEQGWyuAoe-ndKRYSKaSZmB1Cj1zUqI';
const APP_ID = process.env.WECHAT_APP_ID || 'wxc35754215029c360';
let cachedToken = '';
let tokenExpiresAt = 0;

function noticeEnabled() {
  return Boolean(process.env.WECHAT_APP_SECRET);
}

function noticeData(order) {
  return {
    character_string1: { value: String(order.id || '').slice(0, 32) },
    thing2: { value: String(order.service || '陪玩订单').slice(0, 20) },
    thing3: { value: order.renew_from_order_id ? '陪玩续单' : '陪玩预约' },
    amount4: { value: String(Number(order.total_price || 0)) },
    thing5: { value: '金币计价，请及时接单' }
  };
}

async function wechatJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
  return response.json();
}

async function accessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', APP_ID);
  url.searchParams.set('secret', process.env.WECHAT_APP_SECRET);
  const result = await wechatJson(url);
  if (!result.access_token) throw new Error(`获取微信凭证失败 (${result.errcode || 'unknown'})`);
  cachedToken = result.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(result.expires_in || 7200) - 300) * 1000;
  return cachedToken;
}

async function sendOrderNotice(openid, order) {
  if (!noticeEnabled() || !openid || !order) return false;
  const token = await accessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`;
  const result = await wechatJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ touser: openid, template_id: TEMPLATE_ID, page: 'pages/partner-hall/partner-hall', data: noticeData(order), miniprogram_state: process.env.WECHAT_NOTICE_STATE || 'formal' })
  });
  if (result.errcode) {
    if (result.errcode === 40001 || result.errcode === 42001) { cachedToken = ''; tokenExpiresAt = 0; }
    throw new Error(`微信消息发送失败 (${result.errcode}: ${result.errmsg || ''})`);
  }
  return true;
}

module.exports = { TEMPLATE_ID, noticeEnabled, noticeData, sendOrderNotice };
