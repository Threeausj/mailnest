# MailNest v1 implementation contract

All endpoints under `/api/v1`. JSON success objects below; errors `{ error: { code: string, message: string } }` and meaningful HTTP status. Browser uses HttpOnly session cookie (credentials same-origin). Public routes only health and login. All others authenticated, including config and docs. First administrator bootstrapped using ADMIN_EMAIL/ADMIN_PASSWORD env. No public registration. Separate API tokens optionally support `Authorization: Bearer ...` for third-party clients.

## DTOs

User = { id: string, email: string, name: string }
Account = { id: string, name: string, email: string, color: string, provider: 'gmail' | 'imap', username: string, smtpUsername?: string, imap: {host:string,port:number,secure:boolean}, smtp:{host:string,port:number,secure:boolean}, status: 'connected'|'error'|'syncing'|'partial', lastSyncedAt: string|null, error: string|null, unread: number, folders: Folder[], authType:'oauth'|'password', hasSeparateSmtpCredentials:boolean }
Folder = { path:string, name:string, specialUse:string|null, selectable:boolean, kind:'inbox'|'sent'|'drafts'|'junk'|'trash'|'archive'|'important'|'custom' }
Address = { name: string, address: string }
MessageSummary = { id:string, accountId:string, folder:string, from:Address, to:Address[], cc:Address[], subject:string, preview:string, date:string, unread:boolean, starred:boolean, hasAttachments:boolean }
Message = MessageSummary & { text:string, html:string|null, messageId:string|null, bodyTruncated:boolean, attachments: {id:string, filename:string, contentType:string,size:number,contentId:string|null,inline:boolean}[] }

## Endpoints

- GET /health -> {status:'ok'} (public)
- POST /auth/login {email,password} -> {user:User}; session cookie
- GET /auth/me -> {user:User}
- POST /auth/logout -> {ok:true}; revoke cookie session
- POST /auth/password {currentPassword,newPassword} -> {ok:true}; password minimum 12 characters; revokes all sessions and API tokens, requires login again
- GET /config -> { googleConfigured:boolean, pushPublicKey:string|null, pollingInterval:number }
- GET /accounts -> {accounts:Account[]}; each account includes its cached actual folders (including empty folders and non-selectable containers); folders:[] before discovery; no remote IMAP request
- POST /accounts {name,email,color?,provider:'gmail'|'imap',username,password,imap:{host,port,secure},smtp:{host,port,secure},smtpUsername?,smtpPassword?} -> {account:Account} (201); color defaults to #6d5ce8; verify IMAP/SMTP before saving; passwords never returned; max20 accounts/user
- PATCH /accounts/:id {name?,color?,email?,username?,password?,imap?:{host,port,secure},smtp?:{host,port,secure},smtpUsername?:string|null,smtpPassword?:string|null} -> {account:Account,cacheReset:boolean}; at least one field, provider immutable; omitted/empty password keeps existing secret; omitted/empty smtpPassword keeps existing independent SMTP secret (when newly enabling separate SMTP without a secret, use the resulting IMAP password); smtpUsername:null and smtpPassword:null together restore shared IMAP credentials; OAuth accounts accept name/color only, reauthorize with Google flow. Metadata-only changes require no remote connection; changed connection/credentials verify IMAP and SMTP before atomic save, failure retains existing configuration. Identity changes (email or IMAP host ignoring case, or IMAP username) clear only this account's local mail/folder cache and schedule fresh synchronization, cacheReset:true; other changes preserve cache, account id unchanged, never delete remote mail. Internal cache generation prevents stale message ids from targeting another mailbox after identity changes.
- DELETE /accounts/:id -> {ok:true}; disconnect locally, not remove remote email
- GET /accounts/:id/folders -> {folders:Folder[]}; owner-scoped cached catalog, no remote connection; sync refreshes it; selectable:false identifies containers and QQ empty virtual parents without UID metadata; no estimated per-folder counts
- POST /accounts/:id/sync -> {ok:true}; schedule synchronization
- POST /sync {accountId?:string} -> {ok:true}; schedule one/all accounts
- GET /messages?accountId=&folder=INBOX|sent|drafts|junk|trash|archive|important|actualFolderPath&filter=all|unread|starred&q=&page=1&pageSize=30 -> {messages:MessageSummary[],total:number,page:number,pageSize:number}; logical folders resolved per mailbox by Special-Use / common names, all accounts if accountId omitted; with accountId an exact actual folder path takes priority over a logical alias; non-selectable containers return no messages; max100 selectablefolders/account, latest SYNC_MESSAGE_LIMIT summaries per folder; cached searches match subject/from and previously loaded body, not full remote history; account unread uses remote INBOX unseen count
- GET /messages/:id -> {message:Message}; lazy BODYSTRUCTURE-based body loading, max512KiB text / 2MiB HTML and bodyTruncated signals clipped body/metadata (max16 body parts / 100 attachment metadata entries); missing structure falls back to full MIME max30MiB; no persistent raw MIME or attachment binaries, does NOT auto mark read; UI PATCH on opening
- PATCH /messages/:id {unread?:boolean,starred?:boolean} -> {message:MessageSummary}; update remote IMAP then cached state
- POST /messages/:id/move {destination:'trash'|'archive'|'INBOX'} -> {ok:true}; move remote IMAP, update cache
- GET /messages/:id/attachments/:attachmentId -> on-demand binary attachment max30MiB, default application/octet-stream with attachment disposition; ?inline=true|1 returns image/png,jpeg,gif,webp,avif,bmp with matching MIME/inline disposition; false|0 means download, unsupported inline MIME returns 415 UNSUPPORTED_INLINE_TYPE; contentId maps cid: body images
- POST /messages/send {accountId:string,to:string,cc?:string,bcc?:string,subject:string,text:string,inReplyTo?:string,references?:string,attachments?:{filename:string,contentType:string,content:string}[]} -> {ok:true,messageId:string,warning?:string}; max20 attachments, content base64, total decoded attachments <=20 MiB; uses account SMTP, saves sent copy best-effort (Gmail saves automatically) and reports warning for partial SMTP recipient rejection or sent-copy failure; do not repeat delivery on warning
- GET /oauth/google/start -> {url:string}; authenticated, state bound to session/user, PKCE
- GET /oauth/google/callback?code=&state= -> redirect /?oauth=success or /?oauth=error&reason=...; callback session mandatory
- GET /events -> SSE; events named 'mail' with {accountId,count,unreadCount}, 'sync' with {accountId,status:'syncing'|'connected'|'partial'|'error',unreadCount}, 'ready' with {unreadCount}; user-scoped, cookie auth; partial means some folders failed while other folders continue syncing, refresh account.error for sanitized reasons. unreadCount is this user's SUM(accounts.unread), the latest remote INBOX unseen counts, not cached message rows or duplicate label counts; zero with no unread/accounts.
- POST /push/subscriptions {endpoint:string,keys:{p256dh:string,auth:string}} -> {ok:true}
- DELETE /push/subscriptions {endpoint:string} -> {ok:true}
- POST /push/test {endpoint:string} -> {ok:true,accepted:true}; explicitly send one test to the current user's selected registered device, never broadcast. Accepted means Web Push provider accepted the request, not a delivery/display guarantee. Per-user cooldown of 15 seconds across devices, including failed sends; 429 PUSH_TEST_RATE_LIMIT includes Retry-After seconds. Missing and foreign endpoints both 404 PUSH_SUBSCRIPTION_NOT_FOUND; provider 404/410 removes only that subscription and returns 410 PUSH_SUBSCRIPTION_EXPIRED; other provider/network failures return 503 PUSH_DELIVERY_FAILED with safe generic text and retain subscription for retry; missing VAPID is 503 PUSH_NOT_CONFIGURED. Session writes require the same Origin guard; API tokens remain owner-scoped. No DNS/IP precheck, normal browser-provider HTTPS allowlist/TLS validation applies.

Push subscription endpoints retain the browser-provider HTTPS allowlist and key format validation. Registration performs no DNS/IP address filtering; network routing and resolution are delegated to the runtime/TUN, with normal HTTPS certificate verification. Re-registering the current user's endpoint updates its keys, including at the 20-device limit; another user's endpoint cannot be overwritten. The settings UI re-registers an existing browser subscription and reports it active only after the server acknowledges it.

Normal and test Push notification JSON payloads are {title:string,body:string,url:string,tag:string,unreadCount:number}; unreadCount uses the same owner-scoped INBOX total as SSE. Test notifications do not insert mail or change unread counts. Badge support is optional and zero clears the badge; endpoint/key/raw provider error details are never returned from the test API.

- GET /tokens -> {tokens:{id:string,name:string,createdAt:string,lastUsedAt:string|null}[]}
- POST /tokens {name:string} -> {token:string,id:string}; plaintext only once
- DELETE /tokens/:id -> {ok:true}
- GET /openapi.json -> OpenAPI 3.0.3
- GET /docs -> interactive API docs, authenticated

## Environment

PORT=3001 HOST=127.0.0.1 APP_URL=http://localhost:5173 NODE_ENV=development DATA_DIR=./data ENCRYPTION_KEY=64hex ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=random>=12 ADMIN_NAME=管理员 GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET= GOOGLE_REDIRECT_URI=http://localhost:5173/api/v1/oauth/google/callback SYNC_INTERVAL_SECONDS=60 SYNC_MESSAGE_LIMIT=200 MAIL_CACHE_MAX_MIB=64 MAIL_CACHE_TTL_DAYS=7 VAPID_PUBLIC_KEY= VAPID_PRIVATE_KEY= VAPID_SUBJECT=mailto:admin@example.com TRUST_PROXY=false ALLOW_PRIVATE_MAIL_HOSTS=false

Dev Vite :5173 proxies /api -> :3001; production server serves `web/dist` on :3001. Server loads repo-root .env and validates secrets at startup. SQLite WAL in DATA_DIR. Persist only summaries and bounded body/attachment-metadata caches: MAIL_CACHE_MAX_MIB defaults to 64 (4–1024 MiB, instance-wide), MAIL_CACHE_TTL_DAYS to 7 (1–365 days); TTL runs from last access; expired/least-recently-accessed cached details are evicted and refetched on demand. No persistent raw MIME or attachment binaries; summary/config/index storage is separate from that byte limit. Upgrades clear legacy raw MIME, attachment binary, and incompatible body caches without deleting remote mail. AES-256-GCM encrypted stored mail credentials. Frontend sanitizes mail HTML in a sandbox iframe without scripts or same-origin permissions. Opening a message automatically loads CID body images on demand through controlled Data URLs and HTTP(S) external images, with no additional user action; external image requests use no-referrer. Browser checks verify actual image decoding. No caching authenticated API responses in SW. PWA SW supports push. No demo data automatically mixed with real inbox.

Private/loopback/link-local IMAP/SMTP hosts rejected by default to prevent SSRF from web-exposed connection forms; explicit ALLOW_PRIVATE_MAIL_HOSTS permits internal mail servers for self-hosted trusted deployments. TLS required: secure true implicit TLS, false STARTTLS required, certificate verification never disabled. APIs return ownership-scoped data for session or token user. Tokens cannot mint tokens or change password or start Google OAuth; those are session-only. Authentication/Google responses and all API responses use Cache-Control:no-store. Never expose stack traces, passwords/tokens, raw protocol auth logs.
