import { defineConfig, devices } from '@playwright/test';

const port = process.env.E2E_PORT || '5173';
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'tablet', use: { ...devices['iPad Mini'], defaultBrowserType: 'chromium' } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run build && npm start',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      APP_URL: baseURL,
      HOST: '127.0.0.1',
      PORT: port,
      DATA_DIR: './data/e2e',
      ADMIN_EMAIL: 'e2e@mailnest.test',
      ADMIN_PASSWORD: 'Mailnest-E2E-only-password!2026',
      ADMIN_NAME: '测试管理员',
      ENCRYPTION_KEY: 'a'.repeat(64),
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_REDIRECT_URI: `${baseURL}/api/v1/oauth/google/callback`,
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      SYNC_INTERVAL_SECONDS: '3600',
    },
  },
});
