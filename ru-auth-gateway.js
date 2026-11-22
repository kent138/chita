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
module.exports=function(app){
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
