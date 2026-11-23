'use strict';
const express=require('express');
const path=require('path');
const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'16mb'}));
app.get('/api/diagnostics/timeweb-dns',async(req,res)=>{
 const dns=require('node:dns').promises;
 const result={domain:'matreshka-chita.ru'};
 try{
  result.nameservers=await dns.resolveNs('matreshka-chita.ru');
 }catch(e){result.nsError=e.code||'DNS_ERROR';}
 try{
  const records=(await dns.resolveTxt('_dada-verify.matreshka-chita.ru')).map(parts=>parts.join(''));
  result.txtFound=records.some(x=>x.startsWith('dada-domain-verify='));
  result.txtCount=records.length;
 }catch(e){result.txtFound=false;result.txtError=e.code||'DNS_ERROR';}
 try{
  const ip=(await dns.resolve4('ns1.timeweb.ru'))[0];
  const resolver=new dns.Resolver({timeout:2000,tries:1});
  resolver.setServers([ip]);
  const records=(await resolver.resolveTxt('_dada-verify.matreshka-chita.ru')).map(parts=>parts.join(''));
  result.authoritativeTxtFound=records.some(x=>x.startsWith('dada-domain-verify='));
  result.authoritativeRecordCount=records.length;
 }catch(e){result.authoritativeTxtFound=false;result.authoritativeError=e.code||'DNS_ERROR';}
 res.set('Cache-Control','no-store').json(result);
});
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
   const [config,products,me]=await Promise.all([
    fetchRemote('/api/config'),fetchRemote('/api/products?limit=1&page=1'),
    fetchRemote('/api/auth/me')
   ]);
   const c=config.ok?await config.json():null;
   const p=products.ok?await products.json():null;
   res.json({
    configHttp:config.status,productsHttp:products.status,
    databaseReady:c?.databaseReady===true,
    registrationEnabled:c?.customerAccountsEnabled===true,
    totalProducts:Number.isSafeInteger(p?.total)?p.total:null,
    unauthenticatedMeHttp:me.status
   });
  }catch(e){res.status(503).json({error:'Russian store diagnostic unavailable'});}
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
