// ============================================================
//  Сервер интернет-магазина мануфактуры «Матрёшка», Чита
//  Node.js + Express + встроенный SQLite (node:sqlite)
// ============================================================

'use strict';

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, slugify } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Секрет для JWT (в реальном проекте вынести в переменные окружения)
const JWT_SECRET = process.env.JWT_SECRET || 'matryoshka-chita-secret-2024';
// Пароль администратора для панелей каталога и модерации
const ADMIN_PASSWORD = '7316';

// Разрешаем крупные JSON — изображения приходят как data URL (base64)
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    composition: row.composition, material: row.material, price: row.price,
    category: row.category, stock: row.stock, isPopular: !!row.is_popular,
    images, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

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
app.post('/api/auth/register', (req, res) => {
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
  const exists = db.prepare('SELECT id FROM users WHERE phone = ?').get(cleanPhone);
  if (exists) {
    return res.status(409).json({ error: 'Пользователь с таким телефоном уже зарегистрирован' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (name, phone, password_hash) VALUES (?, ?, ?)')
    .run(name.trim(), cleanPhone, hash);
  const user = { id: Number(info.lastInsertRowid), name: name.trim(), phone: cleanPhone };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user });
});

// Вход
app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body;
  const cleanPhone = normPhone(phone);
  const row = db.prepare('SELECT * FROM users WHERE phone = ?').get(cleanPhone);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Неверный телефон или пароль' });
  }
  const user = { id: row.id, name: row.name, phone: row.phone };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user });
});

// Текущий профиль + избранное + адреса
app.get('/api/auth/me', authUser, (req, res) => {
  const row = db.prepare('SELECT id, name, phone, addresses, favorites, created_at FROM users WHERE id = ?')
    .get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({
    id: row.id, name: row.name, phone: row.phone,
    addresses: JSON.parse(row.addresses || '[]'),
    favorites: JSON.parse(row.favorites || '[]'),
    createdAt: row.created_at
  });
});

// Обновление избранного
app.put('/api/auth/favorites', authUser, (req, res) => {
  const favorites = Array.isArray(req.body.favorites) ? req.body.favorites : [];
  db.prepare('UPDATE users SET favorites = ? WHERE id = ?')
    .run(JSON.stringify(favorites), req.user.id);
  res.json({ favorites });
});

// Обновление адресов доставки
app.put('/api/auth/addresses', authUser, (req, res) => {
  const addresses = Array.isArray(req.body.addresses) ? req.body.addresses : [];
  db.prepare('UPDATE users SET addresses = ? WHERE id = ?')
    .run(JSON.stringify(addresses), req.user.id);
  res.json({ addresses });
});

// История заказов пользователя
app.get('/api/auth/orders', authUser, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const result = orders.map(o => ({ ...o, gift_wrap: !!o.gift_wrap, items: itemsStmt.all(o.id) }));
  res.json(result);
});

// ============================================================
//  ТОВАРЫ (публичные)
// ============================================================

// Список товаров с фильтрами
app.get('/api/products', (req, res) => {
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
  let rows = db.prepare(sql).all(...params);
  // Поиск по названию/описанию — в JS, т.к. SQLite LOWER() не работает с кириллицей
  if (search) {
    const s = String(search).toLowerCase();
    rows = rows.filter(r => (r.name || '').toLowerCase().includes(s) || (r.description || '').toLowerCase().includes(s));
  }
  res.json(rows.map(mapProduct));
});

// Уникальные категории и материалы (для фильтров)
app.get('/api/products/facets', (req, res) => {
  const cats = db.prepare("SELECT DISTINCT category FROM products WHERE category != '' ORDER BY category").all().map(r => r.category);
  const mats = db.prepare("SELECT DISTINCT material FROM products WHERE material != '' ORDER BY material").all().map(r => r.material);
  const range = db.prepare('SELECT MIN(price) AS min, MAX(price) AS max FROM products').get();
  res.json({ categories: cats, materials: mats, priceMin: range.min || 0, priceMax: range.max || 0 });
});

// Подсказки поиска (автодополнение) — фильтрация в JS для поддержки кириллицы
app.get('/api/products/suggest', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const rows = db.prepare('SELECT id, slug, name, is_popular FROM products').all();
  const matched = rows
    .filter(r => (r.name || '').toLowerCase().includes(q))
    .sort((a, b) => b.is_popular - a.is_popular)
    .slice(0, 6)
    .map(({ id, slug, name }) => ({ id, slug, name }));
  res.json(matched);
});

// Один товар по slug или id
app.get('/api/products/:key', (req, res) => {
  const key = req.params.key;
  let row = db.prepare('SELECT * FROM products WHERE slug = ?').get(key);
  if (!row && /^\d+$/.test(key)) row = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(key));
  if (!row) return res.status(404).json({ error: 'Товар не найден' });
  const product = mapProduct(row);
  // «С этим покупают» — из той же категории
  const related = db.prepare('SELECT * FROM products WHERE category = ? AND id != ? ORDER BY RANDOM() LIMIT 4')
    .all(row.category, row.id).map(mapProduct);
  const reviews = db.prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY created_at DESC').all(row.id);
  res.json({ product, related, reviews });
});

// Отзыв к товару (от авторизованного пользователя или гостя)
app.post('/api/products/:id/reviews', (req, res) => {
  const productId = Number(req.params.id);
  const { rating, text, name } = req.body;
  const r = Math.max(1, Math.min(5, Number(rating) || 5));
  let userId = null, author = name || 'Покупатель';
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try { const u = jwt.verify(header.slice(7), JWT_SECRET); userId = u.id; author = u.name; } catch {}
  }
  const info = db.prepare('INSERT INTO reviews (product_id, user_id, author_name, rating, text) VALUES (?, ?, ?, ?, ?)')
    .run(productId, userId, author, r, text || '');
  const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(info.lastInsertRowid));
  res.json(review);
});

// ============================================================
//  ЗАКАЗЫ
// ============================================================

// Создание заказа (гость или авторизованный) — сразу попадает в модерацию
app.post('/api/orders', (req, res) => {
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
  const prodStmt = db.prepare('SELECT id, name, price, stock FROM products WHERE id = ?');
  let total = 0;
  const validItems = [];
  for (const it of items) {
    const p = prodStmt.get(Number(it.id));
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
  const orderInfo = db.prepare(`
    INSERT INTO orders (user_id, customer_name, customer_phone, delivery_method,
      delivery_address, payment_method, comment, gift_wrap, promo_code, status, total_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Новый', ?)
  `).run(userId, customerName.trim(), normPhone(customerPhone), deliveryMethod,
    deliveryAddress || '', paymentMethod, comment || '', giftWrap ? 1 : 0, promo, total);

  const orderId = Number(orderInfo.lastInsertRowid);
  const itemStmt = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, product_price, quantity)
    VALUES (?, ?, ?, ?, ?)
  `);
  const decStock = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?');
  for (const it of validItems) {
    itemStmt.run(orderId, it.product_id, it.product_name, it.product_price, it.quantity);
    decStock.run(it.quantity, it.product_id);
  }

  res.json({ ok: true, orderId, total });
});

// ============================================================
//  АДМИН: КАТАЛОГ (пароль 7316)
// ============================================================

// Проверка пароля (для открытия панелей)
app.post('/api/admin/verify', authAdmin, (req, res) => res.json({ ok: true }));

// Добавить товар
app.post('/api/admin/products', authAdmin, (req, res) => {
  const { name, description, composition, material, price, category, stock, images, isPopular } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ error: 'Укажите название и цену' });
  }
  let base = slugify(name) || 'tovar';
  let slug = base, i = 2;
  while (db.prepare('SELECT id FROM products WHERE slug = ?').get(slug)) { slug = base + '-' + i++; }
  const info = db.prepare(`
    INSERT INTO products (slug, name, description, composition, material, price, category, stock, is_popular, images)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, name.trim(), description || '', composition || '', material || '',
    Number(price), category || '', Number(stock) || 0, isPopular ? 1 : 0,
    JSON.stringify(Array.isArray(images) ? images : []));
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(info.lastInsertRowid));
  res.json(mapProduct(row));
});

// Редактировать товар
app.put('/api/admin/products/:id', authAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Товар не найден' });
  const b = req.body;
  const images = Array.isArray(b.images) ? JSON.stringify(b.images) : existing.images;
  db.prepare(`
    UPDATE products SET
      name = ?, description = ?, composition = ?, material = ?, price = ?,
      category = ?, stock = ?, is_popular = ?, images = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.name ?? existing.name,
    b.description ?? existing.description,
    b.composition ?? existing.composition,
    b.material ?? existing.material,
    b.price != null ? Number(b.price) : existing.price,
    b.category ?? existing.category,
    b.stock != null ? Number(b.stock) : existing.stock,
    b.isPopular != null ? (b.isPopular ? 1 : 0) : existing.is_popular,
    images, id
  );
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  res.json(mapProduct(row));
});

// Удалить товар
app.delete('/api/admin/products/:id', authAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ============================================================
//  АДМИН: МОДЕРАЦИЯ ЗАКАЗОВ (пароль 7316)
// ============================================================

// Все заказы (с товарами) — для панели модерации, обновляется по polling
app.get('/api/admin/orders', authAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const result = orders.map(o => ({ ...o, gift_wrap: !!o.gift_wrap, items: itemsStmt.all(o.id) }));
  res.json(result);
});

// Изменить статус заказа
app.put('/api/admin/orders/:id/status', authAdmin, (req, res) => {
  const id = Number(req.params.id);
  const allowed = ['Новый', 'В обработке', 'Отправлен', 'Выполнен', 'Отменён'].map(s => s.normalize('NFC'));
  const status = String(req.body.status || '').normalize('NFC');
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Недопустимый статус' });
  }
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
  res.json({ ok: true, status });
});

// ============================================================
//  B2B / обратная связь / подписка (сохраняем как заявки-заказы с пометкой)
// ============================================================
const requests = []; // заявки хранятся в памяти (демо)

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

app.listen(PORT, () => {
  console.log(`\n  🪆  Мануфактура «Матрёшка» — сервер запущен`);
  console.log(`     http://localhost:${PORT}\n`);
});
