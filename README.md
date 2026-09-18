# 喵伴电竞订单服务

这是云托管的订单服务源码。部署前在云托管关联的 MySQL 数据库执行 `schema.sql`；服务环境变量需提供：

- `MYSQL_ADDRESS`（或 `MYSQL_HOST`）
- `MYSQL_USERNAME`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`

部署后服务应保留原服务名 `express-siza`，小程序无需再改服务名。部署成功后访问 `/api/health`，返回 `database: connected` 即可。
