import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/server\/$/, '/');
export interface Config {
  port: number; host: string; appUrl: string; production: boolean; dataDir: string;
  encryptionKey: string; adminEmail: string; adminPassword: string; adminName: string;
  googleClientId: string; googleClientSecret: string; googleRedirectUri: string;
  syncIntervalSeconds: number; syncMessageLimit: number;
  mailCacheMaxBytes: number; mailCacheTtlDays: number; mailCacheRecentCount: number;
  vapidPublicKey: string; vapidPrivateKey: string; vapidSubject: string;
  trustProxy: boolean; allowPrivateMailHosts: boolean; background: boolean;
}
function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid numeric environment setting (${min}–${max}).`);
  return number;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appUrl = new URL(env.APP_URL || 'http://localhost:5173');
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash) throw new Error('APP_URL must be a plain HTTP(S) origin.');
  const production = env.NODE_ENV === 'production';
  if (production && appUrl.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(appUrl.hostname)) throw new Error('Production APP_URL must use HTTPS.');
  if (!/^[a-f\d]{64}$/i.test(env.ENCRYPTION_KEY || '')) throw new Error('ENCRYPTION_KEY must be 64 hexadecimal characters. Run npm run init.');
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters). Run npm run init.');
  const googleRedirectUri = env.GOOGLE_REDIRECT_URI || `${appUrl.origin}/api/v1/oauth/google/callback`;
  if (new URL(googleRedirectUri).origin !== appUrl.origin) throw new Error('GOOGLE_REDIRECT_URI must share APP_URL origin.');
  if (Boolean(env.VAPID_PUBLIC_KEY) !== Boolean(env.VAPID_PRIVATE_KEY)) throw new Error('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither.');
  return {
    port: integer(env.PORT, 3001, 1, 65535), host: env.HOST || '127.0.0.1', appUrl: appUrl.origin, production,
    dataDir: resolve(repoRoot, env.DATA_DIR || './data'), encryptionKey: env.ENCRYPTION_KEY!,
    adminEmail: env.ADMIN_EMAIL.trim().toLowerCase(), adminPassword: env.ADMIN_PASSWORD, adminName: env.ADMIN_NAME || '管理员',
    googleClientId: env.GOOGLE_CLIENT_ID || '', googleClientSecret: env.GOOGLE_CLIENT_SECRET || '', googleRedirectUri,
    syncIntervalSeconds: integer(env.SYNC_INTERVAL_SECONDS, 60, 30, 86400), syncMessageLimit: integer(env.SYNC_MESSAGE_LIMIT, 200, 20, 1000),
    mailCacheMaxBytes: integer(env.MAIL_CACHE_MAX_MIB, 256, 4, 1024) * 1024 * 1024, mailCacheTtlDays: integer(env.MAIL_CACHE_TTL_DAYS, 7, 1, 365), mailCacheRecentCount: integer(env.MAIL_CACHE_RECENT_COUNT, 100, 0, 1000),
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '', vapidPrivateKey: env.VAPID_PRIVATE_KEY || '', vapidSubject: env.VAPID_SUBJECT || `mailto:${env.ADMIN_EMAIL}`,
    trustProxy: env.TRUST_PROXY === 'true', allowPrivateMailHosts: env.ALLOW_PRIVATE_MAIL_HOSTS === 'true', background: true,
  };
}
export function frontendBuilt() { return existsSync(resolve(repoRoot, 'web/dist/index.html')); }
