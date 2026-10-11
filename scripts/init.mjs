#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const envFile = new URL('.env', root);

try {
  await access(envFile);
  console.log('已有 .env，未作修改。请使用现有管理员账号登录。');
  process.exit(0);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const require = createRequire(new URL('../server/package.json', import.meta.url));
let webPush;
try {
  webPush = require('web-push');
} catch {
  console.error('请先在项目根目录执行 npm install，再运行 npm run init。');
  process.exit(1);
}

const adminEmail = 'admin@example.com';
const password = randomBytes(24).toString('base64url');
const encryptionKey = randomBytes(32).toString('hex');
const vapid = webPush.generateVAPIDKeys();
const content = `# MailNest 本地开发配置；公网部署前请阅读 docs/deployment.md
NODE_ENV=development
HOST=127.0.0.1
PORT=3001
APP_URL=http://localhost:5173
DATA_DIR=./data
ADMIN_EMAIL=${adminEmail}
ADMIN_PASSWORD=${password}
ADMIN_NAME=管理员
ENCRYPTION_KEY=${encryptionKey}
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:5173/api/v1/oauth/google/callback
SYNC_INTERVAL_SECONDS=60
SYNC_MESSAGE_LIMIT=200
VAPID_PUBLIC_KEY=${vapid.publicKey}
VAPID_PRIVATE_KEY=${vapid.privateKey}
VAPID_SUBJECT=mailto:${adminEmail}
TRUST_PROXY=false
ALLOW_PRIVATE_MAIL_HOSTS=false
# 公网 Docker + Caddy 部署时填写，不带协议
DOMAIN=
`;

try {
  await writeFile(envFile, content, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('其他进程已创建 .env，未作修改。');
  process.exit(0);
}

console.log(`已创建 ${fileURLToPath(envFile)}（权限 0600）。`);
console.log(`管理员邮箱：${adminEmail}`);
console.log(`初始密码：${password}`);
console.log('请保存密码；该初始化脚本只在首次创建时显示。首次登录后可在设置中修改密码。');
console.log('请独立安全备份 .env 与数据目录；恢复必须保留 ENCRYPTION_KEY，推送订阅还需要原 VAPID 密钥。');
console.log('开发：npm run dev；生产本机：修改 APP_URL、GOOGLE_REDIRECT_URI 为 http://localhost:3001 后 npm run build && npm start。');
