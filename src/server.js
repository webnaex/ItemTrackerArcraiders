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

// ─── Auth Middleware ───────────────────────────────────────────────────────────
const APP_PASSWORD = process.env.APP_PASSWORD || 'arcraiders';

app.use('/api', (req, res, next) => {
  const auth = req.headers['x-app-password'];
  if (auth !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  next();
});

// ─── Stash laden ──────────────────────────────────────────────────────────────
app.get('/api/stash/:account', async (req, res) => {
  const { account } = req.params;
  if (!['consta', 'silverbase'].includes(account)) {
    return res.status(400).json({ error: 'Unbekannter Account' });
  }

  try {
    const items = await getFullStash(account, 'de');

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

// ─── Transfer erstellen ───────────────────────────────────────────────────────
app.post('/api/transfers', async (req, res) => {
  const { expedition_label, items } = req.body;

  if (!items?.length) return res.status(400).json({ error: 'Keine Items angegeben' });

  try {
    const inserted = [];
    for (const item of items) {
      const { rows } = await pool.query(
        `INSERT INTO transfers
          (expedition_label, item_id, item_name, item_name_en, item_type, icon_url, quantity_transferred)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          expedition_label || 'aktuell',
          item.id,
          item.name,
          item.name_en || null,
          item.type || null,
          item.icon_url || null,
          item.quantity,
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
  try {
    const { rows } = await pool.query(
      `SELECT * FROM transfers WHERE status != 'done' ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Transfer History ─────────────────────────────────────────────────────────
app.get('/api/transfers/history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM transfers ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Item als zurückgegeben markieren ─────────────────────────────────────────
app.patch('/api/transfers/:id/return', async (req, res) => {
  const { id } = req.params;
  const { quantity } = req.body;

  try {
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

// ─── Alle Transfers als erledigt markieren ────────────────────────────────────
app.post('/api/transfers/return-all', async (req, res) => {
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

// ─── Transfer löschen ────────────────────────────────────────────────────────
app.delete('/api/transfers/:id', async (req, res) => {
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
