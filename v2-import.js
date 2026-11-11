'use strict';
const {put,get,head} = require('@vercel/blob');
const crypto=require('crypto');
const url='https://matreshkachita.vercel.app/api/products';
const KEY='v2/catalog.json';
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const isNotFound=e=>/404|not found|not exist/i.test(String(e?.message||''))||e?.statusCode===404;
function authorized(req,res,next){
 if(process.env.V2_IMPORT_ENABLED!=='1')return res.status(403).json({error:'Импорт не разрешён'});
 const wanted=process.env.ADMIN_PASSWORD||'',got=req.header('X-Admin-Password')||'';
 if(!wanted||wanted.length!==got.length||!crypto.timingSafeEqual(Buffer.from(wanted),Buffer.from(got)))
   return res.status(403).json({error:'Нет доступа'});
 next();
}
async function upload(p){
 const images=[];
 for(let n=0;n<(p.images||[]).length;n++){
  const img=p.images[n];
  if(typeof img!=='string')continue;
  if(!img.startsWith('data:')){images.push(img);continue;}
  const m=/^data:(image\/(webp|jpeg|png|gif));base64,(.*)$/s.exec(img);
  if(!m)throw new Error('Invalid media '+p.id);
  const ext=m[2]==='jpeg'?'jpg':m[2];
  const b=await put('v2/images/p-'+p.id+'-'+n+'.'+ext,Buffer.from(m[3],'base64'),{
   access:'public',addRandomSuffix:false,allowOverwrite:true,contentType:m[1],cacheControlMaxAge:31536000
  });
  images.push(b.url);
 }
 return {...p,images};
}
async function readJSON(path){
 const b=await get(path,{access:'public'});
 if(!b?.stream)throw new Error('Missing stage '+path);
 return JSON.parse(await new Response(b.stream).text());
}
module.exports=app=>{
 app.post('/api/v2/import-batch',authorized,wrap(async(req,res)=>{
  const start=Math.max(0,Math.floor(Number(req.query.start)||0));
  const count=Math.min(3,Math.max(1,Math.floor(Number(req.query.count)||2)));
  const response=await fetch(url,{signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error('Source API '+response.status);
  const items=await response.json();
  if(start>=items.length)return res.status(400).json({error:'Outside catalog',total:items.length});
  const selected=[];
  for(const p of items.slice(start,start+count))selected.push(await upload(p));
  await put('v2/staging/batch-'+start+'.json',JSON.stringify(selected),{access:'public',allowOverwrite:true,addRandomSuffix:false,contentType:'application/json'});
  res.json({start,count:selected.length,next:start+selected.length,total:items.length});
 }));
 app.post('/api/v2/import-finalize',authorized,wrap(async(req,res)=>{
   const total=Math.floor(Number(req.query.total)||0),step=Math.floor(Number(req.query.step)||2);
   if(total<1||total>10000||step<1||step>3)return res.status(400).json({error:'Bad total/step'});
   const list=[];
   for(let start=0;start<total;start+=step)list.push(...(await readJSON('v2/staging/batch-'+start+'.json')));
   if(list.length!==total||new Set(list.map(x=>x.id)).size!==total||list.some(x=>x.images.some(s=>s.startsWith('data:'))))
     return res.status(409).json({error:'Проверка копии каталога не пройдена',found:list.length,total});
   try{await head(KEY);return res.status(409).json({error:'Target catalog already exists'});}catch(e){if(!isNotFound(e))throw e;}
   await put('v2/backups/original-catalog.json',JSON.stringify(list),{access:'public',addRandomSuffix:false,contentType:'application/json'});
   await put(KEY,JSON.stringify(list),{access:'public',addRandomSuffix:false,contentType:'application/json',cacheControlMaxAge:60});
   res.json({ok:true,products:list.length,photos:list.reduce((a,p)=>a+p.images.length,0),bytes:Buffer.byteLength(JSON.stringify(list))});
 }));
};