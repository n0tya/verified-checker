// 認証済みフォロワー チェッカー — 中継サーバー（Cloudflare Workers）
//
// X の認証済みフォロワー数（verified_followers_count）は、
// 「X でログインした本人」かつ「X Premium 加入者」にしか返らない。
// そこで、訪問者に X でログインしてもらい（OAuth 2.0 + PKCE）、本人の数を1回だけ取得する。
//
// 流れ
//   1. サイトの「X でログイン」→ GET /auth/login?site=<サイトのURL>
//   2. X の許可画面 → GET /auth/callback?code=…&state=…
//   3. コードをトークンに交換 → GET /2/users/me を1回呼ぶ → トークンはすぐ取り消す（保存しない）
//   4. 結果を URL の # 以降に入れて、サイトに戻す（サーバーには何も残らない）
//
// 設定（Cloudflare 側。README.md の手順を参照）
//   X_CLIENT_ID     : X Developer Console の OAuth 2.0 Client ID（Secret として登録）
//   X_CLIENT_SECRET : 同じく Client Secret（Secret として登録。コードには書かない）
//   ALLOWED_ORIGIN  : 戻り先として許すサイトのオリジン（カンマ区切り）
//   LIMITER         : （任意）Rate Limiting バインディング。1つの IP からのログイン回数を制限する
//
// 料金: ログイン1回につき User 読み取り1件（約 $0.01）。上限は X Developer Console の上限額で抑える。

const SCOPES = 'users.read tweet.read';
const USER_FIELDS = [
  'verified_followers_count',
  'public_metrics',
  'profile_image_url',
  'verified',
  'verified_type',
  'subscription_type',
  'name',
  'username',
].join(',');
const COOKIE = 'vc_oauth';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/auth/login') return await login(request, env, url);
      if (request.method === 'GET' && url.pathname === '/auth/callback') return await callback(request, env, ctx, url);
    } catch (e) {
      return text('エラーが起きました。もう一度お試しください。', 500);
    }
    return text('Not Found', 404);
  },
};

async function login(request, env, url) {
  const site = allowedSite(url.searchParams.get('site'), env);
  if (!site) return text('このサイトからは利用できません。', 403);
  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) return backTo(site, { e: 'not_configured' });

  // 1つの IP から短時間に何度もログインされないようにする（料金の保護）
  if (env.LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) return backTo(site, { e: 'rate_limited' });
  }

  const state = randomString(24);
  const verifier = randomString(48);
  const challenge = await sha256base64url(verifier);
  const redirectUri = `${url.origin}/auth/callback`;

  const auth = new URL('https://x.com/i/oauth2/authorize');
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', env.X_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('scope', SCOPES);
  auth.searchParams.set('state', state);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');

  // state・verifier・戻り先は、この Worker のドメインだけで読める Cookie に10分だけ置く
  const cookieVal = b64url(JSON.stringify({ state, verifier, site }));
  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': `${COOKIE}=${cookieVal}; Path=/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      'Cache-Control': 'no-store',
    },
  });
}

async function callback(request, env, ctx, url) {
  const saved = readCookie(request);
  const clear = `${COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  const site = saved && allowedSite(saved.site, env);
  if (!site) return text('ログインの有効期限が切れました。サイトからもう一度お試しください。', 400, { 'Set-Cookie': clear });

  if (url.searchParams.get('error')) return backTo(site, { e: 'denied' }, clear);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== saved.state) return backTo(site, { e: 'state' }, clear);

  const basic = 'Basic ' + btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}/auth/callback`,
      code_verifier: saved.verifier,
      client_id: env.X_CLIENT_ID,
    }),
  });
  if (!tokenRes.ok) return backTo(site, { e: 'token' }, clear);
  const { access_token: token } = await tokenRes.json();
  if (!token) return backTo(site, { e: 'token' }, clear);

  const meRes = await fetch(`https://api.x.com/2/users/me?user.fields=${USER_FIELDS}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // トークンは保存せず、すぐに取り消す
  ctx.waitUntil(
    fetch('https://api.x.com/2/oauth2/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic },
      body: new URLSearchParams({ token, token_type_hint: 'access_token', client_id: env.X_CLIENT_ID }),
    }).catch(() => {})
  );

  if (meRes.status === 429) return backTo(site, { e: 'rate_limited' }, clear);
  if (meRes.status === 402) return backTo(site, { e: 'quota' }, clear);
  if (!meRes.ok) return backTo(site, { e: 'upstream' }, clear);
  const u = (await meRes.json()).data;
  if (!u) return backTo(site, { e: 'upstream' }, clear);

  const result = {
    u: u.username,
    n: u.name,
    p: (u.profile_image_url || '').replace('_normal.', '_200x200.'),
    v: !!u.verified,
    vt: u.verified_type || 'none',
    st: u.subscription_type || null,
    f: Number(u.public_metrics?.followers_count ?? 0),
    vf: u.verified_followers_count == null ? null : Number(u.verified_followers_count),
    t: new Date().toISOString(),
  };
  return backTo(site, { r: b64url(JSON.stringify(result)) }, clear);
}

// 戻り先は ALLOWED_ORIGIN に入っているオリジンのページだけ
function allowedSite(site, env) {
  if (!site) return null;
  let u;
  try { u = new URL(site); } catch { return null; }
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(u.origin)) return null;
  return `${u.origin}${u.pathname}`;
}

function backTo(site, params, setCookie) {
  const headers = { Location: `${site}#${new URLSearchParams(params)}`, 'Cache-Control': 'no-store' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(null, { status: 302, headers });
}

function readCookie(request) {
  const raw = (request.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  try { return JSON.parse(fromB64url(raw.slice(COOKIE.length + 1))); } catch { return null; }
}

function randomString(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return bytesToB64url(a);
}

async function sha256base64url(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return bytesToB64url(new Uint8Array(d));
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64url(str) {
  return bytesToB64url(new TextEncoder().encode(str));
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function text(body, status, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}
