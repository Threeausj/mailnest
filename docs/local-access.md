# 当前 NAS 访问与管理

浏览器统一访问 <https://mail.leixin.me>。前后端由部署于 `/volume2/docker/mailnest` 的同一个 Docker 容器提供，现有反向代理负责 HTTPS，再转发至 NAS 的 HTTP 5173 端口。`http://192.168.91.85:5173` 和宿主机上的 `http://127.0.0.1:5173` 仅用于代理后端或健康检查；不要从这些地址登录，也不要在另一台电脑使用 `localhost:5173`，那会指向该电脑自身。

Docker Compose 使用 `compose.yml` 与本机 `compose.override.yml`，后者来自仓库的 `deploy/compose.nas.yml`。容器使用宿主网络、NAS 的 DNS / 邮件代理和部署目录的 `data/` 绑定目录；现有 HTTPS 代理继续使用，不叠加独立 Caddy 模板。容器自动重启，`.env` 与持久化 `data/` 位于部署目录；登录密码、邮箱配置和加密密钥从旧服务保留，浏览器应在 HTTPS 域名重新登录。原 `mailnest-lan.service` 已停用，工作区仍保留用于开发和回退。

```sh
cd /volume2/docker/mailnest
docker compose ps
docker compose restart mailnest
docker compose logs --tail=50 mailnest
curl --fail http://127.0.0.1:5173/api/v1/health
curl --fail https://mail.leixin.me/api/v1/health
```

更新部署目录的源码后执行 `docker compose up -d --build`。`restart` 只适合重启现有配置；修改 `.env` 或 Compose 环境变量后要重新创建容器，见下节。运行期间不要另启旧 systemd 服务或默认的 `npm run dev`，以免 5173 端口冲突或重复同步。数据备份、源码更新、代理配置与回退步骤见 [部署文档](deployment.md)。

## 登录来源与域名配置

部署目录 `.env` 的非秘密配置应为：

```dotenv
NODE_ENV=production
APP_URL=https://mail.leixin.me
GOOGLE_REDIRECT_URI=https://mail.leixin.me/api/v1/oauth/google/callback
TRUST_PROXY=true
DATA_DIR=/app/data
```

保留原来的登录凭据、`ENCRYPTION_KEY`、Google 凭据、VAPID 密钥和邮件代理配置。NAS 覆盖文件应读取 `.env` 中的 `NODE_ENV`，不能再固定为 `development`。现有代理将 HTTPS 域名转发至 HTTP 后端，并保留 `Host: mail.leixin.me`、设置 `X-Forwarded-Proto: https`；`TRUST_PROXY=true` 用于这个可信代理。

从 HTTPS 域名登录时如果出现 `INVALID_ORIGIN`，表示浏览器请求的来源与后端实际加载的 `APP_URL` 不一致。例如浏览器使用 `https://mail.leixin.me`，容器仍加载旧 HTTP IP 地址。协议、主机和端口都必须匹配；不要通过关闭来源检查解决。

修改 `.env` 并确认 `compose.override.yml` 不覆盖上述值后执行：

```sh
cd /volume2/docker/mailnest
docker compose up -d --force-recreate mailnest
docker compose ps
curl --fail https://mail.leixin.me/api/v1/health
```

`docker compose restart mailnest` 不会重新读取新的容器环境变量。重建后刷新 HTTPS 页面并重新登录，旧 HTTP 地址的 Cookie 不用于该域名。若通过完整的 `docker compose config` 排查合并配置，其输出可能包含 `.env` 中的秘密，不要复制到日志、工单或仓库。

Google Cloud Web 应用客户端的“已获授权的重定向 URI”须精确登记 `https://mail.leixin.me/api/v1/oauth/google/callback`，并与后端配置一致；添加“已获授权的 JavaScript 来源”时使用 `https://mail.leixin.me`。完整步骤见 [Gmail 配置](gmail.md)。

## PWA 安装与提醒

邮件页面顶部始终提供“安装应用”按钮，“设置 → 应用与提醒”中也有入口。支持安装且浏览器已提供安装事件时，点击会显示原生安装窗口；尚未提供事件或浏览器不支持时，点击显示设备对应的手动操作说明。应用通过独立窗口打开或收到安装完成事件后，按钮会显示“已安装”。

从 <https://mail.leixin.me> 打开页面后安装应用，并在“设置 → 应用与提醒”授权通知。旧 HTTP IP 地址的快捷方式应重新以 HTTPS 域名安装；不同来源的安装状态、登录 Cookie 和推送订阅不共用。后台推送还需要原有 VAPID 配置与设备通知权限。`localhost` 的开发例外只适用于浏览器所在设备本机，NAS 的局域网 IP 不属于该例外。[MDN 安装要求](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)

可用宽度达到 1024 CSS 像素时，电脑和平板都显示邮箱导航、邮件列表、正文三栏；两条分隔线支持鼠标、触摸和键盘调整，刷新保留宽度。触屏分隔线提供 16 像素拖动区域，正文最小宽度为 320 像素；较窄竖屏自动切换布局。

返回手势优先关闭当前弹层或从邮件返回列表。写信时沿用草稿丢弃确认，取消会保留原草稿。独立 PWA 在根页首次返回会提示“再次返回退出应用”，短时间内再次返回才退出；普通浏览器标签页保留返回之前网页的行为。

界面采用简约液态玻璃风格：侧栏与浮层为冷白半透明玻璃，列表、阅读区与默认正文底色为纯白。保留紧凑布局和蓝色状态提示；浏览器不支持模糊或启用减少透明度时自动降级为不透明背景。

桌面宽屏使用邮箱导航、邮件列表和阅读区三栏，未选中邮件时阅读区显示提示。两条分隔线可以拖动，宽度保存在当前浏览器；双击恢复该栏默认宽度，聚焦后也可用左右方向键调整。邮件列表独立滚动并保留位置，阅读区占用剩余宽度，窗口变窄时自动适配。平板窄屏与手机按设备宽度切换列表或正文，星标按钮独立可点击，统一邮箱与单账号筛选方式相同。顶部将文件夹信息与回复 / 转发 / 删除 / 标记放在同一栏，标记菜单包含已读 / 未读及星标，更多菜单提供归档。发件人、主题、收件人压缩为三行；较窄阅读区的安装和提醒入口位于更多菜单，手机保留安装按钮。展开收件人可查看完整地址、抄送、主题与日期。顶部的“收件箱 — 所有邮箱 / 邮件数量”与工具按钮固定，邮件信息和正文在下方滚动；打开新邮件从顶部开始，返回列表恢复位置。正文默认底色跟随系统阅读区，邮件内部原有卡片与品牌背景保留。HTML 保留原邮件排版，图片自动加载，按实际高度展示；宽表格局部横向滚动，不撑宽应用界面。

## 邮件连接使用代理 Fake-IP

当前 NAS 的 mihomo DNS 将 QQ 邮件服务器解析到 `198.18.0.0/15` 的 Fake-IP 地址。部署使用宿主网络和 NAS 的本机 DNS，`.env` 保留 `ALLOW_PRIVATE_MAIL_HOSTS=true`，允许 IMAP / SMTP 使用这些地址，由现有透明代理处理连接。该设置在重建容器后加载，也会允许其他私有 / 保留邮件服务器地址；TLS 证书、域名验证和登录鉴权继续生效，不会自动新增代理服务或规则。是否直连或走代理取决于 NAS 的代理配置。

当前 NAS 的 TUN 常开。Web Push 保留浏览器推送服务的 HTTPS 与订阅格式校验，注册时不检查 DNS / IP 是否属于私有或保留网段，由 TUN 处理实际网络连接；推送无需额外打开 `ALLOW_PRIVATE_MAIL_HOSTS`，该开关用于邮件连接。

登录、回到前台、网络恢复和 Service Worker 切换时，应用会自动补登记已有且与当前 VAPID 公钥匹配的订阅；进入“设置 → 应用与提醒”也会检查登记状态，服务端确认后才显示开启。公钥变更时须在设置中重新开启，不会自动申请通知许可或创建新订阅。此前因地址拦截而失败的设备可刷新后重试。

转发会使用原邮件的邮箱，收件人需重新填写，正文以可编辑纯文本引用发送；原附件默认保留，可在发送前移除。附件只在点击发送时载入，失败保留草稿，合计上限为 20 个 / 20 MiB。

侧栏为“所有邮箱”和每个账号分别提供独立文件夹分组，可单独折叠。打开或刷新页面时，“所有邮箱”默认展开，各账号默认折叠；移除顶部品牌区，直接显示写邮件按钮，手机关闭导航按钮与其并排。合并目录按用途汇总，账号目录使用远端真实路径；自定义文件夹留在所属账号下，目录列表读取本地同步缓存。切换目录 / 账号会清空搜索并回到第一页。侧栏底部仅保留设置，不再显示管理员卡片；系统按个人使用设计，登录密码、API 令牌及退出登录仍在设置中管理。

已连接邮箱可在“设置 → 邮箱管理”点击编辑图标修改，密码 / 授权码留空保留原值；保存连接配置前会验证，失败保留原配置。Google 授权邮箱支持修改名称、颜色与重新授权。更改邮箱地址、IMAP 主机或登录用户名会重新同步本地缓存；其他修改保留缓存。

## 通知测试与未读角标

进入“设置 → 应用与提醒”，开启本设备后台提醒后点击“发送测试通知”。该按钮投递到当前已登记设备，不向其他设备广播；“已接受”表示推送服务接受请求，是否显示还需查看系统通知权限与实际接收结果。每 15 秒最多一次；订阅过期时重新开启即可。测试通知不会伪造未读数。测试及正常提醒都带通知 UUID，走同一展示与去重流程；投递使用高优先级、1 小时有效期、aes128gcm，加密密钥保持原配置。

正常新邮件提醒按默认 60 秒轮询触发，可在登录后的 `/api/v1/config` 查看 `pollingInterval`，并非即时协议。INBOX 自己首次成功同步或 UIDVALIDITY 重置时安静建立基线；后续新到邮件即使先被其他客户端读过也会提醒。前台 SSE 与后台 Push 共用批次 `notificationId` 去重；同账号稳定 tag 配合 `renotify` 提醒下一批。去重记录仅为 UUID 与时间，IndexedDB 保留 7 天、最多 128 条，不含邮件正文或凭据。历史读取及写入各限 500 毫秒，失败或永久等待时自动降级内存，后续通知继续展示；应用启动及回到前台会检查 Worker 更新，保留当前页面与草稿。

用户已确认测试通知能收到，自动新邮件的真机送达仍待验收。可在上述容器日志中查找 `New-mail push accepted` / `New-mail push retry scheduled` / `New-mail push stopped`；日志不含 endpoint、订阅密钥或正文。服务商接受并不保证设备已经收到。

较窄阅读区的铃铛收进菜单时，“更多”按钮及提醒菜单继续显示数字红点。应用内数字红点与页面标题使用所有账号远端收件箱的总未读数，同步事件、前台轮询与后台推送会更新它。支持 Badging API 的系统可显示安装后应用图标的数字角标；全部已读或退出登录时清除。Android 的桌面红点 / 数字依赖系统通知与启动器，应用内数字仍正常显示。[Chrome 平台说明](https://developer.chrome.com/docs/capabilities/web-apis/badging-api)


### 锁屏与后台可靠性

NAS 持续按 60 秒周期同步，关闭 PWA 不会停止。正常新邮件提醒和 INBOX 缓存同事务写入持久队列，重启后恢复；网络故障、408 / 425 / 429 / 5xx 在 1 小时有效期内最多尝试 8 次，按退避 / Retry-After 重试。已被服务商接受的提醒不会为保活反复发送；重试用剩余 TTL 和当前未读数。容器保持 `restart:unless-stopped`；用户主动停止容器后应重新启动。

“设置 → 应用与提醒 → 锁屏提醒设置”提供设备指引。Android 允许邮屿及所用浏览器锁屏通知、后台运行和后台联网，延迟时检查电池限制；不要强行停止浏览器。iPhone / iPad 16.4+ 添加主屏幕后打开并开启提醒，在系统通知中允许锁屏显示，检查专注模式。[Android 官方说明](https://web.dev/articles/push-notifications-faq)、[Apple 官方说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

“设置 → 邮箱管理”上下移动账号并保存，顺序保存在服务器，导航和发件邮箱选择同步，新账号追加末尾。写信 / 回复 / 转发的“发件人名称”默认所选邮箱名称，可自行修改本次显示名，发件地址仍是所选邮箱。
