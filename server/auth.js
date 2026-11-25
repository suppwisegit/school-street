// Konten und Sitzungen. Passwörter: scrypt (gleiche Parameter wie bisher, alte
// Hashes bleiben gültig). Login, Registrierung und Passwort-Reset hashen
// asynchron auf dem Thread-Pool — eine Login-Welle zum Stundenbeginn blockiert
// den Event-Loop nicht mehr.
const crypto = require('crypto');
const { db, q, bumpActive } = require('./db');

const SESSION_MS = 7 * 24 * 3600 * 1000;
const KEY_LEN = 32;             // scrypt-Schlüssel in Bytes (hex: 64 Zeichen)
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 64;

const st = {
  insertUser: db.prepare('INSERT INTO users(username, pass_hash, salt, role, cash, created_at, last_active) VALUES(?,?,?,?,?,?,?)'),
  sessionByToken: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at >= ?'),
  insertSession: db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteSessionsOf: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  setHash: db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?')
};

// Regeln für neue Passwörter: deutscher Satz oder null (in Ordnung).
function passwordProblem(password) {
  const n = String(password ?? '').length;
  if (n < PASSWORD_MIN) return `Passwort: min. ${PASSWORD_MIN} Zeichen`;
  if (n > PASSWORD_MAX) return `Passwort: max. ${PASSWORD_MAX} Zeichen`;
  return null;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, KEY_LEN).toString('hex');
}
function hashPasswordAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

// Legt ein Konto an und gibt die Nutzerzeile zurück. Synchrongehalten für
// Start (Admin, Treasury), Seed und Bot-Anlage — HTTP-Pfade nehmen createUserAsync.
function insertUser(username, passHash, salt, role, cash) {
  const now = Date.now();
  const r = st.insertUser.run(username, passHash, salt, role, cash, now, now);
  return q.userById.get(r.lastInsertRowid);
}
function createUser(username, password, role = 'user', cash = 0) {
  const salt = crypto.randomBytes(8).toString('hex');
  return insertUser(username, hashPassword(String(password ?? ''), salt), salt, role, cash);
}
async function createUserAsync(username, password, role = 'user', cash = 0) {
  const salt = crypto.randomBytes(8).toString('hex');
  return insertUser(username, await hashPasswordAsync(String(password ?? ''), salt), salt, role, cash);
}

// true, wenn beide Hashes gleich lang sind und übereinstimmen.
function hashMatches(hash, stored) {
  const a = Buffer.from(hash), b = Buffer.from(stored || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function verifyLoginAsync(username, password) {
  const u = q.userByName.get(String(username ?? '').trim());
  if (!u) return null;
  return hashMatches(await hashPasswordAsync(String(password ?? ''), u.salt), u.pass_hash) ? u : null;
}

// Setzt ein neues Passwort (neues Salt) und beendet alle Sitzungen des Kontos.
async function setPasswordAsync(userId, password) {
  const salt = crypto.randomBytes(8).toString('hex');
  st.setHash.run(await hashPasswordAsync(String(password ?? ''), salt), salt, userId);
  st.deleteSessionsOf.run(userId);
  return true;
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  st.insertSession.run(token, userId, now, now + SESSION_MS);
  return token;
}
function destroySession(token) { st.deleteSession.run(token); }
// Sitzung + Konto in einer Abfrage (vorher zwei), gültig nur ohne Ablauf.
function userForToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return st.sessionByToken.get(token, Date.now()) || null;
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
  bumpActive(req.user);
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nicht eingeloggt' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für die Investment AG' });
  next();
}
module.exports = {
  createUser, createUserAsync, verifyLoginAsync, setPasswordAsync, passwordProblem, hashPassword,
  createSession, destroySession, userForToken, middleware, requireAuth, requireAdmin
};
