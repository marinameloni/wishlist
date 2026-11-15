import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPreview, titleFromUrl } from './preview.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Configuration ----------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_DAYS = 30;            // durée d'une session
const SESSION_RENEW_DAYS = 15;      // renouvelée automatiquement s'il reste moins de 15 jours
const DAY = 24 * 3600 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Base de données ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'wishlist.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    surprise INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT DEFAULT '',
    image TEXT DEFAULT '',
    price TEXT DEFAULT '',
    note TEXT DEFAULT '',
    chosen INTEGER NOT NULL DEFAULT 0,
    chosen_by TEXT DEFAULT '',
    chosen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id);
`);

// Migrations douces (bases créées par la première version)
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('lists', 'owner_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
addColumn('lists', 'emoji', "TEXT NOT NULL DEFAULT 'gift'");
addColumn('lists', 'event_date', 'TEXT');
addColumn('items', 'chosen_by_user', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

// Icônes de listes : anciennes valeurs emoji → noms d'illustrations SVG
const LIST_ICONS = ['gift', 'tree', 'cake', 'ring', 'baby', 'cap', 'house', 'plane', 'heart', 'egg', 'flower', 'party', 'book', 'teddy'];
const LEGACY_EMOJI = { '🎁': 'gift', '🎄': 'tree', '🎂': 'cake', '💍': 'ring', '👶': 'baby', '🎓': 'cap', '🏠': 'house',
  '✈️': 'plane', '💝': 'heart', '🐣': 'egg', '🌸': 'flower', '🎉': 'party', '📚': 'book', '🧸': 'teddy' };
for (const [e, key] of Object.entries(LEGACY_EMOJI)) db.prepare('UPDATE lists SET emoji = ? WHERE emoji = ?').run(key, e);
db.prepare(`UPDATE lists SET emoji = 'gift' WHERE emoji NOT IN (${LIST_ICONS.map(() => '?').join(',')})`).run(...LIST_ICONS);

const LIST_COLS = `l.*, u.name AS owner_name,
  (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id) AS item_count,
  (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id AND i.chosen = 1) AS chosen_count`;

const q = {
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
  userById: db.prepare('SELECT id, name, created_at FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (name, pass) VALUES (?, ?)'),
  setPass: db.prepare('UPDATE users SET pass = ? WHERE id = ?'),
  passOf: db.prepare('SELECT pass FROM users WHERE id = ?'),
  members: db.prepare(`SELECT u.id, u.name, (SELECT COUNT(*) FROM lists l WHERE l.owner_id = u.id) AS list_count
                       FROM users u ORDER BY u.name COLLATE NOCASE`),
  adoptOrphans: db.prepare('UPDATE lists SET owner_id = ? WHERE owner_id IS NULL'),

  sessionGet: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  sessionInsert: db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionTouch: db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?'),
  sessionDelete: db.prepare('DELETE FROM sessions WHERE id = ?'),
  sessionDeleteOthers: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?'),
  sessionPurge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

  allLists: db.prepare(`SELECT ${LIST_COLS} FROM lists l LEFT JOIN users u ON u.id = l.owner_id
                        ORDER BY (l.event_date IS NULL), l.event_date, l.created_at DESC`),
  listById: db.prepare(`SELECT ${LIST_COLS} FROM lists l LEFT JOIN users u ON u.id = l.owner_id WHERE l.id = ?`),
  listBySlug: db.prepare(`SELECT ${LIST_COLS} FROM lists l LEFT JOIN users u ON u.id = l.owner_id WHERE l.slug = ?`),
  insertList: db.prepare('INSERT INTO lists (slug, title, description, surprise, owner_id, emoji, event_date) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateList: db.prepare('UPDATE lists SET title = ?, description = ?, surprise = ?, emoji = ?, event_date = ? WHERE id = ?'),
  deleteList: db.prepare('DELETE FROM lists WHERE id = ?'),

  itemsOfList: db.prepare('SELECT * FROM items WHERE list_id = ? ORDER BY chosen ASC, created_at DESC'),
  itemById: db.prepare('SELECT * FROM items WHERE id = ?'),
  insertItem: db.prepare('INSERT INTO items (list_id, title, url, image, price, note) VALUES (?, ?, ?, ?, ?, ?)'),
  updateItem: db.prepare('UPDATE items SET title = ?, url = ?, image = ?, price = ?, note = ? WHERE id = ?'),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
  chooseItem: db.prepare(`UPDATE items SET chosen = ?, chosen_by = ?, chosen_by_user = ?,
                          chosen_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ?`),
  reservedBy: db.prepare(`SELECT i.*, l.title AS list_title, l.emoji AS list_emoji, u.name AS owner_name
                          FROM items i JOIN lists l ON l.id = i.list_id LEFT JOIN users u ON u.id = l.owner_id
                          WHERE i.chosen = 1 AND i.chosen_by_user = ? ORDER BY i.chosen_at DESC`),
  search: db.prepare(`SELECT i.*, l.title AS list_title, l.emoji AS list_emoji, l.owner_id, l.surprise, u.name AS owner_name
                      FROM items i JOIN lists l ON l.id = i.list_id LEFT JOIN users u ON u.id = l.owner_id
                      WHERE i.title LIKE ? ESCAPE '\\' OR i.note LIKE ? ESCAPE '\\' OR i.url LIKE ? ESCAPE '\\'
                      ORDER BY i.created_at DESC LIMIT 50`),
};

// ---------- Utilitaires ----------
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isHttpUrl = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };
const cleanUrl = (u) => (u && isHttpUrl(u) ? u : '');
const cleanImage = (u) => (/^\/uploads\/[A-Za-z0-9_-]+\.(jpg|png|webp|gif)$/.test(u || '') ? u : cleanUrl(u));
const cleanDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);
const cleanEmoji = (e) => (LIST_ICONS.includes(e) ? e : 'gift');
const newToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// Mots de passe : scrypt + sel
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pwd, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(pwd, stored) {
  const [, salt, hash] = (stored || '').split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(pwd, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const DUMMY_HASH = hashPassword(newToken());

function inviteToken() {
  let row = q.getSetting.get('invite');
  if (!row) { q.setSetting.run('invite', newToken(12)); row = q.getSetting.get('invite'); }
  return row.value;
}

// ---------- Sessions (cookie httpOnly, 30 jours, renouvelée automatiquement) ----------
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `wl_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`);
}
function startSession(req, res, userId) {
  const token = newToken(32);
  q.sessionInsert.run(sha(token), userId, Date.now() + SESSION_DAYS * DAY);
  setSessionCookie(req, res, token, SESSION_DAYS * 24 * 3600);
}
function loadUser(req, res, next) {
  req.user = null;
  const token = getCookie(req, 'wl_session');
  if (token) {
    const s = q.sessionGet.get(sha(token));
    if (s && s.expires_at > Date.now()) {
      req.user = q.userById.get(s.user_id) || null;
      req.sessionId = s.id;
      if (req.user && s.expires_at - Date.now() < SESSION_RENEW_DAYS * DAY) {
        q.sessionTouch.run(Date.now() + SESSION_DAYS * DAY, s.id);
        setSessionCookie(req, res, token, SESSION_DAYS * 24 * 3600);
      }
    } else if (s) {
      q.sessionDelete.run(s.id);
    }
  }
  next();
}
function requireUser(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Veuillez vous connecter' });
}
setInterval(() => q.sessionPurge.run(Date.now()), 6 * 3600 * 1000).unref();

// Anti-force brute très simple, par adresse IP
const attempts = new Map();
function tooManyAttempts(req) {
  const rec = attempts.get(req.ip) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = Date.now(); }
  attempts.set(req.ip, rec);
  return rec.n >= 10;
}
const failAttempt = (req) => { attempts.get(req.ip).n++; };

// ---------- Mise en forme des listes et articles ----------
// Sur ses propres listes en « mode surprise », on ne voit pas ce qui a été réservé.
const hidesFrom = (list, user) => !!(list.surprise && user && list.owner_id === user.id);

function formatList(list, user) {
  const out = { ...list, is_owner: !!user && list.owner_id === user.id };
  if (hidesFrom(list, user)) out.chosen_count = null;
  return out;
}
function formatItem(item, list, user) {
  if (hidesFrom(list, user)) {
    const { chosen, chosen_by, chosen_by_user, chosen_at, ...rest } = item;
    return { ...rest, chosen: 0, chosen_by: '', hidden: true };
  }
  return { ...item, chosen_by_me: !!user && item.chosen_by_user === user.id };
}
function ownList(req, res) {
  const list = q.listById.get(Number(req.params.id));
  if (!list) { res.status(404).json({ error: 'Liste introuvable' }); return null; }
  if (list.owner_id !== req.user.id) { res.status(403).json({ error: 'Seul le propriétaire peut modifier cette liste' }); return null; }
  return list;
}
function ownItem(req, res) {
  const item = q.itemById.get(Number(req.params.id));
  if (!item) { res.status(404).json({ error: 'Idée introuvable' }); return null; }
  const list = q.listById.get(item.list_id);
  if (list.owner_id !== req.user.id) { res.status(403).json({ error: 'Seul le propriétaire peut modifier cette idée' }); return null; }
  return item;
}

// ---------- Application ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));
app.use('/api', loadUser);

// --- Comptes ---
app.get('/api/me', (req, res) => {
  res.json({ user: req.user, needsSetup: q.userCount.get().n === 0 });
});

app.get('/api/invite/:token', (req, res) => {
  res.json({ valid: q.userCount.get().n === 0 || req.params.token === inviteToken() });
});

app.post('/api/signup', (req, res) => {
  if (tooManyAttempts(req)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
  const first = q.userCount.get().n === 0;
  if (!first && str(req.body?.invite, 100) !== inviteToken()) {
    failAttempt(req);
    return res.status(403).json({ error: 'Lien d\'invitation invalide. Demandez-en un à un membre de la famille.' });
  }
  const name = str(req.body?.name, 40).replace(/\s+/g, ' ');
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (name.length < 2) return res.status(400).json({ error: 'Le nom doit faire au moins 2 caractères.' });
  if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères.' });
  if (password.length > 200) return res.status(400).json({ error: 'Mot de passe trop long.' });
  if (q.userByName.get(name)) return res.status(409).json({ error: 'Ce nom est déjà pris.' });
  const { lastInsertRowid } = q.insertUser.run(name, hashPassword(password));
  if (first) q.adoptOrphans.run(lastInsertRowid); // récupère les listes créées avant les comptes
  startSession(req, res, lastInsertRowid);
  res.status(201).json({ user: q.userById.get(lastInsertRowid) });
});

app.post('/api/login', (req, res) => {
  if (tooManyAttempts(req)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans 15 minutes.' });
  const user = q.userByName.get(str(req.body?.name, 40).replace(/\s+/g, ' '));
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
  const ok = checkPassword(password, user ? user.pass : DUMMY_HASH) && !!user;
  if (!ok) { failAttempt(req); return res.status(401).json({ error: 'Nom ou mot de passe incorrect' }); }
  attempts.delete(req.ip);
  startSession(req, res, user.id);
  res.json({ user: q.userById.get(user.id) });
});

app.post('/api/logout', (req, res) => {
  if (req.sessionId) q.sessionDelete.run(req.sessionId);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.post('/api/password', requireUser, (req, res) => {
  const current = typeof req.body?.current === 'string' ? req.body.current : '';
  const next = typeof req.body?.next === 'string' ? req.body.next : '';
  if (!checkPassword(current, q.passOf.get(req.user.id).pass)) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  if (next.length < 6 || next.length > 200) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 6 caractères.' });
  q.setPass.run(hashPassword(next), req.user.id);
  q.sessionDeleteOthers.run(req.user.id, req.sessionId); // déconnecte les autres appareils
  res.json({ ok: true });
});

// --- Famille ---
app.get('/api/members', requireUser, (req, res) => res.json(q.members.all()));
app.get('/api/invite', requireUser, (req, res) => res.json({ token: inviteToken() }));
app.post('/api/invite/reset', requireUser, (req, res) => { q.setSetting.run('invite', newToken(12)); res.json({ token: inviteToken() }); });

// --- Listes ---
app.get('/api/lists', requireUser, (req, res) => {
  res.json(q.allLists.all().map((l) => formatList(l, req.user)));
});
app.post('/api/lists', requireUser, (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 120);
  if (!title) return res.status(400).json({ error: 'Le nom de la liste est obligatoire' });
  const { lastInsertRowid } = q.insertList.run(newToken(9), title, str(b.description, 1000),
    b.surprise === false ? 0 : 1, req.user.id, cleanEmoji(b.emoji), cleanDate(b.event_date));
  res.status(201).json(formatList(q.listById.get(lastInsertRowid), req.user));
});
app.get('/api/lists/:id', requireUser, (req, res) => {
  const list = q.listById.get(Number(req.params.id));
  if (!list) return res.status(404).json({ error: 'Liste introuvable' });
  res.json({ ...formatList(list, req.user), items: q.itemsOfList.all(list.id).map((i) => formatItem(i, list, req.user)) });
});
app.patch('/api/lists/:id', requireUser, (req, res) => {
  const list = ownList(req, res); if (!list) return;
  const b = req.body || {};
  q.updateList.run(
    b.title !== undefined ? str(b.title, 120) || list.title : list.title,
    b.description !== undefined ? str(b.description, 1000) : list.description,
    b.surprise !== undefined ? (b.surprise ? 1 : 0) : list.surprise,
    b.emoji !== undefined ? cleanEmoji(b.emoji) : list.emoji,
    b.event_date !== undefined ? cleanDate(b.event_date) : list.event_date,
    list.id,
  );
  res.json(formatList(q.listById.get(list.id), req.user));
});
app.delete('/api/lists/:id', requireUser, (req, res) => {
  const list = ownList(req, res); if (!list) return;
  q.deleteList.run(list.id);
  res.json({ ok: true });
});

// --- Idées ---
app.post('/api/lists/:id/items', requireUser, (req, res) => {
  const list = ownList(req, res); if (!list) return;
  const b = req.body || {};
  const title = str(b.title, 300);
  if (!title) return res.status(400).json({ error: 'Le titre est obligatoire' });
  const { lastInsertRowid } = q.insertItem.run(list.id, title, cleanUrl(str(b.url, 2000)), cleanImage(str(b.image, 2000)), str(b.price, 50), str(b.note, 1000));
  res.status(201).json(q.itemById.get(lastInsertRowid));
});
app.patch('/api/items/:id', requireUser, (req, res) => {
  const item = ownItem(req, res); if (!item) return;
  const b = req.body || {};
  if (b.title !== undefined && !str(b.title, 300)) return res.status(400).json({ error: 'Le titre est obligatoire' });
  const pick = (k, max, fn = (x) => x) => (b[k] !== undefined ? fn(str(b[k], max)) : item[k]);
  q.updateItem.run(pick('title', 300), pick('url', 2000, cleanUrl), pick('image', 2000, cleanImage), pick('price', 50), pick('note', 1000), item.id);
  res.json(q.itemById.get(item.id));
});
app.delete('/api/items/:id', requireUser, (req, res) => {
  const item = ownItem(req, res); if (!item) return;
  q.deleteItem.run(item.id);
  res.json({ ok: true });
});

// Réserver / libérer une idée (membre de la famille connecté)
app.post('/api/items/:id/choose', requireUser, (req, res) => {
  const item = q.itemById.get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Idée introuvable' });
  const list = q.listById.get(item.list_id);
  if (hidesFrom(list, req.user)) return res.status(403).json({ error: 'Mode surprise : vous ne pouvez pas réserver vos propres idées.' });
  const chosen = req.body?.chosen ? 1 : 0;
  if (chosen && item.chosen) return res.status(409).json({ error: `Déjà réservé${item.chosen_by ? ' par ' + item.chosen_by : ''}.` });
  if (!chosen && item.chosen_by_user && item.chosen_by_user !== req.user.id) {
    return res.status(403).json({ error: `Seul(e) ${item.chosen_by} peut annuler cette réservation.` });
  }
  q.chooseItem.run(chosen, chosen ? req.user.name : '', chosen ? req.user.id : null, chosen, item.id);
  res.json(formatItem(q.itemById.get(item.id), list, req.user));
});
app.get('/api/reserved', requireUser, (req, res) => res.json(q.reservedBy.all(req.user.id)));

// Recherche dans toutes les listes de la famille
app.get('/api/search', requireUser, (req, res) => {
  const term = str(req.query.q, 100);
  if (!term) return res.json([]);
  const like = `%${term.replace(/[%_\\]/g, '\\$&')}%`;
  res.json(q.search.all(like, like, like).map((i) => formatItem(i, i, req.user)));
});

// Envoi d'une photo (corps brut, type image/*, 8 Mo max)
app.post('/api/upload', requireUser, express.raw({ type: 'image/*', limit: '8mb' }), (req, res) => {
  const ext = IMAGE_TYPES[(req.headers['content-type'] || '').split(';')[0].trim()];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Format accepté : JPG, PNG, WebP ou GIF' });
  }
  const name = `${newToken(12)}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.status(201).json({ url: `/uploads/${name}` });
});

// Aperçu d'un lien
app.post('/api/preview', requireUser, async (req, res) => {
  const url = str(req.body?.url, 2000);
  if (!isHttpUrl(url)) return res.status(400).json({ error: 'Lien invalide' });
  try {
    const p = await fetchPreview(url);
    res.json({ ...p, title: p.title || titleFromUrl(url) });
  } catch (e) {
    const reason = e.name === 'TimeoutError' ? 'le site met trop de temps à répondre' : (e.message || 'erreur');
    res.json({
      title: titleFromUrl(url), image: '', price: '',
      warning: `Infos non récupérées (${reason}). Vérifiez le titre et ajoutez une photo si vous voulez.`,
    });
  }
});

// --- Lien de partage (personnes sans compte) ---
app.get('/api/share/:slug', (req, res) => {
  const list = q.listBySlug.get(str(req.params.slug, 50));
  if (!list) return res.status(404).json({ error: 'Liste introuvable' });
  const { id, slug, title, description, emoji, event_date, owner_name } = list;
  const items = q.itemsOfList.all(list.id).map(({ chosen_by_user, ...i }) => ({ ...i, by_member: !!chosen_by_user }));
  res.json({ id, slug, title, description, emoji, event_date, owner_name, items });
});
app.post('/api/share/:slug/items/:id/choose', (req, res) => {
  const list = q.listBySlug.get(str(req.params.slug, 50));
  const item = q.itemById.get(Number(req.params.id));
  if (!list || !item || item.list_id !== list.id) return res.status(404).json({ error: 'Idée introuvable' });
  const chosen = req.body?.chosen ? 1 : 0;
  if (chosen && item.chosen) return res.status(409).json({ error: 'Ce cadeau a déjà été réservé par quelqu\'un d\'autre.' });
  if (!chosen && item.chosen_by_user) return res.status(403).json({ error: 'Cette réservation a été faite par un membre de la famille.' });
  q.chooseItem.run(chosen, chosen ? str(req.body?.name, 60) : '', null, chosen, item.id);
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));

// --- Front-end ---
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, setHeaders: (r) => r.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🎁 Wishlist en écoute sur le port ${PORT}`));
