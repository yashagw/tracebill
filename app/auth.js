// Portal auth: bcrypt email+password -> HttpOnly session cookie, 24h sliding.
// Sessions are stored as sha256(token), and tenant_id is always resolved from
// the session server-side rather than taken from the request.
'use strict';

const bcrypt = require('bcryptjs');
const { sha256, newSessionToken } = require('../lib/ids');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE = 'tb_session';

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

class Auth {
  constructor(db) {
    this.db = db;
  }

  login(email, password) {
    const user = this.db.prepare('SELECT * FROM tenant_users WHERE email = ?').get(String(email || '').toLowerCase());
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) return null;
    const token = newSessionToken();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), user.id, Date.now() + SESSION_TTL_MS);
    return { token, user };
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  /** {user, tenant} or null. Extends the session on each hit. */
  resolve(token) {
    if (!token) return null;
    const hash = sha256(token);
    const row = this.db
      .prepare(
        `SELECT s.expires_at, u.id AS user_id, u.email, u.tenant_id, t.name AS tenant_name
         FROM sessions s JOIN tenant_users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id
         WHERE s.token_hash = ?`
      )
      .get(hash);
    if (!row || row.expires_at < Date.now()) {
      if (row) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      return null;
    }
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_TTL_MS, hash);
    return {
      user: { id: row.user_id, email: row.email },
      tenant: { id: row.tenant_id, name: row.tenant_name },
    };
  }

  middleware() {
    return (req, res, next) => {
      const token = parseCookies(req)[COOKIE];
      const ctx = this.resolve(token);
      if (!ctx) return res.status(401).json({ error: { code: 'unauthorized', message: 'login required' } });
      req.sessionToken = token;
      req.user = ctx.user;
      req.tenantId = ctx.tenant.id;
      req.tenantName = ctx.tenant.name;
      next();
    };
  }

  setCookie(res, token) {
    res.set('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
  }

  clearCookie(res) {
    res.set('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  }
}

module.exports = { Auth, parseCookies, COOKIE, hashPassword: (p) => bcrypt.hashSync(p, 10) };
