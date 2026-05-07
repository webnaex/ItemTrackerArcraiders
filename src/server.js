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

// ─── User-Tabelle ─────────────────────────────────────────────────────────────
function getUsers() {
  return {
    [process.env.APP_PASSWORD || 'arcraiders']:   { role: 'admin',  account: null },
    [process.env.PASSWORD_VIEW  || 'arc']:         { role: 'view',   account: null },
    ...(process.env.PASSWORD_CONSTA ? { [process.env.PASSWORD_CONSTA]: { role: 'user', account: 'consta' } } : {}),
    ...(process.env.PASSWORD_JUNEZ  ? { [process.env.PASSWORD_JUNEZ]:  { role: 'user', account: 'junez'  } } : {}),
  };
}

// ─── Auth Endpoint (vor Middleware!) ──────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  const user = getUsers()[password];
  if (!user) return res.status(401).json({ error: 'Falsches Passwort' });
  res.json(user);
});

// ─── Auth Middleware ───────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  const pw = req.headers['x-app-password'];
  const user = getUsers()[pw];
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

  const validToAccounts = ['consta', 'junez'];
  const targetAccount = validToAccounts.includes(to_account) ? to_account : 'consta';

  try {
    const inserted = [];
    for (const item of items) {
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
          targetAccount,
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
      // User sieht nur seine eigenen Items
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
    // User darf nur seine eigenen Items zurückgeben
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
