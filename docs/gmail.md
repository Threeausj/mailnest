# Gmail 接入

本项目通过 Gmail 的 IMAP / SMTP 收发邮件，支持 Google OAuth 2.0 和应用专用密码。建议使用 OAuth；普通 Google 账户登录密码不能直接替代邮件客户端的授权凭据。

## Google OAuth 2.0

需要在自己的 Google Cloud 项目中创建 **OAuth 客户端 ID 和客户端密钥**，再配置到 MailNest 后端。Google 授权后的 Access Token / Refresh Token 由程序自动获取，无需手动复制。

### 先确定浏览器访问地址

Google 的 Web 客户端回调要求使用 HTTPS 域名；`localhost` / 回环 IP 可使用 HTTP。**`http://192.168.91.85:5173/api/v1/oauth/google/callback` 这种局域网原始 IP 地址不能作为 Google 回调**，即使改成 HTTPS 原始 IP 也不符合要求。建议公网部署使用自己的 HTTPS 域名，本地开发使用 localhost。[Google 回调地址验证规则](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)

| 使用场景 | `APP_URL` | 已获授权的重定向 URI / `GOOGLE_REDIRECT_URI` |
| --- | --- | --- |
| 同一台电脑开发 | `http://localhost:5173` | `http://localhost:5173/api/v1/oauth/google/callback` |
| 同一台电脑运行构建 / Docker 默认端口 | `http://localhost:3001` | `http://localhost:3001/api/v1/oauth/google/callback` |
| HTTPS 域名部署 | `https://mail.example.com` | `https://mail.example.com/api/v1/oauth/google/callback` |

表中的域名仅为示例，需替换为自己的实际域名，并先配置 HTTPS 及反向代理。浏览器应使用 `APP_URL` 打开网站并登录；localhost 指向浏览器所在设备，在手机或其他电脑中打开 localhost 不能访问 NAS 上的服务。回调的协议、域名、端口、路径、大小写和结尾斜杠必须与 Google 控制台完全一致；MailNest 还要求回调与 `APP_URL` 同源。[Google 服务端 OAuth 配置](https://developers.google.com/identity/protocols/oauth2/web-server)

### 在 Google Cloud 获取客户端凭据

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，在顶部项目选择器中创建或选择一个项目，例如 `MailNest`。
2. 进入 **Google Auth Platform → Branding（品牌信息）**。首次配置点击 **Get started（开始）**，填写应用名称 `MailNest`、支持邮箱和联系邮箱。个人 Gmail 接入选择 **External（外部）**；Internal（内部）适用于符合条件的 Google Workspace 组织内部应用。
3. 进入 **Audience（受众）**，开发阶段保持 **Testing（测试）**，在 **Test users（测试用户）→ Add users** 中添加准备接入的 Gmail 地址。多个邮箱都要分别添加；项目创建者的邮箱也不要遗漏。[Google 同意屏幕与测试用户设置](https://developers.google.com/workspace/guides/configure-oauth-consent)
4. 进入 **Data Access（数据访问）→ Add or Remove Scopes（添加或移除范围）**，选择或手动添加以下范围并保存：

   | 范围 | 用途 |
   | --- | --- |
   | `openid` | 验证 Google 身份 |
   | `email`（控制台通常显示为 `https://www.googleapis.com/auth/userinfo.email`） | 识别已授权邮箱 |
   | `https://mail.google.com/` | Gmail 的 IMAP / SMTP 收发及邮件管理 |

   MailNest 当前请求 `openid email https://mail.google.com/`；IMAP / SMTP 使用完整邮件权限，不能仅用 `gmail.readonly` 或 `gmail.send` 替代。[Gmail XOAUTH2 范围说明](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)
5. 进入 **Clients（客户端）→ Create Client（创建客户端）**，应用类型选择 **Web application（Web 应用）**，名称可填 `MailNest Web`。
6. 在 **Authorized redirect URIs（已获授权的重定向 URI）** 中添加上表中实际使用的完整回调地址。本项目由服务端处理授权，**Authorized JavaScript origins（已获授权的 JavaScript 来源）** 可留空；若填写，也应只填网站来源，不包含 `/api/...` 路径。[Google Web 客户端创建步骤](https://developers.google.com/workspace/guides/create-credentials)
7. 创建后保存 **Client ID（客户端 ID）** 和 **Client secret（客户端密钥）**，或立即下载客户端 JSON。密钥仅在创建时完整显示 / 下载一次；请保存在服务器私有配置中，不放到前端、公开仓库或聊天消息中。[Google 客户端密钥显示规则](https://support.google.com/cloud/answer/15549257)

### 配置 MailNest

编辑项目根目录 `.env`，示例为 HTTPS 域名部署：

```dotenv
GOOGLE_CLIENT_ID=你的客户端ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=你的客户端密钥
APP_URL=https://mail.example.com
GOOGLE_REDIRECT_URI=https://mail.example.com/api/v1/oauth/google/callback
```

**当前 NAS 的局域网服务有额外配置：** `/etc/systemd/system/mailnest-lan.service` 用 `Environment=` 固定设置了 `APP_URL=http://192.168.91.85:5173` 和对应 `GOOGLE_REDIRECT_URI`，其优先级高于 `.env`。因此 `.env` 中的 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 可以正常加载，但仅修改 `.env` 的网站地址和回调地址不会改变当前服务。切换 HTTPS 域名或 localhost 时，必须同步调整 systemd 的这两个环境变量，再执行 `systemctl daemon-reload` 和 `systemctl restart mailnest-lan`；HTTPS 域名还需要代理与证书。修改服务端地址后，浏览器也需使用新地址登录。此说明不会自动更改运行中的局域网服务。

后端使用新配置启动后，在 MailNest 设置中点击连接 Gmail，选择测试用户列表中的账号并授予完整邮件权限。连接多个 Gmail 时，可重复授权，无需为每个邮箱新建客户端 ID。

授权在已登录会话中发起，使用绑定用户 / 会话的短期 state 与 PKCE。回调必须保留同一浏览器的会话，连接成功后跳回首页。Google 邮箱授权与 MailNest 登录分开；取得 Google 授权不会建立 MailNest 登录会话。Refresh Token 加密保存在本地，后台自动更新 Access Token。

### 常见问题

- **“管理员尚未配置 Google OAuth”**：确认 `.env` 中 ID / Secret 已填写，并重启实际运行的后端。
- **`redirect_uri_mismatch`**：核对 Google 控制台和后端实际使用的完整回调，尤其检查当前 systemd 的地址覆盖设置。
- **`access_denied` / 未列入测试用户**：在 Audience 中添加正在授权的 Gmail；Workspace 账号还可能受管理员策略限制。
- **约 7 天后需要重新授权**：外部应用处于 Testing 且申请邮件权限时，Refresh Token 的有效期为 7 天。MailNest 自动刷新 Access Token 不能延长这一期限。[Google Refresh Token 有效期](https://developers.google.com/identity/protocols/oauth2#expiration)

`https://mail.google.com/` 属于受限权限。后续向公众开放时，应按 Google 当前政策准备审核及适用的安全评估；Testing 用于开发接入，切换发布状态也不等于已通过审核。Google 推荐仅需要细粒度权限的应用使用 Gmail API；本项目通过 IMAP / SMTP 兼容不同邮箱服务商。[Google 范围分类](https://developers.google.com/workspace/guides/configure-oauth-consent#scope_categories)、[Gmail XOAUTH2 官方文档](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)

## 应用专用密码

若目前只使用局域网、尚未准备 HTTPS 域名，可暂用应用专用密码接入自己的 Gmail：先在 Google 账号开启两步验证，再到 [创建应用专用密码](https://myaccount.google.com/apppasswords) 生成一组 16 位密码。将其填入 MailNest 的邮箱密码字段，选择密码方式接入，无需 OAuth 回调。组织策略、仅安全密钥验证和高级保护可能使该选项不可用。Google 优先推荐 OAuth；普通 Google 登录密码不能代替应用专用密码。[Google 应用密码说明](https://support.google.com/accounts/answer/185833)

| 配置 | 值 |
| --- | --- |
| 邮箱地址 / IMAP 用户名 | 完整 Gmail 地址 |
| IMAP 主机 / 端口 | `imap.gmail.com` / `993` |
| IMAP 直接 TLS | 开启 |
| SMTP 主机 / 端口 | `smtp.gmail.com` / `465` |
| SMTP 直接 TLS | 开启 |
| 密码 | 应用专用密码 |

SMTP 也可使用 `587`，此时直接 TLS 关闭，连接必须通过 STARTTLS 升级；`secure=false` 表示 STARTTLS 模式，并不表示允许明文发信。本项目强制要求升级且验证证书。[Nodemailer SMTP 文档](https://nodemailer.com/smtp)、[OAuth2 文档](https://nodemailer.com/smtp/oauth2)

应用密码被撤销后需要删除 / 重新接入相应账号。Google 普通密码变更也会撤销既有应用密码；Google Workspace 管理员可限制第三方邮件客户端访问。连接错误时首先检查服务商账户安全页面与管理员策略。
