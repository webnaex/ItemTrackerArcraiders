import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pool, { initDB } from './db.js';
import { getFullStash, getProfile } from './arctracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── User-Tabelle (Env + DB) ──────────────────────────────────────────────────
let _usersCache = null;
let _usersCacheAt = 0;
const USERS_CACHE_TTL = 30_000; // 30 Sekunden

async function getAllUsers(force = false) {
  const now = Date.now();
  if (!force && _usersCache && (now - _usersCacheAt) < USERS_CACHE_TTL) {
    return _usersCache;
  }
  // Superadmin kommt immer aus Env
  const users = {
    [process.env.APP_PASSWORD || 'arcraiders']: { role: 'admin', account: null },
  };
  // Env-Fallbacks (falls noch keine DB-Einträge vorhanden)
  if (process.env.PASSWORD_VIEW)   users[process.env.PASSWORD_VIEW]   = { role: 'view', account: null };
  if (process.env.PASSWORD_CONSTA) users[process.env.PASSWORD_CONSTA] = { role: 'user', account: 'consta' };
  if (process.env.PASSWORD_JUNEZ)  users[process.env.PASSWORD_JUNEZ]  = { role: 'user', account: 'junez' };

  // DB-Passwörter überschreiben Env-Werte
  try {
    const { rows } = await pool.query('SELECT account, password, lang, role FROM user_passwords');
    for (const row of rows) {
      const role = row.role || (row.account === 'view' ? 'view' : 'user');
      const account = role === 'view' ? null : row.account;
      users[row.password] = { role, account, lang: row.lang || 'de' };
    }
  } catch (_) {}

  _usersCache = users;
  _usersCacheAt = now;
  return users;
}

// Cache invalidieren nach User-Änderungen
function invalidateUsersCache() { _usersCache = null; }

// ─── Public Settings (vor Middleware!) ───────────────────────────────────────
app.get('/api/settings/public', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'default_lang'");
    res.json({ default_lang: rows[0]?.value || 'de' });
  } catch (_) {
    res.json({ default_lang: 'de' });
  }
});

// ─── Version (public) ────────────────────────────────────────────────────────
const APP_VERSION = '2.0.17';
const SERVER_START = new Date().toISOString();
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION, timestamp: SERVER_START });
});


// ─── Auth Endpoint (vor Middleware!) ──────────────────────────────────────────
app.post('/api/auth', async (req, res) => {
  const { password } = req.body;
  const users = await getAllUsers();
  const user = users[password];
  if (!user) return res.status(401).json({ error: 'Falsches Passwort' });
  res.json(user);
});

// ─── Auth Middleware ───────────────────────────────────────────────────────────
app.use('/api', async (req, res, next) => {
  const pw = req.headers['x-app-password'];
  const users = await getAllUsers();
  const user = users[pw];
  if (!user) return res.status(401).json({ error: 'Falsches Passwort' });
  req.user = user;
  next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Nur Admins erlaubt' });
  next();
}

function notView(req, res, next) {
  if (req.user.role === 'view') return res.status(403).json({ error: 'Keine Schreibrechte' });
  next();
}

// ─── Admin: User-Passwörter verwalten ─────────────────────────────────────────
const MANAGED_ACCOUNTS = ['view', 'consta', 'junez'];

app.get('/api/admin/users', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT account, updated_at, lang, role FROM user_passwords ORDER BY updated_at ASC'
    );
    const result = rows.map(r => ({
      account: r.account,
      hasPassword: true,
      updatedAt: r.updated_at,
      lang: r.lang || 'de',
      role: r.role || 'user',
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Neuen User anlegen ───────────────────────────────────────────────────────
app.post('/api/admin/users', adminOnly, async (req, res) => {
  const { account, password, role } = req.body;
  if (!account || !/^[a-z0-9_]+$/.test(account)) return res.status(400).json({ error: 'Ungültiger Accountname (nur a-z, 0-9, _)' });
  if (!password || password.length < 3) return res.status(400).json({ error: 'Passwort zu kurz (min. 3 Zeichen)' });
  const validRole = ['user', 'view'].includes(role) ? role : 'user';
  try {
    await pool.query(
      `INSERT INTO user_passwords (account, password, role, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (account) DO UPDATE SET password = $2, role = $3, updated_at = NOW()`,
      [account, password, validRole]
    );
    invalidateUsersCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User löschen ─────────────────────────────────────────────────────────────
app.delete('/api/admin/users/:account', adminOnly, async (req, res) => {
  const { account } = req.params;
  try {
    await pool.query('DELETE FROM user_passwords WHERE account = $1', [account]);
    invalidateUsersCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:account/password', adminOnly, async (req, res) => {
  const { account } = req.params;
  const { password } = req.body;
  if (!password || password.length < 3) return res.status(400).json({ error: 'Passwort zu kurz (min. 3 Zeichen)' });

  try {
    await pool.query(
      `INSERT INTO user_passwords (account, password, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (account) DO UPDATE SET password = $2, updated_at = NOW()`,
      [account, password]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:account/password', adminOnly, async (req, res) => {
  const { account } = req.params;
  try {
    await pool.query('DELETE FROM user_passwords WHERE account = $1', [account]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:account/lang', adminOnly, async (req, res) => {
  const { account } = req.params;
  const { lang } = req.body;
  if (!['de', 'en'].includes(lang)) return res.status(400).json({ error: 'Ungültige Sprache' });
  try {
    // Nur updaten wenn Account existiert - kein INSERT mit leerem Passwort
    const { rowCount } = await pool.query(
      `UPDATE user_passwords SET lang = $1, updated_at = NOW() WHERE account = $2`,
      [lang, account]
    );
    if (rowCount === 0) {
      return res.status(400).json({ error: 'Account hat noch kein Passwort gesetzt' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: App-Einstellungen ────────────────────────────────────────────────
app.get('/api/admin/settings', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/settings', adminOnly, async (req, res) => {
  const { key, value } = req.body;
  const allowedKeys = ['default_lang'];
  if (!allowedKeys.includes(key)) return res.status(400).json({ error: 'Ungültiger Key' });
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backup / Snapshot ───────────────────────────────────────────────────────
app.get('/api/admin/backups', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, label, created_at FROM transfer_backups ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/backups', adminOnly, async (req, res) => {
  const { label } = req.body;
  try {
    const { rows: transfers } = await pool.query('SELECT * FROM transfers ORDER BY created_at');
    const ts = new Date();
    const autoLabel = label?.trim() ||
      `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}_${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}`;
    const { rows } = await pool.query(
      'INSERT INTO transfer_backups (label, snapshot) VALUES ($1, $2) RETURNING id, label, created_at',
      [autoLabel, JSON.stringify(transfers)]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/backups/:id/restore', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT snapshot FROM transfer_backups WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Backup nicht gefunden' });
    const transfers = rows[0].snapshot;

    // Alle aktuellen Transfers löschen und aus Snapshot wiederherstellen (in Transaktion)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM transfers');
      for (const t of transfers) {
        await client.query(
          `INSERT INTO transfers
            (id, expedition_label, item_id, item_name, item_name_en, item_type, icon_url,
             quantity_transferred, quantity_returned, from_account, to_account,
             status, notes, created_at, returned_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO NOTHING`,
          [t.id, t.expedition_label, t.item_id, t.item_name, t.item_name_en, t.item_type,
           t.icon_url, t.quantity_transferred, t.quantity_returned, t.from_account,
           t.to_account, t.status, t.notes, t.created_at, t.returned_at]
        );
      }
      await client.query("SELECT setval('transfers_id_seq', COALESCE((SELECT MAX(id) FROM transfers), 1))");
      await client.query('COMMIT');
    } catch (restoreErr) {
      await client.query('ROLLBACK');
      throw restoreErr;
    } finally {
      client.release();
    }
    res.json({ success: true, count: transfers.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/backups/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM transfer_backups WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Stash laden (Admin only) ─────────────────────────────────────────────────
app.get('/api/stash/:account', adminOnly, async (req, res) => {
  const { account } = req.params;
  if (!['consta', 'silverbase'].includes(account)) {
    return res.status(400).json({ error: 'Unbekannter Account' });
  }

  try {
    // Beide Locales parallel laden für bilinguale Itemnamen
    const [rawDe, rawEn] = await Promise.all([
      getFullStash(account, 'de'),
      getFullStash(account, 'en'),
    ]);

    // EN-Namen per itemId indexieren
    const enNames = {};
    rawEn.forEach(item => {
      const id = item.itemId || item.id || item.item_id;
      if (id) enNames[id] = item.name;
    });

    // Items normalisieren: itemId → id, icon_url aus CDN ableiten
    // maxStack pro Item aus Stash ableiten: max(qty) über alle Slots des gleichen Items
    const maxStackByItemId = {};
    rawDe.forEach(item => {
      const id = item.itemId || item.id || item.item_id;
      const qty = item.quantity ?? item.qty ?? 0;
      if (id && qty > (maxStackByItemId[id] || 0)) maxStackByItemId[id] = qty;
    });

    const items = rawDe.map(item => {
      const id = item.itemId || item.id || item.item_id;
      return {
        id,
        name: { de: item.name, en: enNames[id] || item.name },
        quantity: item.quantity ?? item.qty ?? 0,
        icon_url: `https://cdn.arctracker.io/items/v2/${id}.png`,
        type: item.type || item.category || null,
        slotIndex: item.slotIndex,
        durabilityPercent: item.durabilityPercent,
        maxStack: maxStackByItemId[id] || 1,
      };
    });

    // Snapshot speichern
    await pool.query(
      'INSERT INTO stash_snapshots (account, snapshot_data) VALUES ($1, $2)',
      [account, JSON.stringify(items)]
    );

    // max_stack für bestehende Transfers aktualisieren (anhand item_id)
    for (const [itemId, ms] of Object.entries(maxStackByItemId)) {
      if (ms > 1) {
        await pool.query(
          `UPDATE transfers SET max_stack = $1 WHERE item_id = $2 AND is_stackable = true`,
          [ms, itemId]
        ).catch(() => {});
      }
    }

    res.json({ account, items, count: items.length });
  } catch (err) {
    console.error('Stash Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Transfer erstellen (Admin only) ─────────────────────────────────────────
app.post('/api/transfers', adminOnly, async (req, res) => {
  const { expedition_label, to_account, items } = req.body;

  if (!items?.length) return res.status(400).json({ error: 'Keine Items angegeben' });

  // Erlaubte Empfänger: alle User-Accounts aus der DB + silverbase
  const { rows: userRows } = await pool.query("SELECT account FROM user_passwords WHERE role = 'user'");
  const validToAccounts = ['silverbase', ...userRows.map(r => r.account)];

  try {
    const inserted = [];
    // Aktuell reservierte Mengen pro item_id laden
    const { rows: reservedRows } = await pool.query(
      `SELECT item_id, SUM(quantity_transferred) AS reserved
       FROM transfers WHERE status NOT IN ('done','deleted') GROUP BY item_id`
    );
    const reservedMap = {};
    reservedRows.forEach(r => { reservedMap[r.item_id] = parseInt(r.reserved); });

    for (const item of items) {
      // Per-Item to_account hat Vorrang vor Body-Level to_account
      const target = validToAccounts.includes(item.to_account)
        ? item.to_account
        : validToAccounts.includes(to_account) ? to_account : 'silverbase';

      const { rows } = await pool.query(
        `INSERT INTO transfers
          (expedition_label, item_id, item_name, item_name_en, item_type, icon_url, quantity_transferred, from_account, to_account, is_stackable, max_stack)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          expedition_label || 'aktuell',
          item.id,
          item.name,
          item.name_en || null,
          item.type || null,
          item.icon_url || null,
          item.quantity,
          'silverbase',
          target,
          item.is_stackable !== false,
          (item.is_stackable !== false) ? (item.maxStack ?? 1) : 1,
        ]
      );
      inserted.push(rows[0]);
    }

    res.json({ success: true, transfers: inserted });
  } catch (err) {
    console.error('Transfer Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Aktive Transfers abrufen ──────────────────────────────────────────────────
app.get('/api/transfers', async (req, res) => {
  const { role, account } = req.user;
  const showAll = req.query.all === '1';
  try {
    let rows;
    if (role === 'user') {
      const q = showAll
        ? `SELECT * FROM transfers WHERE to_account = $1 ORDER BY created_at DESC`
        : `SELECT * FROM transfers WHERE status NOT IN ('done','deleted') AND to_account = $1 ORDER BY created_at DESC`;
      ({ rows } = await pool.query(q, [account]));
    } else {
      const q = showAll
        ? `SELECT * FROM transfers ORDER BY created_at DESC`
        : `SELECT * FROM transfers WHERE status NOT IN ('done','deleted') ORDER BY created_at DESC`;
      ({ rows } = await pool.query(q));
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Transfer History ─────────────────────────────────────────────────────────
app.get('/api/transfers/history', async (req, res) => {
  const { role, account } = req.user;
  try {
    let rows;
    if (role === 'user') {
      ({ rows } = await pool.query(
        `SELECT * FROM transfers WHERE to_account = $1 ORDER BY created_at DESC LIMIT 200`,
        [account]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT * FROM transfers ORDER BY created_at DESC LIMIT 200`
      ));
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Item als zurückgegeben markieren (Admin + User) ──────────────────────────
app.patch('/api/transfers/:id/return', notView, async (req, res) => {
  const { id } = req.params;
  const { quantity } = req.body;
  const { role, account } = req.user;

  try {
    if (role === 'user') {
      const check = await pool.query('SELECT to_account FROM transfers WHERE id = $1', [id]);
      if (!check.rows.length || check.rows[0].to_account !== account) {
        return res.status(403).json({ error: 'Nicht dein Item' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE transfers
       SET quantity_returned = $1,
           status = CASE WHEN $1 >= quantity_transferred THEN 'done' ELSE 'partial' END,
           returned_at = CASE WHEN $1 >= quantity_transferred THEN NOW() ELSE NULL END
       WHERE id = $2
       RETURNING *`,
      [quantity, id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Transfer nicht gefunden' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Transfer zuteilen / splitten (Admin only) ────────────────────────────────
app.post('/api/transfers/:id/assign', adminOnly, async (req, res) => {
  const { id } = req.params;
  const { assignments } = req.body; // { consta: 2, junez: 1 }

  try {
    const { rows } = await pool.query('SELECT * FROM transfers WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Transfer nicht gefunden' });
    const orig = rows[0];

    const { rows: aRows } = await pool.query("SELECT account FROM user_passwords WHERE role = 'user'");
    const validAccounts = aRows.map(r => r.account);
    const entries = Object.entries(assignments)
      .filter(([acct, qty]) => validAccounts.includes(acct) && parseInt(qty) > 0)
      .map(([acct, qty]) => [acct, parseInt(qty)]);

    const total = entries.reduce((s, [, q]) => s + q, 0);
    if (total > orig.quantity_transferred) {
      return res.status(400).json({ error: `Summe (${total}) > Menge (${orig.quantity_transferred})` });
    }
    if (total === 0) {
      return res.json({ transfers: [orig] });
    }

    const remainder = orig.quantity_transferred - total;

    // Wenn alles auf einen Account und kein Rest → nur Account updaten
    if (entries.length === 1 && remainder === 0) {
      const [acct] = entries[0];
      const { rows: updated } = await pool.query(
        'UPDATE transfers SET to_account = $1 WHERE id = $2 RETURNING *',
        [acct, id]
      );
      return res.json({ transfers: updated });
    }

    // Split: Original löschen, neue Transfers pro Account anlegen
    await pool.query('DELETE FROM transfers WHERE id = $1', [id]);
    const created = [];
    for (const [acct, qty] of entries) {
      const { rows: r } = await pool.query(
        `INSERT INTO transfers
          (expedition_label, item_id, item_name, item_name_en, item_type, icon_url,
           quantity_transferred, from_account, to_account, is_stackable, max_stack, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [orig.expedition_label, orig.item_id, orig.item_name, orig.item_name_en,
         orig.item_type, orig.icon_url, qty, orig.from_account, acct, orig.is_stackable, orig.max_stack ?? 1, orig.created_at]
      );
      created.push(r[0]);
    }
    // Rest bleibt als eigener Transfer ohne spezifischen Empfänger (to_account = from_account)
    if (remainder > 0) {
      const { rows: r } = await pool.query(
        `INSERT INTO transfers
          (expedition_label, item_id, item_name, item_name_en, item_type, icon_url,
           quantity_transferred, from_account, to_account, is_stackable, max_stack, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [orig.expedition_label, orig.item_id, orig.item_name, orig.item_name_en,
         orig.item_type, orig.icon_url, remainder, orig.from_account, orig.from_account, orig.is_stackable, orig.max_stack ?? 1, orig.created_at]
      );
      created.push(r[0]);
    }
    res.json({ transfers: created });
  } catch (err) {
    console.error('Assign Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Return rückgängig machen (Admin + User) ─────────────────────────────────
app.post('/api/transfers/:id/undo-return', notView, async (req, res) => {
  const { id } = req.params;
  const { role, account } = req.user;
  try {
    if (role === 'user') {
      const check = await pool.query('SELECT to_account FROM transfers WHERE id = $1', [id]);
      if (!check.rows.length || check.rows[0].to_account !== account)
        return res.status(403).json({ error: 'Nicht dein Item' });
    }
    const { rows } = await pool.query(
      `UPDATE transfers
       SET quantity_returned = 0, status = 'pending', returned_at = NULL
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transfer nicht gefunden' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Notiz speichern (Admin + User) ──────────────────────────────────────────
app.patch('/api/transfers/:id/notes', notView, async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;
  const { role, account } = req.user;
  try {
    if (role === 'user') {
      const check = await pool.query('SELECT to_account FROM transfers WHERE id = $1', [id]);
      if (!check.rows.length || check.rows[0].to_account !== account)
        return res.status(403).json({ error: 'Nicht dein Item' });
    }
    const { rows } = await pool.query(
      'UPDATE transfers SET notes = $1 WHERE id = $2 RETURNING *',
      [notes ?? null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transfer nicht gefunden' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Alle Transfers als erledigt markieren (Admin only) ───────────────────────
app.post('/api/transfers/return-all', adminOnly, async (req, res) => {
  try {
    await pool.query(
      `UPDATE transfers
       SET status = 'done',
           quantity_returned = quantity_transferred,
           returned_at = NOW()
       WHERE status != 'done'`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Transfer löschen (Admin only) ───────────────────────────────────────────
// ─── Itemnamen EN backfill (Admin) ───────────────────────────────────────────
app.post('/api/transfers/backfill-names', adminOnly, async (req, res) => {
  try {
    const rawEn = await getFullStash('silverbase', 'en');
    const enNames = {};
    rawEn.forEach(item => {
      const id = item.itemId || item.id || item.item_id;
      if (id && item.name) enNames[id] = item.name;
    });

    let updated = 0;
    for (const [itemId, nameEn] of Object.entries(enNames)) {
      const { rowCount } = await pool.query(
        `UPDATE transfers SET item_name_en = $1 WHERE item_id = $2 AND (item_name_en IS NULL OR item_name_en = '')`,
        [nameEn, itemId]
      );
      updated += rowCount;
    }
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Waffen-Transfers aufteilen (Admin) ──────────────────────────────────────
app.post('/api/admin/transfers/split-weapons', adminOnly, async (req, res) => {
  try {
    // 1) Stash holen um Waffen-IDs zu ermitteln (durabilityPercent != null)
    const rawDe = await getFullStash('silverbase', 'de');
    const weaponIds = new Set(
      rawDe
        .filter(item => item.durabilityPercent != null)
        .map(item => item.itemId || item.id || item.item_id)
        .filter(Boolean)
    );

    if (weaponIds.size === 0) {
      return res.json({ marked: 0, split: 0, message: 'Keine Waffen im Stash gefunden' });
    }

    // 2) is_stackable = false für alle Waffen-Transfers setzen
    const { rowCount: marked } = await pool.query(
      `UPDATE transfers SET is_stackable = false
       WHERE item_id = ANY($1) AND is_stackable = true`,
      [Array.from(weaponIds)]
    );

    // 3) Transfers mit qty > 1 die Waffen sind aufteilen
    const { rows: toSplit } = await pool.query(
      `SELECT * FROM transfers
       WHERE is_stackable = false AND quantity_transferred > 1
         AND status NOT IN ('done', 'deleted')`
    );

    let splitCount = 0;
    for (const row of toSplit) {
      const qty = row.quantity_transferred;
      // Original auf qty=1 setzen
      await pool.query(
        `UPDATE transfers SET quantity_transferred = 1 WHERE id = $1`,
        [row.id]
      );
      // (qty - 1) neue Zeilen anlegen
      for (let i = 1; i < qty; i++) {
        await pool.query(
          `INSERT INTO transfers
             (expedition_label, item_id, item_name, item_name_en, item_type, icon_url,
              quantity_transferred, from_account, to_account, is_stackable, status)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,false,$9)`,
          [row.expedition_label, row.item_id, row.item_name, row.item_name_en,
           row.item_type, row.icon_url, row.from_account, row.to_account, row.status]
        );
        splitCount++;
      }
    }

    res.json({ marked, split: splitCount, weapons: weaponIds.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Duplikate zusammenführen ─────────────────────────────────────────────────
app.post('/api/transfers/merge-duplicates', adminOnly, async (req, res) => {
  try {
    // Zuerst: is_stackable reparieren basierend auf Itemname (Waffen = röm. Zahlen am Ende)
    await pool.query(`UPDATE transfers SET is_stackable = false WHERE item_name ~ '\\s(IV|III|II|I)$' AND is_stackable = true`).catch(() => {});
    await pool.query(`UPDATE transfers SET is_stackable = true WHERE item_name !~ '\\s(IV|III|II|I)$' AND is_stackable = false`).catch(() => {});

    // Nur stapelbare Items zusammenführen (keine Waffen/Aufsätze)
    const { rows: groups } = await pool.query(`
      SELECT item_name, to_account, expedition_label,
             array_agg(id ORDER BY created_at) AS ids,
             SUM(quantity_transferred) AS total_qty
      FROM transfers
      WHERE status = 'pending' AND is_stackable = true
      GROUP BY item_name, to_account, expedition_label
      HAVING COUNT(*) > 1
    `);
    let merged = 0;
    for (const g of groups) {
      const [keepId, ...removeIds] = g.ids;
      await pool.query(
        `UPDATE transfers SET quantity_transferred = $1 WHERE id = $2`,
        [g.total_qty, keepId]
      );
      await pool.query(
        `DELETE FROM transfers WHERE id = ANY($1)`,
        [removeIds]
      );
      merged += removeIds.length;
    }
    res.json({ merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/transfers/:id', adminOnly, async (req, res) => {
  try {
    // Soft-delete: Status auf 'deleted' setzen statt wirklich löschen
    await pool.query(
      `UPDATE transfers SET status = 'deleted', deleted_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Alle Transfers löschen (Admin Reset) ────────────────────────────────────
app.delete('/api/admin/transfers/all', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM transfers');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Debug: max_stack forcieren ──────────────────────────────────────────────
app.post('/api/admin/fix-max-stack', adminOnly, async (req, res) => {
  try {
    // 1. Snapshots prüfen
    const { rows: snaps } = await pool.query(`
      SELECT DISTINCT ON (account) account, taken_at,
        jsonb_array_length(snapshot_data) AS item_count
      FROM stash_snapshots ORDER BY account, taken_at DESC
    `);

    // 2. max_stack aus Snapshots ableiten und updaten
    const { rows: snapData } = await pool.query(`
      SELECT DISTINCT ON (account) account, snapshot_data
      FROM stash_snapshots ORDER BY account, taken_at DESC
    `);

    let updated = 0;
    const maxStackMap = {};
    for (const snap of snapData) {
      const items = Array.isArray(snap.snapshot_data) ? snap.snapshot_data : [];
      items.forEach(item => {
        const id = item.id || item.item_id;
        const qty = item.quantity ?? item.qty ?? 0;
        if (id && qty > (maxStackMap[id] || 0)) maxStackMap[id] = qty;
      });
    }

    for (const [itemId, ms] of Object.entries(maxStackMap)) {
      if (ms > 1) {
        const r = await pool.query(
          `UPDATE transfers SET max_stack = $1 WHERE item_id = $2 AND is_stackable = true AND max_stack < $1`,
          [ms, itemId]
        );
        updated += r.rowCount;
      }
    }

    // 3. Aktuelle Verteilung ausgeben
    const { rows: dist } = await pool.query(`
      SELECT max_stack, COUNT(*) AS cnt FROM transfers
      WHERE status IN ('pending','partial') AND is_stackable = true
      GROUP BY max_stack ORDER BY max_stack
    `);

    // Snapshot-Sample ausgeben zur Diagnose
    const { rows: snapSample } = await pool.query(`
      SELECT DISTINCT ON (account) account, taken_at,
        (snapshot_data->0)::text AS first_item,
        jsonb_array_length(snapshot_data) AS total_items,
        (SELECT COUNT(*) FROM jsonb_array_elements(snapshot_data) e WHERE (e->>'quantity')::int > 1) AS items_with_qty_gt1
      FROM stash_snapshots ORDER BY account, taken_at DESC
    `);

    // Transfers mit item_id prüfen die im Snapshot sind
    const matchingIds = Object.keys(maxStackMap).slice(0, 5);
    const { rows: transferSample } = matchingIds.length > 0
      ? await pool.query(`SELECT item_id, item_name, max_stack, quantity_transferred FROM transfers WHERE item_id = ANY($1) LIMIT 10`, [matchingIds])
      : { rows: [] };

    res.json({ snapshots: snaps, snapSample, maxStackSample: Object.entries(maxStackMap).filter(([,v])=>v>1).slice(0,10), updated, distribution: dist, transferSample });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Slot-Statistik ──────────────────────────────────────────────────────────
app.get('/api/stats/slots', async (req, res) => {
  const TOTAL_SLOTS = 280;
  try {
    // Slots = CEIL(qty / max_stack) pro Transfer – korrekt für gestapelte Items
    const { rows } = await pool.query(`
      SELECT to_account,
        SUM(CEIL(quantity_transferred::numeric / GREATEST(COALESCE(max_stack, 1), 1)))::int AS slots
      FROM transfers
      WHERE status IN ('pending', 'partial')
      GROUP BY to_account
      ORDER BY slots DESC
    `);
    const usedPerUser = rows.map(r => ({ account: r.to_account, slots: parseInt(r.slots) || 0 }));
    const totalUsed = usedPerUser.reduce((s, r) => s + r.slots, 0);
    res.json({ totalSlots: TOTAL_SLOTS, totalUsed, free: TOTAL_SLOTS - totalUsed, perUser: usedPerUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Gelöschten Transfer wiederherstellen ────────────────────────────────────
app.post('/api/transfers/:id/restore', adminOnly, async (req, res) => {
  try {
    await pool.query(
      `UPDATE transfers SET status = 'pending', deleted_at = NULL WHERE id = $1 AND status = 'deleted'`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Transfer aufteilen (qty > 1 → N×qty 1) ─────────────────────────────────
app.post('/api/transfers/:id/split', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM transfers WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    const row = rows[0];
    const qty = row.quantity_transferred;
    if (qty <= 1) return res.json({ split: 0, message: 'Bereits qty=1' });

    // Original auf qty=1 setzen (is_stackable bleibt unverändert)
    await pool.query(
      `UPDATE transfers SET quantity_transferred = 1 WHERE id = $1`,
      [row.id]
    );
    // (qty - 1) neue Zeilen mit gleichem is_stackable
    for (let i = 1; i < qty; i++) {
      await pool.query(
        `INSERT INTO transfers
           (expedition_label, item_id, item_name, item_name_en, item_type, icon_url,
            quantity_transferred, from_account, to_account, is_stackable, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11)`,
        [row.expedition_label, row.item_id, row.item_name, row.item_name_en,
         row.item_type, row.icon_url, row.from_account, row.to_account,
         row.is_stackable, row.status, row.notes]
      );
    }
    res.json({ split: qty - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Gelöschte Transfers permanent entfernen ─────────────────────────────────
app.delete('/api/admin/transfers/deleted', adminOnly, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM transfers WHERE status = 'deleted'`);
    res.json({ removed: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Server starten ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 TransferTracker läuft auf Port ${PORT}`);
  });
}).catch(err => {
  console.error('❌ DB Init fehlgeschlagen:', err);
  process.exit(1);
});
