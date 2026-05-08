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
async function getAllUsers() {
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
    const { rows } = await pool.query('SELECT account, password, lang FROM user_passwords');
    for (const row of rows) {
      if (row.account === 'view') {
        users[row.password] = { role: 'view', account: null, lang: row.lang || 'de' };
      } else {
        users[row.password] = { role: 'user', account: row.account, lang: row.lang || 'de' };
      }
    }
  } catch (_) {}

  return users;
}

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
const APP_VERSION = '1.2.1';
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
      'SELECT account, updated_at, lang FROM user_passwords WHERE account = ANY($1)',
      [MANAGED_ACCOUNTS]
    );
    const result = MANAGED_ACCOUNTS.map(a => {
      const found = rows.find(r => r.account === a);
      return { account: a, hasPassword: !!found, updatedAt: found?.updated_at || null, lang: found?.lang || 'de' };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:account/password', adminOnly, async (req, res) => {
  const { account } = req.params;
  const { password } = req.body;
  if (!MANAGED_ACCOUNTS.includes(account)) return res.status(400).json({ error: 'Unbekannter Account' });
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
  if (!MANAGED_ACCOUNTS.includes(account)) return res.status(400).json({ error: 'Unbekannter Account' });
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
  if (!MANAGED_ACCOUNTS.includes(account)) return res.status(400).json({ error: 'Unbekannter Account' });
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

    // Alle aktuellen Transfers löschen und aus Snapshot wiederherstellen
    await pool.query('DELETE FROM transfers');
    for (const t of transfers) {
      await pool.query(
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
    // Sequence zurücksetzen
    await pool.query("SELECT setval('transfers_id_seq', COALESCE((SELECT MAX(id) FROM transfers), 1))");
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
    const raw = await getFullStash(account, 'de');

    // Items normalisieren: itemId → id, icon_url aus CDN ableiten
    const items = raw.map(item => ({
      id: item.itemId || item.id || item.item_id,
      name: item.name,
      quantity: item.quantity ?? item.qty ?? 0,
      icon_url: `https://cdn.arctracker.io/items/v2/${item.itemId || item.id || item.item_id}.png`,
      type: item.type || item.category || null,
      slotIndex: item.slotIndex,
      durabilityPercent: item.durabilityPercent,
    }));

    // Snapshot speichern
    await pool.query(
      'INSERT INTO stash_snapshots (account, snapshot_data) VALUES ($1, $2)',
      [account, JSON.stringify(items)]
    );

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

  const validToAccounts = ['consta', 'junez', 'silverbase'];

  try {
    const inserted = [];
    for (const item of items) {
      // Per-Item to_account hat Vorrang vor Body-Level to_account
      const target = validToAccounts.includes(item.to_account)
        ? item.to_account
        : validToAccounts.includes(to_account) ? to_account : 'silverbase';

      const { rows } = await pool.query(
        `INSERT INTO transfers
          (expedition_label, item_id, item_name, item_name_en, item_type, icon_url, quantity_transferred, from_account, to_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
  try {
    let rows;
    if (role === 'user') {
      ({ rows } = await pool.query(
        `SELECT * FROM transfers WHERE status != 'done' AND to_account = $1 ORDER BY created_at DESC`,
        [account]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT * FROM transfers WHERE status != 'done' ORDER BY created_at DESC`
      ));
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

    const validAccounts = ['consta', 'junez'];
    const entries = Object.entries(assignments)
      .filter(([acct, qty]) => validAccounts.includes(acct) && parseInt(qty) > 0)
      .map(([acct, qty]) => [acct, parseInt(qty)]);

    const total = entries.reduce((s, [, q]) => s + q, 0);
    if (total !== orig.quantity_transferred) {
      return res.status(400).json({ error: `Summe (${total}) ≠ Menge (${orig.quantity_transferred})` });
    }

    if (entries.length === 1) {
      // Nur Account ändern, kein Split
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
           quantity_transferred, from_account, to_account, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [orig.expedition_label, orig.item_id, orig.item_name, orig.item_name_en,
         orig.item_type, orig.icon_url, qty, orig.from_account, acct, orig.created_at]
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
app.delete('/api/transfers/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM transfers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
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
