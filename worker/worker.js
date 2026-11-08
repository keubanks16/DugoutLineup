// Dugout Lineup sync server (Cloudflare Worker + Durable Object).
//
// Everyone can READ the current game (lineup, field, pitch counts).
// Only the admin (coach) can CHANGE it, after signing in with the admin password.
// The first time the app is opened, the coach creates that password from the Setup tab.
//
// Routes (all under /api):
//   GET  /api/state?v=N   current game + last field-update notice (state only sent when it changed)
//   GET  /api/admin       { hasAdmin } — has the admin password been created yet?
//   POST /api/setup       { password } — create the admin password (only works once)
//   POST /api/login       { password } — sign in, returns a token
//   POST /api/logout      (admin) sign this device out
//   POST /api/password    (admin) { password, newPassword } — change password, signs out every device
//   POST /api/state       (admin) { state } — save the game
//   POST /api/push        (admin) { msg, inning } — pop up "Field update" on every device
//
// Optional Variable in the Worker's Settings: ALLOWED_ORIGIN (comma separated), default https://keubanks16.github.io

const TOKEN_DAYS = 180;
const MAX_BODY = 900_000;

function corsHeaders(req, env) {
  const allowed = String(env.ALLOWED_ORIGIN || 'https://keubanks16.github.io').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes(origin) || allowed.includes('*')) h['Access-Control-Allow-Origin'] = origin || '*';
  return h;
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Dugout Lineup sync server is running.', { headers: { 'Content-Type': 'text/plain', ...cors } });
    }
    const stub = env.ROOM.get(env.ROOM.idFromName('main'));
    const res = await stub.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  },
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

export class Room {
  constructor(state, env) { this.storage = state.storage; this.env = env; }

  async readBody(req) {
    const text = await req.text();
    if (text.length > MAX_BODY) throw new Error('too big');
    return text ? JSON.parse(text) : {};
  }

  async newToken() {
    const t = randHex(32);
    await this.storage.put('tok:' + (await sha256(t)), Date.now() + TOKEN_DAYS * 864e5);
    return t;
  }

  async isAdmin(req) {
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.get('Authorization') || '');
    if (!m) return false;
    const key = 'tok:' + (await sha256(m[1]));
    const exp = await this.storage.get(key);
    if (!exp) return false;
    if (exp < Date.now()) { await this.storage.delete(key); return false; }
    return key;
  }

  async throttled() {
    const f = (await this.storage.get('fails')) || { n: 0, t: 0 };
    return f.n >= 8 && Date.now() - f.t < 15 * 60e3;
  }
  async fail() {
    const f = (await this.storage.get('fails')) || { n: 0, t: 0 };
    const fresh = Date.now() - f.t > 15 * 60e3;
    await this.storage.put('fails', { n: fresh ? 1 : f.n + 1, t: Date.now() });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '');
    try {
      if (req.method === 'GET' && path === '/state') {
        const v = (await this.storage.get('v')) || 0;
        const push = (await this.storage.get('push')) || null;
        const known = Number(url.searchParams.get('v'));
        if (known === v) return json({ v, push, same: true });
        return json({ v, push, state: (await this.storage.get('state')) || null });
      }
      if (req.method === 'GET' && path === '/admin') {
        return json({ hasAdmin: !!(await this.storage.get('admin')) });
      }
      if (req.method !== 'POST') return json({ error: 'Not found' }, 404);

      if (path === '/setup') {
        if (await this.storage.get('admin')) return json({ error: 'The admin password was already created. Sign in instead.' }, 409);
        const { password } = await this.readBody(req);
        if (typeof password !== 'string' || password.length < 6) return json({ error: 'Use at least 6 characters.' }, 400);
        const salt = randHex(16);
        await this.storage.put('admin', { salt, hash: await pbkdf2(password, salt) });
        return json({ token: await this.newToken() });
      }
      if (path === '/login') {
        if (await this.throttled()) return json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
        const admin = await this.storage.get('admin');
        if (!admin) return json({ error: 'No admin password yet. Create one first.' }, 409);
        const { password } = await this.readBody(req);
        if (typeof password !== 'string' || !safeEq(await pbkdf2(password, admin.salt), admin.hash)) {
          await this.fail();
          return json({ error: 'Wrong password.' }, 401);
        }
        await this.storage.delete('fails');
        return json({ token: await this.newToken() });
      }

      const tokKey = await this.isAdmin(req);
      if (!tokKey) return json({ error: 'Admin sign-in needed.' }, 401);

      if (path === '/logout') { await this.storage.delete(tokKey); return json({ ok: true }); }
      if (path === '/password') {
        const { password, newPassword } = await this.readBody(req);
        const admin = await this.storage.get('admin');
        if (typeof password !== 'string' || !safeEq(await pbkdf2(password, admin.salt), admin.hash)) return json({ error: 'Current password is wrong.' }, 401);
        if (typeof newPassword !== 'string' || newPassword.length < 6) return json({ error: 'Use at least 6 characters.' }, 400);
        const salt = randHex(16);
        await this.storage.put('admin', { salt, hash: await pbkdf2(newPassword, salt) });
        const toks = await this.storage.list({ prefix: 'tok:' });
        await this.storage.delete([...toks.keys()]);
        return json({ token: await this.newToken() });
      }
      if (path === '/state') {
        const { state } = await this.readBody(req);
        if (!state || typeof state !== 'object' || !Array.isArray(state.roster)) return json({ error: 'Bad game data.' }, 400);
        const v = ((await this.storage.get('v')) || 0) + 1;
        await this.storage.put({ state, v });
        return json({ v });
      }
      if (path === '/push') {
        const { msg, inning } = await this.readBody(req);
        const push = { id: Date.now(), msg: String(msg || 'Field update').slice(0, 120), inning: Number(inning) || null };
        await this.storage.put('push', push);
        return json({ push });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message === 'too big' ? 'Too much data.' : 'Bad request.' }, 400);
    }
  }
}
