const crypto = require('crypto');
const { db, q, bumpActive } = require('./db');

const SESSION_MS = 7 * 24 * 3600 * 1000;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}
function createUser(username, password, role = 'user', cash = 0) {
  const now = Date.now();
  const salt = crypto.randomBytes(8).toString('hex');
  const r = db.prepare('INSERT INTO users(username, pass_hash, salt, role, cash, created_at, last_active) VALUES(?,?,?,?,?,?,?)')
    .run(username, hashPassword(password, salt), salt, role, cash, now, now);
  return q.userById.get(r.lastInsertRowid);
}
function verifyLogin(username, password) {
  const u = q.userByName.get(String(username || '').trim());
  if (!u) return null;
  const h = hashPassword(password, u.salt);
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.pass_hash)) ? u : null;
}
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .run(token, userId, now, now + SESSION_MS);
  return token;
}
function destroySession(token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
function userForToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s || s.expires_at < Date.now()) return null;
  return q.userById.get(s.user_id) || null;
}
// Express-Middleware: Bearer-Token oder ?token=
function middleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  req.token = token;
  req.user = userForToken(token);
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nicht eingeloggt' });
  if (req.user.frozen && req.user.role === 'user') return res.status(403).json({ error: 'Konto eingefroren (BaFin)' });
  bumpActive(req.user.id);
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nicht eingeloggt' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für die Investment AG' });
  next();
}
module.exports = { createUser, verifyLogin, createSession, destroySession, userForToken, middleware, requireAuth, requireAdmin, hashPassword };
