/* ============================================================
   Мануфактура «Матрёшка» — клиентская логика (SPA)
   Роутер, каталог, корзина, авторизация, админ-панели.
   ============================================================ */

'use strict';

// -------------------- Состояние приложения --------------------
const State = {
  token: localStorage.getItem('mtr_token') || null,
  user: JSON.parse(localStorage.getItem('mtr_user') || 'null'),
  cart: JSON.parse(localStorage.getItem('mtr_cart') || '[]'),
  favorites: JSON.parse(localStorage.getItem('mtr_fav') || '[]'),
  adminPassword: null,          // хранится в памяти на время сессии панелей
  moderationTimer: null         // таймер polling для панели модерации
};

// -------------------- API-обёртка --------------------
async function api(path, { method = 'GET', body, admin = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (State.token) headers['Authorization'] = 'Bearer ' + State.token;
  if (admin && State.adminPassword) headers['X-Admin-Password'] = State.adminPassword;

  let res;
  try {
    res = await fetch('/api' + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    // fetch падает, если сервер не запущен или недоступен
    throw new Error('Нет связи с сервером. Убедитесь, что сервер запущен: откройте папку проекта и выполните «npm start».');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Ошибка сервера (код ' + res.status + ')'));
  return data;
}

// -------------------- Утилиты --------------------
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const money = n => new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' toast--' + type : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

function saveCart() {
  localStorage.setItem('mtr_cart', JSON.stringify(State.cart));
  updateCartBadge();
}
function saveFav() {
  localStorage.setItem('mtr_fav', JSON.stringify(State.favorites));
  updateFavBadge();
  if (State.token) api('/auth/favorites', { method: 'PUT', body: { favorites: State.favorites } }).catch(() => {});
}
function updateCartBadge() {
  const count = State.cart.reduce((s, i) => s + i.quantity, 0);
  const b = $('#cartBadge'); b.textContent = count; b.hidden = count === 0;
}
function updateFavBadge() {
  const b = $('#favBadge'); b.textContent = State.favorites.length; b.hidden = State.favorites.length === 0;
}

// ============================================================
//  МОДАЛЬНОЕ ОКНО (универсальное)
// ============================================================
function openModal(html, wide = '') {
  const modal = $('#modal');
  modal.className = 'modal' + (wide ? ' modal--' + wide : '');
  $('#modalContent').innerHTML = html;
  $('#modalOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  $('#modalOverlay').hidden = true;
  document.body.style.overflow = '';
  if (State.moderationTimer) { clearInterval(State.moderationTimer); State.moderationTimer = null; }
}
$('#modalClose').addEventListener('click', closeModal);
$('#modalOverlay').addEventListener('click', e => { if (e.target.id === 'modalOverlay') closeModal(); });

// ============================================================
//  АВТОРИЗАЦИЯ
// ============================================================
function authModal(tab = 'login') {
  openModal(`
    <div class="modal__tabs">
      <button data-tab="login" class="${tab==='login'?'active':''}">Вход</button>
      <button data-tab="register" class="${tab==='register'?'active':''}">Регистрация</button>
    </div>
    <div id="authFormWrap"></div>
  `);
  $$('.modal__tabs button').forEach(b =>
    b.addEventListener('click', () => renderAuthForm(b.dataset.tab)));
  renderAuthForm(tab);
}

function renderAuthForm(tab) {
  $$('.modal__tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const wrap = $('#authFormWrap');
  if (tab === 'login') {
    wrap.innerHTML = `
      <h2>С возвращением!</h2>
      <p style="color:var(--ink-soft);margin-bottom:20px">Войдите, чтобы видеть заказы и избранное.</p>
      <div class="form-error" id="authErr" hidden></div>
      <form id="loginForm">
        <div class="form-row"><label>Телефон</label><input name="phone" type="tel" placeholder="+7 914 000-00-00" required></div>
        <div class="form-row"><label>Пароль</label><input name="password" type="password" required></div>
        <button class="btn btn--primary btn--block btn--lg" type="submit">Войти</button>
      </form>
      <p class="form-hint">Тест: 79990000000 / test1234</p>`;
    $('#loginForm').addEventListener('submit', handleLogin);
  } else {
    wrap.innerHTML = `
      <h2>Создать аккаунт</h2>
      <p style="color:var(--ink-soft);margin-bottom:20px">Быстрая регистрация — только нужное.</p>
      <div class="form-error" id="authErr" hidden></div>
      <form id="registerForm">
        <div class="form-row"><label>Имя</label><input name="name" placeholder="Как вас зовут?" required></div>
        <div class="form-row"><label>Телефон</label><input name="phone" type="tel" placeholder="+7 914 000-00-00" required></div>
        <div class="form-row"><label>Пароль</label><input name="password" type="password" placeholder="Не короче 6 символов" required></div>
        <div class="form-row"><label>Повторите пароль</label><input name="passwordRepeat" type="password" required></div>
        <label class="checkbox-row consent-row">
          <input type="checkbox" name="consent" id="regConsent" required>
          <span>Я согласен(а) на <a href="#/returns" data-link onclick="closeModal()">обработку персональных данных</a></span>
        </label>
        <button class="btn btn--primary btn--block btn--lg" type="submit">Зарегистрироваться</button>
      </form>`;
    $('#registerForm').addEventListener('submit', handleRegister);
  }
}

function showAuthErr(msg) { const e = $('#authErr'); if (e) { e.textContent = msg; e.hidden = false; } }

async function handleLogin(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const data = await api('/auth/login', { method: 'POST',
      body: { phone: f.get('phone'), password: f.get('password') } });
    onAuthSuccess(data);
  } catch (err) { showAuthErr(err.message); }
}

async function handleRegister(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  if (!$('#regConsent')?.checked) return showAuthErr('Поставьте галочку согласия на обработку персональных данных');
  if (f.get('password') !== f.get('passwordRepeat')) return showAuthErr('Пароли не совпадают');
  try {
    const data = await api('/auth/register', { method: 'POST', body: {
      name: f.get('name'), phone: f.get('phone'),
      password: f.get('password'), passwordRepeat: f.get('passwordRepeat') } });
    onAuthSuccess(data);
  } catch (err) { showAuthErr(err.message); }
}

function onAuthSuccess(data) {
  State.token = data.token; State.user = data.user;
  localStorage.setItem('mtr_token', data.token);
  localStorage.setItem('mtr_user', JSON.stringify(data.user));
  closeModal();
  renderAuthUI();
  toast('Добро пожаловать, ' + data.user.name + '!', 'success');
  // Подтягиваем избранное с сервера
  api('/auth/me').then(me => {
    if (Array.isArray(me.favorites) && me.favorites.length) {
      State.favorites = [...new Set([...State.favorites, ...me.favorites])];
      saveFav();
    }
  }).catch(() => {});
}

function logout() {
  State.token = null; State.user = null;
  localStorage.removeItem('mtr_token'); localStorage.removeItem('mtr_user');
  renderAuthUI();
  toast('Вы вышли из аккаунта');
  navigate('#/');
}

function renderAuthUI() {
  const authed = !!State.token;
  $('#authButtons').hidden = authed;
  $('#userMenu').hidden = !authed;
  if (authed) $('#userName').textContent = State.user?.name?.split(' ')[0] || 'Кабинет';
}

// ============================================================
//  КОРЗИНА
// ============================================================
function addToCart(product, qty = 1) {
  const existing = State.cart.find(i => i.id === product.id);
  if (existing) existing.quantity += qty;
  else State.cart.push({ id: product.id, name: product.name, price: product.price,
    image: product.images?.[0] || '', quantity: qty });
  saveCart();
  toast('«' + product.name + '» в корзине', 'success');
}
function changeQty(id, delta) {
  const item = State.cart.find(i => i.id === id);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) State.cart = State.cart.filter(i => i.id !== id);
  saveCart(); renderCart();
}
function removeFromCart(id) { State.cart = State.cart.filter(i => i.id !== id); saveCart(); renderCart(); }
function cartTotal() { return State.cart.reduce((s, i) => s + i.price * i.quantity, 0); }

function openCart() { $('#cartOverlay').hidden = false; $('#cartDrawer').hidden = false; renderCart(); }
function closeCart() { $('#cartOverlay').hidden = true; $('#cartDrawer').hidden = true; }

function renderCart() {
  const body = $('#cartItems'), foot = $('#cartFoot');
  if (State.cart.length === 0) {
    body.innerHTML = '<div class="empty">🪆<br>Корзина пуста.<br>Загляните в каталог!</div>';
    foot.innerHTML = '<button class="btn btn--ghost btn--block" onclick="navigate(\'#/catalog\');closeCart()">В каталог</button>';
    return;
  }
  body.innerHTML = State.cart.map(i => `
    <div class="cart-item">
      <img src="${esc(i.image)}" alt="${esc(i.name)}">
      <div>
        <div class="cart-item__name">${esc(i.name)}</div>
        <div class="cart-item__price">${money(i.price)}</div>
        <div class="qty">
          <button onclick="changeQty(${i.id},-1)">−</button>
          <span>${i.quantity}</span>
          <button onclick="changeQty(${i.id},1)">+</button>
        </div>
      </div>
      <button class="cart-item__remove" onclick="removeFromCart(${i.id})">🗑</button>
    </div>`).join('');
  foot.innerHTML = `
    <div class="cart-total"><span>Итого:</span> <b>${money(cartTotal())}</b></div>
    <button class="btn btn--primary btn--block btn--lg" onclick="navigate('#/checkout');closeCart()">Оформить заказ</button>`;
}

// ============================================================
//  ИЗБРАННОЕ
// ============================================================
function toggleFav(id) {
  id = Number(id);
  if (State.favorites.includes(id)) State.favorites = State.favorites.filter(f => f !== id);
  else State.favorites.push(id);
  saveFav();
  $$('.card__fav[data-fav="' + id + '"]').forEach(b => b.classList.toggle('active', State.favorites.includes(id)));
}

// ============================================================
//  КАРТОЧКА ТОВАРА (переиспользуемая)
// ============================================================
function productCard(p) {
  const inStock = p.stock > 0;
  const isFav = State.favorites.includes(p.id);
  return `
    <article class="card">
      <div class="card__media" onclick="navigate('#/product/${esc(p.slug)}')">
        <img src="${esc(p.images?.[0]||'')}" alt="${esc(p.name)}" loading="lazy">
        <span class="card__badge">Ручная работа</span>
        <button class="card__fav ${isFav?'active':''}" data-fav="${p.id}" onclick="event.stopPropagation();toggleFav(${p.id})">♥</button>
      </div>
      <div class="card__body">
        <span class="card__cat">${esc(p.category)}</span>
        <div class="card__title" onclick="navigate('#/product/${esc(p.slug)}')">${esc(p.name)}</div>
        <div class="card__stock ${inStock?'in':'out'}">${inStock?'✓ В наличии':'Нет в наличии'}</div>
        <div class="card__foot">
          <span class="card__price">${money(p.price)}</span>
          <button class="btn btn--primary btn--sm" ${inStock?'':'disabled'} onclick='addToCart(${JSON.stringify({id:p.id,name:p.name,price:p.price,images:p.images})})'>В корзину</button>
        </div>
      </div>
    </article>`;
}

// ============================================================
//  РОУТЕР
// ============================================================
const app = $('#app');
function navigate(hash) { window.location.hash = hash; }

function parseRoute() {
  const raw = window.location.hash.slice(1) || '/';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  return { path, params };
}

const routes = [
  { re: /^\/$/,                 render: renderHome },
  { re: /^\/catalog$/,          render: renderCatalog },
  { re: /^\/product\/(.+)$/,    render: (m) => renderProduct(m[1]) },
  { re: /^\/checkout$/,         render: renderCheckout },
  { re: /^\/about$/,            render: renderAbout },
  { re: /^\/contacts$/,         render: renderContacts },
  { re: /^\/blog$/,             render: renderBlog },
  { re: /^\/sale$/,             render: renderSale },
  { re: /^\/b2b$/,              render: renderB2B },
  { re: /^\/returns$/,          render: renderReturns },
  { re: /^\/account$/,          render: renderAccount }
];

async function router() {
  const { path, params } = parseRoute();
  window.scrollTo(0, 0);
  $$('.nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + path));
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) { app.innerHTML = '<div class="spinner">Загрузка…</div>'; try { await r.render(m, params); } catch (e) { app.innerHTML = `<div class="container section"><p class="empty">Ошибка: ${esc(e.message)}</p></div>`; } return; }
  }
  app.innerHTML = '<div class="container section"><div class="empty">Страница не найдена. <a href="#/" data-link style="color:var(--terra)">На главную</a></div></div>';
}
window.addEventListener('hashchange', router);

// ============================================================
//  СТРАНИЦА: ГЛАВНАЯ
// ============================================================
async function renderHome() {
  const popular = await api('/products?popular=1');
  app.innerHTML = `
    <section class="hero">
      <div class="container">
        <div class="hero__solo">
          <span class="hero__eyebrow">Чита · Забайкальский край</span>
          <h1>Сделано в Чите.<br><span class="accent">Сделано с любовью.</span></h1>
          <p class="hero__lead">Мы — мастера из Читы, которые делают настоящие вещи руками. Тепло, натуральность и сибирские традиции в каждом изделии.</p>
          <div class="hero__cta">
            <button class="btn btn--primary btn--lg" onclick="navigate('#/catalog')">Смотреть каталог</button>
            <button class="btn btn--ghost btn--lg" onclick="navigate('#/about')">О мануфактуре</button>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="features">
          <div class="feature"><div class="feature__icon">✋</div><h3>Ручная работа</h3><p>Каждое изделие создаётся мастером вручную — двух одинаковых не бывает.</p></div>
          <div class="feature"><div class="feature__icon">🌲</div><h3>Сибирские материалы</h3><p>Кедр, берёза, лён, шерсть, береста — только натуральное.</p></div>
          <div class="feature"><div class="feature__icon">📦</div><h3>Доставка по России</h3><p>Почта России и СДЭК. Или самовывоз в Чите.</p></div>
          <div class="feature"><div class="feature__icon">🛡️</div><h3>Гарантия качества</h3><p>Отвечаем за каждую вещь. Не понравилось — вернём деньги.</p></div>
        </div>
      </div>
    </section>

    <section class="section section--tint">
      <div class="container">
        <div class="section__head"><h2>Популярные товары</h2><p>То, что покупают чаще всего</p><div class="ornament"></div></div>
        <div class="products-grid">${popular.slice(0,8).map(productCard).join('')}</div>
        <div style="text-align:center;margin-top:34px"><button class="btn btn--gold btn--lg" onclick="navigate('#/catalog')">Весь каталог →</button></div>
      </div>
    </section>

    <section class="section">
      <div class="container story">
        <div class="story__art">🏭</div>
        <div>
          <h2>История мануфактуры</h2>
          <p>Всё началось в маленькой мастерской на улице Бутина. Несколько мастеров, любовь к дереву и желание делать вещи, которые служат годами и радуют глаз.</p>
          <p>Сегодня «Матрёшка» — это команда читинских ремесленников, объединённых одной идеей: настоящее не выходит из моды. Мы работаем с сибирскими материалами и храним традиции народных промыслов.</p>
          <button class="btn btn--ghost" onclick="navigate('#/about')">Узнать больше</button>
        </div>
      </div>
    </section>

    <section class="section section--tint">
      <div class="container">
        <div class="section__head"><h2>Отзывы покупателей</h2><p>Нам доверяют по всей России</p><div class="ornament"></div></div>
        <div class="reviews-grid">
          ${[
            {s:5,t:'Заказывала матрёшку в подарок — пришла быстро, упаковано с душой. Роспись просто загляденье!',a:'Ольга, Москва'},
            {s:5,t:'Кедровая доска пахнет лесом на всю кухню. Чувствуется, что делали с любовью. Спасибо!',a:'Сергей, Новосибирск'},
            {s:5,t:'Люблю поддерживать местных мастеров. Лён отличный, вышивка аккуратная. Буду заказывать ещё.',a:'Ирина, Чита'}
          ].map(r=>`<div class="review"><div class="review__stars">${'★'.repeat(r.s)}</div><p class="review__text">«${r.t}»</p><div class="review__author">${r.a}</div></div>`).join('')}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="subscribe">
          <h2>Первыми узнавайте о новинках</h2>
          <p>Подпишитесь — расскажем о новых изделиях, акциях и жизни мануфактуры.</p>
          <form class="subscribe__form" id="subForm">
            <input type="email" name="email" placeholder="Ваш e-mail" required>
            <button class="btn btn--gold btn--lg" type="submit">Подписаться</button>
          </form>
        </div>
      </div>
    </section>`;
  $('#subForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/subscribe', { method: 'POST', body: { email: new FormData(e.target).get('email') } });
      toast('Спасибо за подписку!', 'success'); e.target.reset(); }
    catch (err) { toast(err.message, 'error'); }
  });
}

// ============================================================
//  СТРАНИЦА: КАТАЛОГ
// ============================================================
let catalogFacets = null;
async function renderCatalog(_m, params) {
  if (!catalogFacets) catalogFacets = await api('/products/facets');
  const preCat = params.get('category') || '';
  app.innerHTML = `
    <div class="container page-head">
      <div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Каталог</div>
      <h1>Каталог</h1>
      <p style="color:var(--ink-soft)">Товары ручной работы из Читы</p>
    </div>
    <div class="container section" style="padding-top:20px">
      <div class="catalog">
        <aside class="filters">
          <h3>Фильтры</h3>
          <div class="filter-group">
            <h4>Категория</h4>
            <label><input type="radio" name="category" value="" ${!preCat?'checked':''}> Все</label>
            ${catalogFacets.categories.map(c=>`<label><input type="radio" name="category" value="${esc(c)}" ${preCat===c?'checked':''}> ${esc(c)}</label>`).join('')}
          </div>
          <div class="filter-group">
            <h4>Материал</h4>
            <label><input type="radio" name="material" value="" checked> Любой</label>
            ${catalogFacets.materials.map(m=>`<label><input type="radio" name="material" value="${esc(m)}"> ${esc(m)}</label>`).join('')}
          </div>
          <div class="filter-group">
            <h4>Цена, ₽</h4>
            <div class="price-range">
              <input type="number" id="minPrice" placeholder="от" min="0">
              <span>—</span>
              <input type="number" id="maxPrice" placeholder="до" min="0">
            </div>
          </div>
          <div class="filter-group">
            <label><input type="checkbox" id="inStock"> Только в наличии</label>
          </div>
          <button class="btn btn--primary btn--block" id="applyFilters">Применить</button>
          <button class="btn btn--link btn--block" id="resetFilters">Сбросить</button>
        </aside>
        <div>
          <div class="catalog__head">
            <span class="catalog__count" id="catCount"></span>
          </div>
          <div class="products-grid" id="catGrid"></div>
        </div>
      </div>
    </div>`;

  async function load() {
    const q = new URLSearchParams();
    const cat = $('input[name="category"]:checked')?.value;
    const mat = $('input[name="material"]:checked')?.value;
    if (cat) q.set('category', cat);
    if (mat) q.set('material', mat);
    if ($('#minPrice').value) q.set('minPrice', $('#minPrice').value);
    if ($('#maxPrice').value) q.set('maxPrice', $('#maxPrice').value);
    if ($('#inStock').checked) q.set('inStock', '1');
    const list = await api('/products?' + q.toString());
    $('#catCount').textContent = 'Найдено товаров: ' + list.length;
    $('#catGrid').innerHTML = list.length ? list.map(productCard).join('') : '<div class="empty">По вашему запросу ничего не найдено.</div>';
  }
  $('#applyFilters').addEventListener('click', load);
  $('#resetFilters').addEventListener('click', () => { navigate('#/catalog'); renderCatalog(_m, new URLSearchParams()); });
  $$('input[name="category"], input[name="material"]').forEach(r => r.addEventListener('change', load));
  load();
}

// ============================================================
//  СТРАНИЦА: ТОВАР
// ============================================================
async function renderProduct(slug) {
  const { product: p, related, reviews } = await api('/products/' + encodeURIComponent(slug));
  const inStock = p.stock > 0;
  const avg = reviews.length ? (reviews.reduce((s,r)=>s+r.rating,0)/reviews.length).toFixed(1) : null;
  app.innerHTML = `
    <div class="container page-head">
      <div class="breadcrumbs"><a href="#/" data-link>Главная</a> / <a href="#/catalog" data-link>Каталог</a> / ${esc(p.name)}</div>
    </div>
    <div class="container section" style="padding-top:16px">
      <div class="product">
        <div class="gallery">
          <div class="gallery__main"><img id="galMain" src="${esc(p.images?.[0]||'')}" alt="${esc(p.name)}"></div>
          ${p.images.length>1?`<div class="gallery__thumbs">${p.images.map((img,i)=>`<img src="${esc(img)}" class="${i===0?'active':''}" onclick="document.getElementById('galMain').src=this.src;document.querySelectorAll('.gallery__thumbs img').forEach(t=>t.classList.remove('active'));this.classList.add('active')">`).join('')}</div>`:''}
        </div>
        <div class="product__info">
          <span class="card__cat">${esc(p.category)}</span>
          <h1>${esc(p.name)}</h1>
          ${avg?`<div class="review__stars">${'★'.repeat(Math.round(avg))}<span style="color:var(--ink-soft);font-size:14px"> ${avg} · ${reviews.length} отзыв(ов)</span></div>`:''}
          <div class="product__price">${money(p.price)}</div>
          <div class="product__stock" style="color:${inStock?'var(--green)':'var(--hohloma)'}">${inStock?'✓ В наличии ('+p.stock+' шт.)':'Нет в наличии'}</div>
          <div class="product__actions">
            <button class="btn btn--primary btn--lg" ${inStock?'':'disabled'} id="addCartBtn">В корзину</button>
            <button class="btn btn--gold btn--lg" ${inStock?'':'disabled'} id="buyNowBtn">Купить сразу</button>
            <button class="btn btn--ghost card__fav ${State.favorites.includes(p.id)?'active':''}" data-fav="${p.id}" onclick="toggleFav(${p.id})" style="width:auto">♥</button>
          </div>
          <div class="product__section"><h3>Описание</h3><p>${esc(p.description)}</p></div>
          ${p.composition?`<div class="product__section"><h3>Состав и материалы</h3><p>${esc(p.composition)}</p></div>`:''}
          <div class="product__section">
            ${p.material?`<span class="tag">Материал: ${esc(p.material)}</span>`:''}
            <span class="tag">Ручная работа</span>
            <span class="tag">Сделано в Чите</span>
          </div>
        </div>
      </div>

      ${related.length?`
      <div class="section__head" style="text-align:left"><h2 style="font-size:28px">С этим покупают</h2></div>
      <div class="products-grid">${related.map(productCard).join('')}</div>`:''}

      <div class="section" style="padding-bottom:0">
        <div class="section__head" style="text-align:left"><h2 style="font-size:28px">Отзывы</h2></div>
        <div id="reviewsList">
          ${reviews.length?reviews.map(r=>`<div class="review" style="margin-bottom:14px"><div class="review__stars">${'★'.repeat(r.rating)}</div><p class="review__text">${esc(r.text)}</p><div class="review__author">${esc(r.author_name)}</div></div>`).join(''):'<p class="empty">Пока нет отзывов. Будьте первым!</p>'}
        </div>
        <div class="info-block" style="margin-top:20px">
          <h3>Оставить отзыв</h3>
          <form id="reviewForm">
            <div class="form-row"><label>Оценка</label>
              <select name="rating"><option value="5">★★★★★ Отлично</option><option value="4">★★★★ Хорошо</option><option value="3">★★★ Нормально</option><option value="2">★★ Плохо</option><option value="1">★ Ужасно</option></select></div>
            ${State.token?'':'<div class="form-row"><label>Имя</label><input name="name" placeholder="Ваше имя"></div>'}
            <div class="form-row"><label>Отзыв</label><textarea name="text" placeholder="Поделитесь впечатлением…" required></textarea></div>
            <button class="btn btn--primary" type="submit">Отправить отзыв</button>
          </form>
        </div>
      </div>
    </div>`;

  $('#addCartBtn')?.addEventListener('click', () => addToCart(p));
  $('#buyNowBtn')?.addEventListener('click', () => { addToCart(p); navigate('#/checkout'); });
  $('#reviewForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/products/' + p.id + '/reviews', { method: 'POST',
        body: { rating: f.get('rating'), text: f.get('text'), name: f.get('name') } });
      toast('Спасибо за отзыв!', 'success');
      renderProduct(slug);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ============================================================
//  СТРАНИЦА: ОФОРМЛЕНИЕ ЗАКАЗА
// ============================================================
async function renderCheckout() {
  if (State.cart.length === 0) {
    app.innerHTML = `<div class="container section"><div class="empty">Корзина пуста.<br><button class="btn btn--primary" style="margin-top:16px" onclick="navigate('#/catalog')">В каталог</button></div></div>`;
    return;
  }
  const u = State.user || {};
  app.innerHTML = `
    <div class="container page-head"><h1>Оформление заказа</h1></div>
    <div class="container section" style="padding-top:16px">
      <div class="catalog" style="grid-template-columns:1fr 380px">
        <form id="checkoutForm">
          <div class="info-block">
            <h3>Контактные данные</h3>
            <div class="form-row"><label>Имя*</label><input name="customerName" value="${esc(u.name||'')}" required></div>
            <div class="form-row"><label>Телефон*</label><input name="customerPhone" type="tel" value="${esc(u.phone||'')}" placeholder="+7 914 000-00-00" required></div>
          </div>

          <div class="info-block">
            <h3>Способ доставки</h3>
            <label class="radio-card"><input type="radio" name="delivery" value="Самовывоз" checked><span><b>Самовывоз</b><small>ул. Бутина, 44, пом. 1, Чита — бесплатно</small></span></label>
            <label class="radio-card"><input type="radio" name="delivery" value="Почта России"><span><b>Почта России</b><small>Доставка по всей России</small></span></label>
            <label class="radio-card"><input type="radio" name="delivery" value="СДЭК"><span><b>СДЭК</b><small>До пункта выдачи или курьером</small></span></label>
            <div class="form-row" id="addressRow" hidden><label>Адрес доставки</label><input name="deliveryAddress" placeholder="Город, улица, дом, индекс"></div>
          </div>

          <div class="info-block">
            <h3>Способ оплаты</h3>
            <label class="radio-card"><input type="radio" name="payment" value="Карта (Мир)" checked><span><b>Банковская карта «Мир»</b><small>Оплата онлайн</small></span></label>
            <label class="radio-card"><input type="radio" name="payment" value="СБП"><span><b>СБП</b><small>Система быстрых платежей — по QR-коду</small></span></label>
            <label class="radio-card"><input type="radio" name="payment" value="Наличные при получении"><span><b>Наличные при получении</b><small>Оплата в пункте выдачи или курьеру</small></span></label>
          </div>

          <div class="info-block">
            <h3>Дополнительно</h3>
            <div class="checkbox-row"><input type="checkbox" name="giftWrap" id="giftWrap"><label for="giftWrap" style="margin:0">🎁 Подарочная упаковка (+150 ₽)</label></div>
            <div class="form-row"><label>Комментарий к заказу</label><textarea name="comment" placeholder="Пожелания по заказу, удобное время доставки…"></textarea></div>
          </div>
        </form>

        <aside class="filters" style="position:sticky;top:90px">
          <h3>Ваш заказ</h3>
          <div id="checkoutItems"></div>
          <div class="form-row" style="margin-top:14px"><label>Промокод</label>
            <div style="display:flex;gap:8px"><input id="promoInput" placeholder="СИБИРЬ10"><button class="btn btn--ghost btn--sm" id="applyPromo">OK</button></div>
            <div class="form-hint" id="promoHint">Попробуйте: СИБИРЬ10, ЧИТА15</div>
          </div>
          <div class="cart-total" style="margin-top:16px"><span>Итого:</span> <b id="checkoutTotal">${money(cartTotal())}</b></div>
          <button class="btn btn--primary btn--block btn--lg" id="placeOrderBtn">Оформить заказ</button>
          <p class="form-hint" style="text-align:center">Нажимая кнопку, вы соглашаетесь с условиями</p>
        </aside>
      </div>
    </div>`;

  let discount = 0, appliedPromo = '';
  function renderSummary() {
    $('#checkoutItems').innerHTML = State.cart.map(i => `
      <div style="display:flex;justify-content:space-between;font-size:14px;padding:6px 0;border-bottom:1px solid var(--cream-2)">
        <span>${esc(i.name)} × ${i.quantity}</span><b>${money(i.price*i.quantity)}</b></div>`).join('');
    let total = cartTotal();
    if (discount) total = Math.round(total * (1 - discount));
    if ($('#giftWrap').checked) total += 150;
    $('#checkoutTotal').textContent = money(total);
  }
  renderSummary();

  // Показ поля адреса при выборе доставки
  $$('input[name="delivery"]').forEach(r => r.addEventListener('change', () => {
    $('#addressRow').hidden = r.value === 'Самовывоз';
  }));
  $('#giftWrap').addEventListener('change', renderSummary);

  $('#applyPromo').addEventListener('click', () => {
    const code = $('#promoInput').value.trim().toUpperCase();
    if (['СИБИРЬ10','SIBIR10'].includes(code)) { discount = 0.10; appliedPromo = code; $('#promoHint').textContent = '✓ Скидка 10% применена'; $('#promoHint').style.color='var(--green)'; }
    else if (['ЧИТА15','CHITA15'].includes(code)) { discount = 0.15; appliedPromo = code; $('#promoHint').textContent = '✓ Скидка 15% применена'; $('#promoHint').style.color='var(--green)'; }
    else { discount = 0; appliedPromo=''; $('#promoHint').textContent = 'Промокод не найден'; $('#promoHint').style.color='var(--hohloma)'; }
    renderSummary();
  });

  $('#placeOrderBtn').addEventListener('click', async () => {
    const form = $('#checkoutForm');
    if (!form.customerName.value.trim() || !form.customerPhone.value.trim()) {
      return toast('Заполните имя и телефон', 'error');
    }
    const delivery = $('input[name="delivery"]:checked').value;
    const payment = $('input[name="payment"]:checked').value;
    if (delivery !== 'Самовывоз' && !form.deliveryAddress.value.trim()) {
      return toast('Укажите адрес доставки', 'error');
    }
    const body = {
      customerName: form.customerName.value, customerPhone: form.customerPhone.value,
      deliveryMethod: delivery, deliveryAddress: form.deliveryAddress.value,
      paymentMethod: payment, comment: form.comment.value,
      giftWrap: $('#giftWrap').checked, promoCode: appliedPromo,
      items: State.cart.map(i => ({ id: i.id, quantity: i.quantity }))
    };
    try {
      const res = await api('/orders', { method: 'POST', body });
      State.cart = []; saveCart();
      openModal(`
        <div style="text-align:center">
          <div style="font-size:64px">🎉</div>
          <h2>Заказ №${res.orderId} оформлен!</h2>
          <p style="color:var(--ink-soft);margin:14px 0">Спасибо за доверие! Мы уже получили ваш заказ и скоро свяжемся с вами по телефону.</p>
          <p class="product__price">${money(res.total)}</p>
          <button class="btn btn--primary btn--lg" style="margin-top:16px" onclick="closeModal();navigate('#/')">На главную</button>
        </div>`);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ============================================================
//  СТРАНИЦА: О НАС
// ============================================================
function renderAbout() {
  app.innerHTML = `
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / О нас</div><h1>О мануфактуре</h1></div>
    <div class="container section" style="padding-top:16px">
      <div class="info-block">
        <h2>Матрёшка — сибирская душа в каждой вещи</h2>
        <p>Мы — мастера из Читы, которые делают настоящие вещи руками. Наша мануфактура выросла из небольшой мастерской в самом сердце Забайкалья и сегодня объединяет ремесленников, влюблённых в своё дело.</p>
        <p>Мы верим, что вещь, сделанная руками, хранит тепло мастера. Поэтому не гонимся за конвейером — каждое изделие проходит через руки человека, а не машины.</p>
      </div>
      <div class="story" style="margin:32px 0">
        <div class="story__art">🌲</div>
        <div>
          <h2>Наши ценности</h2>
          <p><b>Традиции.</b> Мы храним и продолжаем народные промыслы Сибири.</p>
          <p><b>Натуральность.</b> Кедр, берёза, лён, шерсть, береста — только природные материалы.</p>
          <p><b>Честность.</b> Говорим правду о товаре и отвечаем за качество.</p>
          <p><b>Локальность.</b> Мы гордимся тем, что делаем это именно здесь, в Чите.</p>
        </div>
      </div>
      <div class="features">
        <div class="feature"><div class="feature__icon">👐</div><h3>Команда мастеров</h3><p>Резчики, швеи, художники — каждый мастер своего дела.</p></div>
        <div class="feature"><div class="feature__icon">🏭</div><h3>Своё производство</h3><p>Полный цикл — от заготовки до росписи — в Чите.</p></div>
        <div class="feature"><div class="feature__icon">💛</div><h3>С любовью</h3><p>Мы делаем то, что нравится нам самим.</p></div>
        <div class="feature"><div class="feature__icon">♻️</div><h3>Бережно к природе</h3><p>Используем материалы ответственно и без отходов.</p></div>
      </div>
      <div style="text-align:center;margin-top:40px"><button class="btn btn--primary btn--lg" onclick="navigate('#/catalog')">Смотреть каталог</button></div>
    </div>`;
}

// ============================================================
//  СТРАНИЦА: КОНТАКТЫ
// ============================================================
function renderContacts() {
  app.innerHTML = `
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Контакты</div><h1>Контакты</h1></div>
    <div class="container section" style="padding-top:16px">
      <div class="contact-grid">
        <div>
          <div class="info-block">
            <h3>📍 Адрес</h3><p>г. Чита, ул. Бутина, 44, помещение 1</p>
            <h3>📞 Телефон</h3><p><a href="tel:+79143592767" style="color:var(--terra);font-weight:700;font-size:18px">+7 914 359-27-67</a></p>
            <h3>💬 Мессенджеры</h3>
            <p><a href="https://wa.me/79143592767" target="_blank" rel="noopener" style="color:var(--green);font-weight:700">WhatsApp</a> · <a href="https://t.me/+79143592767" target="_blank" rel="noopener" style="color:#2f6fb0;font-weight:700">Telegram</a> — +7 914 359-27-67</p>
            <h3>🕒 Режим работы</h3><p>Пн–Пт: 9:00 – 19:00<br>Сб: 10:00 – 16:00<br>Вс: выходной</p>
          </div>
        </div>
        <div>
          <div class="map-embed">
            <iframe loading="lazy" src="https://yandex.ru/map-widget/v1/?ll=113.501049%2C52.033635&z=16&text=Чита%20улица%20Бутина%2044" title="Карта — ул. Бутина, 44, Чита"></iframe>
          </div>
          <div class="info-block" style="margin-top:22px">
            <h3>Напишите нам</h3>
            <div class="form-error" id="fbErr" hidden></div>
            <form id="feedbackForm">
              <div class="form-row"><label>Имя*</label><input name="name" required></div>
              <div class="form-row"><label>Телефон</label><input name="phone" type="tel" placeholder="+7 914 000-00-00"></div>
              <div class="form-row"><label>Сообщение*</label><textarea name="message" required></textarea></div>
              <button class="btn btn--primary" type="submit">Отправить</button>
            </form>
          </div>
        </div>
      </div>
    </div>`;
  $('#feedbackForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api('/feedback', { method: 'POST', body: { name: f.get('name'), phone: f.get('phone'), message: f.get('message') } });
      toast('Сообщение отправлено!', 'success'); e.target.reset(); }
    catch (err) { toast(err.message, 'error'); }
  });
}

// ============================================================
//  СТРАНИЦА: БЛОГ
// ============================================================
function renderBlog() {
  const posts = [
    { icon:'🪆', date:'12 июня 2026', title:'Как рождается матрёшка', text:'Рассказываем весь путь — от липовой заготовки до последнего мазка кисти.' },
    { icon:'🌲', date:'28 мая 2026', title:'Почему мы работаем с кедром', text:'Сибирский кедр — не просто дерево. Делимся, чем он особенный.' },
    { icon:'🧵', date:'15 мая 2026', title:'Секреты льняной вышивки', text:'Традиционные забайкальские узоры и их значение.' },
    { icon:'🎨', date:'2 мая 2026', title:'Хохлома: золото без золота', text:'Как красное и чёрное превращаются в тёплое золото.' },
    { icon:'📦', date:'20 апреля 2026', title:'Как мы упаковываем заказы', text:'Чтобы изделие доехало до вас в целости и с настроением.' },
    { icon:'👐', date:'8 апреля 2026', title:'Знакомьтесь: наши мастера', text:'Люди, которые создают «Матрёшку» каждый день.' }
  ];
  app.innerHTML = `
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Блог</div><h1>Блог мануфактуры</h1><p style="color:var(--ink-soft)">Новости, истории и заметки из мастерской</p></div>
    <div class="container section" style="padding-top:16px">
      <div class="blog-grid">
        ${posts.map(p=>`<article class="blog-card"><div class="blog-card__art">${p.icon}</div><div class="blog-card__body"><span class="blog-card__date">${p.date}</span><h3>${p.title}</h3><p>${p.text}</p><button class="btn btn--link" style="padding-left:0;margin-top:8px" onclick="toast('Полная статья скоро появится :)')">Читать →</button></div></article>`).join('')}
      </div>
    </div>`;
}

// ============================================================
//  СТРАНИЦА: АКЦИИ
// ============================================================
function renderSale() {
  app.innerHTML = `
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Акции</div><h1>Акции и скидки</h1></div>
    <div class="container section" style="padding-top:16px">
      <div class="subscribe" style="background:linear-gradient(135deg,var(--gold),var(--terra));margin-bottom:24px">
        <h2>🎁 Промокоды месяца</h2>
        <p style="margin-bottom:20px">Введите промокод при оформлении заказа</p>
        <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap">
          <div style="background:rgba(255,255,255,.2);padding:18px 28px;border-radius:14px"><b style="font-size:24px;font-family:var(--serif)">СИБИРЬ10</b><br>−10% на весь заказ</div>
          <div style="background:rgba(255,255,255,.2);padding:18px 28px;border-radius:14px"><b style="font-size:24px;font-family:var(--serif)">ЧИТА15</b><br>−15% при заказе от души</div>
        </div>
      </div>
      <div class="info-block">
        <h2>Постоянные предложения</h2>
        <ul>
          <li>🚚 <b>Бесплатный самовывоз</b> из мастерской на ул. Бутина, 44.</li>
          <li>🎀 <b>Подарочная упаковка</b> всего за 150 ₽ — красиво и с душой.</li>
          <li>📦 <b>Скидка оптовикам</b> — специальные цены для магазинов и мастерских. <a href="#/b2b" data-link style="color:var(--terra)">Подробнее →</a></li>
          <li>💛 <b>Кэшбэк отзывами</b> — оставьте отзыв и получите бонус на следующий заказ.</li>
        </ul>
      </div>
      <div style="text-align:center;margin-top:30px"><button class="btn btn--primary btn--lg" onclick="navigate('#/catalog')">За покупками →</button></div>
    </div>`;
}

// ============================================================
//  СТРАНИЦА: ОПТОВИКАМ (B2B)
// ============================================================
function renderB2B() {
  app.innerHTML = `
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Оптовикам</div><h1>Оптовым покупателям</h1></div>
    <div class="container section" style="padding-top:16px">
      <div class="contact-grid">
        <div class="info-block">
          <h2>Сотрудничество</h2>
          <p>Мы рады работать с магазинами сувениров, эко-лавками, отелями, туристическими центрами и всеми, кто ценит настоящее ручное производство.</p>
          <h3>Что предлагаем:</h3>
          <ul>
            <li>Специальные оптовые цены от 10 000 ₽</li>
            <li>Стабильные поставки и брендирование</li>
            <li>Индивидуальные партии под ваш запрос</li>
            <li>Отсрочку платежа для постоянных партнёров</li>
          </ul>
          <p>Оставьте заявку — менеджер свяжется с вами в течение рабочего дня.</p>
        </div>
        <div class="info-block">
          <h3>Заявка на сотрудничество</h3>
          <div class="form-error" id="b2bErr" hidden></div>
          <form id="b2bForm">
            <div class="form-row"><label>Компания</label><input name="company" placeholder="Название организации"></div>
            <div class="form-row"><label>Контактное лицо*</label><input name="name" required></div>
            <div class="form-row"><label>Телефон*</label><input name="phone" type="tel" placeholder="+7 914 000-00-00" required></div>
            <div class="form-row"><label>Комментарий</label><textarea name="message" placeholder="Что вас интересует?"></textarea></div>
            <button class="btn btn--primary btn--block btn--lg" type="submit">Отправить заявку</button>
          </form>
        </div>
      </div>
    </div>`;
  $('#b2bForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api('/b2b', { method: 'POST', body: { company: f.get('company'), name: f.get('name'), phone: f.get('phone'), message: f.get('message') } });
      toast('Заявка отправлена! Мы свяжемся с вами.', 'success'); e.target.reset(); }
    catch (err) { const el=$('#b2bErr'); el.textContent=err.message; el.hidden=false; }
  });
}

// ============================================================
//  СТРАНИЦА: ВОЗВРАТ И ГАРАНТИЯ
// ============================================================
function renderReturns() {
  app.innerHTML = `
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Возврат и гарантия</div><h1>Возврат и гарантия</h1></div>
    <div class="container section" style="padding-top:16px">
      <div class="info-block">
        <h2>Гарантия качества</h2>
        <p>Мы отвечаем за каждое изделие. Если товар пришёл с браком или повреждён при доставке — заменим или вернём деньги.</p>
        <h3>Возврат товара</h3>
        <p>Вы можете вернуть товар надлежащего качества в течение <b>14 дней</b> с момента получения, если он не был в употреблении, сохранены его вид, свойства и упаковка.</p>
        <h3>Как оформить возврат:</h3>
        <ul>
          <li>Свяжитесь с нами по телефону <a href="tel:+79143592767" style="color:var(--terra)">+7 914 359-27-67</a> или в мессенджере.</li>
          <li>Опишите причину возврата, при необходимости приложите фото.</li>
          <li>Согласуем способ возврата и вернём средства в течение 10 дней.</li>
        </ul>
        <h3>Что нельзя вернуть</h3>
        <p>Изделия, изготовленные индивидуально под заказ, а также товары, потерявшие товарный вид по вине покупателя.</p>
        <p style="margin-top:20px;color:var(--ink-soft)">Наша цель — чтобы вы остались довольны. Если что-то пошло не так, просто напишите нам — решим по-человечески.</p>
      </div>
    </div>`;
}

// ============================================================
//  СТРАНИЦА: ЛИЧНЫЙ КАБИНЕТ
// ============================================================
async function renderAccount(_m, params) {
  if (!State.token) { authModal('login'); navigate('#/'); return; }
  const tab = params.get('tab') || 'orders';
  app.innerHTML = `
    <div class="container page-head"><h1>Личный кабинет</h1><p style="color:var(--ink-soft)">${esc(State.user.name)} · ${esc(State.user.phone)}</p></div>
    <div class="container section" style="padding-top:16px">
      <div class="account">
        <nav class="account__nav">
          <button data-tab="orders" class="${tab==='orders'?'active':''}">📦 История заказов</button>
          <button data-tab="fav" class="${tab==='fav'?'active':''}">♥ Избранное</button>
          <button data-tab="address" class="${tab==='address'?'active':''}">📍 Адреса доставки</button>
        </nav>
        <div id="accountBody"></div>
      </div>
    </div>`;
  $$('.account__nav button').forEach(b => b.addEventListener('click', () => navigate('#/account?tab=' + b.dataset.tab)));
  const body = $('#accountBody');

  if (tab === 'orders') {
    body.innerHTML = '<div class="spinner">Загрузка заказов…</div>';
    const orders = await api('/auth/orders');
    body.innerHTML = orders.length ? orders.map(o => `
      <div class="order-card">
        <div class="order-card__head">
          <span class="order-card__id">Заказ №${o.id}</span>
          <span class="status-pill status-${esc(o.status.replace(/\s/g,''))}">${esc(o.status)}</span>
        </div>
        <div class="order-card__meta">${new Date(o.created_at+' UTC').toLocaleString('ru-RU')} · ${esc(o.delivery_method)} · ${esc(o.payment_method)}</div>
        <div class="order-card__items">${o.items.map(i=>`${esc(i.product_name)} × ${i.quantity}`).join('<br>')}</div>
        <div style="text-align:right"><b class="card__price">${money(o.total_price)}</b></div>
      </div>`).join('') : '<div class="empty">У вас пока нет заказов.<br><button class="btn btn--primary" style="margin-top:14px" onclick="navigate(\'#/catalog\')">За покупками</button></div>';
  }
  else if (tab === 'fav') {
    body.innerHTML = '<div class="spinner">Загрузка…</div>';
    const all = await api('/products');
    const favs = all.filter(p => State.favorites.includes(p.id));
    body.innerHTML = favs.length ? `<div class="products-grid">${favs.map(productCard).join('')}</div>`
      : '<div class="empty">В избранном пусто.<br>Нажимайте ♥ на товарах, чтобы сохранить их здесь.</div>';
  }
  else if (tab === 'address') {
    const me = await api('/auth/me');
    const addresses = me.addresses || [];
    body.innerHTML = `
      <div class="info-block">
        <h3>Мои адреса</h3>
        <div id="addrList">${addresses.length?addresses.map((a,i)=>`<div class="radio-card" style="justify-content:space-between"><span>${esc(a)}</span><button class="cart-item__remove" onclick="removeAddress(${i})">🗑</button></div>`).join(''):'<p class="empty">Пока нет сохранённых адресов.</p>'}</div>
        <form id="addrForm" style="margin-top:16px">
          <div class="form-row"><label>Новый адрес</label><input name="address" placeholder="Город, улица, дом, квартира, индекс" required></div>
          <button class="btn btn--primary" type="submit">Добавить адрес</button>
        </form>
      </div>`;
    window.removeAddress = async (idx) => {
      const next = addresses.filter((_, i) => i !== idx);
      await api('/auth/addresses', { method: 'PUT', body: { addresses: next } });
      renderAccount(_m, params);
    };
    $('#addrForm').addEventListener('submit', async e => {
      e.preventDefault();
      const val = new FormData(e.target).get('address');
      await api('/auth/addresses', { method: 'PUT', body: { addresses: [...addresses, val] } });
      toast('Адрес добавлен', 'success');
      renderAccount(_m, params);
    });
  }
}

// ============================================================
//  АДМИН: ПАНЕЛЬ РЕДАКТИРОВАНИЯ КАТАЛОГА (пароль 7316)
// ============================================================
function requireAdmin(onSuccess) {
  openModal(`
    <h2>🔒 Доступ по паролю</h2>
    <p style="color:var(--ink-soft);margin-bottom:18px">Введите пароль администратора.</p>
    <div class="form-error" id="admErr" hidden></div>
    <form id="admForm">
      <div class="form-row"><input name="password" type="password" placeholder="Пароль" autofocus required></div>
      <button class="btn btn--primary btn--block btn--lg" type="submit">Войти</button>
    </form>`);
  $('#admForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pass = new FormData(e.target).get('password');
    State.adminPassword = pass;
    try { await api('/admin/verify', { method: 'POST', admin: true }); onSuccess(); }
    catch { State.adminPassword = null; const el=$('#admErr'); el.textContent='Неверный пароль'; el.hidden=false; }
  });
}

async function openCatalogAdmin() {
  const products = await api('/products');
  openModal(`
    <h2>✎ Управление каталогом</h2>
    <div class="admin-toolbar">
      <span class="catalog__count">Товаров: ${products.length}</span>
      <button class="btn btn--primary" id="addProductBtn">+ Добавить товар</button>
    </div>
    <div style="overflow-x:auto">
    <table class="admin-table">
      <thead><tr><th>Фото</th><th>Название</th><th>Категория</th><th>Цена</th><th>Склад</th><th></th></tr></thead>
      <tbody id="admProducts">
        ${products.map(p=>`<tr>
          <td><img src="${esc(p.images?.[0]||'')}"></td>
          <td><b>${esc(p.name)}</b></td>
          <td>${esc(p.category)}</td>
          <td>${money(p.price)}</td>
          <td>${p.stock}</td>
          <td><div class="admin-actions">
            <button class="btn btn--ghost btn--sm" onclick="editProduct(${p.id})">✎</button>
            <button class="btn btn--danger btn--sm" onclick="deleteProduct(${p.id},'${esc(p.name).replace(/'/g,"")}')">🗑</button>
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>`, 'xwide');
  $('#addProductBtn').addEventListener('click', () => productForm());
}

function productForm(product = null) {
  const isEdit = !!product;
  openModal(`
    <h2>${isEdit?'Редактировать товар':'Новый товар'}</h2>
    <div class="form-error" id="pfErr" hidden></div>
    <form id="productForm">
      <div class="form-row"><label>Название*</label><input name="name" value="${esc(product?.name||'')}" required></div>
      <div class="form-row"><label>Описание</label><textarea name="description">${esc(product?.description||'')}</textarea></div>
      <div class="form-row"><label>Состав / материалы</label><input name="composition" value="${esc(product?.composition||'')}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-row"><label>Категория</label><input name="category" value="${esc(product?.category||'')}" placeholder="Посуда, Текстиль…"></div>
        <div class="form-row"><label>Материал</label><input name="material" value="${esc(product?.material||'')}" placeholder="Дерево, Лён…"></div>
        <div class="form-row"><label>Цена, ₽*</label><input name="price" type="number" step="1" value="${product?.price||''}" required></div>
        <div class="form-row"><label>Количество на складе</label><input name="stock" type="number" value="${product?.stock??0}"></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" name="isPopular" id="pfPop" ${product?.isPopular?'checked':''}><label for="pfPop" style="margin:0">⭐ Показывать в популярных</label></div>
      <div class="form-row">
        <label>Фото товара</label>
        <input type="file" id="pfImage" accept="image/*" ${isEdit?'':''}>
        <div class="form-hint">Загрузите изображение (JPG/PNG). ${isEdit?'Оставьте пустым, чтобы сохранить текущее.':''}</div>
        <div id="pfPreview" style="margin-top:10px">${product?.images?.[0]?`<img src="${esc(product.images[0])}" style="width:90px;height:90px;object-fit:cover;border-radius:10px">`:''}</div>
      </div>
      <button class="btn btn--primary btn--block btn--lg" type="submit">${isEdit?'Сохранить':'Добавить товар'}</button>
    </form>`);

  let imageData = product?.images?.[0] || null;
  $('#pfImage').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { imageData = reader.result;
      $('#pfPreview').innerHTML = `<img src="${imageData}" style="width:90px;height:90px;object-fit:cover;border-radius:10px">`; };
    reader.readAsDataURL(file);
  });

  $('#productForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      name: f.get('name'), description: f.get('description'), composition: f.get('composition'),
      category: f.get('category'), material: f.get('material'),
      price: f.get('price'), stock: f.get('stock'),
      isPopular: $('#pfPop').checked,
      images: imageData ? [imageData] : (product?.images || [])
    };
    try {
      if (isEdit) await api('/admin/products/' + product.id, { method: 'PUT', admin: true, body });
      else await api('/admin/products', { method: 'POST', admin: true, body });
      toast(isEdit ? 'Товар обновлён' : 'Товар добавлен', 'success');
      catalogFacets = null; // сбросить кэш фильтров
      openCatalogAdmin();
    } catch (err) { const el=$('#pfErr'); el.textContent=err.message; el.hidden=false; }
  });
}

window.editProduct = async (id) => {
  const list = await api('/products');
  const p = list.find(x => x.id === id);
  if (p) productForm(p);
};
window.deleteProduct = async (id, name) => {
  if (!confirm('Удалить товар «' + name + '»?')) return;
  await api('/admin/products/' + id, { method: 'DELETE', admin: true });
  toast('Товар удалён');
  catalogFacets = null;
  openCatalogAdmin();
};

// ============================================================
//  АДМИН: ПАНЕЛЬ МОДЕРАЦИИ ЗАКАЗОВ (пароль 7316, polling 10с)
// ============================================================
const STATUSES = ['Новый', 'В обработке', 'Отправлен', 'Выполнен', 'Отменён'];
let lastOrderCount = 0;

async function openModeration() {
  openModal(`
    <h2><span class="live-dot"></span> Панель модерации заказов</h2>
    <p style="color:var(--ink-soft);margin-bottom:16px">Обновляется автоматически каждые 10 секунд.</p>
    <div id="ordersWrap"><div class="spinner">Загрузка заказов…</div></div>
  `, 'wide');
  lastOrderCount = 0;
  await loadOrders(true);
  State.moderationTimer = setInterval(() => loadOrders(false), 10000);
}

async function loadOrders(first) {
  let orders;
  try { orders = await api('/admin/orders', { admin: true }); }
  catch { return; }
  const wrap = $('#ordersWrap');
  if (!wrap) { if (State.moderationTimer) clearInterval(State.moderationTimer); return; }

  // Уведомление о новых заказах
  if (!first && orders.length > lastOrderCount) {
    toast('🔔 Новый заказ! Всего: ' + orders.length, 'success');
  }
  lastOrderCount = orders.length;

  if (orders.length === 0) { wrap.innerHTML = '<div class="empty">Пока нет заказов.</div>'; return; }
  wrap.innerHTML = orders.map(o => `
    <div class="order-card ${o.status==='Новый'?'is-new':''}">
      <div class="order-card__head">
        <span class="order-card__id">Заказ №${o.id}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <select class="status-select" onchange="changeOrderStatus(${o.id}, this.value)">
            ${STATUSES.map(s=>`<option ${s===o.status?'selected':''}>${s}</option>`).join('')}
          </select>
          ${(o.status==='Выполнен'||o.status==='Отменён')?`<button class="btn btn--danger btn--sm" title="Удалить заказ" onclick="deleteOrder(${o.id})">🗑</button>`:''}
        </div>
      </div>
      <div class="order-card__meta">
        👤 <b>${esc(o.customer_name)}</b> · 📞 <a href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a><br>
        🚚 ${esc(o.delivery_method)}${o.delivery_address?' — '+esc(o.delivery_address):''}<br>
        💳 ${esc(o.payment_method)}${o.gift_wrap?' · 🎁 подарочная упаковка':''}${o.promo_code?' · промокод: '+esc(o.promo_code):''}<br>
        🕒 ${new Date(o.created_at+' UTC').toLocaleString('ru-RU')}
        ${o.comment?`<br>💬 <i>${esc(o.comment)}</i>`:''}
      </div>
      <div class="order-card__items">${o.items.map(i=>`• ${esc(i.product_name)} — ${i.quantity} × ${money(i.product_price)}`).join('<br>')}</div>
      <div style="text-align:right"><b class="card__price">${money(o.total_price)}</b></div>
    </div>`).join('');
}

window.changeOrderStatus = async (id, status) => {
  try { await api('/admin/orders/' + id + '/status', { method: 'PUT', admin: true, body: { status } });
    toast('Статус заказа №' + id + ' → ' + status, 'success'); loadOrders(true); }
  catch (err) { toast(err.message, 'error'); }
};

// Удаление заказа из панели модерации (только выполненные/отменённые)
window.deleteOrder = async (id) => {
  if (!confirm('Удалить заказ №' + id + ' безвозвратно?')) return;
  try {
    await api('/admin/orders/' + id, { method: 'DELETE', admin: true });
    toast('Заказ №' + id + ' удалён', 'success');
    lastOrderCount = 0; // чтобы уведомление о «новых» не сработало ложно
    loadOrders(true);
  } catch (err) { toast(err.message, 'error'); }
};

// ============================================================
//  ПОИСК С АВТОДОПОЛНЕНИЕМ
// ============================================================
let searchTimer = null;
$('#searchInput').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $('#searchSuggest');
  if (!q) { box.innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const items = await api('/products/suggest?q=' + encodeURIComponent(q));
      box.innerHTML = items.length ? items.map(i => `<a href="#/product/${esc(i.slug)}">${esc(i.name)}</a>`).join('')
        : '<a style="color:var(--ink-soft);cursor:default">Ничего не найдено</a>';
    } catch {}
  }, 200);
});
$('#searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { navigate('#/catalog'); $('#searchSuggest').innerHTML = ''; e.target.blur(); }
});
document.addEventListener('click', e => {
  if (!e.target.closest('.search')) $('#searchSuggest').innerHTML = '';
  if (!e.target.closest('.dots-menu')) $('#dotsDropdown').hidden = true;
});

// ============================================================
//  ПРИВЯЗКА СОБЫТИЙ ШАПКИ
// ============================================================
$('#loginBtn').addEventListener('click', () => authModal('login'));
$('#registerBtn').addEventListener('click', () => authModal('register'));
$('#logoutBtn').addEventListener('click', logout);
$('#accountBtn').addEventListener('click', () => navigate('#/account'));
$('#favBtn').addEventListener('click', () => { if (State.token) navigate('#/account?tab=fav'); else authModal('login'); });
$('#cartBtn').addEventListener('click', openCart);
$('#cartClose').addEventListener('click', closeCart);
$('#cartOverlay').addEventListener('click', closeCart);

$('#dotsBtn').addEventListener('click', e => { e.stopPropagation(); $('#dotsDropdown').hidden = !$('#dotsDropdown').hidden; });
$('#menuEditCatalog').addEventListener('click', () => { $('#dotsDropdown').hidden = true; requireAdmin(openCatalogAdmin); });
$('#menuModeration').addEventListener('click', () => { $('#dotsDropdown').hidden = true; requireAdmin(openModeration); });

// Мобильное меню (бургер)
$('#burgerBtn').addEventListener('click', () => {
  const nav = document.createElement('div');
  nav.className = 'mobile-nav';
  nav.innerHTML = `
    <button class="icon-btn mobile-nav__close">✕</button>
    <a href="#/catalog">Каталог</a><a href="#/about">О нас</a><a href="#/blog">Блог</a>
    <a href="#/sale">Акции</a><a href="#/b2b">Оптовикам</a><a href="#/contacts">Контакты</a>`;
  document.body.appendChild(nav);
  nav.querySelector('.mobile-nav__close').addEventListener('click', () => nav.remove());
  nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => nav.remove()));
});

// Обработка кликов по ссылкам data-link (плавно)
document.addEventListener('click', e => {
  const link = e.target.closest('a[data-link]');
  if (link && link.getAttribute('href')?.startsWith('#')) {
    // хэш-роутер сработает сам
  }
});

// ============================================================
//  ИНИЦИАЛИЗАЦИЯ
// ============================================================
renderAuthUI();
updateCartBadge();
updateFavBadge();
if (!window.location.hash) window.location.hash = '#/';
router();

// Проверяем валидность токена при загрузке
if (State.token) {
  api('/auth/me').catch(() => { /* токен истёк */ State.token=null; State.user=null;
    localStorage.removeItem('mtr_token'); localStorage.removeItem('mtr_user'); renderAuthUI(); });
}
