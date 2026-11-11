'use strict';
// Cross-device accounts are stored in a SEPARATE Russian PostgreSQL database.
// Never put buyer identities into the Stockholm merchandise database.
const {Pool}=require('pg');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const crypto=require('node:crypto');

const COOKIE='mtr_cloud_buyer';
const ERROR=(message,status=400)=>Object.assign(new Error(message),{statusCode:status});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const open=()=>process.env.ACCOUNT_REGISTRATION_ENABLED==='1'
  && process.env.ACCOUNT_DATA_LOCATION_CONFIRMED==='RU'
  && process.env.ACCOUNT_PRIVACY_POLICY_APPROVED==='1'
  && String(process.env.JWT_SECRET||'').length>=32
  && !!String(process.env.ACCOUNT_DATABASE_URL||'').trim();
let pool,readyPromise;
function getPool(){
  if(!open())throw ERROR('Регистрация покупателей пока не подключена',503);
  if(pool)return pool;
  let url;
  try{url=new URL(process.env.ACCOUNT_DATABASE_URL);}
  catch{throw ERROR('Не задан корректный адрес российской базы аккаунтов',503);}
  if(!['postgres:','postgresql:'].includes(url.protocol))
    throw ERROR('Для аккаунтов требуется PostgreSQL',503);
  const host=url.hostname.toLowerCase();
  const local=['localhost','127.0.0.1'].includes(host);
  if(!local && url.searchParams.get('sslmode')!=='verify-full')
    throw ERROR('Для внешней российской базы нужен sslmode=verify-full',503);
  if(/(^|\.)supabase\.(com|co)$/.test(host)||host.endsWith('.pooler.supabase.com'))
    throw ERROR('База аккаунтов не должна указывать на существующий зарубежный Supabase',503);
  // Database certificate verification stays enabled. For a private CA, add
  // the appropriate certificate via NODE_EXTRA_CA_CERTS at runtime.
  pool=new Pool({connectionString:process.env.ACCOUNT_DATABASE_URL,
    max:4,connectionTimeoutMillis:8000,idleTimeoutMillis:20000,
    application_name:'matreshka-russian-customer-accounts'});
  return pool;
}
async function ready(){
  if(!open())throw ERROR('Регистрация покупателей пока не подключена',503);
  if(!readyPromise)readyPromise=(async()=>{
    const p=getPool();
    const r=await p.query("SELECT to_regclass('public.customer_profiles') IS NOT NULL AS profiles, to_regclass('public.customer_auth_attempts') IS NOT NULL AS attempts");
    if(!r.rows[0]?.profiles||!r.rows[0]?.attempts)
      throw ERROR('Таблицы российской базы покупателей ещё не созданы',503);
    return true;
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function sessionSecret(){
  return crypto.createHmac('sha256',process.env.JWT_SECRET)
    .update('matreshka-v2-russian-customers-v1').digest('hex');
}
const cookieOpts={httpOnly:true,sameSite:'lax',path:'/'};
function issue(res,id){
  const token=jwt.sign({id,kind:'customer-cloud'},sessionSecret(),
    {algorithm:'HS256',issuer:'matreshka-v2',audience:'shop-buyers',expiresIn:'14d'});
  res.cookie(COOKIE,token,{...cookieOpts,
    secure:process.env.NODE_ENV==='production'||!!process.env.VERCEL,
    maxAge:14*86400000});
}
function clear(res){
  res.clearCookie(COOKIE,{...cookieOpts,
    secure:process.env.NODE_ENV==='production'||!!process.env.VERCEL});
}
function decodeCookie(req){
  const part=String(req.headers.cookie||'').split(';').map(x=>x.trim())
    .find(x=>x.startsWith(COOKIE+'='));
  if(!part)return null;
  let token;
  try{token=decodeURIComponent(part.slice(COOKIE.length+1));}catch{return null;}
  try{
    const payload=jwt.verify(token,sessionSecret(),
      {algorithms:['HS256'],issuer:'matreshka-v2',audience:'shop-buyers'});
    return payload.kind==='customer-cloud'&&
      /^[a-f0-9-]{36}$/i.test(String(payload.id||''))?payload.id:null;
  }catch{return null;}
}
function requireUser(req,res,next){
  const id=decodeCookie(req);
  if(!id)return res.status(401).json({error:'Войдите в аккаунт'});
  req.cloudUserId=id;next();
}
const nickname=s=>String(s||'').trim().toLowerCase();
function validateLogin(s){
  const login=nickname(s);
  if(!/^[a-z0-9_.-]{3,32}$/.test(login))
    throw ERROR('Логин: 3–32 символа — латинские буквы, цифры, точка, дефис, подчёркивание');
  return login;
}
function validatePassword(s){
  if(typeof s!=='string'||s.length<10||s.length>128)
    throw ERROR('Пароль должен содержать от 10 до 128 символов');
  return s;
}
const userShape=r=>({
  id:r.id,username:r.login,name:r.login,
  favorites:Array.isArray(r.favorites)?r.favorites:[],
  cart:Array.isArray(r.cart)?r.cart:[],
  createdAt:r.created_at,cloud:true
});
function key(req,purpose){
  const ip=String(req.get('x-forwarded-for')||req.ip||'').split(',')[0].trim().slice(0,128);
  return crypto.createHmac('sha256',sessionSecret()).update(purpose+'|'+ip).digest('hex');
}
async function limit(p,id){
  const r=await p.query('SELECT locked_until FROM customer_auth_attempts WHERE id=$1',[id]);
  if(r.rows[0]?.locked_until && new Date(r.rows[0].locked_until)>new Date())
    throw ERROR('Слишком много попыток входа. Повторите через 15 минут.',429);
}
async function failed(p,id){
  await p.query(
    "INSERT INTO customer_auth_attempts(id,failures,locked_until,updated_at) VALUES($1,1,NULL,now()) "+
    "ON CONFLICT(id) DO UPDATE SET failures=CASE WHEN customer_auth_attempts.updated_at<now()-interval '15 minutes' THEN 1 ELSE customer_auth_attempts.failures+1 END,"+
    "locked_until=CASE WHEN customer_auth_attempts.updated_at>=now()-interval '15 minutes' AND customer_auth_attempts.failures>=4 THEN now()+interval '15 minutes' ELSE NULL END, updated_at=now()",
    [id]);
}
async function succeeded(p,id){await p.query('DELETE FROM customer_auth_attempts WHERE id=$1',[id]);}
function validFavorites(data){
  if(!Array.isArray(data)||data.length>1000||
    data.some(i=>typeof i!=='number'||!Number.isSafeInteger(i)||i<=0))
    throw ERROR('Некорректный список избранного');
  return [...new Set(data)];
}
function validCart(data){
  if(!Array.isArray(data)||data.length>150)throw ERROR('Некорректная корзина');
  const m=new Map();
  for(const item of data){
    if(!item||typeof item!=='object'||
       !Number.isSafeInteger(item.id)||item.id<=0||
       !Number.isSafeInteger(item.quantity)||item.quantity<=0||item.quantity>100)
      throw ERROR('Некорректное количество товара');
    m.set(item.id,Math.max(m.get(item.id)||0,item.quantity));
  }
  return [...m].map(([id,quantity])=>({id,quantity}));
}
const dummyHash='$2a$12$C6UzMDM.H6dfI/f/IKcEeOBY59CtNn./Iqdh7DP0oO1R3fjqZk7SC';
function register(app){
  app.use('/api/cloud-auth',(req,res,next)=>{
    if(!open())return res.status(503).json({error:'Серверная регистрация покупателей ещё не подключена'});
    ready().then(()=>next()).catch(e=>res.status(503).json({error:'Российская база покупателей недоступна'}));
  });
  app.post('/api/cloud-auth/register',wrap(async(req,res)=>{
    const p=getPool(),login=validateLogin(req.body?.username),pwd=validatePassword(req.body?.password);
    if(req.body?.consent!==true)throw ERROR('Нужно согласие на обработку данных аккаунта');
    if(req.body?.passwordRepeat!==pwd)throw ERROR('Пароли не совпадают');
    const ipKey=key(req,'register');
    await limit(p,ipKey);
    const hash=await bcrypt.hash(pwd,12);
    let user;
    try{
      const r=await p.query(
        'INSERT INTO customer_profiles(login,password_hash) VALUES($1,$2) RETURNING id,login,favorites,cart,created_at',
        [login,hash]);
      user=r.rows[0];
    }catch(e){
      if(e.code==='23505'){await failed(p,ipKey);throw ERROR('Этот логин уже занят',409);}
      throw e;
    }
    await succeeded(p,ipKey);
    issue(res,user.id);
    res.status(201).json({user:userShape(user)});
  }));
  app.post('/api/cloud-auth/login',wrap(async(req,res)=>{
    const p=getPool(),login=validateLogin(req.body?.username),
      pwd=String(req.body?.password||'');
    const lockKey=key(req,'login:'+login);
    await limit(p,lockKey);
    const r=await p.query(
      'SELECT id,login,password_hash,favorites,cart,created_at FROM customer_profiles WHERE login=$1',
      [login]);
    const user=r.rows[0];
    const matches=await bcrypt.compare(pwd,user?.password_hash||dummyHash);
    if(!user||!matches){
      await failed(p,lockKey);
      throw ERROR('Неверный логин или пароль',401);
    }
    await succeeded(p,lockKey);
    issue(res,user.id);
    res.json({user:userShape(user)});
  }));
  app.post('/api/cloud-auth/logout',(req,res)=>{clear(res);res.json({ok:true});});
  app.get('/api/cloud-auth/me',requireUser,wrap(async(req,res)=>{
    const r=await getPool().query(
      'SELECT id,login,favorites,cart,created_at FROM customer_profiles WHERE id=$1',
      [req.cloudUserId]);
    if(!r.rows[0])throw ERROR('Пользователь не найден',401);
    res.set('Cache-Control','no-store');
    res.json(userShape(r.rows[0]));
  }));
  app.put('/api/cloud-auth/favorites',requireUser,wrap(async(req,res)=>{
    const favorites=validFavorites(req.body?.favorites);
    const r=await getPool().query(
      'UPDATE customer_profiles SET favorites=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING id',
      [req.cloudUserId,JSON.stringify(favorites)]);
    if(!r.rowCount)throw ERROR('Профиль не найден',401);
    res.json({favorites});
  }));
  app.put('/api/cloud-auth/cart',requireUser,wrap(async(req,res)=>{
    const cart=validCart(req.body?.cart);
    const r=await getPool().query(
      'UPDATE customer_profiles SET cart=$2::jsonb,updated_at=now() WHERE id=$1 RETURNING id',
      [req.cloudUserId,JSON.stringify(cart)]);
    if(!r.rowCount)throw ERROR('Профиль не найден',401);
    res.json({cart});
  }));
}
module.exports={register,open,ready,validCart,validFavorites};
