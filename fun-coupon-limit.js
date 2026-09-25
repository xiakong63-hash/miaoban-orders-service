const FUN_COUPON_WEEKLY_LIMIT = 2;

// A returned coupon has no used_order_id, so an unstarted cancelled order releases its slot.
// CURDATE() and orders.created_at both use the database session's calendar week (Monday–Sunday).
async function weeklyFunCouponUsage(executor, openid) {
  const [[row]] = await executor.query(
    `SELECT COUNT(*) AS used_count
       FROM orders o
       JOIN user_coupons c ON c.used_order_id = o.id AND c.openid = o.openid AND c.status = 'used'
      WHERE o.openid = ? AND o.coupon_id = c.id AND o.service LIKE '%趣味%'
        AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
        AND o.created_at < DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 7 DAY)`,
    [openid]
  );
  return Number(row.used_count || 0);
}

module.exports = { FUN_COUPON_WEEKLY_LIMIT, weeklyFunCouponUsage };
