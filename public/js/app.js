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
  adminPassword: null,          // старое значение больше не используется: вход через защищённую cookie
  adminLockTimer: null,
  moderationTimer: null         // таймер polling для панели модерации
};

const Shop = { databaseReady:false, acceptingOrders:false, adminConfigured:false, seller:null };

// -------------------- API-обёртка --------------------
async function api(path, { method = 'GET', body, admin = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // Session and administrator authentication use HttpOnly same-site cookies.
  // Passwords are not transmitted with each API call.

  let res;
  try {
    res = await fetch('/api' + path, {
      method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    // fetch падает, если сервер не запущен или недоступен
    throw new Error('Нет связи с магазином. Проверьте интернет и повторите попытку.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const failure = new Error(data.error || ('Ошибка сервера (код ' + res.status + ')'));
    failure.retryAfterSeconds=Number(data.retryAfterSeconds)||0;
    failure.status=res.status;
    throw failure;
  }
  return data;
}

// -------------------- Утилиты --------------------
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const money = n => new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
const formatShopDate = d => { const s=String(d||''); const x=new Date(s); return Number.isNaN(x.getTime()) ? s : x.toLocaleString('ru-RU'); };
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
  if (State.adminLockTimer) { clearInterval(State.adminLockTimer); State.adminLockTimer = null; }
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
      </form>`;
    $('#loginForm').addEventListener('submit', handleLogin);
  } else {
    wrap.innerHTML = `
      <h2>Создать аккаунт</h2>
      <p style="color:var(--ink-soft);margin-bottom:20px">Быстрая регистрация — только нужное.</p>
      <div class="form-error" id="authErr" hidden></div>
      <form id="registerForm">
        <div class="form-row"><label>Имя</label><input name="name" placeholder="Как вас зовут?" required></div>
        <div class="form-row"><label>Телефон</label><input name="phone" type="tel" placeholder="+7 914 000-00-00" required></div>
        <div class="form-row"><label>Пароль</label><input name="password" type="password" placeholder="Не короче 10 символов" required></div>
        <div class="form-row"><label>Повторите пароль</label><input name="passwordRepeat" type="password" required></div>
        <label class="checkbox-row consent-row">
          <input type="checkbox" name="consent" id="regConsent" required>
          <span>Я согласен(а) на <a href="#/privacy" data-link onclick="closeModal()">обработку персональных данных</a></span>
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
      password: f.get('password'), passwordRepeat: f.get('passwordRepeat'), consent: true } });
    onAuthSuccess(data);
  } catch (err) { showAuthErr(err.message); }
}

function onAuthSuccess(data) {
  State.token = 'session'; State.user = data.user;
  localStorage.setItem('mtr_token', 'session');
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

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (e) { console.warn(e.message); }
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
        <span class="card__badge">${esc(p.category || "В наличии")}</span>
        <button class="card__fav ${isFav?'active':''}" data-fav="${p.id}" onclick="event.stopPropagation();toggleFav(${p.id})">♥</button>
      </div>
      <div class="card__body">
        <span class="card__cat">${esc(p.category)}</span>
        <div class="card__title" onclick="navigate('#/product/${esc(p.slug)}')">${esc(p.name)}</div>
        <div class="card__stock ${inStock?'in':'out'}">${inStock?'✓ В наличии':'Нет в наличии'}</div>
        <div class="card__foot">
          <span class="card__price">${money(p.price)}</span>
          <button class="btn btn--primary btn--sm" onclick="navigate('#/product/${esc(p.slug)}')">Подробнее</button>
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
  { re: /^\/privacy$/,          render: renderPrivacy },
  { re: /^\/privacy$/,          render: renderPrivacy },
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
  const popular = (await api('/products?limit=12')).items || [];
  app.innerHTML = `
    <section class="hero hero--fabric">
      <div class="container">
        <div class="hero__solo">
          <span class="hero__eyebrow">Чита · Забайкальский край</span>
          <h1>Ткани, в которые<br><span class="accent">легко влюбиться.</span></h1>
          <p class="hero__lead">Магазин тканей и фурнитуры «Матрёшка» в Чите. Выбирайте материалы для своих идей — с фотографиями, ценами и актуальным ассортиментом.</p>
          <div class="hero__cta">
            <button class="btn btn--primary btn--lg" onclick="navigate('#/catalog')">Смотреть каталог</button>
            <button class="btn btn--ghost btn--lg" onclick="navigate('#/contacts')">Адрес магазина</button>
          </div>
        </div>
        <div class="hero-v2-gallery" aria-label="Ткани из каталога">
          ${popular.slice(0,3).map((p,i)=>`<figure class="hero-v2-tile hero-v2-tile--${i}"><img src="${esc(p.images?.[0]||'')}" alt="${esc(p.name)}" loading="${i===0?'eager':'lazy'}"><figcaption>${esc(p.name)}</figcaption></figure>`).join('')}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="features">
          <div class="feature"><div class="feature__icon">🧵</div><h3>Ткани на любой вкус</h3><p>От натуральных материалов до нарядных тканей для особых проектов.</p></div>
          <div class="feature"><div class="feature__icon">🎨</div><h3>Вдохновение для шитья</h3><p>Удобно сравнивайте фактуру, состав и цену материалов.</p></div>
          <div class="feature"><div class="feature__icon">📍</div><h3>В самом сердце Читы</h3><p>Магазин «Матрёшка», ул. Бутина, 44, помещение 1.</p></div>
          <div class="feature"><div class="feature__icon">⚡</div><h3>Удобный каталог</h3><p>Быстрый поиск, фильтры и загрузка товаров по страницам.</p></div>
        </div>
      </div>
    </section>

    <section class="section section--tint">
      <div class="container">
        <div class="section__head"><h2>Ткани в наличии</h2><p>Реальные товары из нашего каталога</p><div class="ornament"></div></div>
        <div class="products-grid">${popular.slice(0,8).map(productCard).join('')}</div>
        <div style="text-align:center;margin-top:34px"><button class="btn btn--gold btn--lg" onclick="navigate('#/catalog')">Весь каталог →</button></div>
      </div>
    </section>

    <section class="section section--contact">
      <div class="container v2-info-panel">
        <div>
          <span class="hero__eyebrow">Магазин в Чите</span>
          <h2>Подберите ткань для новой идеи</h2>
          <p>Изучайте фотографии, составы и цены прямо в каталоге. Уточнить характеристики и наличие можно у магазина «Матрёшка».</p>
          <div class="v2-info-actions">
            <a class="btn btn--primary btn--lg" href="#/catalog">Открыть каталог</a>
            <a class="btn btn--ghost btn--lg" href="tel:+79143592767">Позвонить в магазин</a>
          </div>
        </div>
        <div class="v2-address"><span>Ждём вас по адресу</span><strong>Чита, ул. Бутина, 44</strong><span>Помещение 1</span><a href="#/contacts">Контакты и расположение →</a></div>
      </div>
    </section>`;
}

// ============================================================
//  СТРАНИЦА: КАТАЛОГ
// ============================================================
let catalogFacets = null;
async function renderCatalog(_m, params) {
  // Render immediately: filters and products load independently.
  let filters={category:params.get('category')||'',material:'',minPrice:'',maxPrice:'',inStock:false};
  let currentPage=1,requestSerial=0;
  const pageSize=24;
  app.innerHTML = [
    '<div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Каталог</div>',
    '<h1>Каталог тканей и фурнитуры</h1><p style="color:var(--ink-soft)">Материалы для творчества, шитья и вдохновения.</p></div>',
    '<div class="container section" style="padding-top:20px"><div class="catalog"><aside class="filters">',
    '<h3>Фильтры</h3><div id="v2Filters">Загружаем фильтры…</div></aside><div>',
    '<div class="catalog__head"><span class="catalog__count" id="catCount" aria-live="polite">Загружаем товары…</span></div>',
    '<div class="products-grid" id="catGrid"><div class="v2-loading">Загружаем каталог…</div></div>',
    '<nav class="v2-pages" id="v2Pages" aria-label="Страницы каталога"></nav></div></div></div>'
  ].join('');
  const grid=$('#catGrid'),counter=$('#catCount'),pages=$('#v2Pages'),filterBox=$('#v2Filters');
  const active=()=>$('#catGrid')===grid;
  async function loadPage(page=1){
    currentPage=page;
    const req=++requestSerial;
    grid.innerHTML='<div class="v2-loading">Загружаем товары…</div>';
    counter.textContent='Загружаем товары…';pages.innerHTML='';
    const q=new URLSearchParams({page:String(currentPage),limit:String(pageSize)});
    if(filters.category)q.set('category',filters.category);
    if(filters.material)q.set('material',filters.material);
    if(filters.minPrice!=='')q.set('minPrice',filters.minPrice);
    if(filters.maxPrice!=='')q.set('maxPrice',filters.maxPrice);
    if(filters.inStock)q.set('inStock','1');
    try{
      const data=await api('/products?'+q.toString());
      if(!active()||req!==requestSerial)return;
      const items=Array.isArray(data.items)?data.items:[];
      const total=Number(data.total)||0;
      const count=Math.max(1,Number(data.pages)||1);
      counter.textContent='Найдено товаров: '+total;
      grid.innerHTML=items.length?items.map(productCard).join(''):'<div class="empty">Ничего не найдено.</div>';
      if(count>1){
        const nums=[...new Set([1,count,currentPage-1,currentPage,currentPage+1].filter(n=>n>=1&&n<=count))].sort((a,b)=>a-b);
        let html='<button data-page="'+Math.max(1,currentPage-1)+'" '+(currentPage<=1?'disabled':'')+'>‹</button>';
        nums.forEach((n,i)=>{
          if(i && n-nums[i-1]>1)html+='<span>…</span>';
          html+='<button data-page="'+n+'" '+(n===currentPage?'aria-current="page"':'')+'>'+n+'</button>';
        });
        html+='<button data-page="'+Math.min(count,currentPage+1)+'" '+(currentPage>=count?'disabled':'')+'>›</button>';
        pages.innerHTML=html;
        pages.querySelectorAll('button[data-page]').forEach(btn=>btn.addEventListener('click',()=>{
          if(btn.disabled)return;loadPage(Number(btn.dataset.page));
          window.scrollTo({top:0,behavior:'smooth'});
        }));
      }
    }catch(e){
      if(!active()||req!==requestSerial)return;
      counter.textContent='Не удалось загрузить товары';
      grid.innerHTML='<div class="empty">'+esc(e.message)+' <button id="v2Retry" class="btn btn--primary">Повторить</button></div>';
      $('#v2Retry')?.addEventListener('click',()=>loadPage(currentPage));
    }
  }
  loadPage(); // Start before filters finish downloading.
  (async()=>{
    try{
      const facets=catalogFacets||await api('/products/facets');
      if(!active())return;
      catalogFacets=facets;
      let html='<div class="filter-group"><h4>Категория</h4><label><input type="radio" name="category" value="" '+(!filters.category?'checked':'')+'> Все</label>';
      html+=facets.categories.map(c=>'<label><input type="radio" name="category" value="'+esc(c)+'" '+(filters.category===c?'checked':'')+'> '+esc(c)+'</label>').join('');
      html+='</div><div class="filter-group"><h4>Материал</h4><label><input type="radio" name="material" value="" checked> Любой</label>';
      html+=facets.materials.map(m=>'<label><input type="radio" name="material" value="'+esc(m)+'"> '+esc(m)+'</label>').join('');
      html+='</div><div class="filter-group"><h4>Цена, ₽</h4><div class="price-range">';
      html+='<input type="number" id="minPrice" min="0" placeholder="от"><span>—</span><input type="number" id="maxPrice" min="0" placeholder="до"></div></div>';
      html+='<div class="filter-group"><label><input type="checkbox" id="inStock"> Только в наличии</label></div>';
      html+='<button class="btn btn--primary btn--block" id="applyFilters">Применить</button>';
      html+='<button class="btn btn--link btn--block" id="resetFilters">Сбросить</button>';
      filterBox.innerHTML=html;
      function sync(){
        filters={
          category:$('input[name="category"]:checked',filterBox)?.value||'',
          material:$('input[name="material"]:checked',filterBox)?.value||'',
          minPrice:$('#minPrice',filterBox)?.value||'',
          maxPrice:$('#maxPrice',filterBox)?.value||'',
          inStock:$('#inStock',filterBox)?.checked||false
        };
        loadPage(1);
      }
      $('#applyFilters',filterBox).addEventListener('click',sync);
      $$('input[type="radio"],input[type="checkbox"]',filterBox).forEach(e=>e.addEventListener('change',sync));
      $('#resetFilters',filterBox).addEventListener('click',()=>{
        filters={category:'',material:'',minPrice:'',maxPrice:'',inStock:false};
        filterBox.querySelector('input[name="category"][value=""]').checked=true;
        filterBox.querySelector('input[name="material"][value=""]').checked=true;
        $('#minPrice',filterBox).value='';$('#maxPrice',filterBox).value='';$('#inStock',filterBox).checked=false;
        loadPage(1);
      });
    }catch(e){
      if(active())filterBox.innerHTML='<p class="empty">Фильтры временно недоступны. Каталог можно просматривать.</p>';
    }
  })();
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
            ${Shop.acceptingOrders?'':'<span class="v2-purchase-note">Оформление заказов станет доступно после настройки магазина.</span>'}
            <button class="btn btn--primary" id="addCartBtn" ${inStock?'':'disabled'}>В корзину</button>
            <button class="btn btn--ghost" id="buyNowBtn" ${inStock?'':'disabled'}>Купить сейчас</button>
            
            <button class="btn btn--ghost card__fav ${State.favorites.includes(p.id)?'active':''}" data-fav="${p.id}" onclick="toggleFav(${p.id})" style="width:auto">♥</button>
          </div>
          <div class="product__section"><h3>Описание</h3><p>${esc(p.description)}</p></div>
          ${p.composition?`<div class="product__section"><h3>Состав и материалы</h3><p>${esc(p.composition)}</p></div>`:''}
          <div class="product__section">
            ${p.material?`<span class="tag">Состав: ${esc(p.material)}</span>`:''}
            ${p.width?`<span class="tag">Ширина: ${esc(p.width)}</span>`:''}

          </div>
        </div>
      </div>

      ${related.length?`
      <div class="section__head" style="text-align:left"><h2 style="font-size:28px">Похожие товары</h2></div>
      <div class="products-grid">${related.map(productCard).join('')}</div>`:''}

      <div class="section" style="padding-bottom:0">
        <div class="section__head" style="text-align:left"><h2 style="font-size:28px">Отзывы</h2></div>
        <div id="reviewsList">
          ${reviews.length?reviews.map(r=>`<div class="review" style="margin-bottom:14px"><div class="review__stars">${'★'.repeat(r.rating)}</div><p class="review__text">${esc(r.text)}</p><div class="review__author">${esc(r.author_name)}</div></div>`).join(''):'<p class="empty">Пока нет отзывов. Будьте первым!</p>'}
        </div>
        <p class="v2-purchase-note">Отзывы можно будет оставлять после запуска продаж.</p>
        <form id="reviewForm" class="v2-review-form" style="margin-top:12px">
          <label>Ваша оценка <select name="rating"><option value="5">5 ★</option><option value="4">4 ★</option><option value="3">3 ★</option><option value="2">2 ★</option><option value="1">1 ★</option></select></label>
          <div class="form-row"><label>Отзыв о покупке</label><textarea name="text" placeholder="Поделитесь впечатлением" required minlength="5"></textarea></div>
          <button type="submit" class="btn btn--ghost">Отправить на проверку</button>
        </form>
      </div>
    </div>`;

  $('#addCartBtn')?.addEventListener('click', () => addToCart(p));
  $('#buyNowBtn')?.addEventListener('click', () => { addToCart(p); navigate('#/checkout'); });
  $('#reviewForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!State.token) { authModal('login'); return; }
    const f = new FormData(e.target);
    try {
      await api('/products/' + p.id + '/reviews', { method: 'POST',
        body: { rating: f.get('rating'), text: f.get('text'), name: f.get('name') } });
      toast('Отзыв отправлен на проверку!', 'success');
      renderProduct(slug);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ============================================================
//  СТРАНИЦА: ОФОРМЛЕНИЕ ЗАКАЗА
// ============================================================
async function renderCheckout() {
  if (!Shop.acceptingOrders) { app.innerHTML='<div class="container section"><div class="empty">Оформление заказов пока не включено. Каталог доступен для просмотра.</div></div>'; return; }
  if (State.cart.length === 0) {
    app.innerHTML = `<div class="container section"><div class="empty">Корзина пуста.<br><button class="btn btn--primary" style="margin-top:16px" onclick="navigate('#/catalog')">В каталог</button></div></div>`;
    return;
  }
  const u = State.user || {};
  app.innerHTML = `
    <div class="container page-head"><h1>Оформление заказа</h1></div>
    <div class="container section" style="padding-top:16px">
      <div class="checkout-grid">
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
            <h3>Оплата</h3>
            <label class="radio-card"><input type="radio" name="payment" value="При получении" checked><span><b>При получении</b><small>Согласуйте условия оплаты с магазином при подтверждении заказа</small></span></label>
            <label class="radio-card"><input type="radio" name="payment" value="Согласовать с магазином"><span><b>Согласовать с магазином</b><small>Менеджер свяжется с вами после оформления заказа</small></span></label>
            <p class="form-hint">Онлайн-оплата картой и СБП пока не подключены. Не отправляйте платёж до подтверждения магазина.</p>
          </div>

          <div class="info-block">
            <h3>Дополнительно</h3>
            
            <div class="form-row"><label>Комментарий к заказу</label><textarea name="comment" placeholder="Пожелания по заказу, удобное время доставки…"></textarea></div>
          </div>
          <label class="checkbox-row consent-row"><input id="orderConsent" type="checkbox" required><span>Согласен(на) на обработку данных для оформления заказа согласно <a href="#/privacy" data-link>политике конфиденциальности</a></span></label>
        </form>

        <aside class="filters checkout-summary">
          <h3>Ваш заказ</h3>
          <div id="checkoutItems"></div>
          <div class="cart-total" style="margin-top:16px"><span>Стоимость товаров:</span> <b id="checkoutTotal">${money(cartTotal())}</b></div>
          <p class="form-hint">Стоимость и сроки доставки согласуются с магазином до оплаты. Онлайн-оплата не подключена.</p>
          <button class="btn btn--primary btn--block btn--lg" id="placeOrderBtn">Отправить заказ</button>
          <p class="form-hint" style="text-align:center">Отправка заявки не означает проведение платежа.</p>
        </aside>
      </div>
    </div>`;

  function renderSummary() {
    $('#checkoutItems').innerHTML = State.cart.map(i => `
      <div style="display:flex;justify-content:space-between;font-size:14px;padding:6px 0;border-bottom:1px solid var(--cream-2)">
        <span>${esc(i.name)} × ${i.quantity}</span><b>${money(i.price*i.quantity)}</b></div>`).join('');
    $('#checkoutTotal').textContent = money(cartTotal());
  }
  renderSummary();
  $$('input[name="delivery"]').forEach(r => r.addEventListener('change', () => {
    $('#addressRow').hidden = r.value === 'Самовывоз';
  }));

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
    if (!$('#orderConsent').checked) return toast('Подтвердите согласие на обработку данных', 'error');
    const fingerprint = JSON.stringify(State.cart.map(x=>[x.id,x.quantity]).sort((a,b)=>a[0]-b[0]));
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem('mtr_v2_pending_order')||'null'); } catch {}
    if (!pending || pending.fingerprint !== fingerprint) pending = {fingerprint,key:crypto.randomUUID()};
    sessionStorage.setItem('mtr_v2_pending_order',JSON.stringify(pending));
    const submitButton = $('#placeOrderBtn'); submitButton.disabled=true;
    const body = {
      idempotencyKey:pending.key, consent:true,
      customerName: form.customerName.value, customerPhone: form.customerPhone.value,
      deliveryMethod: delivery, deliveryAddress: form.deliveryAddress.value,
      paymentMethod: payment, comment: form.comment.value,
      items: State.cart.map(i => ({ id: i.id, quantity: i.quantity }))
    };
    try {
      const res = await api('/orders', { method: 'POST', body });
      State.cart = []; saveCart(); sessionStorage.removeItem('mtr_v2_pending_order');
      openModal(`
        <div style="text-align:center">
          <div style="font-size:64px">🎉</div>
          <h2>Заказ №${res.orderId} оформлен!</h2>
          <p style="color:var(--ink-soft);margin:14px 0">Заявка сохранена. Магазин свяжется с вами для подтверждения наличия, доставки и оплаты.</p>
          <p class="product__price">${money(res.total)}</p>
          <button class="btn btn--primary btn--lg" style="margin-top:16px" onclick="closeModal();navigate('#/')">На главную</button>
        </div>`);
    } catch (err) { toast(err.message, 'error'); }
    finally { submitButton.disabled=false; }
  });
}

function renderPrivacy() {
  const seller=Shop.seller;
  const name=seller?.name||'Данные продавца не заполнены';
  const address=seller?.address||'Юридический адрес не заполнен';
  const contact=seller?.contact||'Контакт для обращений не заполнен';
  const ogrn=seller?.ogrn||'ОГРН / ОГРНИП не указан';
  app.innerHTML='<div class="container page-head"><h1>Обработка персональных данных</h1></div>'+
    '<div class="container section"><div class="info-block" style="max-width:860px">'+
    (!seller?'<p class="form-error">Магазин готовится к запуску. Реквизиты продавца ещё не заполнены, регистрация и оформление заказов отключены.</p>':'')+
    '<h3>Сведения об операторе</h3><p>'+esc(name)+' · '+esc(ogrn)+'</p><p>'+esc(address)+'</p>'+
    '<p>Контакт по вопросам обработки данных: '+esc(contact)+'</p>'+
    '<h3>Какие сведения собираются</h3><p>При оформлении заказа: имя, телефон, адрес доставки, состав заказа, комментарий. При регистрации: имя, телефон, защищённый хеш пароля, избранное и история заказов.</p>'+
    '<h3>Цели использования</h3><p>Создание личного кабинета, оформление и сопровождение заказов, связь по вопросам доставки и исполнения обязательств. Данные не публикуются в каталоге.</p>'+
    '<h3>Обращения и удаление данных</h3><p>Для запроса доступа, исправления или удаления данных обратитесь к оператору по указанному контакту. Данные, которые требуется хранить по закону, могут сохраняться в установленные законом сроки.</p>'+
    '<h3>Важная информация</h3><p>Перед запуском продаж оператор должен утвердить полную политику и проверить соответствие хранения и обработки данных применимому законодательству.</p>'+
    '</div></div>';
}

// ============================================================
//  СТРАНИЦА: О НАС
// ============================================================
function renderAbout() {
  app.innerHTML = `
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / О нас</div><h1>О магазине «Матрёшка»</h1></div>
    <div class="container section" style="padding-top:16px">
      <div class="info-block">
        <h2>Ткани и фурнитура в Чите</h2>
        <p>«Матрёшка» — магазин тканей и фурнитуры по адресу г. Чита, ул. Бутина, 44, помещение 1.</p>
        <p>В каталоге можно посмотреть фотографии тканей, узнать их состав, цену и наличие. Мы сохраняем ассортимент и переносим его в новую, более быструю версию сайта.</p>
      </div>
      <div class="features" style="margin-top:30px">
        <div class="feature"><div class="feature__icon">🧵</div><h3>Каталог тканей</h3><p>Фотографии, состав и цена каждого товара.</p></div>
        <div class="feature"><div class="feature__icon">🎨</div><h3>Поиск по материалу</h3><p>Фильтры по ткани, материалу и стоимости.</p></div>
        <div class="feature"><div class="feature__icon">📍</div><h3>Магазин в Чите</h3><p>ул. Бутина, 44, помещение 1.</p></div>
        <div class="feature"><div class="feature__icon">☎</div><h3>Есть вопросы?</h3><p>Уточнить детали можно по телефону магазина.</p></div>
      </div>
      <div style="text-align:center;margin-top:36px"><a class="btn btn--primary btn--lg" href="#/catalog">Перейти в каталог</a></div>
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
        <div class="info-block">
          <h2>Магазин тканей «Матрёшка»</h2>
          <h3>📍 Адрес</h3><p>г. Чита, ул. Бутина, 44, помещение 1</p>
          <h3>📞 Телефон</h3><p><a href="tel:+79143592767" style="color:var(--terra);font-weight:700;font-size:20px">+7 914 359-27-67</a></p>
          <p>Уточните по телефону наличие, цены, режим работы и возможность самовывоза. В тестовой версии оформление заказа пока отключено.</p>
          <p><a class="btn btn--primary" href="#/catalog">Открыть каталог</a></p>
        </div>
        <div class="map-embed">
          <iframe loading="lazy" src="https://yandex.ru/map-widget/v1/?ll=113.501049%2C52.033635&z=16&text=Чита%20улица%20Бутина%2044" title="Карта — ул. Бутина, 44, Чита"></iframe>
        </div>
      </div>
    </div>`;
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
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Специальные предложения</div><h1>Специальные предложения</h1></div>
    <div class="container section" style="padding-top:16px">
      <div class="info-block">
        <h2>Уточняйте действующие акции в магазине</h2>
        <p>Доступность скидок и оптовых условий уточняйте непосредственно у магазина «Матрёшка». На сайте показываются актуальные цены каталога, без автоматических промокодов.</p>
        <p>Адрес: Чита, ул. Бутина, 44, пом. 1. Телефон: <a href="tel:+79143592767">+7 914 359-27-67</a>.</p>
      </div>
      <div style="text-align:center;margin-top:30px"><button class="btn btn--primary btn--lg" onclick="navigate('#/catalog')">Перейти в каталог</button></div>
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
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Возвраты</div><h1>Возврат и обмен</h1></div>
    <div class="container section" style="padding-top:16px"><div class="info-block">
      <h2>Есть вопрос по заказу?</h2>
      <p>Для вопросов о качестве, обмене и возврате свяжитесь с магазином по телефону <a href="tel:+79143592767">+7 914 359-27-67</a>. Сообщите номер заказа и описание ситуации.</p>
      <p>Сроки и условия возврата зависят от вида товара и способа его приобретения. Для тканей, отпускаемых метражом, могут действовать специальные правила. Магазин рассмотрит обращение в соответствии с законодательством РФ.</p>
      <p>Почтовый адрес магазина: Чита, ул. Бутина, 44, пом. 1.</p>
    </div></div>`;
}
function renderPrivacy() {
  const s=Shop.seller||{};
  app.innerHTML = `
    <div class="container page-head"><div class="breadcrumbs"><a href="#/" data-link>Главная</a> / Конфиденциальность</div><h1>Обработка персональных данных</h1></div>
    <div class="container section" style="padding-top:16px"><div class="info-block">
      <p><b>Оператор:</b> ${esc(s.name||'Реквизиты продавца будут указаны перед запуском приёма заказов')}.</p>
      <p><b>ИНН или ОГРН/ОГРНИП:</b> ${esc(s.inn||s.ogrn||'Будет указан до запуска')}.</p>
      <p><b>Юридический адрес:</b> ${esc(s.address||'Будет указан до запуска')}.</p>
      <p><b>Контакт:</b> ${esc(s.contact||'+7 914 359-27-67')}.</p>
      <h2>Какие данные используются</h2>
      <p>При регистрации и заказе могут обрабатываться имя, телефон, адрес доставки, состав заказов и данные учётной записи. Данные необходимы для подтверждения заказа, связи с покупателем, доставки, истории покупок и защиты учётных записей.</p>
      <h2>Обращения по данным</h2>
      <p>Для запроса доступа, уточнения или удаления персональных данных обратитесь по указанному контакту. Отдельные сведения о заказах могут храниться в случаях, предусмотренных законодательством.</p>
      <p class="form-hint">Этот раздел требует проверки и утверждения владельцем магазина до публичного запуска приёма заказов.</p>
    </div></div>`;
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
        <div class="order-card__meta">${formatShopDate(o.created_at)} · ${esc(o.delivery_method)} · ${esc(o.payment_method)}</div>
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
    <p style="color:var(--ink-soft);margin-bottom:18px">Три неверных попытки блокируют вход на 1 минуту, затем на 3, 9 минут и дольше.</p>
    <div class="form-error" id="admErr" hidden></div>
    <form id="admForm">
      <div class="form-row"><input name="password" type="password" placeholder="Пароль" autofocus required></div>
      <button class="btn btn--primary btn--block btn--lg" type="submit">Войти</button>
    </form>`);
  $('#admForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pass = new FormData(e.target).get('password');
    try { await api('/admin/login', { method: 'POST', body: { password: pass } }); onSuccess(); }
    catch (err) {
      const el=$('#admErr'); el.textContent=err.message; el.hidden=false;
      if(err.retryAfterSeconds>0){
        const button=$('#admForm button[type="submit"]');
        button.disabled=true;
        if(State.adminLockTimer)clearInterval(State.adminLockTimer);
        let left=Math.ceil(err.retryAfterSeconds);
        const update=()=>{
          if(!el.isConnected){clearInterval(State.adminLockTimer);State.adminLockTimer=null;return;}
          if(left<=0){
            clearInterval(State.adminLockTimer);State.adminLockTimer=null;
            button.disabled=false;el.textContent='Время блокировки прошло. Можете попробовать снова.';
            return;
          }
          const mm=Math.floor(left/60),ss=String(left%60).padStart(2,'0');
          el.textContent='Вход заблокирован. Повторите через '+mm+':'+ss;
          left--;
        };
        update();State.adminLockTimer=setInterval(update,1000);
      }
    }
  });
}

async function openCatalogAdmin() {
  let currentPage=1, requestNumber=0, searchTimer;
  openModal(`
    <h2>✎ Управление каталогом</h2>
    <div class="admin-toolbar">
      <span class="catalog__count" id="admProductCount">Загрузка…</span>
      <input id="adminSearch" type="search" placeholder="Поиск по каталогу…" aria-label="Поиск товаров">
      <button class="btn btn--primary" id="addProductBtn">+ Добавить товар</button>
    </div>
    <div style="overflow-x:auto">
      <table class="admin-table">
        <thead><tr><th>Фото</th><th>Название</th><th>Категория</th><th>Цена</th><th>Склад</th><th>Действия</th></tr></thead>
        <tbody id="admProducts"><tr><td colspan="6">Загружаем товары…</td></tr></tbody>
      </table>
    </div>
    <div class="admin-pagination" style="display:flex;align-items:center;justify-content:center;gap:15px;margin-top:16px">
      <button id="admPrev" class="btn btn--ghost btn--sm">Назад</button>
      <span id="admPageLabel"></span>
      <button id="admNext" class="btn btn--ghost btn--sm">Вперёд</button>
    </div>
  `, 'xwide');
  const root=$('#modalContent');
  const load=async()=>{
    const n=++requestNumber, query=root.querySelector('#adminSearch').value.trim();
    const params=new URLSearchParams({page:String(currentPage),limit:'50'});
    if(query)params.set('search',query);
    const tbody=root.querySelector('#admProducts');
    tbody.innerHTML='<tr><td colspan="6">Загружаем…</td></tr>';
    try{
      const result=await api('/admin/products?'+params.toString(),{admin:true});
      if(n!==requestNumber||!root.querySelector('#admProducts'))return;
      root.querySelector('#admProductCount').textContent='Товаров: '+result.total;
      tbody.innerHTML=result.items.length ? result.items.map(p=>`<tr>
        <td><img loading="lazy" decoding="async" width="52" height="52" src="${esc(p.images?.[0]||'')}" alt=""></td>
        <td><b>${esc(p.name)}</b></td>
        <td>${esc(p.category)}</td>
        <td>${money(p.price)}</td>
        <td>${p.stock}</td>
        <td><div class="admin-actions"><button class="btn btn--ghost btn--sm" onclick="editProduct(${p.id})" aria-label="Изменить товар">✎</button><button class="btn btn--danger btn--sm" onclick="deleteProduct(${p.id})" aria-label="Удалить товар">🗑</button></div></td>
      </tr>`).join(''):'<tr><td colspan="6">Товары не найдены.</td></tr>';
      root.querySelector('#admPageLabel').textContent=currentPage+' / '+Math.max(1,result.pages);
      root.querySelector('#admPrev').disabled=currentPage<=1;
      root.querySelector('#admNext').disabled=currentPage>=result.pages;
    }catch(err) {
      if(n===requestNumber)tbody.innerHTML='<tr><td colspan="6">'+esc(err.message)+'</td></tr>';
    }
  };
  root.querySelector('#addProductBtn').addEventListener('click',()=>productForm());
  root.querySelector('#admPrev').addEventListener('click',()=>{currentPage=Math.max(1,currentPage-1);load();});
  root.querySelector('#admNext').addEventListener('click',()=>{currentPage++;load();});
  root.querySelector('#adminSearch').addEventListener('input',()=>{
    clearTimeout(searchTimer);currentPage=1;searchTimer=setTimeout(load,250);
  });
  load();
}

// Catalogue-only mode: show an actual useful overview instead of an empty menu.
// This intentionally does NOT bypass the administrator's database-backed login.
async function openCatalogReadOnly(){
  let page=1,serial=0;
  openModal(`
    <h2>👁 Просмотр товаров</h2>
    <p style="color:var(--ink-soft)">Все товары доступны для просмотра. Изменение цен, фотографий и остатков пока отключено, поскольку к новой версии не подключена отдельная база PostgreSQL.</p>
    <div class="admin-toolbar">
      <span class="catalog__count" id="v2ReadOnlyCount">Загрузка товаров…</span>
      <input id="v2ReadOnlySearch" type="search" placeholder="Найти товар…" aria-label="Поиск по товарам">
    </div>
    <div id="v2ReadOnlyContent" aria-live="polite"></div>
    <div class="admin-pagination" style="display:flex;gap:12px;align-items:center;justify-content:center;margin-top:20px">
      <button class="btn btn--ghost btn--sm" id="v2ReadOnlyPrev">← Назад</button>
      <span id="v2ReadOnlyPage">1 / 1</span>
      <button class="btn btn--ghost btn--sm" id="v2ReadOnlyNext">Вперёд →</button>
    </div>
    <div class="info-block" style="margin-top:20px">
      <h3>Как включить редактирование?</h3>
      <p>Нужно подключить <b>новую независимую базу PostgreSQL</b> к проекту matreshka-v2 в Vercel. После подключения появится вход по паролю, а товары можно будет добавлять и изменять. Старый магазин при этом не затрагивается.</p>
    </div>
  `,'xwide');
  const root=$('#modalContent');
  const load=async()=>{
    const n=++serial;
    const q=new URLSearchParams({page:String(page),limit:'24'});
    const search=root.querySelector('#v2ReadOnlySearch')?.value.trim();
    if(search)q.set('search',search);
    try{
      const data=await api('/products?'+q.toString());
      if(n!==serial||!root.querySelector('#v2ReadOnlyContent'))return;
      root.querySelector('#v2ReadOnlyCount').textContent='Товаров: '+data.total;
      root.querySelector('#v2ReadOnlyContent').innerHTML=data.items?.length
        ? '<div class="products-grid">'+data.items.map(productCard).join('')+'</div>'
        : '<p class="empty">Товаров не найдено.</p>';
      root.querySelector('#v2ReadOnlyPage').textContent=page+' / '+Math.max(1,data.pages||1);
      root.querySelector('#v2ReadOnlyPrev').disabled=page<=1;
      root.querySelector('#v2ReadOnlyNext').disabled=page>=(data.pages||1);
    }catch(err){
      if(n===serial&&root.querySelector('#v2ReadOnlyContent'))
        root.querySelector('#v2ReadOnlyContent').textContent='Ошибка загрузки: '+err.message;
    }
  };
  let searchTimer;
  root.querySelector('#v2ReadOnlyPrev').addEventListener('click',()=>{page=Math.max(1,page-1);load();});
  root.querySelector('#v2ReadOnlyNext').addEventListener('click',()=>{page++;load();});
  root.querySelector('#v2ReadOnlySearch').addEventListener('input',()=>{
    clearTimeout(searchTimer);page=1;searchTimer=setTimeout(load,250);
  });
  load();
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
        <div class="form-row"><label>Состав</label><input name="material" value="${esc(product?.material||'')}" placeholder="Хлопок, лён, шёлк…"></div>
        <div class="form-row"><label>Ширина</label><input name="width" value="${esc(product?.width||'')}" placeholder="напр. 20 см"></div>
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
    if(file.size>7*1024*1024){toast('Фотография должна быть меньше 7 МБ','error');e.target.value='';return;}
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
      category: f.get('category'), material: f.get('material'), width: f.get('width'),
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
  try{
    const data = await api('/products/' + id);
    if(data.product) productForm(data.product);
  }catch(err){toast(err.message,'error');}
};
window.deleteProduct = async (id) => {
  if (!confirm('Снять товар №' + id + ' с продажи? Действие сохранит историю заказов.')) return;
  await api('/admin/products/' + id, { method: 'DELETE', admin: true });
  toast('Товар удалён');
  catalogFacets = null;
  openCatalogAdmin();
};

// ============================================================
//  АДМИН: ПАНЕЛЬ МОДЕРАЦИИ ЗАКАЗОВ (пароль 7316, polling 10с)
// ============================================================
const STATUSES = ['Новый', 'В обработке', 'Готов к выдаче', 'Отправлен', 'Выполнен', 'Отменён'];
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
          <span class="status-pill">В истории</span>
        </div>
      </div>
      <div class="order-card__meta">
        👤 <b>${esc(o.customer_name)}</b> · 📞 <a href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a><br>
        🚚 ${esc(o.delivery_method)}${o.delivery_address?' — '+esc(o.delivery_address):''}<br>
        💳 ${esc(o.payment_method)} · <label>Оплата: <select class="status-select" aria-label="Статус оплаты заказа №${o.id}" onchange="changePaymentStatus(${o.id},this.value)">
          ${['Ожидает оплаты','Оплачен','Возврат'].map(x=>`<option value="${x}" ${x===o.payment_status?'selected':''}>${x}</option>`).join('')}
        </select></label><br>
        🕒 ${formatShopDate(o.created_at)}
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

window.changePaymentStatus=async(id,status)=>{
  try {
    await api('/admin/orders/'+id+'/payment',{method:'PUT',admin:true,body:{status}});
    toast('Статус оплаты обновлён','success');loadOrders(true);
  } catch(err) {toast(err.message,'error');loadOrders(true);}
};

// Удаление заказов отключено — история продаж должна сохраняться.
async function openReviewModeration() {
  const list=await api('/admin/reviews',{admin:true});
  openModal('<h2>Отзывы на проверке</h2><div id="reviewModeration"></div>','wide');
  $('#reviewModeration').innerHTML=list.length?list.map(r=>
    '<div class="order-card"><b>'+esc(r.product_name)+'</b> · '+'★'.repeat(r.rating)+
    '<p>'+esc(r.text)+'</p><small>'+esc(r.author_name)+'</small>'+
    '<div class="admin-actions" style="margin-top:12px">'+
    '<button class="btn btn--primary btn--sm" onclick="resolveReview('+r.id+',true)">Опубликовать</button>'+
    '<button class="btn btn--danger btn--sm" onclick="resolveReview('+r.id+',false)">Отклонить</button>'+
    '</div></div>').join(''):'<p class="empty">Новых отзывов нет.</p>';
}
window.resolveReview=async(id,approved)=>{
  try {
    await api('/admin/reviews/'+id,{method:'PUT',admin:true,body:{approved}});
    toast(approved?'Отзыв опубликован':'Отзыв отклонён','success');
    openReviewModeration();
  }catch(err){toast(err.message,'error');}
};
async function openRequests() {
  const items=await api('/admin/requests',{admin:true});
  openModal('<h2>Обращения покупателей и оптовиков</h2><div id="shopRequests"></div>','wide');
  $('#shopRequests').innerHTML=items.length?items.map(i=>
    '<div class="order-card"><div class="order-card__head"><b>'+esc(i.type)+'</b><span>'+
    new Date(i.created_at).toLocaleString('ru-RU')+'</span></div><p>'+
    esc(i.company)+' '+esc(i.name)+' '+esc(i.phone)+' '+esc(i.email)+'</p><p>'+
    esc(i.message)+'</p></div>').join(''):'<p class="empty">Обращений пока нет.</p>';
}

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
  if (e.key === 'Enter') { const term=e.target.value.trim(); navigate('#/catalog'+(term?'?search='+encodeURIComponent(term):'')); $('#searchSuggest').innerHTML = ''; e.target.blur(); }
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
$('#menuEditCatalog').addEventListener('click', () => { $('#dotsDropdown').hidden = true; if(Shop.databaseReady&&Shop.adminConfigured) requireAdmin(openCatalogAdmin); else openCatalogReadOnly(); });
$('#menuModeration')?.addEventListener('click', () => { $('#dotsDropdown').hidden = true; requireAdmin(openModeration); });
$('#menuReviews')?.addEventListener('click', () => { $('#dotsDropdown').hidden = true; requireAdmin(openReviewModeration); });
$('#menuRequests')?.addEventListener('click', () => { $('#dotsDropdown').hidden = true; requireAdmin(openRequests); });

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

async function initializeShop(){
  try{
    const cfg=await api('/config');
    Shop.databaseReady=!!cfg.databaseReady;
    Shop.acceptingOrders=!!cfg.acceptingOrders;
    Shop.adminConfigured=!!cfg.adminConfigured;
    Shop.seller=cfg.seller||null;
    document.body.classList.toggle('v2-preview',!Shop.databaseReady);
    $('#shopNoticeTitle').textContent=Shop.acceptingOrders?'Матрёшка — магазин тканей и фурнитуры':'Матрёшка 2.0 — подготовка к запуску';
    $('#shopNoticeText').textContent=Shop.acceptingOrders
      ?'Каталог и оформление заказов работают. Оплата согласуется с магазином.'
      :Shop.databaseReady
        ?'База товаров и личные кабинеты подключены. Приём заказов пока выключен.'
        :'Каталог работает. Оформление заказов включим после подключения отдельной базы данных.';
    const adminReady=Shop.databaseReady&&Shop.adminConfigured;
    $('#menuEditCatalog').hidden=false;
    $('#menuEditCatalog').textContent=adminReady?'✎ Редактировать каталог':'👁 Просмотр товаров';
    $('#menuModeration').hidden=!adminReady;
    $('#menuRequests').hidden=!adminReady;
    $('#menuReviews').hidden=!adminReady;
    renderAuthUI();
    if(Shop.databaseReady&&State.token){
      try{const me=await api('/auth/me');State.user=me;localStorage.setItem('mtr_user',JSON.stringify(me));}
      catch{State.token=null;State.user=null;localStorage.removeItem('mtr_token');localStorage.removeItem('mtr_user');}
      renderAuthUI();
    }
  }catch(err){
    console.warn('Магазин ещё не настроен:',err.message);
    document.body.classList.add('v2-preview');
  }
}

// ============================================================
//  ИНИЦИАЛИЗАЦИЯ
// ============================================================
renderAuthUI();
updateCartBadge();
updateFavBadge();
initializeShop();
if (!window.location.hash) window.location.hash = '#/';
router();

// Проверяем валидность токена при загрузке
// Session is verified by initializeShop after the database is ready.
