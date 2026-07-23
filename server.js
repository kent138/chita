// ============================================================
//  Сервер интернет-магазина мануфактуры «Матрёшка», Чита
//  Node.js + Express. База: SQLite (локально) или Turso (на Vercel).
//  Работает и как обычный сервер (npm start), и как serverless-функция Vercel.
// ============================================================

'use strict';

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { q, slugify, initAndSeed, DRIVER } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Секрет для JWT (на Vercel задайте переменную окружения JWT_SECRET)
const JWT_SECRET = process.env.JWT_SECRET || 'matryoshka-chita-secret-2024';
// Пароль администратора для панелей каталога и модерации
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '7316';

// Разрешаем крупные JSON — изображения приходят как data URL (base64)
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
//  Гарантируем, что схема создана и база наполнена — один раз
//  (важно для serverless: выполняется при «холодном старте»)
// ------------------------------------------------------------
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = initAndSeed().catch(err => { readyPromise = null; throw err; });
  }
  return readyPromise;
}
// Перед любым /api-запросом дожидаемся готовности базы
app.use('/api', async (req, res, next) => {
  try { await ensureReady(); next(); } catch (e) { next(e); }
});

// ------------------------------------------------------------
//  Вспомогательные функции
// ------------------------------------------------------------

// Преобразование строки товара из БД в объект для клиента
function mapProduct(row) {
  if (!row) return null;
  let images = [];
  try { images = JSON.parse(row.images || '[]'); } catch { images = []; }
  return {
    id: row.id, slug: row.slug, name: row.name, description: row.description,
    composition: row.composition, material: row.material, width: row.width, price: row.price,
    category: row.category, stock: row.stock, isPopular: !!row.is_popular,
    images, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

// Обёртка для async-маршрутов: ловит ошибки и передаёт в обработчик
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Middleware: проверка JWT-токена пользователя
function authUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
}

// Middleware: проверка пароля администратора (заголовок X-Admin-Password)
function authAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Неверный пароль' });
  }
  next();
}

// Нормализация телефона: оставляем только цифры
function normPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// ============================================================
//  АВТОРИЗАЦИЯ
// ============================================================

// Регистрация
app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, phone, password, passwordRepeat } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  }
  if (passwordRepeat !== undefined && password !== passwordRepeat) {
    return res.status(400).json({ error: 'Пароли не совпадают' });
  }
  const cleanPhone = normPhone(phone);
  if (cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Введите корректный номер телефона' });
  }
  const exists = await q.get('SELECT id FROM users WHERE phone = ?', [cleanPhone]);
  if (exists) {
    return res.status(409).json({ error: 'Пользователь с таким телефоном уже зарегистрирован' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = await q.run('INSERT INTO users (name, phone, password_hash) VALUES (?, ?, ?)',
    [name.trim(), cleanPhone, hash]);
  const user = { id: Number(info.lastInsertRowid), name: name.trim(), phone: cleanPhone };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user });
}));

// Вход
app.post('/api/auth/login', wrap(async (req, res) => {
  const { phone, password } = req.body;
  const cleanPhone = normPhone(phone);
  const row = await q.get('SELECT * FROM users WHERE phone = ?', [cleanPhone]);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Неверный телефон или пароль' });
  }
  const user = { id: row.id, name: row.name, phone: row.phone };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user });
}));

// Текущий профиль + избранное + адреса
app.get('/api/auth/me', authUser, wrap(async (req, res) => {
  const row = await q.get('SELECT id, name, phone, addresses, favorites, created_at FROM users WHERE id = ?',
    [req.user.id]);
  if (!row) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({
    id: row.id, name: row.name, phone: row.phone,
    addresses: JSON.parse(row.addresses || '[]'),
    favorites: JSON.parse(row.favorites || '[]'),
    createdAt: row.created_at
  });
}));

// Обновление избранного
app.put('/api/auth/favorites', authUser, wrap(async (req, res) => {
  const favorites = Array.isArray(req.body.favorites) ? req.body.favorites : [];
  await q.run('UPDATE users SET favorites = ? WHERE id = ?', [JSON.stringify(favorites), req.user.id]);
  res.json({ favorites });
}));

// Обновление адресов доставки
app.put('/api/auth/addresses', authUser, wrap(async (req, res) => {
  const addresses = Array.isArray(req.body.addresses) ? req.body.addresses : [];
  await q.run('UPDATE users SET addresses = ? WHERE id = ?', [JSON.stringify(addresses), req.user.id]);
  res.json({ addresses });
}));

// История заказов пользователя
app.get('/api/auth/orders', authUser, wrap(async (req, res) => {
  const orders = await q.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  const result = [];
  for (const o of orders) {
    const items = await q.all('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
    result.push({ ...o, gift_wrap: !!o.gift_wrap, items });
  }
  res.json(result);
}));

// ============================================================
//  ТОВАРЫ (публичные)
// ============================================================

// Список товаров с фильтрами
app.get('/api/products', wrap(async (req, res) => {
  const { category, material, minPrice, maxPrice, inStock, popular, search } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (material) { sql += ' AND material = ?'; params.push(material); }
  if (minPrice) { sql += ' AND price >= ?'; params.push(Number(minPrice)); }
  if (maxPrice) { sql += ' AND price <= ?'; params.push(Number(maxPrice)); }
  if (inStock === '1') { sql += ' AND stock > 0'; }
  if (popular === '1') { sql += ' AND is_popular = 1'; }
  sql += ' ORDER BY is_popular DESC, created_at DESC';
  let rows = await q.all(sql, params);
  // Поиск по названию/описанию — в JS, т.к. SQLite LOWER() не работает с кириллицей
  if (search) {
    const s = String(search).toLowerCase();
    rows = rows.filter(r => (r.name || '').toLowerCase().includes(s) || (r.description || '').toLowerCase().includes(s));
  }
  res.json(rows.map(mapProduct));
}));

// Уникальные категории и материалы (для фильтров)
app.get('/api/products/facets', wrap(async (req, res) => {
  const cats = (await q.all("SELECT DISTINCT category FROM products WHERE category != '' ORDER BY category")).map(r => r.category);
  const mats = (await q.all("SELECT DISTINCT material FROM products WHERE material != '' ORDER BY material")).map(r => r.material);
  const range = await q.get('SELECT MIN(price) AS min, MAX(price) AS max FROM products');
  res.json({ categories: cats, materials: mats, priceMin: (range && range.min) || 0, priceMax: (range && range.max) || 0 });
}));

// Подсказки поиска (автодополнение) — фильтрация в JS для поддержки кириллицы
app.get('/api/products/suggest', wrap(async (req, res) => {
  const term = String(req.query.q || '').toLowerCase().trim();
  if (!term) return res.json([]);
  const rows = await q.all('SELECT id, slug, name, is_popular FROM products');
  const matched = rows
    .filter(r => (r.name || '').toLowerCase().includes(term))
    .sort((a, b) => b.is_popular - a.is_popular)
    .slice(0, 6)
    .map(({ id, slug, name }) => ({ id, slug, name }));
  res.json(matched);
}));

// Один товар по slug или id
app.get('/api/products/:key', wrap(async (req, res) => {
  const key = req.params.key;
  let row = await q.get('SELECT * FROM products WHERE slug = ?', [key]);
  if (!row && /^\d+$/.test(key)) row = await q.get('SELECT * FROM products WHERE id = ?', [Number(key)]);
  if (!row) return res.status(404).json({ error: 'Товар не найден' });
  const product = mapProduct(row);
  // «С этим покупают» — из той же категории
  const related = (await q.all('SELECT * FROM products WHERE category = ? AND id != ? ORDER BY RANDOM() LIMIT 4',
    [row.category, row.id])).map(mapProduct);
  const reviews = await q.all('SELECT * FROM reviews WHERE product_id = ? ORDER BY created_at DESC', [row.id]);
  res.json({ product, related, reviews });
}));

// Отзыв к товару (от авторизованного пользователя или гостя)
app.post('/api/products/:id/reviews', wrap(async (req, res) => {
  const productId = Number(req.params.id);
  const { rating, text, name } = req.body;
  const r = Math.max(1, Math.min(5, Number(rating) || 5));
  let userId = null, author = name || 'Покупатель';
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try { const u = jwt.verify(header.slice(7), JWT_SECRET); userId = u.id; author = u.name; } catch {}
  }
  const info = await q.run('INSERT INTO reviews (product_id, user_id, author_name, rating, text) VALUES (?, ?, ?, ?, ?)',
    [productId, userId, author, r, text || '']);
  const review = await q.get('SELECT * FROM reviews WHERE id = ?', [Number(info.lastInsertRowid)]);
  res.json(review);
}));

// ============================================================
//  ЗАКАЗЫ
// ============================================================

// Создание заказа (гость или авторизованный) — сразу попадает в модерацию
app.post('/api/orders', wrap(async (req, res) => {
  const {
    customerName, customerPhone, deliveryMethod, deliveryAddress,
    paymentMethod, comment, giftWrap, promoCode, items
  } = req.body;

  if (!customerName || !customerPhone || !deliveryMethod || !paymentMethod) {
    return res.status(400).json({ error: 'Заполните обязательные поля заказа' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Корзина пуста' });
  }

  // Определяем пользователя, если передан токен
  let userId = null;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try { userId = jwt.verify(header.slice(7), JWT_SECRET).id; } catch {}
  }

  // Считаем сумму по реальным ценам из БД (защита от подмены на клиенте)
  let total = 0;
  const validItems = [];
  for (const it of items) {
    const p = await q.get('SELECT id, name, price, stock FROM products WHERE id = ?', [Number(it.id)]);
    if (!p) continue;
    const qty = Math.max(1, Number(it.quantity) || 1);
    total += p.price * qty;
    validItems.push({ product_id: p.id, product_name: p.name, product_price: p.price, quantity: qty });
  }
  if (validItems.length === 0) {
    return res.status(400).json({ error: 'Товары не найдены' });
  }

  // Промокод (normalize — для корректного сравнения кириллицы)
  let discount = 0;
  const promo = String(promoCode || '').trim().toUpperCase().normalize('NFC');
  if (promo === 'СИБИРЬ10'.normalize('NFC') || promo === 'SIBIR10') discount = 0.10;
  else if (promo === 'ЧИТА15'.normalize('NFC') || promo === 'CHITA15') discount = 0.15;
  if (discount) total = Math.round(total * (1 - discount));

  // Подарочная упаковка
  if (giftWrap) total += 150;

  // Сохраняем заказ
  const orderInfo = await q.run(`
    INSERT INTO orders (user_id, customer_name, customer_phone, delivery_method,
      delivery_address, payment_method, comment, gift_wrap, promo_code, status, total_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Новый', ?)
  `, [userId, customerName.trim(), normPhone(customerPhone), deliveryMethod,
    deliveryAddress || '', paymentMethod, comment || '', giftWrap ? 1 : 0, promo, total]);

  const orderId = Number(orderInfo.lastInsertRowid);
  for (const it of validItems) {
    await q.run('INSERT INTO order_items (order_id, product_id, product_name, product_price, quantity) VALUES (?, ?, ?, ?, ?)',
      [orderId, it.product_id, it.product_name, it.product_price, it.quantity]);
    await q.run('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?', [it.quantity, it.product_id]);
  }

  res.json({ ok: true, orderId, total });
}));

// ============================================================
//  АДМИН: КАТАЛОГ (пароль 7316)
// ============================================================

// Проверка пароля (для открытия панелей)
app.post('/api/admin/verify', authAdmin, (req, res) => res.json({ ok: true }));

// Добавить товар
app.post('/api/admin/products', authAdmin, wrap(async (req, res) => {
  const { name, description, composition, material, width, price, category, stock, images, isPopular } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ error: 'Укажите название и цену' });
  }
  let base = slugify(name) || 'tovar';
  let slug = base, i = 2;
  while (await q.get('SELECT id FROM products WHERE slug = ?', [slug])) { slug = base + '-' + i++; }
  const info = await q.run(`
    INSERT INTO products (slug, name, description, composition, material, width, price, category, stock, is_popular, images)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [slug, name.trim(), description || '', composition || '', material || '', width || '',
    Number(price), category || '', Number(stock) || 0, isPopular ? 1 : 0,
    JSON.stringify(Array.isArray(images) ? images : [])]);
  const row = await q.get('SELECT * FROM products WHERE id = ?', [Number(info.lastInsertRowid)]);
  res.json(mapProduct(row));
}));

// Редактировать товар
app.put('/api/admin/products/:id', authAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await q.get('SELECT * FROM products WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Товар не найден' });
  const b = req.body;
  const images = Array.isArray(b.images) ? JSON.stringify(b.images) : existing.images;
  await q.run(`
    UPDATE products SET
      name = ?, description = ?, composition = ?, material = ?, width = ?, price = ?,
      category = ?, stock = ?, is_popular = ?, images = ?, updated_at = datetime('now')
    WHERE id = ?
  `, [
    b.name ?? existing.name,
    b.description ?? existing.description,
    b.composition ?? existing.composition,
    b.material ?? existing.material,
    b.width ?? existing.width,
    b.price != null ? Number(b.price) : existing.price,
    b.category ?? existing.category,
    b.stock != null ? Number(b.stock) : existing.stock,
    b.isPopular != null ? (b.isPopular ? 1 : 0) : existing.is_popular,
    images, id
  ]);
  const row = await q.get('SELECT * FROM products WHERE id = ?', [id]);
  res.json(mapProduct(row));
}));

// Удалить товар
app.delete('/api/admin/products/:id', authAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  await q.run('DELETE FROM products WHERE id = ?', [id]);
  res.json({ ok: true });
}));

// ============================================================
//  АДМИН: МОДЕРАЦИЯ ЗАКАЗОВ (пароль 7316)
// ============================================================

// Все заказы (с товарами) — для панели модерации, обновляется по polling
app.get('/api/admin/orders', authAdmin, wrap(async (req, res) => {
  const orders = await q.all('SELECT * FROM orders ORDER BY created_at DESC');
  const result = [];
  for (const o of orders) {
    const items = await q.all('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
    result.push({ ...o, gift_wrap: !!o.gift_wrap, items });
  }
  res.json(result);
}));

// Изменить статус заказа
app.put('/api/admin/orders/:id/status', authAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const allowed = ['Новый', 'В обработке', 'Отправлен', 'Выполнен', 'Отменён'].map(s => s.normalize('NFC'));
  const status = String(req.body.status || '').normalize('NFC');
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Недопустимый статус' });
  }
  await q.run('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
  res.json({ ok: true, status });
}));

// Удалить заказ — только если он уже «Выполнен» (доставлен) или «Отменён»
app.delete('/api/admin/orders/:id', authAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const order = await q.get('SELECT status FROM orders WHERE id = ?', [id]);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  const status = String(order.status || '').normalize('NFC');
  if (status !== 'Выполнен'.normalize('NFC') && status !== 'Отменён'.normalize('NFC')) {
    return res.status(400).json({ error: 'Удалять можно только выполненные или отменённые заказы' });
  }
  await q.run('DELETE FROM order_items WHERE order_id = ?', [id]);
  await q.run('DELETE FROM orders WHERE id = ?', [id]);
  res.json({ ok: true });
}));

// ============================================================
//  B2B / обратная связь / подписка (демо — хранятся в памяти)
// ============================================================
const requests = [];

app.post('/api/b2b', (req, res) => {
  const { company, name, phone, message } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Укажите имя и телефон' });
  requests.push({ type: 'b2b', company, name, phone, message, at: new Date().toISOString() });
  res.json({ ok: true });
});

app.post('/api/feedback', (req, res) => {
  const { name, phone, message } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'Заполните форму' });
  requests.push({ type: 'feedback', name, phone, message, at: new Date().toISOString() });
  res.json({ ok: true });
});

app.post('/api/subscribe', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Укажите e-mail' });
  requests.push({ type: 'subscribe', email, at: new Date().toISOString() });
  res.json({ ok: true });
});

// ------------------------------------------------------------
//  SPA fallback — все прочие GET-маршруты отдают index.html
// ------------------------------------------------------------
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------------------------------------------------
//  Глобальный обработчик ошибок — любая непойманная ошибка
//  возвращается как понятный JSON, а сервер не падает
// ------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Ошибка сервера:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Ошибка на сервере: ' + (err.message || 'неизвестная ошибка') });
});

// ------------------------------------------------------------
//  Локальные IP — чтобы открыть сайт с телефона в той же Wi-Fi сети
// ------------------------------------------------------------
function lanAddresses() {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// ------------------------------------------------------------
//  Запуск.
//   • Локально (node server.js) — поднимаем обычный сервер.
//   • На Vercel — файл импортируется как функция, listen не вызывается,
//     наружу отдаётся сам Express-app (module.exports).
// ------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🪆  Мануфактура «Матрёшка» — сервер запущен (база: ${DRIVER})`);
    console.log(`     • На этом компьютере:  http://localhost:${PORT}`);
    const ips = lanAddresses();
    if (ips.length) {
      console.log(`     • С других устройств в этой же Wi-Fi сети:`);
      ips.forEach(ip => console.log(`         http://${ip}:${PORT}`));
    }
    console.log('');
  });
}

module.exports = app;
