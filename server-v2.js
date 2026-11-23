'use strict';
const express=require('express');
const path=require('path');
const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'16mb'}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=()');
  next();
});
app.use(express.static(path.join(__dirname,'public'),{
  maxAge:'1h',
  setHeaders(res,p){if(/\.html$/.test(p))res.setHeader('Cache-Control','no-cache');}
}));

// Route buyer accounts to the already-tested Russian service; retain existing Vercel catalog.
'use strict';
// Server-side same-origin gateway: buyer data is persisted ONLY by the Russian DADA service.
// Never proxy product or admin routes: Vercel's existing catalogue stays authoritative.
const REMOTE='https://chita-5949ba.apps.dada-tuda.ru';
const methods=new Set(['GET','POST','PUT','DELETE']);
const paths=new Set(['/register','/login','/logout','/me','/favorites','/cart','/addresses']);
const remoteUrl=path=>REMOTE+'/api/auth'+path;
const originAllowed=req=>{
 const origin=req.get('origin');
 if(!origin)return true;
 try {return new URL(origin).host===req.get('host');}catch{return false;}
};
async function fetchRemote(path,opts={}){
 return fetch(REMOTE+path,{...opts,redirect:'manual',signal:AbortSignal.timeout(9000)});
}
function mountRussianAuth(app){
 // Read-only diagnostic on preview; never includes credentials or buyer details.
 app.get('/api/diagnostics/russian-store',async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const [config,products,me,media,script]=await Promise.all([
    fetchRemote('/api/config'),fetchRemote('/api/products?limit=1&page=1'),
    fetchRemote('/api/auth/me'),
    fetchRemote('/api/media/00000000-0000-4000-8000-000000000000'),
    fetchRemote('/js/app.js?version-check=20261123')
   ]);
   const c=config.ok?await config.json():null;
   const p=products.ok?await products.json():null;
   const mediaError=await media.json().catch(()=>({}));
   const js=script.ok?await script.text():'';
   res.json({
    configHttp:config.status,productsHttp:products.status,
    databaseReady:c?.databaseReady===true,
    registrationEnabled:c?.customerAccountsEnabled===true,
    totalProducts:Number.isSafeInteger(p?.total)?p.total:null,
    unauthenticatedMeHttp:me.status,
    mediaHttp:media.status,mediaError:String(mediaError.error||'').slice(0,100),
    scriptHttp:script.status,hasUpdatedImageForm:js.includes('let imagePending = false;')
   });
  }catch(e){res.status(503).json({error:'Russian store diagnostic unavailable'});}
 });

 app.get('/api/diagnostics/russian-catalog-names',async(req,res)=>{
   res.set('Cache-Control','no-store');
   try{
    const responses=await Promise.all([1,2].map(page=>fetchRemote('/api/products?limit=48&page='+page)));
    if(responses.some(r=>!r.ok))throw Error('Catalog temporarily inaccessible');
    const pages=await Promise.all(responses.map(r=>r.json()));
    res.json({
     total:pages[0].total,
     items:pages.flatMap(x=>x.items).map(p=>({
       id:p.id,name:p.name,slug:p.slug,price:p.price,
       category:p.category,stock:p.stock
     }))
    });
   }catch(e){res.status(503).json({error:'Catalog unavailable'});}
 });
 app.get('/api/config',async(req,res,next)=>{
  try{
   const remote=await fetchRemote('/api/config');
   if(!remote.ok)throw new Error('Russian account service unavailable');
   const cfg=await remote.json();
   if(cfg.databaseReady!==true||cfg.customerAccountsEnabled!==true)
    throw new Error('Russian account service not ready');
   // The product catalogue and admin panel still belong to Vercel/Supabase.
   res.set('Cache-Control','no-store').json({
    version:'2.1',databaseReady:true,acceptingOrders:false,
    adminConfigured:true,customerAccountsEnabled:true,
    cloudAccountsEnabled:false,cloudAccountApiBase:'',
    sellerReady:!!cfg.sellerReady,seller:cfg.seller||null,
    paymentMethods:['При получении','Согласовать с магазином'],
    paymentsOnline:false,shippingPrice:'Уточняется магазином при подтверждении'
   });
  }catch(e){
   // Fail closed: no buyer data is accepted by the Swedish catalogue DB.
   res.set('Cache-Control','no-store').json({
    version:'2.1',databaseReady:true,acceptingOrders:false,
    customerAccountsEnabled:false,cloudAccountsEnabled:false,
    adminConfigured:true,sellerReady:false,seller:null,
    message:'Сервис регистрации временно недоступен'
   });
  }
 });
 app.use('/api/auth',async(req,res)=>{
  if(!methods.has(req.method)||!paths.has(req.path))
   return res.status(404).json({error:'Неизвестный запрос'});
  if(!originAllowed(req))return res.status(403).json({error:'Запрос с другого сайта запрещён'});
  try{
   const headers={'accept':'application/json'};
   if(req.get('cookie'))headers.cookie=req.get('cookie');
   if(req.method!=='GET')headers['content-type']='application/json';
   const upstream=await fetch(remoteUrl(req.path),{
    method:req.method,headers,
    body:req.method==='GET'?undefined:JSON.stringify(req.body||{}),
    redirect:'manual',signal:AbortSignal.timeout(12000)
   });
   res.status(upstream.status);
   res.set('Cache-Control','no-store');
   const cookie=upstream.headers.get('set-cookie');
   if(cookie)res.append('Set-Cookie',cookie);
   res.type('application/json');
   res.send(await upstream.text());
  }catch(e){
   res.status(503).json({error:'Сервис регистрации временно недоступен'});
  }
 });
};

mountRussianAuth(app);

if(process.env.DATABASE_URL || process.env.POSTGRES_URL){
  require('./shop-api')(app);
}else{
  // Catalogue remains online until a separate transactional database is configured.
  app.get('/api/config',(req,res)=>{
    res.set('Cache-Control','no-store');
    res.json({version:'2.1',databaseReady:false,acceptingOrders:false,
      adminConfigured:false,paymentsOnline:false,
      message:'Каталог работает. Для оформления заказов нужна отдельная PostgreSQL-база.'});
  });
  // No transactional DB means no durable brute-force protection. Fail closed:
  // never expose the legacy direct-password admin endpoints.
  app.use('/api/admin',(req,res)=>res.status(503).json({
    error:'Админ-панель будет доступна после подключения отдельной защищённой PostgreSQL-базы.'
  }));
  require('./v2-api')(app);
  const disabled=(req,res)=>res.status(503).json({
    error:'Оформление заказов и личный кабинет будут включены после подключения защищённой базы данных.'
  });
  app.use('/api/auth',disabled);
  app.use('/api/orders',disabled);
  app.use('/api/admin/orders',disabled);
  app.use('/api/products/:id/reviews',disabled);
}
app.use('/api',(req,res)=>res.status(404).json({error:'Неизвестный запрос'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{
  if(err.type==='entity.too.large')return res.status(413).json({error:'Файл слишком большой'});
  console.error('[MATRESHKA-V2]',req.path,err.message);
  const status=Number(err.statusCode);
  res.status(status>=400&&status<=599?status:500).json({
    error:status>=400&&status<=499?err.message:'Не удалось обработать запрос. Попробуйте ещё раз.'
  });
});
const port=process.env.PORT||3000;
if(require.main===module)app.listen(port,()=>console.log('Matreshka v2 listening',port));
module.exports=app;
