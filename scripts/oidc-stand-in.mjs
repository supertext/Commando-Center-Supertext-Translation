// A stand-in for Supertext's Person Service (OIDC), for local development, the docs
// screenshots and the sign-in check. Never use it in production: it signs in anyone who
// clicks a button.
//
//   node scripts/oidc-stand-in.mjs            # http://127.0.0.1:8767/person
//   COMMANDO_OIDC_ISSUER=http://127.0.0.1:8767/person COMMANDO_OIDC_CLIENT_ID=Supertext.PluginHealth.Admin.UI \
//   COMMANDO_SESSION_SECRET=<32+ characters> npm run dev
//
// The login page offers two invented people: Ada Muster (role Administrator, gets in) and
// Max Kunde (role Customer, refused). Authorization code flow with PKCE, RS256 ID tokens.
import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PEOPLE = {
  ada: { sub: '1001', name: 'Ada Muster', given_name: 'Ada', family_name: 'Muster', email: 'ada.muster@example.com', role: ['Administrator'] },
  max: { sub: '2002', name: 'Max Kunde', given_name: 'Max', family_name: 'Kunde', email: 'max.kunde@example.com', role: ['Customer'] },
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'stand-in', use: 'sig', alg: 'RS256' };
const codes = new Map(); // code -> { person, clientId, redirectUri, nonce, challenge }
const tokens = new Map(); // access token -> person

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(issuer, clientId, person, nonce) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'RS256', kid: 'stand-in', typ: 'JWT' })}.${b64({ iss: issuer, aud: clientId, sub: person.sub, nonce, iat: now, exp: now + 300, name: person.name, email: person.email })}`;
  return `${data}.${sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let s = '';
  for await (const c of req) s += c;
  return new URLSearchParams(s);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Handles requests under `prefix` (e.g. "/person"); returns false for other paths. */
export async function handleOidc(req, res, origin, prefix = '/person') {
  const url = new URL(req.url ?? '/', origin);
  if (!url.pathname.startsWith(`${prefix}/`)) return false;
  const issuer = `${origin}${prefix}`;
  const path = url.pathname.slice(prefix.length);

  if (path === '/.well-known/openid-configuration') {
    send(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/connect/authorize`,
      token_endpoint: `${issuer}/connect/token`,
      userinfo_endpoint: `${issuer}/connect/userinfo`,
      end_session_endpoint: `${issuer}/connect/endsession`,
      jwks_uri: `${issuer}/.well-known/openid-configuration/jwks`,
      code_challenge_methods_supported: ['S256'],
    });
  } else if (path === '/.well-known/openid-configuration/jwks') {
    send(res, 200, { keys: [jwk] });
  } else if (path === '/connect/authorize' && req.method === 'GET') {
    const q = url.searchParams;
    const hidden = [...q].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    send(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><title>Supertext login (stand-in)</title>
<body style="font-family:sans-serif;max-width:420px;margin:10vh auto"><h1>Supertext login (stand-in)</h1>
<form method="post">${hidden}<p><button name="person" value="ada">Ada Muster (Administrator)</button></p>
<p><button name="person" value="max">Max Kunde (Customer)</button></p></form></body>`,
      'text/html; charset=utf-8',
    );
  } else if (path === '/connect/authorize' && req.method === 'POST') {
    const f = await readBody(req);
    const person = PEOPLE[f.get('person')];
    const redirect = f.get('redirect_uri');
    if (!person || !redirect || f.get('code_challenge_method') !== 'S256') return send(res, 400, { error: 'invalid_request' }), true;
    const code = randomBytes(16).toString('base64url');
    codes.set(code, { person, clientId: f.get('client_id'), redirectUri: redirect, nonce: f.get('nonce'), challenge: f.get('code_challenge') });
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', f.get('state') ?? '');
    res.writeHead(302, { Location: back.toString() });
    res.end();
  } else if (path === '/connect/token' && req.method === 'POST') {
    const f = await readBody(req);
    const c = codes.get(f.get('code') ?? '');
    codes.delete(f.get('code') ?? '');
    const verifier = f.get('code_verifier') ?? '';
    if (!c || c.clientId !== f.get('client_id') || c.redirectUri !== f.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== c.challenge)
      return send(res, 400, { error: 'invalid_grant' }), true;
    const access = randomBytes(16).toString('base64url');
    tokens.set(access, c.person);
    send(res, 200, { id_token: idToken(issuer, c.clientId, c.person, c.nonce), access_token: access, token_type: 'Bearer', expires_in: 3600 });
  } else if (path === '/connect/userinfo') {
    const person = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!person) return send(res, 401, { error: 'invalid_token' }), true;
    send(res, 200, person);
  } else if (path === '/connect/endsession') {
    const back = url.searchParams.get('post_logout_redirect_uri');
    res.writeHead(back ? 302 : 200, back ? { Location: back } : { 'Content-Type': 'text/plain' });
    res.end(back ? '' : 'Signed out.');
  } else {
    send(res, 404, { error: 'not_found' });
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8767);
  const origin = `http://127.0.0.1:${port}`;
  http
    .createServer(async (req, res) => {
      if (!(await handleOidc(req, res, origin))) send(res, 404, { error: 'not_found' });
    })
    .listen(port, '127.0.0.1', () => console.log(`OIDC stand-in: ${origin}/person`));
}
