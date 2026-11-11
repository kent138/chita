'use strict';
const { get, head, put } = require('@vercel/blob');
const crypto = require('crypto');
const KEY = 'v2/catalog.json';
let cached = null, cachedAt = 0, cachedEtag = null;
const asyncRoute = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const notFound = e => e && (e.name === 'BlobNotFoundError' || e.statusCode === 404 || e.status === 404 || /not found|does not exist|404/i.test(e.message || ''));
function slugify(s) {
  const m={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ы:'y',э:'e',ю:'yu',я:'ya',ь:'',ъ:''};
  return String(s).toLowerCase().split('').map(c=>m[c]===undefined?c:m[c]).join('').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'tovar';
}
async function readBlob(path) {
  const b=await get(path,{access:'public'});
  if (!b || !b.stream) throw new Error('Файл каталога недоступен');
  return JSON.parse(await new Response(b.stream).text());
}
async function readCatalog(fresh=false) {
  if (!fresh && cached && Date.now()-cachedAt < 7000) return cached;
  try {
    const meta=await head(KEY);
    if (cached && meta.etag===cachedEtag) {cachedAt=Date.now();return cached;}
    const data=await readBlob(KEY);
    if (!Array.isArray(data)) throw new Error('Некорректная структура каталога');
    cached=data;cachedAt=Date.now();cachedEtag=meta.etag;return data;
  } catch(e) {
    if(notFound(e)) throw Object.assign(new Error('Перенос каталога ещё выполняется'),{statusCode:503});
    throw e;
  }
}
function checkAdmin(req,res,next){
  const expected=process.env.ADMIN_PASSWORD;
  const candidate=req.get('X-Admin-Password')||'';
  if(!expected || candidate.length!==expected.length ||
    !crypto.timingSafeEqual(Buffer.from(candidate),Buffer.from(expected)))
    return res.status(403).json({error:'Неверный пароль администратора'});
  next();
}
async function saveCatalog(list, originalEtag){
  const b=await put(KEY,JSON.stringify(list),{access:'public',addRandomSuffix:false,
    allowOverwrite:true,ifMatch:originalEtag,contentType:'application/json',cacheControlMaxAge:60});
  cached=list;cachedAt=Date.now();cachedEtag=b.etag || (await head(KEY)).etag;
}
async function uploadImages(images,id){
  const result=[];
  for(let n=0;n<images.length;n++){
    const img=images[n];
    if(typeof img!=='string') continue;
    if(!img.startsWith('data:')) {result.push(img); continue;}
    const m=/^data:(image\/(webp|png|jpeg|gif));base64,(.+)$/s.exec(img);
    if(!m) throw Object.assign(new Error('Поддерживаются изображения WebP, PNG, JPEG и GIF'),{statusCode:400});
    const ext=m[2]==='jpeg'?'jpg':m[2];
    const bytes=Buffer.from(m[3],'base64');
    if(bytes.length>8*1024*1024) throw Object.assign(new Error('Слишком большое изображение'),{statusCode:400});
    const path='v2/media/product-'+id+'-'+n+'-'+crypto.randomUUID()+'.'+ext;
    const blob=await put(path,bytes,{access:'public',contentType:m[1],addRandomSuffix:false,allowOverwrite:true,cacheControlMaxAge:31536000});
    result.push(blob.url);
  }
  return result;
}
function validate(b){
  if(!b || !String(b.name||'').trim() || !Number.isFinite(Number(b.price)) || Number(b.price)<0)
    throw Object.assign(new Error('Нужны название и корректная цена'),{statusCode:400});
}
module.exports=function(app){
  app.get('/api/v2/status',asyncRoute(async(req,res)=>{
    const list=await readCatalog();
    res.json({version:'2.0-preview',total:list.length,photos:list.reduce((a,p)=>a+(p.images||[]).length,0),
      note:'Изолированный тестовый каталог. Заказы отключены.'});
  }));
  app.get('/api/products',asyncRoute(async(req,res)=>{
    let list=await readCatalog();
    const {category,material,minPrice,maxPrice,inStock,popular,search}=req.query;
    if(category) list=list.filter(p=>p.category===category);
    if(material) list=list.filter(p=>p.material===material);
    if(minPrice!==undefined&&minPrice!=='') list=list.filter(p=>p.price>=Number(minPrice));
    if(maxPrice!==undefined&&maxPrice!=='') list=list.filter(p=>p.price<=Number(maxPrice));
    if(inStock==='1') list=list.filter(p=>p.stock>0);
    if(popular==='1') list=list.filter(p=>p.isPopular);
    if(search){const q=String(search).toLocaleLowerCase('ru');list=list.filter(p=>(p.name+' '+(p.description||'')).toLocaleLowerCase('ru').includes(q));}
    res.set('Cache-Control','public, max-age=0, s-maxage=10, stale-while-revalidate=60');
    if(req.query.limit){
      const limit=Math.min(48,Math.max(1,Number(req.query.limit)||24));
      const page=Math.max(1,Number(req.query.page)||1);
      return res.json({items:list.slice((page-1)*limit,page*limit),total:list.length,page,limit,pages:Math.ceil(list.length/limit)});
    }
    res.json(list);
  }));
  app.get('/api/products/facets',asyncRoute(async(req,res)=>{
    const list=await readCatalog();
    res.json({categories:[...new Set(list.map(p=>p.category).filter(Boolean))].sort(),
     materials:[...new Set(list.map(p=>p.material).filter(Boolean))].sort(),
     priceMin:list.length?Math.min(...list.map(p=>p.price)):0,priceMax:Math.max(0,...list.map(p=>p.price))});
  }));
  app.get('/api/products/suggest',asyncRoute(async(req,res)=>{
    const q=String(req.query.q||'').trim().toLocaleLowerCase('ru');
    if(!q)return res.json([]);
    const list=await readCatalog();
    res.json(list.filter(p=>p.name.toLocaleLowerCase('ru').includes(q)).slice(0,6).map(p=>({id:p.id,slug:p.slug,name:p.name})));
  }));
  app.get('/api/products/:key',asyncRoute(async(req,res)=>{
    const list=await readCatalog();
    const p=list.find(p=>p.slug===req.params.key||String(p.id)===req.params.key);
    if(!p)return res.status(404).json({error:'Товар не найден'});
    res.json({product:p,related:list.filter(x=>x.category===p.category && x.id!==p.id).slice(0,4),reviews:[]});
  }));
  app.post('/api/admin/verify',checkAdmin,(req,res)=>res.json({ok:true}));
  app.post('/api/admin/products',checkAdmin,asyncRoute(async(req,res)=>{
    const b=req.body;validate(b);
    const list=await readCatalog(true);
    const etag=cachedEtag;
    const id=Math.max(0,...list.map(x=>x.id))+1;
    const slugBase=slugify(b.name);
    let slug=slugBase,n=2;while(list.some(p=>p.slug===slug))slug=slugBase+'-'+n++;
    const images=await uploadImages(Array.isArray(b.images)?b.images:[],id);
    const p={id,slug,name:String(b.name).trim(),description:b.description||'',composition:b.composition||'',
      material:b.material||'',width:b.width||'',price:Number(b.price),category:b.category||'',stock:Math.max(0,Number(b.stock)||0),
      isPopular:!!b.isPopular,images,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await saveCatalog([p,...list],etag);
    res.json(p);
  }));
  app.put('/api/admin/products/:id',checkAdmin,asyncRoute(async(req,res)=>{
    const list=await readCatalog(true),etag=cachedEtag,id=Number(req.params.id),index=list.findIndex(p=>p.id===id);
    if(index<0)return res.status(404).json({error:'Товар не найден'});
    const old=list[index],b=req.body;validate({...old,...b});
    const images=Array.isArray(b.images)?await uploadImages(b.images,id):old.images;
    const p={...old,name:b.name??old.name,description:b.description??old.description,composition:b.composition??old.composition,
      material:b.material??old.material,width:b.width??old.width,price:b.price!==undefined?Number(b.price):old.price,
      category:b.category??old.category,stock:b.stock!==undefined?Math.max(0,Number(b.stock)||0):old.stock,
      isPopular:b.isPopular===undefined?old.isPopular:!!b.isPopular,images,updatedAt:new Date().toISOString()};
    list[index]=p;await saveCatalog(list,etag);res.json(p);
  }));
  app.delete('/api/admin/products/:id',checkAdmin,asyncRoute(async(req,res)=>{
    const list=await readCatalog(true),etag=cachedEtag,id=Number(req.params.id);
    if(!list.some(p=>p.id===id))return res.status(404).json({error:'Товар не найден'});
    await saveCatalog(list.filter(p=>p.id!==id),etag);res.json({ok:true});
  }));
};
