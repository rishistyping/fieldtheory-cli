import test from 'node:test';
import assert from 'node:assert/strict';
import { loadChromeSessionConfig } from '../src/config.js';

test('loadChromeSessionConfig reads data dir and profile from env with Firefox as default', () => {
  const previousBrowser = process.env.FT_BROWSER;
  process.env.FT_BROWSER = '';
  process.env.FT_CHROME_USER_DATA_DIR = '/tmp/chrome-user-data';
  process.env.FT_CHROME_PROFILE_DIRECTORY = 'Profile 1';
  try {
    const config = loadChromeSessionConfig();
    assert.equal(config.chromeUserDataDir, '/tmp/chrome-user-data');
    assert.equal(config.chromeProfileDirectory, 'Profile 1');
    assert.equal(config.browser.id, 'firefox');
  } finally {
    delete process.env.FT_CHROME_USER_DATA_DIR;
    delete process.env.FT_CHROME_PROFILE_DIRECTORY;
    if (previousBrowser === undefined) delete process.env.FT_BROWSER;
    else process.env.FT_BROWSER = previousBrowser;
  }
});

test('loadChromeSessionConfig defaults profile to Default', () => {
  process.env.FT_CHROME_USER_DATA_DIR = '/tmp/chrome-user-data';
  delete process.env.FT_CHROME_PROFILE_DIRECTORY;
  const config = loadChromeSessionConfig();
  assert.equal(config.chromeProfileDirectory, 'Default');
  delete process.env.FT_CHROME_USER_DATA_DIR;
});

test('loadChromeSessionConfig: --browser brave resolves to Brave', () => {
  delete process.env.FT_CHROME_USER_DATA_DIR;
  delete process.env.FT_BROWSER;
  const config = loadChromeSessionConfig({ browserId: 'brave' });
  assert.equal(config.browser.id, 'brave');
  assert.match(config.chromeUserDataDir, /Brave/i);
});

test('loadChromeSessionConfig: FT_BROWSER env is honored', () => {
  delete process.env.FT_CHROME_USER_DATA_DIR;
  process.env.FT_BROWSER = 'brave';
  const config = loadChromeSessionConfig();
  assert.equal(config.browser.id, 'brave');
  delete process.env.FT_BROWSER;
});

test('loadChromeSessionConfig: unknown browser throws', () => {
  delete process.env.FT_CHROME_USER_DATA_DIR;
  assert.throws(
    () => loadChromeSessionConfig({ browserId: 'bogus' }),
    /Unknown browser: "bogus"/,
  );
});

test('loadChromeSessionConfig: --browser firefox resolves correctly', () => {
  delete process.env.FT_CHROME_USER_DATA_DIR;
  delete process.env.FT_BROWSER;
  const config = loadChromeSessionConfig({ browserId: 'firefox' });
  assert.equal(config.browser.id, 'firefox');
  assert.equal(config.browser.cookieBackend, 'firefox');
  assert.match(config.chromeUserDataDir, /Firefox/);
});
