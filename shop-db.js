'use strict';
const { Pool } = require('pg');
const { get } = require('@vercel/blob');

// Completely separate PostgreSQL database: never touches the original Turso store.
const externallyManaged = process.env.DB_SCHEMA_MANAGED === '1';
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
// The Vercel Supabase integration provides POSTGRES_URL, without copying
// any passwords into code, client-side JavaScript, or documentation.
const driver = new Pool({
  connectionString: databaseUrl,
  max: 5, connectionTimeoutMillis: 8000, idleTimeoutMillis: 20000,
  application_name: 'matreshka-v2-store'
});
// The integration connects using its managed postgres role, whose default
// search_path is public. Explicitly qualify ONLY table references rather than
// changing a shared role's search_path (which could break Supabase services).
// In particular this works with both session and transaction poolers.
function isolatedSql(sql){
  if(!externallyManaged)return sql;
  const qualify=text=>text
    .replace(/\b(FROM|JOIN|INTO|UPDATE)\s+(shop_(?:users|products|orders|order_items|reviews|requests|auth_attempts|admin_attempts))\b/gi,
      (_,verb,table)=>verb+' matreshka_private.'+table)
    .replace(/nextval\('shop_product_ids'\)/gi,"nextval('matreshka_private.shop_product_ids')");
  if(typeof sql==='string')return qualify(sql);
  return sql&&typeof sql==='object'&&typeof sql.text==='string'
    ?{...sql,text:qualify(sql.text)}:sql;
}
const pool={
  query(sql,params){return driver.query(isolatedSql(sql),params);},
  async connect(){
    const client=await driver.connect();
    return {
      query(sql,params){return client.query(isolatedSql(sql),params);},
      release(force){client.release(force);}
    };
  },
  end(){return driver.end();}
};
let readyPromise;
const ddl = [
  "CREATE SEQUENCE IF NOT EXISTS shop_product_ids START 100000",
  "CREATE TABLE IF NOT EXISTS shop_users (id BIGSERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL, phone VARCHAR(20) UNIQUE NOT NULL, password_hash TEXT NOT NULL, addresses JSONB NOT NULL DEFAULT '[]', favorites JSONB NOT NULL DEFAULT '[]', consented_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS shop_products (id BIGINT PRIMARY KEY, slug VARCHAR(255) UNIQUE NOT NULL, name VARCHAR(250) NOT NULL, description TEXT NOT NULL DEFAULT '', composition TEXT NOT NULL DEFAULT '', material VARCHAR(150) NOT NULL DEFAULT '', width VARCHAR(100) NOT NULL DEFAULT '', price NUMERIC(12,2) NOT NULL CHECK(price>=0), category VARCHAR(150) NOT NULL DEFAULT '', stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0), is_popular BOOLEAN NOT NULL DEFAULT false, active BOOLEAN NOT NULL DEFAULT true, images JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS shop_orders (id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES shop_users(id) ON DELETE SET NULL, customer_name VARCHAR(150) NOT NULL, customer_phone VARCHAR(20) NOT NULL, delivery_method VARCHAR(70) NOT NULL, delivery_address TEXT NOT NULL DEFAULT '', payment_method VARCHAR(70) NOT NULL, payment_status VARCHAR(50) NOT NULL DEFAULT 'Ожидает оплаты', comment TEXT NOT NULL DEFAULT '', gift_wrap BOOLEAN NOT NULL DEFAULT false, promo_code VARCHAR(40) NOT NULL DEFAULT '', status VARCHAR(50) NOT NULL DEFAULT 'Новый', total_price NUMERIC(12,2) NOT NULL CHECK(total_price>=0), idempotency_key VARCHAR(128) UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS shop_order_items (id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE, product_id BIGINT REFERENCES shop_products(id) ON DELETE SET NULL, product_name TEXT NOT NULL, product_price NUMERIC(12,2) NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0))",
  "CREATE TABLE IF NOT EXISTS shop_reviews (id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE, user_id BIGINT REFERENCES shop_users(id) ON DELETE SET NULL, author_name VARCHAR(120) NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), text TEXT NOT NULL DEFAULT '', approved BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS shop_requests (id BIGSERIAL PRIMARY KEY, type VARCHAR(40) NOT NULL, company TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', phone VARCHAR(24) NOT NULL DEFAULT '', email VARCHAR(255) NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS shop_auth_attempts (id VARCHAR(64) PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS shop_admin_attempts (id VARCHAR(64) PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, lock_level INTEGER NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE INDEX IF NOT EXISTS shop_products_category_idx ON shop_products (active,category,id DESC)",
  "CREATE INDEX IF NOT EXISTS shop_products_material_idx ON shop_products (active,material,id DESC)",
  "CREATE INDEX IF NOT EXISTS shop_products_price_idx ON shop_products (active,price)",
  "CREATE INDEX IF NOT EXISTS shop_products_popular_idx ON shop_products (active,is_popular,id DESC)",
  "CREATE INDEX IF NOT EXISTS shop_orders_user_idx ON shop_orders (user_id,created_at DESC)",
  "CREATE INDEX IF NOT EXISTS shop_orders_status_idx ON shop_orders (status,created_at DESC)",
  "CREATE INDEX IF NOT EXISTS shop_order_items_order_idx ON shop_order_items (order_id)",
  "CREATE INDEX IF NOT EXISTS shop_reviews_product_idx ON shop_reviews (product_id,approved)"
];

async function sourceCatalog() {
  const object = await get('v2/catalog.json',{access:'public'});
  if(!object || !object.stream) throw new Error('Исходный каталог V2 недоступен');
  const products = JSON.parse(await new Response(object.stream).text());
  if (!Array.isArray(products) || !products.length) throw new Error('Исходный каталог пуст');
  return products;
}
async function bootstrap() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Transaction-scoped advisory lock works with pooled PostgreSQL connections.
    await c.query('SELECT pg_advisory_xact_lock(20261111,20)');
    if (externallyManaged) {
      const found=(await c.query("SELECT to_regclass('matreshka_private.shop_products') IS NOT NULL AS present")).rows[0].present;
      if(!found)throw new Error('Wrong PostgreSQL connection: isolated matreshka_private schema is missing');
      const expected='https://odaitemhtecieklsbnpd.supabase.co';
      if(process.env.SUPABASE_URL && process.env.SUPABASE_URL!==expected){
        throw new Error('Supabase integration points to another project');
      }
    } else {
      for (const sql of ddl) await c.query(sql);
    }
    const n=(await c.query('SELECT count(*)::int AS n FROM shop_products')).rows[0].n;
    if (n === 0) {
      const catalog=await sourceCatalog();
      for (const p of catalog) {
        await c.query(
          "INSERT INTO shop_products (id,slug,name,description,composition,material,width,price,category,stock,is_popular,images,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) ON CONFLICT (id) DO NOTHING",
          [p.id,p.slug,p.name,p.description||'',p.composition||'',p.material||'',p.width||'',
            Number(p.price),p.category||'',Math.max(0,Number(p.stock)||0),!!p.isPopular,
            JSON.stringify(p.images||[]),p.createdAt||new Date().toISOString(),p.updatedAt||new Date().toISOString()]
        );
      }
    }
    await c.query('COMMIT');
  } catch(e) {
    try {await c.query('ROLLBACK');}catch{}
    throw e;
  } finally {
    c.release();
  }
}
async function ready() {
  if(!readyPromise) readyPromise=bootstrap().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function mapProduct(p){
  if(!p) return null;
  return {id:Number(p.id),slug:p.slug,name:p.name,description:p.description,composition:p.composition,
    material:p.material,width:p.width,price:Number(p.price),category:p.category,
    stock:p.stock,isPopular:p.is_popular,images:Array.isArray(p.images)?p.images:[],
    createdAt:p.created_at,updatedAt:p.updated_at};
}
module.exports={pool,ready,mapProduct};
