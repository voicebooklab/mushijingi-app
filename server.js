const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3456; // 専用ポート（3000は他プロジェクトと衝突するため変更）
const HTTPS_PORT = process.env.HTTPS_PORT || 3457; // スマホ等、他の端末からのオフライン機能・音声入力用
const USER_ID = 1; // v1は単一ユーザー運用（将来ここをセッションのユーザーIDに置き換える）

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 各ルートの中でエラーが起きたときに、ちゃんと拾ってログに出すための小さなラッパー
function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

async function getProgress() {
  const sets = await db.prepare('SELECT set_no, total_cards FROM sets ORDER BY set_no').all();
  const counts = await db.prepare('SELECT set_no, COUNT(*) AS n FROM cards WHERE user_id = ? GROUP BY set_no').all(USER_ID);
  const countMap = {};
  for (const c of counts) countMap[c.set_no] = c.n;
  const bySet = sets.map((s) => {
    const registered = countMap[s.set_no] || 0;
    return {
      set_no: s.set_no,
      total_cards: s.total_cards,
      registered,
      remaining: s.total_cards > 0 ? s.total_cards - registered : null,
    };
  });

  // 全弾合計（総枚数が未設定＝0の弾は合計から除く）
  const withTotal = bySet.filter((s) => s.total_cards > 0);
  const totalCards = withTotal.reduce((sum, s) => sum + s.total_cards, 0);
  const totalRegistered = withTotal.reduce((sum, s) => sum + s.registered, 0);
  const unsetSets = bySet.filter((s) => s.total_cards <= 0).map((s) => s.set_no);
  const overall = {
    total_cards: totalCards,
    registered: totalRegistered,
    remaining: totalCards - totalRegistered,
    unsetSets,
  };

  return { bySet, overall };
}

// ホーム：弾ごとの登録進捗
app.get('/', asyncRoute(async (req, res) => {
  const { bySet, overall } = await getProgress();
  res.render('index', { progress: bySet, overall });
}));

// カード登録フォーム
app.get('/cards/new', asyncRoute(async (req, res) => {
  const sets = await db.prepare('SELECT set_no FROM sets ORDER BY set_no').all();
  res.render('cards_new', { sets, error: null, form: {} });
}));

const CARD_TYPES = ['虫', '術', '強化'];

app.post('/cards', asyncRoute(async (req, res) => {
  const {
    card_type, name, cost, set_no,
    hp, color, attack1_text, effect1_text, attack2_text, effect2_text,
    spell_effect_text,
    boost_modifier_text, boost_effect_text,
    memo_text,
  } = req.body;
  const type = CARD_TYPES.includes(card_type) ? card_type : '虫';

  if (!name || !set_no) {
    const sets = await db.prepare('SELECT set_no FROM sets ORDER BY set_no').all();
    return res.status(400).render('cards_new', {
      sets,
      error: 'カード名と第何弾は必須です。',
      form: req.body,
    });
  }
  await db.prepare(`
    INSERT INTO cards (
      user_id, card_type, name, cost, set_no,
      hp, color, attack1_text, effect1_text, attack2_text, effect2_text,
      spell_effect_text, boost_modifier_text, boost_effect_text, memo_text
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    USER_ID,
    type,
    name,
    cost ? Number(cost) : null,
    Number(set_no),
    type === '虫' && hp ? Number(hp) : null,
    type === '虫' ? (color || null) : null,
    type === '虫' ? (attack1_text || null) : null,
    type === '虫' ? (effect1_text || null) : null,
    type === '虫' ? (attack2_text || null) : null,
    type === '虫' ? (effect2_text || null) : null,
    type === '術' ? (spell_effect_text || null) : null,
    type === '強化' ? (boost_modifier_text || null) : null,
    type === '強化' ? (boost_effect_text || null) : null,
    type !== '虫' ? (memo_text || null) : null
  );
  res.redirect('/cards');
}));

// カード一覧・検索
app.get('/cards', asyncRoute(async (req, res) => {
  const { q, set_no } = req.query;
  let sql = 'SELECT * FROM cards WHERE user_id = ?';
  const params = [USER_ID];
  if (q) {
    sql += ' AND name LIKE ?';
    params.push(`%${q}%`);
  }
  if (set_no) {
    sql += ' AND set_no = ?';
    params.push(Number(set_no));
  }
  sql += ' ORDER BY set_no, id DESC';
  const cards = await db.prepare(sql).all(...params);
  const sets = await db.prepare('SELECT set_no FROM sets ORDER BY set_no').all();
  res.render('cards_list', { cards, sets, q: q || '', set_no: set_no || '' });
}));

// カード詳細（攻略メモ＋大会履歴）
app.get('/cards/:id', asyncRoute(async (req, res) => {
  const card = await db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, USER_ID);
  if (!card) return res.status(404).send('カードが見つかりません');
  // このカードが入っていたデッキが出場した大会（既存の大会・デッキデータを再利用。二重入力なし）
  const history = await db.prepare(`
    SELECT t.date, t.name AS tournament_name, t.result, d.id AS deck_id, d.name AS deck_name
    FROM deck_cards dc
    JOIN decks d ON d.id = dc.deck_id
    JOIN tournaments t ON t.deck_id = d.id
    WHERE dc.card_id = ? AND t.user_id = ?
    ORDER BY t.date DESC
  `).all(card.id, USER_ID);
  res.render('card_detail', { card, history });
}));

app.post('/cards/:id/notes', asyncRoute(async (req, res) => {
  const { good_usage_text, bad_usage_text, good_matchup_text, bad_matchup_text, memo_text } = req.body;
  await db.prepare(`
    UPDATE cards SET good_usage_text = ?, bad_usage_text = ?, good_matchup_text = ?, bad_matchup_text = ?, memo_text = ?
    WHERE id = ? AND user_id = ?
  `).run(
    good_usage_text || null,
    bad_usage_text || null,
    good_matchup_text || null,
    bad_matchup_text || null,
    memo_text || null,
    req.params.id,
    USER_ID
  );
  res.redirect(`/cards/${req.params.id}`);
}));

// デッキ一覧（同じ名前は「別バージョン」としてグループ表示。上書きはしない）
app.get('/decks', asyncRoute(async (req, res) => {
  const decks = await db.prepare('SELECT * FROM decks WHERE user_id = ? ORDER BY name, created_at DESC, id DESC').all(USER_ID);
  const counts = await db.prepare(`
    SELECT deck_id, SUM(quantity) AS n FROM deck_cards GROUP BY deck_id
  `).all();
  const countMap = {};
  for (const c of counts) countMap[c.deck_id] = c.n;

  const groups = [];
  const groupMap = {};
  for (const d of decks) {
    if (!groupMap[d.name]) {
      groupMap[d.name] = { name: d.name, versions: [] };
      groups.push(groupMap[d.name]);
    }
    groupMap[d.name].versions.push(d);
  }
  res.render('decks', { groups, countMap });
}));

// デッキ比較（保存はしない。既存データから都度計算して表示）
app.get('/decks/compare', asyncRoute(async (req, res) => {
  const decks = await db.prepare('SELECT id, name, created_at FROM decks WHERE user_id = ? ORDER BY name, created_at DESC').all(USER_ID);
  const aId = req.query.a ? Number(req.query.a) : null;
  const bId = req.query.b ? Number(req.query.b) : null;
  let result = null;

  if (aId && bId && aId !== bId) {
    const deckA = await db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(aId, USER_ID);
    const deckB = await db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(bId, USER_ID);
    if (deckA && deckB) {
      const getCards = (deckId) => db.prepare(`
        SELECT dc.card_id, dc.quantity, c.name, c.set_no, c.card_type
        FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
        WHERE dc.deck_id = ?
        ORDER BY c.set_no, c.name
      `).all(deckId);
      const cardsA = await getCards(aId);
      const cardsB = await getCards(bId);
      const mapA = {};
      cardsA.forEach((c) => { mapA[c.card_id] = c; });
      const mapB = {};
      cardsB.forEach((c) => { mapB[c.card_id] = c; });

      const common = [];
      const removed = []; // Aにあり、Bに無い
      const changed = []; // 両方にあり枚数が違う
      for (const id in mapA) {
        if (mapB[id]) {
          if (mapA[id].quantity === mapB[id].quantity) {
            common.push(mapA[id]);
          } else {
            changed.push({ name: mapA[id].name, set_no: mapA[id].set_no, card_type: mapA[id].card_type, qtyA: mapA[id].quantity, qtyB: mapB[id].quantity });
          }
        } else {
          removed.push(mapA[id]);
        }
      }
      const added = []; // Bにあり、Aに無い
      for (const id in mapB) {
        if (!mapA[id]) added.push(mapB[id]);
      }
      result = { deckA, deckB, common, removed, added, changed };
    }
  }
  res.render('deck_compare', { decks, aId, bId, result });
}));

// デッキ作成フォーム（短い新規作成用。データ構造は過去デッキ登録と共通）
app.get('/decks/new', asyncRoute(async (req, res) => {
  const cards = await db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY set_no, name').all(USER_ID);
  res.render('deck_new', { cards, error: null, form: {} });
}));

// 過去デッキ登録フォーム（使用時期・大会名・勝敗・良かった点・改善点・メモまで入力）
app.get('/decks/new-past', asyncRoute(async (req, res) => {
  const cards = await db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY set_no, name').all(USER_ID);
  res.render('deck_new_past', { cards, error: null, form: {} });
}));

app.post('/decks', asyncRoute(async (req, res) => {
  const { name, form_type, used_period, tournament_name, win_count, loss_count, good_points, improve_points, memo } = req.body;
  const template = form_type === 'past' ? 'deck_new_past' : 'deck_new';
  if (!name) {
    const cards = await db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY set_no, name').all(USER_ID);
    return res.status(400).render(template, { cards, error: 'デッキ名は必須です。', form: req.body });
  }
  const cardIds = [].concat(req.body.card_id || []);
  const quantities = [].concat(req.body.quantity || []);

  const tx = await db.client.transaction('write');
  let deckId;
  try {
    const result = await tx.execute({
      sql: `INSERT INTO decks (user_id, name, used_period, tournament_name, win_count, loss_count, good_points, improve_points, memo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        USER_ID,
        name,
        used_period || null,
        tournament_name || null,
        win_count !== '' && win_count != null ? Number(win_count) : null,
        loss_count !== '' && loss_count != null ? Number(loss_count) : null,
        good_points || null,
        improve_points || null,
        memo || null,
      ],
    });
    deckId = Number(result.lastInsertRowid);
    for (let i = 0; i < cardIds.length; i++) {
      const qty = Number(quantities[i] || 0);
      if (qty > 0) {
        await tx.execute({
          sql: 'INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)',
          args: [deckId, Number(cardIds[i]), qty],
        });
      }
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
  res.redirect(`/decks/${deckId}`);
}));

// デッキ詳細（このデッキが実際に出場した大会も、既存の大会データから表示）
app.get('/decks/:id', asyncRoute(async (req, res) => {
  const deck = await db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(req.params.id, USER_ID);
  if (!deck) return res.status(404).send('デッキが見つかりません');
  const deckCards = await db.prepare(`
    SELECT dc.quantity, c.* FROM deck_cards dc
    JOIN cards c ON c.id = dc.card_id
    WHERE dc.deck_id = ?
    ORDER BY c.set_no, c.name
  `).all(deck.id);
  const tournamentHistory = await db.prepare(`
    SELECT date, name AS tournament_name, result FROM tournaments
    WHERE deck_id = ? AND user_id = ?
    ORDER BY date DESC
  `).all(deck.id, USER_ID);
  const otherVersions = await db.prepare(`
    SELECT id, created_at, win_count, loss_count FROM decks
    WHERE user_id = ? AND name = ? AND id != ?
    ORDER BY created_at DESC
  `).all(USER_ID, deck.name, deck.id);
  res.render('deck_detail', { deck, deckCards, tournamentHistory, otherVersions });
}));

// 大会・戦績一覧
app.get('/tournaments', asyncRoute(async (req, res) => {
  const tournaments = await db.prepare(`
    SELECT t.*, d.name AS deck_name FROM tournaments t
    LEFT JOIN decks d ON d.id = t.deck_id
    WHERE t.user_id = ?
    ORDER BY t.date DESC, t.id DESC
  `).all(USER_ID);
  res.render('tournaments', { tournaments });
}));

app.get('/tournaments/new', asyncRoute(async (req, res) => {
  const decks = await db.prepare('SELECT * FROM decks WHERE user_id = ? ORDER BY name').all(USER_ID);
  res.render('tournament_new', { decks, error: null, form: {} });
}));

app.post('/tournaments', asyncRoute(async (req, res) => {
  const { date, name, deck_id, result, memo } = req.body;
  if (!date) {
    const decks = await db.prepare('SELECT * FROM decks WHERE user_id = ? ORDER BY name').all(USER_ID);
    return res.status(400).render('tournament_new', { decks, error: '大会日は必須です。', form: req.body });
  }
  await db.prepare(`
    INSERT INTO tournaments (user_id, date, name, deck_id, result, memo)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(USER_ID, date, name || null, deck_id ? Number(deck_id) : null, result || null, memo || null);
  res.redirect('/tournaments');
}));

// 大会詳細＋各試合の記録
app.get('/tournaments/:id', asyncRoute(async (req, res) => {
  const t = await db.prepare(`
    SELECT t.*, d.name AS deck_name FROM tournaments t
    LEFT JOIN decks d ON d.id = t.deck_id
    WHERE t.id = ? AND t.user_id = ?
  `).get(req.params.id, USER_ID);
  if (!t) return res.status(404).send('大会が見つかりません');
  const matches = await db.prepare('SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY id').all(t.id);
  res.render('tournament_detail', { t, matches });
}));

app.post('/tournaments/:id/matches', asyncRoute(async (req, res) => {
  const t = await db.prepare('SELECT id FROM tournaments WHERE id = ? AND user_id = ?').get(req.params.id, USER_ID);
  if (!t) return res.status(404).send('大会が見つかりません');
  const { result, opponent_name, opponent_notes, good_points, improve_points, memo } = req.body;
  const countRow = await db.prepare('SELECT COUNT(*) AS n FROM tournament_matches WHERE tournament_id = ?').get(t.id);
  await db.prepare(`
    INSERT INTO tournament_matches (tournament_id, match_no, result, opponent_name, opponent_notes, good_points, improve_points, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    t.id,
    countRow.n + 1,
    result || null,
    opponent_name || null,
    opponent_notes || null,
    good_points || null,
    improve_points || null,
    memo || null
  );
  res.redirect(`/tournaments/${t.id}`);
}));

// エラーが起きたときに真っ白な画面にしない
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('エラーが発生しました。もう一度お試しください。');
});

async function start() {
  await db.ready; // データベースの準備が終わるまで待つ

  app.listen(PORT, () => {
    console.log(`http://localhost:${PORT} で起動しました`);
  });

  // スマホ等、他の端末からアクセスするとき用のHTTPS（自己署名証明書）。
  const certPath = path.join(__dirname, 'certs', 'cert.pem');
  const keyPath = path.join(__dirname, 'certs', 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    https
      .createServer(
        { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
        app
      )
      .listen(HTTPS_PORT, () => {
        console.log(`https://<このパソコンのIP>:${HTTPS_PORT} で起動しました（スマホ用）`);
      });
  }
}

start().catch((err) => {
  console.error('起動に失敗しました:', err);
  process.exit(1);
});
