# API v1

所有端点前缀为 `/api/v1`，同源前后端使用 JSON。机器可读定义为 [openapi.json](openapi.json)，登录后可在 `/api/v1/docs` 浏览交互文档或下载 `/api/v1/openapi.json`。文档也需鉴权。公开端点仅 `GET /health` 和 `POST /auth/login`，没有公开注册。

## 鉴权与错误

浏览器使用 `mailnest_session` HttpOnly Cookie，会话有效期 7 天。登录及其他使用 Cookie 的写操作（POST / PATCH / DELETE）必须提供与 `APP_URL` 完全一致的 `Origin` 头；同源浏览器会自动提供。HTTPS Cookie 使用 Secure。SSE、密码修改、Google 授权和 API 令牌管理使用浏览器会话。修改密码后会撤销该用户全部会话与 API 令牌，需重新登录并生成新令牌。

第三方工具使用 `Authorization: Bearer <MailNest API token>`；在设置中或已登录会话下 `POST /tokens` 创建，明文只返回一次，可随时撤销。API 令牌是 MailNest 的独立凭据，不是 Google Access Token。目前令牌可操作所属用户全部邮箱与邮件，没有细粒度权限；不能管理令牌、修改登录密码或进行 Google OAuth。

所有资源以当前用户为边界，访问其他用户的 ID 与访问不存在的 ID 均失败。错误统一为：

```json
{ "error": { "code": "UNAUTHENTICATED", "message": "请先登录。" } }
```

常见 HTTP 状态：`400` 参数无效 / 邮箱连接或收发失败；`401` 未登录 / 凭据无效；`403` 来源不匹配 / 要求会话；`404` 资源不存在或无权限；`409` 重复连接 / 远端邮件 UID 状态失效；`413` 请求、附件或兼容读取的完整邮件过大；`415` 不支持作为内嵌图片显示的附件类型；`429` 登录或 SSE 连接过多；`503` 功能未配置 / 服务关闭中；`504` 邮箱操作超时；`500` 内部异常。错误 code 区分具体原因，具体端点响应见 OpenAPI；客户端应结合 HTTP 状态处理。服务不返回密码、OAuth 秘密或错误堆栈。API、附件及授权响应均 `Cache-Control: no-store`。

## 快速使用

以下本机示例针对构建 / Docker 地址；开发时将地址与 Origin 改为 `http://localhost:5173`。公网用 HTTPS 实际域名。登录用自己的登录邮箱与初始化密码，避免将秘密放入共享日志或脚本仓库：

```sh
curl -c /tmp/mailnest.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"替换为真实密码"}' \
  http://localhost:3001/api/v1/auth/login

curl -b /tmp/mailnest.cookies \
  -H 'Origin: http://localhost:3001' \
  -H 'Content-Type: application/json' \
  -d '{"name":"本地自动化"}' \
  http://localhost:3001/api/v1/tokens
```

第二个响应为 `{ "token": "...", "id": "..." }`（201）。保存 token 后独立调用，无需 Cookie 或 Origin：

```sh
curl -H 'Authorization: Bearer 替换为API令牌' \
  'http://localhost:3001/api/v1/messages?folder=INBOX&page=1&pageSize=30'

curl -H 'Authorization: Bearer 替换为API令牌' \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"替换为邮箱ID","to":"recipient@example.com","subject":"测试邮件","text":"来自 MailNest API"}' \
  http://localhost:3001/api/v1/messages/send
```

创建或撤销令牌仍需 Cookie 会话。`DELETE /tokens/{id}` 立即撤销令牌。调用完成后妥善清理临时 Cookie 文件。

## 端点概览

下表路径省略 `/api/v1`；“会话”要求 Cookie，“用户”可使用 Cookie 或 API 令牌。

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | 健康检查 |
| POST | `/auth/login` | 公开 + Origin | 登录，设置会话 Cookie |
| GET | `/auth/me` | 用户 | 当前用户 |
| POST | `/auth/logout` | 会话 | 注销当前会话 |
| POST | `/auth/password` | 会话 | 修改密码（至少 12 字符） |
| GET | `/config` | 用户 | Google 是否配置、Push 公钥、轮询间隔（秒） |
| GET | `/accounts` | 用户 | 邮箱列表，附各账号目录缓存 |
| POST | `/accounts` | 用户 | 验证并添加 IMAP / SMTP 邮箱（201） |
| PATCH | `/accounts/{id}` | 用户 | 修改已添加邮箱的配置 |
| DELETE | `/accounts/{id}` | 用户 | 删除本地连接及缓存 |
| GET | `/accounts/{id}/folders` | 用户 | 本地缓存的真实文件夹 |
| POST | `/accounts/{id}/sync` | 用户 | 调度指定邮箱同步 |
| POST | `/sync` | 用户 | 调度指定 / 全部邮箱同步 |
| GET | `/messages` | 用户 | 缓存邮件列表、筛选及分页 |
| GET | `/messages/{id}` | 用户 | 正文及附件元数据 |
| PATCH | `/messages/{id}` | 用户 | 未读 / 星标 |
| POST | `/messages/{id}/move` | 用户 | 移到收件箱、归档或回收站 |
| GET | `/messages/{id}/attachments/{attachmentId}` | 用户 | 下载附件二进制 |
| POST | `/messages/send` | 用户 | SMTP 发信（可带附件） |
| GET | `/oauth/google/start` | 会话 | 获取 Google 授权 URL |
| GET | `/oauth/google/callback` | 会话 | Google 浏览器回调与跳转 |
| GET | `/events` | 会话 | SSE 实时同步 / 新邮件事件 |
| POST / DELETE | `/push/subscriptions` | 用户 | 添加 / 撤销 Web Push 订阅 |
| GET / POST | `/tokens` | 会话 | 查看 / 创建 API 令牌 |
| DELETE | `/tokens/{id}` | 会话 | 撤销 API 令牌 |
| GET | `/openapi.json` | 用户 | OpenAPI 3.0.3 定义 |
| GET | `/docs` | 用户 | 交互式接口文档 |

## 邮箱及邮件行为

`POST /accounts` 示例：

```json
{
  "name": "个人邮箱",
  "email": "you@gmail.com",
  "color": "#6366f1",
  "provider": "gmail",
  "username": "you@gmail.com",
  "password": "应用专用密码",
  "imap": { "host": "imap.gmail.com", "port": 993, "secure": true },
  "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true }
}
```

可选 `smtpUsername` / `smtpPassword` 用于不同发信凭据，省略时复用 IMAP 凭据；`color` 省略时为 `#6d5ce8`，最多接入 20 个邮箱，重复邮箱返回 409。`secure=true` 为直接 TLS；`false` 为必须成功的 STARTTLS；证书始终验证。默认拒绝私有 / 回环 / 链路本地地址。创建前验证 IMAP / SMTP 连接，返回 DTO 绝不包含秘密。Google OAuth 接入另走授权流程。

`PATCH /accounts/{id}` 编辑已有配置，仅提交需要修改的字段，至少一个字段。支持 `name`、`color`、`email`、`username`、`password`、`imap`、`smtp`、`smtpUsername`、`smtpPassword`，`provider` 不可修改。`imap` / `smtp` 如提交，需包含完整的 `{host,port,secure}`。请求中的 `password`、`smtpPassword` 省略或为空字符串时保留原有密码；填写非空值则替换。取消独立 SMTP 凭据需同时提交 `smtpUsername:null`、`smtpPassword:null`，恢复共用 IMAP 的用户名与密码。首次启用独立 SMTP 而未提供非空 SMTP 密码时，API 采用本次更新后的 IMAP 密码；网页表单要求显式填写新独立 SMTP 的用户名和密码。

```json
{
  "name": "工作邮箱",
  "smtp": { "host": "smtp.example.com", "port": 587, "secure": false },
  "password": "新的邮箱授权码"
}
```

成功返回 `{account,cacheReset}`。账号 DTO 的 `authType` 表示实际使用 `password` 或 `oauth`，`hasSeparateSmtpCredentials` 用于表示是否设置了独立 SMTP 凭据；不会返回密码或 OAuth token。仅名称 / 颜色变更直接保存；连接配置或凭据变化会先验证 IMAP / SMTP，验证失败时保留原配置。邮箱地址或 IMAP 主机（均忽略大小写）、IMAP 登录用户名变化时，原子清理该账号的可重建本地邮件 / 目录缓存并安排重新同步，返回 `cacheReset:true`；客户端应重置旧目录、搜索和正文选择。其他修改保留缓存，账号 ID 不变，远端邮件不会删除。旧邮件 ID 不会因新邮箱返回相同 UID 而复用。

Google OAuth 邮箱只允许修改 `name` / `color`，修改地址、服务器或密码会拒绝；访问权限通过现有 Google 授权流程更新，重新授权时选择原邮箱。Gmail 使用应用专用密码连接时按密码邮箱编辑，用户名需与邮箱地址一致，服务器须为 `imap.gmail.com` / `smtp.gmail.com`。

`GET /messages` 查询参数：

| 参数 | 默认 / 可用值 | 说明 |
| --- | --- | --- |
| `accountId` | 省略 | 汇总全部账号；填写则单邮箱 |
| `folder` | `INBOX`；另有 `sent`、`trash`、`archive` 或实际文件夹路径 | 逻辑名按邮箱解析，实际路径来自文件夹接口 |
| `filter` | `all`；另有 `unread`、`starred` | 状态筛选 |
| `q` | 空 | 搜索本地缓存摘要 |
| `page` | `1` | 从 1 开始 |
| `pageSize` | `30`，最大 `100` | 每页条数 |

响应 `{ messages, total, page, pageSize }`，按日期倒序。默认同步每个可选文件夹最近 200 封摘要（每账号最多 100 个文件夹），`SYNC_MESSAGE_LIMIT` 可修改。列表 total、筛选和搜索针对缓存主题、发件人及已加载正文，不是远端全量索引；`Account.unread` 来自远端完整 INBOX 未读数，可能大于缓存中未读数。

阅读时按 MIME 结构只读取正文，纯文本最多 512 KiB、HTML 最多 2 MiB；响应 `bodyTruncated` 提示内容或元数据被截断（最多读取 16 个正文段、100 个附件元数据）。服务商未提供邮件结构时兼容读取完整 MIME，上限 30 MiB，超过返回 413。

完整 MIME 和附件二进制不持久保存，正文与附件元数据按需缓存，全实例默认最多 64 MiB、保留 7 天（`MAIL_CACHE_MAX_MIB` / `MAIL_CACHE_TTL_DAYS`）；按最近访问淘汰，保留期从最后访问起算；淘汰后会重新读取，搜索只匹配仍缓存的正文。

`GET /messages/{id}` 不自动标记已读；需要发送 `PATCH {"unread":false}`。PATCH 接受 `unread`、`starred` 的一个或两个字段，先修改远端再更新缓存。

账号 `status` 为 `connected` / `syncing` / `partial` / `error`。`partial` 表示部分目录同步失败，其他目录仍继续同步；`error` 保存经过处理的目录失败原因，`lastSyncedAt` 记录本轮完成时间。本轮失败且没有任何目录同步成功时使用 `error` 状态。客户端不应把单个目录失败显示为整个账号断开。

移动请求为 `{ "destination": "trash" }`，目标也可为 `archive` 或 `INBOX`。回收站操作是移动而非永久删除。

附件元数据包含 `contentId: string|null` 和 `inline: boolean`，可将 HTML 中的 `cid:` 图片对应到附件。`size` 为 IMAP 服务端报告的近似字节数，可能包含传输编码开销；兼容读取完整 MIME 时可为解码后的实际大小。下载附件不包装 JSON，单附件上限 30 MiB；默认返回 `Content-Disposition: attachment`、`Content-Type: application/octet-stream` 和 UTF-8 `filename*`。同一端点加 `?inline=true`（或 `1`）可获取 PNG、JPEG、GIF、WebP、AVIF、BMP 图片，返回对应图片 MIME 与 inline disposition；`false` / `0` 为默认下载，其他附件类型返回 `415 UNSUPPORTED_INLINE_TYPE`。打开邮件时，正文中的 CID 图片按需获取并使用受控 Data URL 自动展示，HTTP(S) 外部图片自动加载，无需再次点击；外部图片请求使用 `no-referrer`。附件二进制不落盘。邮件 HTML 仍须净化并在隔离来源、不授予同源权限的沙箱中展示；邮件自带的脚本与事件不得执行。当前阅读器只用随机 CSP nonce 允许内置高度测量脚本，并验证消息来源、私有 token 及高度范围，从而让 HTML 正文随外层页面滚动。

发信为 `accountId`、`to`、`subject`、`text`，可选 `cc`、`bcc`、`inReplyTo`、`references`、`attachments`。地址字段可用逗号分隔多个邮箱；附件为 `{ filename, contentType, content }`，`content` 使用纯 Base64（无 data URI 前缀），最多 20 个，解码后的总内容上限 20 MiB。正文上限 2 MiB，请求体上限 32 MiB。发送只使用指定邮箱的 SMTP 凭据。SMTP 至少接受一个收件人后返回 `{ "ok": true, "messageId": "..." }`；部分收件人被拒绝或已发送副本保存失败时额外返回 `warning`，不要因此向所有收件人重复发送。普通 IMAP 账号尽力保存远端已发送副本，Gmail 由服务商自动保存避免重复。接口当前没有发信幂等键，网络异常后重试前应确认投递结果。

回复使用 `inReplyTo` / `references`；转发复用此发信端点，重新指定收件人，不携带原线程头。当前发送正文仅支持 `text`，客户端将 HTML 原文净化为纯文本引用。转发附件先通过现有鉴权下载端点读取，再按 Base64 放入 `attachments`，不需要新增转发端点。源附件无法读取时客户端保留草稿，停止本次发送。

## 账号目录与统一目录

`GET /accounts` 的每个账号包含 `folders`，`GET /accounts/{id}/folders` 单独返回同一目录缓存。目录字段为 `{ path, name, specialUse, selectable, kind }`；`kind` 为 `inbox`、`sent`、`drafts`、`junk`、`trash`、`archive`、`important` 或 `custom`，由 IMAP Special-Use 和常见目录名称归一化。目录来自真实远端发现，包含空目录；首次同步前返回 `[]`。`selectable:false` 表示不可选择的容器，也包括 QQ 未返回 UID 信息的空虚拟父目录，其子目录仍可正常选择。目录不附估算的未读或总数；账号 `unread` 继续表示远端收件箱未读数。

读取目录只访问本地缓存，远端连接异常时仍可显示上次发现的目录。自动同步会刷新目录；需要主动刷新时调用 `POST /accounts/{id}/sync` 或 `POST /sync`，等待同步结束后重新读取。新出现和移除的目录随下一次成功发现更新。

单个账号的独立目录使用 `GET /messages?accountId=…&folder=实际path`；提供 `accountId` 时真实路径优先，以免恰好名为 `drafts` 的目录与其他草稿目录混淆。合并目录省略 `accountId`，使用 `INBOX`、`sent`、`drafts`、`junk`、`trash`、`archive` 或 `important`，服务端分别解析各账号的对应目录并汇总结果。某个账号没有对应目录时跳过该账号。自定义目录按账号真实路径单独访问，不以显示名称合并；不可选容器不会返回邮件。

## Google 授权、SSE 与推送

先在已登录浏览器请求 `GET /oauth/google/start`，取得 `{url}` 后导航至该地址。Google 回调需保留发起会话，验证 state 和 PKCE，结果跳转 `/?oauth=success` 或 `/?oauth=error&reason=...`。需要配置 Web OAuth 客户端，申请 `openid email` 与 Gmail IMAP / SMTP 的 `https://mail.google.com/` 权限，详情见 [Gmail 配置](gmail.md)。

`GET /events` 返回 `text/event-stream`，使用浏览器 EventSource Cookie 连接。事件 `ready` 为 `{}`，`mail` 为 `{accountId,count}`，`sync` 为 `{accountId,status}`，status 为 `syncing` / `connected` / `partial` / `error`；收到 `partial` 后可刷新账号获取具体目录原因。每用户最多 10 个连接，每 25 秒保活；会话过期、注销或修改密码时关闭。连接断开后重新连接并刷新列表；当前没有持久事件重放承诺。同步 API 的 `{ok:true}` 表示已调度，不能据此认定已同步完成。

`POST /push/subscriptions` 传入浏览器 PushManager 的 `{endpoint,keys:{p256dh,auth}}`；`DELETE` 传入 `{endpoint}`。每用户最多 20 个推送设备，仅接受浏览器提供的 Google / Mozilla / Apple / Windows HTTPS 推送服务地址。需要 VAPID 公私钥、用户主动授权、HTTPS 和浏览器支持。新邮件提醒由后续同步发现新邮件触发，首次同步旧邮件不提醒。Push 送达及显示依赖浏览器和系统。日志不应保存邮件秘密或推送授权信息。

## 文档维护

每次修改 API，一起更新路由实现、`shared/api-contract.md`、`docs/openapi.json` 和本文：请求字段 / 默认值、状态码、响应结构、鉴权范围与业务边界须一致。新增端点使用 `/api/v1` 命名空间；破坏兼容的变更应单独规划新版本。

提交前运行 `npm run typecheck`、`npm test`、`npm run check:api`、`npm run build` 和适用的 `npm run test:e2e`。`check:api` 校验 OpenAPI 格式及已实现 API 的路径 / 方法覆盖；不要只新增文档而漏实现接口，也不要只新增路由而漏文档。涉及远端协议的变更，应使用受控测试邮箱验证实际 IMAP / SMTP 行为。
