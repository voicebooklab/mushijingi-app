const path = require('path');
const { createClient } = require('@libsql/client');

// 環境変数があればクラウド(Turso)へ、無ければ今まで通りパソコン内のファイルへ保存する。
// ローカルでの使い方（`npm start`）は今まで通り一切変わらない。
const url = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'data', 'data.sqlite')}`;
const authToken = process.env.TURSO_AUTH_TOKEN; // ローカルの時は不要

const client = createClient(authToken ? { url, authToken } : { url });

// 既存のserver.js側のコード（db.prepare(sql).get/all/run(...)、db.exec(sql)）を
// なるべく変えずに済むよう、node:sqlite相当の見た目のラッパーを用意する。
// 違いは「非同期になった＝awaitが必要」という1点だけ。
function normalizeRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

const db = {
  prepare(sql) {
    return {
      async get(...args) {
        const rs = await client.execute({ sql, args });
        return normalizeRow(rs.rows[0]);
      },
      async all(...args) {
        const rs = await client.execute({ sql, args });
        return rs.rows.map(normalizeRow);
      },
      async run(...args) {
        const rs = await client.execute({ sql, args });
        return {
          changes: Number(rs.rowsAffected),
          lastInsertRowid: rs.lastInsertRowid === undefined ? undefined : Number(rs.lastInsertRowid),
        };
      },
    };
  },
  async exec(sql) {
    // 複数文（; 区切り）にも単一文にも対応
    await client.executeMultiple(sql);
  },
};

async function ensureColumn(table, column, type) {
  const rs = await client.execute(`PRAGMA table_info(${table})`);
  const cols = rs.rows.map((c) => c.name);
  if (!cols.includes(column)) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

async function init() {
  await client.execute('PRAGMA foreign_keys = ON;');

  await client.executeMultiple(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sets (
  set_no INTEGER PRIMARY KEY,
  total_cards INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  cost INTEGER,
  hp INTEGER,
  color TEXT,
  rarity TEXT,
  set_no INTEGER NOT NULL,
  attack_text TEXT,
  effect_text TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (set_no) REFERENCES sets(set_no)
);

CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS deck_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  deck_id INTEGER,
  result TEXT,
  memo TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (deck_id) REFERENCES decks(id)
);

CREATE TABLE IF NOT EXISTS tournament_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  match_no INTEGER,
  result TEXT,
  opponent_name TEXT,
  opponent_notes TEXT,
  good_points TEXT,
  improve_points TEXT,
  memo TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE
);
`);

  // cards: 攻撃1/効果1(任意)/攻撃2(任意)/効果2(任意) ＋ 攻略メモ5項目
  await ensureColumn('cards', 'attack1_text', 'TEXT');
  await ensureColumn('cards', 'effect1_text', 'TEXT');
  await ensureColumn('cards', 'attack2_text', 'TEXT');
  await ensureColumn('cards', 'effect2_text', 'TEXT');
  await ensureColumn('cards', 'good_usage_text', 'TEXT');
  await ensureColumn('cards', 'bad_usage_text', 'TEXT');
  await ensureColumn('cards', 'good_matchup_text', 'TEXT');
  await ensureColumn('cards', 'bad_matchup_text', 'TEXT');
  await ensureColumn('cards', 'memo_text', 'TEXT');

  await client.execute(`UPDATE cards SET attack1_text = attack_text WHERE attack1_text IS NULL AND attack_text IS NOT NULL`);
  await client.execute(`UPDATE cards SET effect1_text = effect_text WHERE effect1_text IS NULL AND effect_text IS NOT NULL`);

  await ensureColumn('cards', 'card_type', "TEXT NOT NULL DEFAULT '虫'");
  await ensureColumn('cards', 'spell_effect_text', 'TEXT');
  await ensureColumn('cards', 'boost_modifier_text', 'TEXT');
  await ensureColumn('cards', 'boost_effect_text', 'TEXT');

  await client.execute(`UPDATE cards SET rarity = NULL WHERE rarity IS NOT NULL`);

  await ensureColumn('decks', 'used_period', 'TEXT');
  await ensureColumn('decks', 'tournament_name', 'TEXT');
  await ensureColumn('decks', 'win_count', 'INTEGER');
  await ensureColumn('decks', 'loss_count', 'INTEGER');
  await ensureColumn('decks', 'good_points', 'TEXT');
  await ensureColumn('decks', 'improve_points', 'TEXT');
  await ensureColumn('decks', 'memo', 'TEXT');

  await ensureColumn('tournaments', 'name', 'TEXT');

  const userCountRs = await client.execute('SELECT COUNT(*) AS n FROM users');
  if (Number(userCountRs.rows[0].n) === 0) {
    await client.execute({ sql: 'INSERT INTO users (id, name) VALUES (1, ?)', args: ['default'] });
  }

  const SETS_SEED = [
    [1, 130],
    [2, 55],
    [3, 64],
    [4, 64],
    [5, 64],
    [6, 64],
    [7, 64],
    [8, 64],
  ];
  for (const [setNo, total] of SETS_SEED) {
    await client.execute({
      sql: `INSERT INTO sets (set_no, total_cards) VALUES (?, ?)
            ON CONFLICT(set_no) DO UPDATE SET total_cards = excluded.total_cards`,
      args: [setNo, total],
    });
  }
}

// server.jsはこの初期化が終わるのを待ってから起動する
db.ready = init();
db.client = client; // トランザクションなど、ラッパーでは表現しきれない操作用

module.exports = db;
