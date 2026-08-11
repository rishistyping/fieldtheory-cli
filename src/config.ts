import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { dataDir } from './paths.js';
import { getBrowser, browserUserDataDir, listBrowserIds } from './browsers.js';
import type { BrowserDef } from './browsers.js';

export interface ChromeSessionConfig {
  chromeUserDataDir: string;
  chromeProfileDirectory: string;
  browser: BrowserDef;
}

export function loadEnv(): void {
  const dir = dataDir();
  const candidatePaths = [
    path.join(process.cwd(), '.env.local'),
    path.join(process.cwd(), '.env'),
    path.join(dir, '.env.local'),
    path.join(dir, '.env'),
  ];

  for (const envPath of candidatePaths) {
    loadDotenv({ path: envPath, quiet: true });
  }
}

export function loadChromeSessionConfig(overrides: { browserId?: string } = {}): ChromeSessionConfig {
  loadEnv();

  // Resolve browser: CLI flag > FT_BROWSER env > deterministic Firefox default.
  const browserId = overrides.browserId ?? process.env.FT_BROWSER;
  const browser = getBrowser(browserId || 'firefox');

  // Resolve user-data dir: env override > registry path for the browser
  const dir = process.env.FT_CHROME_USER_DATA_DIR ?? browserUserDataDir(browser);
  if (!dir) {
    const supported = listBrowserIds().join(', ');
    throw new Error(
      `Could not detect a browser data directory for ${browser.displayName} on ${os.platform()}.\n` +
      `Set FT_CHROME_USER_DATA_DIR in .env, pass --chrome-user-data-dir, or try --browser <name>.\n` +
      `Supported browsers: ${supported}`
    );
  }

  const profileDirectory = process.env.FT_CHROME_PROFILE_DIRECTORY ?? 'Default';

  return { chromeUserDataDir: dir, chromeProfileDirectory: profileDirectory, browser };
}

export function loadXApiConfig() {
  loadEnv();

  const apiKey = process.env.X_API_KEY ?? process.env.X_CONSUMER_KEY;
  const apiSecret = process.env.X_API_SECRET ?? process.env.X_SECRET_KEY;
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const bearerToken = process.env.X_BEARER_TOKEN;
  const callbackUrl = process.env.X_CALLBACK_URL ?? 'http://127.0.0.1:3000/callback';

  if (!apiKey || !apiSecret || !clientId || !clientSecret) {
    throw new Error(
      'Missing X API credentials for API sync.\n' +
      'Set X_API_KEY, X_API_SECRET, X_CLIENT_ID, and X_CLIENT_SECRET in .env.\n' +
      'These are only needed for --api mode. Default sync uses your browser session.'
    );
  }

  return { apiKey, apiSecret, clientId, clientSecret, bearerToken, callbackUrl };
}
