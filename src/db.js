import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      expedition_label TEXT NOT NULL DEFAULT 'aktuell',
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      item_name_en TEXT,
      item_type TEXT,
      icon_url TEXT,
      quantity_transferred INTEGER NOT NULL,
      quantity_returned INTEGER NOT NULL DEFAULT 0,
      from_account TEXT NOT NULL DEFAULT 'silverbase',
      to_account TEXT NOT NULL DEFAULT 'consta',
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      returned_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS stash_snapshots (
      id SERIAL PRIMARY KEY,
      account TEXT NOT NULL,
      snapshot_data JSONB NOT NULL,
      taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_passwords (
      account TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO app_settings (key, value) VALUES ('default_lang', 'de')
      ON CONFLICT (key) DO NOTHING;
  `);
  console.log('✅ DB initialisiert');
}

export default pool;
