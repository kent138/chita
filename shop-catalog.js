'use strict';
const crypto=require('crypto');
const {put}=require('@vercel/blob');
const {pool,mapProduct}=require('./shop-db');
const {wrap,error,userAuth,adminAuth,safeText}=require('./shop-auth');

const slugify=(text)=>{
 const map={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ы:'y',э:'e',ю:'yu',я:'ya'};
 return String(text).toLocaleLowerCase('ru').split('').map(c=>map[c]===undefined?c:map[c]).join('')
   .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'tovar';
};
const productCols='id,slug,name,description,composition,material,width,price,category,stock,is_popular,images,created_at,updated_at';
const validNumber=(n,min,max,field)=>{
 const v=Number(n); if(!Number.isFinite(v)||v<min||v>max)throw error('Некорректное поле: '+field);
 return v;
};
function productData(b,old){
 const name=safeText(b.name ?? old?.name,250);
 if(name.length<2)throw error('Название товара должно содержать минимум 2 символа');
 const stock=validNumber(b.stock??old?.stock,0,1000000,'остаток');
 if(!Number.isInteger(stock))throw error('Остаток должен быть целым числом');
 return {
  name,description:safeText(b.description??old?.description,10000),
  composition:safeText(b.composition??old?.composition,1000),
  material:safeText(b.material??old?.material,150),
  width:safeText(b.width??old?.width,100),
  price:validNumber(b.price??old?.price,0,100000000,'цена'),
  category:safeText(b.category??old?.category,150),
  stock,
  isPopular:b.isPopular===undefined?!!old?.is_popular:!!b.isPopular
 };
}
async function normalizeImages(raw,id) {
 if(!Array.isArray(raw)||raw.length>8)throw error('Разрешено не более 8 фотографий');
 const uploaded=[];
 for(let i=0;i<raw.length;i++){
   const s=raw[i]; if(typeof s!=='string')throw error('Некорректная фотография');
   if(s.startsWith('https://')){
     const u=new URL(s);
     if(!u.hostname.endsWith('.public.blob.vercel-storage.com'))throw error('Фотографии необходимо загружать через форму');
     uploaded.push(s);continue;
   }
   const m=/^data:image\/(webp|png|jpeg|gif);base64,([a-z0-9+/=\r\n]+)$/i.exec(s);
   if(!m)throw error('Поддерживаются WebP, PNG, JPEG, GIF');
   const buffer=Buffer.from(m[2],'base64');
   if(buffer.length<12||buffer.length>8*1024*1024)throw error('Размер фотографии не должен превышать 8 МБ');
   const ext=m[1]==='jpeg'?'jpg':m[1].toLowerCase();
   const isValid=ext==='webp'?buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP'
      :ext==='png'?buffer.subarray(0,4).equals(Buffer.from([137,80,78,71]))
      :ext==='jpg'?buffer[0]===255&&buffer[1]===216
      :buffer.toString('ascii',0,3)==='GIF';
   if(!isValid)throw error('Содержимое фотографии не соответствует формату');
   const name='v2/media/product-'+id+'-'+crypto.randomUUID()+'.'+ext;
   const b=await put(name,buffer,{access:'public',contentType:'image/'+m[1].toLowerCase(),
     addRandomSuffix:false,cacheControlMaxAge:31536000});
   uploaded.push(b.url);
 }
 return uploaded;
}
function register(app){
 app.get('/api/products',wrap(async(req,res)=>{
  const conditions=['active=true'],params=[];
  const add=(sql,val)=>{params.push(val);conditions.push(sql.replace(/\?/g,'$'+params.length));};
  if(req.query.category)add('category=?',String(req.query.category).slice(0,150));
  if(req.query.material)add('material=?',String(req.query.material).slice(0,150));
  if(req.query.minPrice!==undefined&&req.query.minPrice!=='')add('price>=?',validNumber(req.query.minPrice,0,100000000,'цена'));
  if(req.query.maxPrice!==undefined&&req.query.maxPrice!=='')add('price<=?',validNumber(req.query.maxPrice,0,100000000,'цена'));
  if(req.query.inStock==='1')conditions.push('stock>0');
  if(req.query.popular==='1')conditions.push('is_popular=true');
  if(req.query.search)add("(name ILIKE ? OR description ILIKE ?)",'%'+String(req.query.search).slice(0,150).replace(/[%_]/g,'\\$&')+'%');
  const whereFinal=conditions.join(' AND ');
  const limitPresent=req.query.limit!==undefined;
  const page=Math.max(1,Math.floor(Number(req.query.page)||1));
  const limit=Math.min(48,Math.max(1,Math.floor(Number(req.query.limit)||24)));
  const order='ORDER BY is_popular DESC, created_at DESC, id DESC';
  if(limitPresent){
    const total=Number((await pool.query('SELECT count(*)::int AS n FROM shop_products WHERE '+whereFinal,params)).rows[0].n);
    const result=await pool.query('SELECT '+productCols+' FROM shop_products WHERE '+whereFinal+' '+order+
       ' LIMIT $'+(params.length+1)+' OFFSET $'+(params.length+2),[...params,limit,(page-1)*limit]);
    res.set('Cache-Control','public,max-age=0,s-maxage=5,stale-while-revalidate=20');
    return res.json({items:result.rows.map(mapProduct),total,page,limit,pages:Math.ceil(total/limit)});
  }
  // Admin legacy editor and favorites: return a bounded list, without embedded images.
  const result=await pool.query('SELECT '+productCols+' FROM shop_products WHERE '+whereFinal+' '+order+' LIMIT 10000',params);
  res.json(result.rows.map(mapProduct));
 }));
 app.get('/api/products/facets',wrap(async(req,res)=>{
   const [cats,mats,ranges]=await Promise.all([
     pool.query("SELECT DISTINCT category FROM shop_products WHERE active=true AND category<>'' ORDER BY category"),
     pool.query("SELECT DISTINCT material FROM shop_products WHERE active=true AND material<>'' ORDER BY material"),
     pool.query('SELECT min(price) AS min,max(price) AS max FROM shop_products WHERE active=true')
   ]);
   res.json({categories:cats.rows.map(r=>r.category),materials:mats.rows.map(r=>r.material),
     priceMin:Number(ranges.rows[0].min)||0,priceMax:Number(ranges.rows[0].max)||0});
 }));
 app.get('/api/products/suggest',wrap(async(req,res)=>{
   const q=safeText(req.query.q,100).replace(/[%_]/g,'\\$&');
   if(!q)return res.json([]);
   const rows=(await pool.query('SELECT id,slug,name FROM shop_products WHERE active=true AND name ILIKE $1 ORDER BY is_popular DESC,id DESC LIMIT 6',['%'+q+'%'])).rows;
   res.json(rows.map(r=>({...r,id:Number(r.id)})));
 }));
 app.get('/api/products/:key',wrap(async(req,res)=>{
   const key=String(req.params.key);
   const result=await pool.query('SELECT '+productCols+' FROM shop_products WHERE active=true AND (slug=$1 OR id=CASE WHEN $1 ~ $2 THEN $1::bigint ELSE -1 END) LIMIT 1',[key,'^[0-9]{1,15}$']);
   const row=result.rows[0];
   if(!row)throw error('Товар не найден',404);
   const [related,reviews]=await Promise.all([
     pool.query('SELECT '+productCols+' FROM shop_products WHERE active=true AND category=$1 AND id<>$2 ORDER BY is_popular DESC,id DESC LIMIT 4',[row.category,row.id]),
     pool.query('SELECT id,author_name,rating,text,created_at FROM shop_reviews WHERE product_id=$1 AND approved=true ORDER BY created_at DESC LIMIT 40',[row.id])
   ]);
   res.json({product:mapProduct(row),related:related.rows.map(mapProduct),reviews:reviews.rows});
 }));
 app.post('/api/products/:id/reviews',userAuth,wrap(async(req,res)=>{
    const id=Number(req.params.id),rating=Number(req.body?.rating),text=safeText(req.body?.text,2000);
    if(!Number.isSafeInteger(id)||rating<1||rating>5||!Number.isInteger(rating)||text.length<5)throw error('Поставьте оценку и напишите отзыв (не менее 5 символов)');
    const paid=(await pool.query("SELECT 1 FROM shop_orders o JOIN shop_order_items i ON i.order_id=o.id WHERE o.user_id=$1 AND i.product_id=$2 AND o.status<>'Отменён' LIMIT 1",[req.userId,id])).rowCount;
    if(!paid)throw error('Оставить отзыв можно после покупки товара',403);
    const u=(await pool.query('SELECT name FROM shop_users WHERE id=$1',[req.userId])).rows[0];
    const r=(await pool.query('INSERT INTO shop_reviews(product_id,user_id,author_name,rating,text) VALUES($1,$2,$3,$4,$5) RETURNING id',[id,req.userId,u.name,rating,text])).rows[0];
    res.status(201).json({id:Number(r.id),pendingModeration:true});
 }));
 app.post('/api/admin/products',adminAuth,wrap(async(req,res)=>{
    const b=req.body||{},v=productData(b),id=Number((await pool.query("SELECT nextval('shop_product_ids') AS id")).rows[0].id);
    const slug=slugify(v.name)+'-'+id;
    const images=await normalizeImages(b.images||[],id);
    const p=(await pool.query("INSERT INTO shop_products(id,slug,name,description,composition,material,width,price,category,stock,is_popular,images) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING "+productCols,
      [id,slug,v.name,v.description,v.composition,v.material,v.width,v.price,v.category,v.stock,v.isPopular,JSON.stringify(images)])).rows[0];
    res.status(201).json(mapProduct(p));
 }));
 app.put('/api/admin/products/:id',adminAuth,wrap(async(req,res)=>{
    const id=Number(req.params.id);
    const old=(await pool.query('SELECT * FROM shop_products WHERE id=$1 AND active=true',[id])).rows[0];
    if(!old)throw error('Товар не найден',404);
    const v=productData(req.body||{},old);
    const images=Array.isArray(req.body?.images)?await normalizeImages(req.body.images,id):old.images;
    const row=(await pool.query("UPDATE shop_products SET name=$2,description=$3,composition=$4,material=$5,width=$6,price=$7,category=$8,stock=$9,is_popular=$10,images=$11::jsonb,updated_at=now() WHERE id=$1 RETURNING "+productCols,
      [id,v.name,v.description,v.composition,v.material,v.width,v.price,v.category,v.stock,v.isPopular,JSON.stringify(images)])).rows[0];
    res.json(mapProduct(row));
 }));
 app.delete('/api/admin/products/:id',adminAuth,wrap(async(req,res)=>{
    const row=await pool.query('UPDATE shop_products SET active=false,updated_at=now() WHERE id=$1 AND active=true RETURNING id',[Number(req.params.id)]);
    if(!row.rowCount)throw error('Товар не найден',404);
    res.json({ok:true});
 }));
 app.get('/api/admin/reviews',adminAuth,wrap(async(req,res)=>{
   const r=await pool.query('SELECT r.id,r.product_id,r.author_name,r.rating,r.text,r.created_at,p.name AS product_name FROM shop_reviews r JOIN shop_products p ON p.id=r.product_id WHERE r.approved=false ORDER BY r.created_at DESC LIMIT 100');
   res.json(r.rows);
 }));
 app.put('/api/admin/reviews/:id',adminAuth,wrap(async(req,res)=>{
   if(typeof req.body?.approved!=='boolean')throw error('Передайте approved: true или false');
   if(req.body.approved)await pool.query('UPDATE shop_reviews SET approved=true WHERE id=$1',[req.params.id]);
   else await pool.query('DELETE FROM shop_reviews WHERE id=$1 AND approved=false',[req.params.id]);
   res.json({ok:true});
 }));
}
module.exports={register,normalizeImages,productData};
