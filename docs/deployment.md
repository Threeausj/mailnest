# 部署与备份

## 配置原则

需要 Node.js 24+ 或 Docker Compose v2。公网使用独立域名和 HTTPS，前后端从同一来源提供。`APP_URL` 必须填写浏览器实际访问地址，不能使用内部容器地址；Google 回调地址必须与该来源及 Google 控制台登记值一致。生产模式只为本机 `localhost` / `127.0.0.1` 回环地址允许 HTTP，公网 HTTP 会被拒绝。

首次先执行 `npm install && npm run init`，检查管理员邮箱并保存生成的密码。已有数据时保留 `.env` 中 `ENCRYPTION_KEY`，更换该密钥会导致已有邮箱密码 / OAuth 凭据无法解密；保留 VAPID 公私钥可维持原推送订阅。管理员密码修改后以数据库中的密码为准，`.env` 的 `ADMIN_PASSWORD` 只用于首次引导。修改密码会撤销全部会话与 API 令牌；更新依赖令牌的自动化配置。

`DATA_DIR` 相对项目根目录解析；默认本机 `./data`，容器 `/app/data`。SQLite 使用 WAL，数据目录也保存邮件缓存。浏览器 Cookie 为 HttpOnly、SameSite，HTTPS 时启用 Secure；Cookie 写操作检查 `Origin`，来源不匹配会拒绝。Bearer 令牌用于独立 API 调用。

## 本机 Docker

将 `.env` 中 `APP_URL` 改为 `http://localhost:3001`，`GOOGLE_REDIRECT_URI` 改为 `http://localhost:3001/api/v1/oauth/google/callback`。运行：

```sh
docker compose up -d --build
docker compose ps
curl http://localhost:3001/api/v1/health
```

访问 <http://localhost:3001>。Compose 强制 `NODE_ENV=production`，只绑定宿主机回环地址，应用使用非 root 用户、只读容器文件系统和独立可写数据卷。关闭容器不会删除数据；不要执行 `docker compose down -v`，它会删除数据卷。

## 当前 NAS 的 Docker 部署

当前 NAS 部署目录为 `/volume2/docker/mailnest`，访问地址为 `http://192.168.91.85:5173`。[GitHub 私有仓库 Threeausj/mailnest](https://github.com/Threeausj/mailnest) 仅保存源码；`.env`、`data/`、`backups/`、本机覆盖文件和私钥均排除在 Git 与镜像构建之外。现有 `/volume2/workspace/mailnest` 可继续用于开发。

部署目录的 `compose.override.yml` 由 `deploy/compose.nas.yml` 复制而来，与基础 `compose.yml` 自动合并。该模板使用宿主网络和 `127.0.0.1` DNS，沿用 NAS 的 mihomo 代理 / Fake-IP；数据绑定至部署目录的 `data/`。Docker Compose 需要支持 `!reset` / `!override`（2.24.4+）。容器以 UID 1000 运行，只读根文件系统，数据目录可写，自动重启并检查 5173 端口健康状态。

此模板运行编译后的前后端，`NODE_ENV=development` 用于兼容当前 LAN HTTP 地址，不会启动开发服务器。公网使用上面的基础生产配置及下面的 HTTPS 模板，不叠加 NAS 覆盖文件。

首次迁移保留原 `.env` 中所有秘密，将 `APP_URL` / `GOOGLE_REDIRECT_URI` 改为当前 LAN 来源，`DATA_DIR=/app/data`，保留 `ALLOW_PRIVATE_MAIL_HOSTS=true` 供现有 Fake-IP 使用。不要重新初始化密钥。先构建镜像并验证，再停止旧 `mailnest-lan.service`，备份 `.env` 及完整 SQLite 文件后复制最新数据库；不要复制 `data/e2e`。目标数据目录属主设为 `1000:1000`，目录权限 700、文件 600。确认容器正常后停用旧服务的开机启动，避免重复同步或争用端口。

日常管理：

```sh
cd /volume2/docker/mailnest
docker compose ps
docker compose logs --tail=100 mailnest
docker compose restart mailnest
curl --fail http://192.168.91.85:5173/api/v1/health
```

更新源码并重建：

```sh
cd /volume2/docker/mailnest
git pull --ff-only
docker compose build mailnest
docker compose up -d mailnest
```

更新前按下方步骤备份；`.env`、`compose.override.yml` 和 `data/` 不受 Git 更新影响。NAS 的数据是绑定目录，可停容器后将完整 `data/` 与 `.env` 复制到权限受限的 `backups/`。迁移时生成的备份保存在 `/volume2/docker/mailnest/backups/`，原工作区数据也保留；回退时先停止容器，再恢复原工作区的 systemd 服务，避免两处同时运行。

## 公网 Caddy 模板

1. 为服务器设置域名 DNS A / AAAA 记录，确认入站 TCP 80 / 443 可达，UDP 443 可选用于 HTTP/3。服务器须能访问邮箱服务商 IMAP / SMTP、Google OAuth 和浏览器推送服务。
2. 在 `.env` 填写 `DOMAIN=mail.example.com`，并将 `APP_URL=https://mail.example.com`、`GOOGLE_REDIRECT_URI=https://mail.example.com/api/v1/oauth/google/callback`。按 [Gmail 配置](gmail.md) 配置 Google Web 应用凭据和精确回调地址。
3. 在仓库根目录执行：

```sh
docker compose -f compose.yml -f deploy/compose.public.yml config
docker compose -f compose.yml -f deploy/compose.public.yml up -d --build
docker compose -f compose.yml -f deploy/compose.public.yml ps
```

公共模板自动使用 `https://${DOMAIN}` 并启用 `TRUST_PROXY=true`；Caddy 在容器网络中转发至 `mailnest:3001`，申请和续期证书。应用端口仍仅暴露于宿主机回环地址，公网通过 Caddy 进入。在已有 NAS / Nginx 反向代理上部署时，可以只运行基础 Compose，把 HTTPS 域名转发至 `127.0.0.1:3001`，同时显式设置正确 `APP_URL` / Google 回调和 `TRUST_PROXY=true`；后者仅应在可信代理后启用。基础 Compose 固定 `TRUST_PROXY=false`，使用自己的代理时需在覆盖文件中改为 `true`。

部署后访问 `https://mail.example.com`，登录、修改初始密码，测试接入邮箱、发信、同步及安装后的通知。可通过公开的 `/api/v1/health` 探活；其响应不泄露用户或邮件信息。

默认拒绝连接私有 / 回环 / 链路本地 IMAP / SMTP 地址，防止邮箱连接表单被用来探测内部网络。只有确实需要连接内网邮件服务器、且所有用户可信时才设置 `ALLOW_PRIVATE_MAIL_HOSTS=true`。无论此选项如何设置，连接均须使用证书有效的 TLS 或 STARTTLS，不支持关闭证书验证。

## 邮件缓存与空间

列表仅保存每目录最近 `SYNC_MESSAGE_LIMIT` 封摘要（默认 200）。阅读时获取正文和附件元数据；原始 MIME、附件和内嵌图片二进制不持久保存，下载或显示图片时从远端按需获取。正文分段读取，纯文本上限 512 KiB、HTML 上限 2 MiB；超限返回 `bodyTruncated` 提示。服务商不支持邮件结构时，兼容读取完整 MIME 上限为 30 MiB；单附件下载上限为 30 MiB。

`MAIL_CACHE_MAX_MIB=64` 限制全实例正文及附件元数据缓存（4–1024 MiB），`MAIL_CACHE_TTL_DAYS=7` 控制有效期（1–365 天）。有效期从最后访问起算，过期或超过总量时按最近访问时间清理缓存，再次打开会重新读取；列表摘要、账号配置和 SQLite 索引不计入该上限，因此这不是整个数据目录的大小上限。以上清理不删除远端邮件。

升级时自动清除旧版持久保存的完整 MIME、附件二进制和不兼容正文缓存。SQLite 释放的页会被后续写入复用，文件大小可能不会立即下降；需要立即回收磁盘时，应先停止应用并备份数据，再对数据库执行 SQLite `VACUUM`，完成后启动。不要直接删除数据库或正在使用的 WAL 文件。

账号 `partial` 表示部分目录失败、其他目录仍同步；账号错误详情会指出经过处理的目录失败原因。不要仅因 QQ 邮箱某个目录被服务商拒绝就重新添加账号。

## 备份与恢复

备份时停止应用，复制完整数据目录或 Docker 数据卷，避免只复制正在写入的 SQLite 主文件而遗漏 WAL。另行安全保存 `.env`；不要将邮箱数据、凭据和备份放入源码仓库。Docker 示例从项目根目录执行：

```sh
mkdir -p backups
chmod 700 backups
umask 077
docker compose stop mailnest
docker compose run --rm -T --no-deps --entrypoint tar \
  mailnest -czf - -C /app/data . > backups/mailnest-data.tar.gz
docker compose start mailnest
cp .env backups/mailnest.env
chmod 600 backups/mailnest.env backups/mailnest-data.tar.gz
```

使用公共模板部署时，以上 `docker compose` 命令加上同样的 `-f compose.yml -f deploy/compose.public.yml` 参数。备份通过非 root 临时容器读出数据流，由本机保存归档；确认归档命令成功后再恢复运行。敏感归档宜额外加密并转存另一设备。

恢复到空数据卷时，先停止应用并放回原 `.env`。解包：

```sh
docker compose run --rm -T --no-deps --entrypoint tar \
  mailnest --no-same-owner -xzf - -C /app/data < backups/mailnest-data.tar.gz
docker compose up -d
```

此操作要求目标数据卷为空；恢复前保留目标原数据备份。若更换域名，调整 `APP_URL` / Google 回调，重新订阅浏览器推送；不要重新运行初始化来生成加密密钥。Caddy 证书状态位于 `caddy_data` / `caddy_config` 卷，可额外备份。

升级前备份 `.env` 和数据，更新代码后重新构建，观察 `docker compose logs --tail=100 mailnest` 与健康状态。真实邮箱连接错误显示在账号状态中；检查服务商应用密码、TLS 端口、账户权限和出站网络。不要开启记录完整 IMAP / SMTP 身份验证或邮件内容的调试日志。
