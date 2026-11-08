// Takes the screenshots in docs/images/ from a running center with an empty database.
//
//   1. Start the center against a fresh database, pointing GitHub release lookups and the
//      sample sites' ping endpoints at the stand-in this script starts on port 8766
//      (COMMANDO_PING_* are test-only switches, never set them in production):
//        GITHUB_API_URL=http://127.0.0.1:8766 COMMANDO_PROXY_URL=http://127.0.0.1:8766 COMMANDO_PROXY_TOKEN=docs-proxy-token \
//        COMMANDO_PING_ALLOW_PRIVATE=1 \
//        COMMANDO_PING_HOSTS="$(node scripts/docs-screenshots.mjs --ping-hosts)" \
//        COMMANDO_OIDC_ISSUER=http://127.0.0.1:8766/person COMMANDO_OIDC_CLIENT_ID=Supertext.PluginHealth.Admin.UI \
//        COMMANDO_SESSION_SECRET=<32+ characters> COMMANDO_DB_NAME=commando_docs npm run dev
//   2. COMMANDO_URL=http://127.0.0.1:3000 npm run docs:screenshots
//
// It signs in through the stand-in Person Service (scripts/oidc-stand-in.mjs) as the invented
// Ada Muster, sends sample reports for invented sites (no customer data), maps two of them to
// invented clients through the UI, and saves cropped 1× PNGs.
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { handleOidc } from './oidc-stand-in.mjs';

// The sample sites' ping endpoints all go to the stand-in, except one that "is behind a firewall".
const PING_HOSTS = {
  'www.alpenblick-hotels.example.ch': '127.0.0.1:8766',
  'staging.alpenblick-hotels.example.ch': '127.0.0.1:8766',
  'www.bergbahnen-muster.example.ch': '127.0.0.1:8766',
  'shop.velo-beispiel.example.com': '127.0.0.1:8766',
  'www.kanton-musterland.example.ch': '127.0.0.1:1',
};
if (process.argv.includes('--ping-hosts')) {
  console.log(Object.entries(PING_HOSTS).map(([h, a]) => `${h}=${a}`).join(','));
  process.exit(0);
}

const BASE = (process.env.COMMANDO_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const OUT = new URL('../docs/images/', import.meta.url);

// Stand-in for the GitHub releases API: the latest release per plugin.
const RELEASES = {
  'supertext-wordpress-polylang': '2.1.0',
  'Typo3-Supertext-Translation': '0.4.0',
  'Magento-Supertext-Translation': '0.3.0',
  'Strapi-Supertext-Translation': '0.2.0',
  'Contao-Supertext-Translation': '0.3.1',
};
const PROXY_USAGE = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  integrations: [
    { tenant: 'a1'.repeat(32), tenantLabel: 'Alpenblick Hotels AG', plugin: 'supertext-wordpress-polylang', pluginVersion: '2.1.0', sdk: 'php', keyChecks: 3, uploads: 128, memoryAnswers: 74, firstSeenAt: new Date(Date.now() - 9 * 86400e3).toISOString(), lastSeenAt: new Date(Date.now() - 12 * 60e3).toISOString() },
    { tenant: 'b2'.repeat(32), tenantLabel: 'Bergbahnen Muster', plugin: 'Typo3-Supertext-Translation', pluginVersion: '0.3.0', sdk: 'php', keyChecks: 1, uploads: 41, memoryAnswers: 9, firstSeenAt: new Date(Date.now() - 4 * 86400e3).toISOString(), lastSeenAt: new Date(Date.now() - 3 * 3600e3).toISOString() },
    { tenant: 'c3'.repeat(32), tenantLabel: '', plugin: 'Strapi-Supertext-Translation', pluginVersion: '0.2.0', sdk: 'typescript', keyChecks: 2, uploads: 6, memoryAnswers: 0, firstSeenAt: new Date(Date.now() - 86400e3).toISOString(), lastSeenAt: new Date(Date.now() - 86400e3 + 600e3).toISOString() },
  ],
};

const standIn = http
  .createServer(async (req, res) => {
    // Stand-in Person Service for signing in (OIDC).
    if (await handleOidc(req, res, 'http://127.0.0.1:8766')) return;
    // Ping endpoints of the sample sites, by Host header.
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host in PING_HOSTS) {
      const u = new URL(req.url ?? '/', 'http://x');
      if (host.startsWith('staging.')) {
        res.writeHead(302, { Location: '/wp-login.php' }); // staging behind a login
        return res.end();
      }
      if (host.startsWith('shop.')) {
        res.writeHead(200, { 'Content-Type': 'text/html' }); // a maintenance page in front of the shop
        return res.end('<html><body>We are back soon.</body></html>');
      }
      const plugin = host.startsWith('www.alpenblick') ? 'supertext-wordpress-polylang' : 'Typo3-Supertext-Translation';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, plugin, challenge: u.searchParams.get('challenge') }));
    }
    // Stand-in for the translation proxy's usage API (invented sample data).
    if (req.url === '/api/usage') {
      const ok = req.headers.authorization === 'Bearer docs-proxy-token';
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ok ? PROXY_USAGE : { error: 'unauthorized' }));
    }
    const m = req.url?.match(/^\/repos\/[^/]+\/([^/]+)\/releases/);
    const v = m && RELEASES[decodeURIComponent(m[1])];
    res.writeHead(v ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(v ? [{ tag_name: `v${v}`, draft: false }] : { message: 'Not Found' }));
  })
  .listen(8766, '127.0.0.1');

async function report(body) {
  const res = await fetch(`${BASE}/api/v1/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 1, ...body }),
  });
  if (res.status !== 202) throw new Error(`report failed: ${res.status} ${await res.text()}`);
}

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const check = (status, min, extra = {}) => ({ api_key_check: { status, checked_at: ago(min), ...extra } });
const ping = (url) => ({ callback: { url } });
const wp = (system, plugin, event, extra = {}) => ({
  event,
  site_url: 'https://www.alpenblick-hotels.example.ch/',
  ...ping('http://www.alpenblick-hotels.example.ch/wp-json/supertext/v1/ping'),
  plugin: { name: 'supertext-wordpress-polylang', version: plugin },
  system: { name: 'WordPress', version: system },
  runtime: { name: 'PHP', version: '8.3.12' },
  api_key_configured: true,
  ...extra,
});
// Each sample's API key check result, so the screenshots show every status:
// ok, rejected (wrong key pasted, then fixed; a revoked key), unreachable, no key, not checked (older plugin),
// and two named keys (WordPress).
const samples = [
  wp('6.8.3', '2.0.0', 'installed', check('invalid', 9, { http_status: 401, error_code: 'INVALID_API_KEY' })),
  wp('6.8.3', '2.0.0', 'settings_saved', check('ok', 8, { http_status: 200 })),
  wp('6.9.0', '2.0.0', 'upgraded'),
  wp('6.9.0', '2.1.0', 'upgraded'),
  // Plugin Health 0.2: the WordPress plugin reports its two keys by name.
  wp('6.9.0', '2.1.0', 'settings_saved', {
    api_keys: [
      { name: 'AI translation', configured: true, check: { status: 'ok', checked_at: ago(7), http_status: 200 } },
      { name: 'Professional orders', configured: true, check: { status: 'ok', checked_at: ago(7), http_status: 200 } },
    ],
  }),
  // Plugin Health 0.3: the administrator sends the installed plugins (button), later again after updates.
  wp('6.9.0', '2.1.0', 'extensions', {
    api_keys: [
      { name: 'AI translation', configured: true, check: { status: 'ok', checked_at: ago(7), http_status: 200 } },
      { name: 'Professional orders', configured: true, check: { status: 'ok', checked_at: ago(7), http_status: 200 } },
    ],
    extensions: [
      { name: 'Polylang Pro', version: '3.6.4', active: true, type: 'plugin' },
      { name: 'Yoast SEO', version: '24.0', active: true, type: 'plugin' },
      { name: 'WP Rocket', version: '3.17', active: true, type: 'plugin' },
      { name: 'WPML Multilingual CMS', version: '4.6.13', active: false, type: 'plugin' },
      { name: 'Akismet Anti-spam', version: '5.3', active: false, type: 'plugin' },
      { name: 'Twenty Twenty-Five', version: '1.2', active: true, type: 'theme' },
    ],
  }),
  wp('6.9.0', '2.1.0', 'extensions', {
    api_keys: [
      { name: 'AI translation', configured: true, check: { status: 'ok', checked_at: ago(7), http_status: 200 } },
      { name: 'Professional orders', configured: true, check: { status: 'ok', checked_at: ago(7), http_status: 200 } },
    ],
    extensions: [
      { name: 'Polylang Pro', version: '3.7.2', active: true, type: 'plugin' },
      { name: 'Yoast SEO', version: '24.1', active: true, type: 'plugin' },
      { name: 'WP Rocket', version: '3.17', active: true, type: 'plugin' },
      { name: 'Akismet Anti-spam', version: '5.3', active: true, type: 'plugin' },
      { name: 'Redirection', version: '5.5.1', active: true, type: 'plugin' },
      { name: 'Twenty Twenty-Five', version: '1.2', active: true, type: 'theme' },
    ],
  }),
  { event: 'settings_saved', site_url: 'https://staging.alpenblick-hotels.example.ch', plugin: { name: 'supertext-wordpress-polylang', version: '2.0.0' }, system: { name: 'WordPress', version: '6.8.3' }, runtime: { name: 'PHP', version: '8.2.20' }, api_key_configured: true, ...check('unreachable', 6), ...ping('http://staging.alpenblick-hotels.example.ch/wp-json/supertext/v1/ping') },
  { event: 'upgraded', site_url: 'https://www.bergbahnen-muster.example.ch/', plugin: { name: 'Typo3-Supertext-Translation', version: '0.3.0' }, system: { name: 'TYPO3', version: '13.4.2' }, runtime: { name: 'PHP', version: '8.3.12' }, sdk_version: '0.2.0', api_key_configured: true, ...check('ok', 5, { http_status: 200 }), ...ping('http://www.bergbahnen-muster.example.ch/?eID=supertext_ping') },
  { event: 'installed', site_url: 'https://shop.velo-beispiel.example.com/de/', plugin: { name: 'Magento-Supertext-Translation', version: '0.3.0' }, system: { name: 'Magento', version: '2.4.8' }, runtime: { name: 'PHP', version: '8.4.1' }, api_key_configured: false, ...check('missing', 4), ...ping('http://shop.velo-beispiel.example.com/supertext/ping') },
  { event: 'settings_saved', site_url: 'https://cms.uhrenmanufaktur.example.org', plugin: { name: 'Strapi-Supertext-Translation', version: '0.2.0' }, system: { name: 'Strapi', version: '5.12.0' }, runtime: { name: 'Node.js', version: '22.11.0' }, sdk_version: '0.3.0', api_key_configured: true },
  { event: 'settings_saved', site_url: 'https://www.kanton-musterland.example.ch/', plugin: { name: 'Contao-Supertext-Translation', version: '0.2.0' }, system: { name: 'Contao', version: '5.7.1' }, runtime: { name: 'PHP', version: '8.3.12' }, sdk_version: '0.2.0', api_key_configured: true, ...check('ok', 3, { http_status: 200 }), ...ping('http://www.kanton-musterland.example.ch/supertext/ping') },
  { event: 'api_key_check', site_url: 'https://www.kanton-musterland.example.ch/', plugin: { name: 'Contao-Supertext-Translation', version: '0.2.0' }, system: { name: 'Contao', version: '5.7.1' }, runtime: { name: 'PHP', version: '8.3.12' }, sdk_version: '0.2.0', api_key_configured: true, ...check('invalid', 1, { http_status: 403, error_code: 'API_KEY_REVOKED' }), ...ping('http://www.kanton-musterland.example.ch/supertext/ping') },
];
for (const s of samples) await report(s);

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 640 }, deviceScaleFactor: 1, colorScheme: 'light' });
const shot = async (name, opts = {}) => page.screenshot({ path: new URL(name, OUT).pathname, ...opts });

await page.goto(`${BASE}/login`);
await shot('login.png', { clip: { x: 440, y: 60, width: 480, height: 300 } });
await page.click('a:has-text("Sign in with Supertext")');
await Promise.all([page.waitForURL(`${BASE}/`), page.click('button[value=ada]')]);

// Map the two Alpenblick sites to one client (new client, then existing), the Bergbahnen site to another.
async function mapTo(urlPart, client, isNew) {
  await page.goto(`${BASE}/`);
  await page.click(`a:has-text("${urlPart}")`);
  await page.waitForLoadState('networkidle'); // fill the form only once React has hydrated it
  if (isNew) await page.fill('input[name=new_client]', client);
  else await page.selectOption('select[name=client]', { label: client });
  await page.fill('textarea[name=notes]', urlPart.startsWith('staging') ? 'Staging' : 'Production');
  await Promise.all([page.waitForURL(/saved=1/), page.click('button.primary')]);
}
await mapTo('www.alpenblick-hotels', 'Alpenblick Hotels AG', true);
await mapTo('staging.alpenblick-hotels', 'Alpenblick Hotels AG', false);
await mapTo('www.bergbahnen-muster', 'Bergbahnen Muster', true);

await page.goto(`${BASE}/`);
await shot('installations.png', { fullPage: true });
await page.goto(`${BASE}/?status=outdated`);
await shot('installations-outdated.png', { clip: { x: 0, y: 0, width: 1360, height: 520 } });
await page.goto(`${BASE}/?key=problem`);
await shot('installations-key-problems.png', { clip: { x: 0, y: 0, width: 1360, height: 640 } });
await page.goto(`${BASE}/?callback=problem`);
await shot('installations-not-reachable.png', { clip: { x: 0, y: 0, width: 1360, height: 640 } });

await page.goto(`${BASE}/`);
await page.click('a:has-text("www.alpenblick-hotels")');
await page.waitForSelector('h2:has-text("History")');
await page.waitForLoadState('networkidle');
await Promise.all([page.waitForURL(/pinged=1/), page.click('button:has-text("Ping now")')]);
await shot('installation.png', { fullPage: true });
// Page coordinates (the redirect after Ping now scrolls to #callback).
const [top, bottom] = await page.evaluate(() => {
  const y = (el) => el.getBoundingClientRect().top + window.scrollY;
  return [y(document.getElementById('callback')), y(document.getElementById('extensions'))];
});
await shot('installation-reachability.png', { fullPage: true, clip: { x: 0, y: top - 8, width: 1360, height: bottom - top } });
const [extTop, extBottom] = await page.evaluate(() => {
  const y = (el) => el.getBoundingClientRect().top + window.scrollY;
  const history = [...document.querySelectorAll('h2')].find((h) => h.textContent === 'History');
  return [y(document.getElementById('extensions')), y(history)];
});
await shot('installation-extensions.png', { fullPage: true, clip: { x: 0, y: extTop - 8, width: 1360, height: extBottom - extTop } });

await page.goto(`${BASE}/clients`);
await shot('clients.png', { clip: { x: 0, y: 0, width: 1360, height: 360 } });
await Promise.all([page.waitForURL(/\/clients\/\d+$/), page.click('a:has-text("Alpenblick Hotels AG")')]);
await shot('client.png', { fullPage: true });

await page.goto(`${BASE}/proxy`);
await shot('proxy.png', { clip: { x: 0, y: 0, width: 1360, height: 520 } });

await browser.close();
standIn.close();
console.log(`screenshots saved in ${OUT.pathname}`);
