// ============================================================
//  База данных мануфактуры «Матрёшка»
//
//  Два режима работы (выбирается автоматически):
//   • ЛОКАЛЬНО (на вашем компьютере) — встроенный SQLite (node:sqlite),
//     файл db.sqlite. Ничего настраивать не нужно.
//   • НА VERCEL (в интернете) — облачная база Turso (libSQL по HTTPS).
//     Включается, если заданы переменные окружения
//     TURSO_DATABASE_URL и TURSO_AUTH_TOKEN.
//
//  Весь остальной код работает через единый асинхронный интерфейс q.*
// ============================================================

'use strict';

const path = require('path');

const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

// rawExecute({ sql, args }) → { rows, lastInsertRowid, rowsAffected }
let rawExecute;
let DRIVER;

if (TURSO_URL) {
  // -------- Продакшн: облачная база Turso (без нативных модулей) --------
  DRIVER = 'turso';
  const { createClient } = require('@libsql/client/web');
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  rawExecute = async ({ sql, args = [] }) => {
    const r = await client.execute({ sql, args });
    return {
      rows: r.rows.map(row => ({ ...row })),
      lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : undefined,
      rowsAffected: r.rowsAffected
    };
  };
} else {
  // -------- Локальная разработка: встроенный SQLite (node:sqlite) --------
  DRIVER = 'sqlite';
  const { DatabaseSync } = require('node:sqlite');
  const sdb = new DatabaseSync(path.join(__dirname, 'db.sqlite'));
  sdb.exec('PRAGMA foreign_keys = ON;');
  sdb.exec('PRAGMA journal_mode = WAL;');
  sdb.exec('PRAGMA busy_timeout = 5000;');
  const isWrite = sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|PRAGMA|BEGIN|COMMIT|ROLLBACK)/i.test(sql);
  rawExecute = async ({ sql, args = [] }) => {
    const stmt = sdb.prepare(sql);
    if (isWrite(sql)) {
      const info = stmt.run(...args);
      return { rows: [], lastInsertRowid: Number(info.lastInsertRowid), rowsAffected: info.changes };
    }
    const rows = stmt.all(...args).map(row => ({ ...row }));
    return { rows, rowsAffected: 0 };
  };
}

// Единый асинхронный интерфейс для запросов
const q = {
  all: async (sql, args = []) => (await rawExecute({ sql, args })).rows,
  get: async (sql, args = []) => { const r = await rawExecute({ sql, args }); return r.rows[0] || null; },
  run: async (sql, args = []) => { const r = await rawExecute({ sql, args }); return { lastInsertRowid: r.lastInsertRowid, rowsAffected: r.rowsAffected }; }
};

// ------------------------------------------------------------
//  Создание таблиц (каждый оператор — отдельно, так требует libSQL)
// ------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    phone         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    addresses     TEXT    DEFAULT '[]',
    favorites     TEXT    DEFAULT '[]',
    created_at    TEXT    DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT    UNIQUE,
    name          TEXT    NOT NULL,
    description   TEXT    DEFAULT '',
    composition   TEXT    DEFAULT '',
    material      TEXT    DEFAULT '',
    price         REAL    NOT NULL,
    category      TEXT    DEFAULT '',
    stock         INTEGER DEFAULT 0,
    is_popular    INTEGER DEFAULT 0,
    images        TEXT    DEFAULT '[]',
    created_at    TEXT    DEFAULT (datetime('now')),
    updated_at    TEXT    DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER,
    customer_name    TEXT    NOT NULL,
    customer_phone   TEXT    NOT NULL,
    delivery_method  TEXT    NOT NULL,
    delivery_address TEXT    DEFAULT '',
    payment_method   TEXT    NOT NULL,
    comment          TEXT    DEFAULT '',
    gift_wrap        INTEGER DEFAULT 0,
    promo_code       TEXT    DEFAULT '',
    status           TEXT    DEFAULT 'Новый',
    total_price      REAL    NOT NULL,
    created_at       TEXT    DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL,
    product_id    INTEGER,
    product_name  TEXT    NOT NULL,
    product_price REAL    NOT NULL,
    quantity      INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL,
    user_id     INTEGER,
    author_name TEXT    DEFAULT 'Покупатель',
    rating      INTEGER NOT NULL,
    text        TEXT    DEFAULT '',
    created_at  TEXT    DEFAULT (datetime('now'))
  )`
];

async function initSchema() {
  for (const stmt of SCHEMA) await rawExecute({ sql: stmt, args: [] });
}

// ------------------------------------------------------------
//  Генератор SVG-заглушки для товаров (data URL, без внешних файлов)
// ------------------------------------------------------------
function svgPlaceholder(title, bg, accent) {
  const safe = String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
    <rect width="600" height="600" fill="${bg}"/>
    <circle cx="300" cy="250" r="120" fill="${accent}" opacity="0.18"/>
    <path d="M300 150c-45 0-70 40-70 95 0 60 30 110 70 110s70-50 70-110c0-55-25-95-70-95z" fill="${accent}" opacity="0.55"/>
    <circle cx="300" cy="215" r="34" fill="#fff" opacity="0.85"/>
    <circle cx="288" cy="212" r="4" fill="#7a3b2e"/>
    <circle cx="312" cy="212" r="4" fill="#7a3b2e"/>
    <path d="M285 226q15 12 30 0" stroke="#7a3b2e" stroke-width="3" fill="none" stroke-linecap="round"/>
    <text x="300" y="500" font-family="Georgia, serif" font-size="34" fill="#6b3a2a" text-anchor="middle" font-weight="bold">${safe}</text>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function slugify(text) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',' ':'-' };
  return String(text).toLowerCase().split('').map(c => map[c] ?? c).join('')
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ------------------------------------------------------------
//  Начальные данные (товары, отзывы). Тестового аккаунта нет.
// ------------------------------------------------------------
async function seed() {
  const row = await q.get('SELECT COUNT(*) AS c FROM products');
  if (Number(row.c) > 0) return; // уже заполнено

  const CREAM = '#f3e7d3', TERRA = '#c8613f', GOLD = '#d9a441', RED = '#b23a2e';

  const products = [
    { name: 'Матрёшка «Забайкальская», 5 мест', category: 'Игрушки', material: 'Дерево',
      price: 3200, stock: 12, popular: 1,
      description: 'Классическая пятиместная матрёшка, расписанная вручную нашими мастерами. Тёплые терракотовые тона и мотивы забайкальских трав.',
      composition: 'Липа, темпера, льняное масло, лак.' , bg: CREAM, accent: TERRA },
    { name: 'Кружка керамическая «Сибирь»', category: 'Посуда', material: 'Керамика',
      price: 950, stock: 40, popular: 1,
      description: 'Толстостенная кружка ручной лепки. Держит тепло, приятно ложится в ладонь. Каждая — единственная в своём роде.',
      composition: 'Красная глина, пищевая глазурь.', bg: '#efe0c9', accent: GOLD },
    { name: 'Полотенце льняное с вышивкой', category: 'Текстиль', material: 'Лён',
      price: 1400, stock: 25, popular: 1,
      description: 'Натуральный лён с традиционной красной вышивкой. Чем дольше пользуетесь — тем мягче становится.',
      composition: '100% лён, хлопковые нити вышивки.', bg: '#f5ecd8', accent: RED },
    { name: 'Доска разделочная «Кедр»', category: 'Кухня', material: 'Дерево',
      price: 1800, stock: 18, popular: 1,
      description: 'Массив сибирского кедра, пропитка натуральным маслом. Ароматная и долговечная.',
      composition: 'Кедр, минеральное масло.', bg: '#ecdcc2', accent: TERRA },
    { name: 'Варежки шерстяные «Метель»', category: 'Текстиль', material: 'Шерсть',
      price: 1100, stock: 30, popular: 0,
      description: 'Связаны вручную из овечьей шерсти. Настоящее сибирское тепло для морозной Читы.',
      composition: '100% овечья шерсть.', bg: '#f3e7d3', accent: '#8a5a3b' },
    { name: 'Туес берестяной для хранения', category: 'Декор', material: 'Береста',
      price: 2100, stock: 9, popular: 0,
      description: 'Плетёный туес из бересты. Хранит крупы и травы, сохраняя их свежесть — проверено веками.',
      composition: 'Береста, деревянное дно.', bg: '#efe0c9', accent: GOLD },
    { name: 'Тарелка расписная «Хохлома»', category: 'Посуда', material: 'Дерево',
      price: 1650, stock: 22, popular: 0,
      description: 'Деревянная тарелка с росписью в стиле хохломы — красное золото на чёрном фоне.',
      composition: 'Липа, темпера, лак.', bg: '#f5ecd8', accent: RED },
    { name: 'Фартук льняной «Хозяюшка»', category: 'Текстиль', material: 'Лён',
      price: 1350, stock: 15, popular: 0,
      description: 'Плотный льняной фартук с большим карманом. Практичный и красивый — для кухни и мастерской.',
      composition: '100% лён.', bg: '#ecdcc2', accent: TERRA },
    { name: 'Ложка деревянная резная', category: 'Кухня', material: 'Дерево',
      price: 450, stock: 60, popular: 1,
      description: 'Резная ложка из берёзы. Не царапает посуду, не нагревается. Мелочь, а приятно.',
      composition: 'Берёза, льняное масло.', bg: '#f3e7d3', accent: GOLD },
    { name: 'Свеча восковая «Тайга»', category: 'Декор', material: 'Воск',
      price: 700, stock: 35, popular: 0,
      description: 'Свеча из натурального пчелиного воска с ароматом кедра. Горит ровно и долго.',
      composition: 'Пчелиный воск, хлопковый фитиль, эфирные масла.', bg: '#efe0c9', accent: '#8a5a3b' },
    { name: 'Панно «Забайкальские узоры»', category: 'Декор', material: 'Дерево',
      price: 2800, stock: 7, popular: 0,
      description: 'Резное панно из массива дерева с традиционным орнаментом. Украсит стену и согреет дом.',
      composition: 'Липа, морилка, воск.', bg: '#f5ecd8', accent: TERRA },
    { name: 'Набор подставок под кружки, 4 шт', category: 'Кухня', material: 'Береста',
      price: 890, stock: 28, popular: 0,
      description: 'Плетёные берестяные подставки. Защищают стол и добавляют уюта чаепитию.',
      composition: 'Береста.', bg: '#ecdcc2', accent: GOLD }
  ];

  const seenSlugs = new Set();
  for (const p of products) {
    let base = slugify(p.name);
    let slug = base, i = 2;
    while (seenSlugs.has(slug)) { slug = base + '-' + i++; }
    seenSlugs.add(slug);
    const img = svgPlaceholder(p.category, p.bg, p.accent);
    // INSERT OR IGNORE — защита от дублей при одновременном первом запуске (serverless)
    await q.run(`INSERT OR IGNORE INTO products
      (slug, name, description, composition, material, price, category, stock, is_popular, images)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [slug, p.name, p.description, p.composition, p.material, p.price, p.category, p.stock, p.popular, JSON.stringify([img])]);
  }

  // Отзывы (только если их ещё нет)
  const rc = await q.get('SELECT COUNT(*) AS c FROM reviews');
  if (Number(rc.c) === 0) {
    const reviews = [
      { pid: 1, name: 'Ольга', rating: 5, text: 'Матрёшка бесподобная! Роспись живая, дочка в восторге. Спасибо мастерам!' },
      { pid: 1, name: 'Дмитрий', rating: 5, text: 'Брал в подарок коллегам из Москвы — все были в восторге от читинской работы.' },
      { pid: 2, name: 'Ирина', rating: 4, text: 'Кружка тёплая и уютная, чай долго не остывает. Немного тяжеловата, но это плюс.' },
      { pid: 3, name: 'Анна', rating: 5, text: 'Лён отличного качества, вышивка аккуратная. После стирки стало ещё мягче.' },
      { pid: 4, name: 'Сергей', rating: 5, text: 'Доска пахнет кедром на всю кухню. Крепкая, ножи не скользят.' }
    ];
    for (const r of reviews) {
      await q.run('INSERT INTO reviews (product_id, author_name, rating, text) VALUES (?, ?, ?, ?)',
        [r.pid, r.name, r.rating, r.text]);
    }
  }

  console.log('✔ База заполнена начальными данными (12 товаров, отзывы).');
}

// Создание схемы + наполнение (вызывается один раз при старте / первом запросе)
async function initAndSeed() {
  await initSchema();
  await seed();
}

module.exports = { q, slugify, svgPlaceholder, initAndSeed, DRIVER };

// Прямой запуск: node database.js  — создать схему и наполнить базу
if (require.main === module) {
  initAndSeed()
    .then(() => { console.log('✔ Готово. Драйвер базы:', DRIVER); process.exit(0); })
    .catch(err => { console.error('Ошибка инициализации базы:', err); process.exit(1); });
}
