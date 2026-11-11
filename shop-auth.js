'use strict';
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const crypto=require('crypto');
const {pool}=require('./shop-db');
const ADMIN_COOKIE='mtr_v2_admin';
const USER_COOKIE='mtr_v2_session';
const error=(message,status=400)=>Object.assign(new Error(message),{statusCode:status});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const digits=s=>String(s||'').replace(/\D/g,'');
const normPhone=s=>{const p=digits(s);if(p.length<10||p.length>15)throw error('Неверный номер телефона');return p;};
function secret(){const s=process.env.JWT_SECRET||'';if(s.length<32)throw error('Не настроен секрет авторизации',503);return s;}
function cookieValue(req,name){
  const part=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  if(!part)return null;
  try{return decodeURIComponent(part.slice(name.length+1));}catch{return null;}
}
function setCookie(res,name,value,age){
  res.cookie(name,value,{httpOnly:true,secure:process.env.NODE_ENV==='production'||!!process.env.VERCEL,
    sameSite:'lax',path:'/',maxAge:age});
}
function clearCookie(res,name){res.clearCookie(name,{httpOnly:true,secure:process.env.NODE_ENV==='production'||!!process.env.VERCEL,sameSite:'lax',path:'/'});}
function issueUser(res,user){
  setCookie(res,USER_COOKIE,jwt.sign({id:Number(user.id),kind:'user'},secret(),{expiresIn:'14d'}),14*86400*1000);
}
function adminSessionSecret(){
  // Changing ADMIN_PASSWORD revokes all previously issued administrator cookies.
  return crypto.createHmac('sha256',secret())
    .update('matreshka-v2-admin:'+String(process.env.ADMIN_PASSWORD||''))
    .digest('hex');
}
function issueAdmin(res){
  setCookie(res,ADMIN_COOKIE,jwt.sign({kind:'admin'},adminSessionSecret(),{expiresIn:'2h'}),2*3600*1000);
}
function decodeUser(req){
  let cookie=cookieValue(req,USER_COOKIE);
  if(!cookie) return null;
  try{const d=jwt.verify(cookie,secret());return d.kind==='user'?Number(d.id):null;}catch{return null;}
}
function decodeAdmin(req){
  let cookie=cookieValue(req,ADMIN_COOKIE);
  if(!cookie)return false;
  try {return jwt.verify(cookie,adminSessionSecret()).kind==='admin';} catch {return false;}
}
function userAuth(req,res,next){
  const id=decodeUser(req);
  if(!id)return res.status(401).json({error:'Войдите в личный кабинет'});
  req.userId=id;next();
}
function adminAuth(req,res,next){
  if(!decodeAdmin(req))return res.status(401).json({error:'Требуется вход администратора'});
  next();
}
const userShape=x=>({id:Number(x.id),name:x.name,phone:x.phone,addresses:x.addresses||[],favorites:x.favorites||[],createdAt:x.created_at});
function safeText(x,max=120){return String(x||'').trim().slice(0,max);}
function clientId(req,kind){
  const ip=String(req.headers['x-forwarded-for']||req.ip||'').split(',')[0].trim().slice(0,120);
  return crypto.createHash('sha256').update(kind+':'+ip+':'+secret()).digest('hex');
}
async function checkRate(id){
  const r=await pool.query('SELECT failed_count,locked_until FROM shop_auth_attempts WHERE id=$1',[id]);
  if(r.rows[0]?.locked_until && new Date(r.rows[0].locked_until)>new Date())
    throw error('Слишком много попыток. Повторите позже.',429);
}
async function failed(id){
  await pool.query("INSERT INTO shop_auth_attempts (id,failed_count,locked_until,updated_at) VALUES ($1,1,NULL,now()) ON CONFLICT(id) DO UPDATE SET failed_count=CASE WHEN shop_auth_attempts.updated_at<now()-interval '15 minutes' THEN 1 ELSE shop_auth_attempts.failed_count+1 END,locked_until=CASE WHEN shop_auth_attempts.failed_count>=4 AND shop_auth_attempts.updated_at>=now()-interval '15 minutes' THEN now()+interval '15 minutes' ELSE NULL END,updated_at=now()",[id]);
}
async function succeeded(id){await pool.query('DELETE FROM shop_auth_attempts WHERE id=$1',[id]);}

/**
 * Admin attempts are keyed by the requester's IP (hashed with the server secret).
 * PostgreSQL advisory transaction locks serialize concurrent attempts across instances.
 * Three incorrect attempts trigger 1, 3, 9, 27... minute bans.
 * A successful login resets the sequence. Attempts while locked do not count.
 * Duration is capped at 30 days to avoid permanent lockouts or timestamp overflow.
 */
const ADMIN_MAX_LOCK_MINUTES=43200;
function adminLockMinutes(level){
  return Math.min(ADMIN_MAX_LOCK_MINUTES,Math.pow(3,Math.max(0,level-1)));
}
async function recordAdminAttempt(id,correct){
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(20261111,hashtext($1))',[id]);
    const result=await client.query(
      'SELECT failed_count,lock_level,locked_until FROM shop_admin_attempts WHERE id=$1 FOR UPDATE',[id]);
    const previous=result.rows[0];
    const now=Date.now();
    if(previous?.locked_until){
      const left=Math.ceil((new Date(previous.locked_until).getTime()-now)/1000);
      if(left>0){
        await client.query('COMMIT');
        return {locked:true,retryAfterSeconds:left,lockLevel:previous.lock_level};
      }
    }
    if(correct){
      await client.query('DELETE FROM shop_admin_attempts WHERE id=$1',[id]);
      await client.query('COMMIT');
      return {ok:true};
    }
    let errors=(previous?.failed_count||0)+1,level=previous?.lock_level||0;
    let retryAfterSeconds=0;
    let until=null;
    if(errors>=3){
      errors=0;
      level+=1;
      const duration=adminLockMinutes(level);
      until=new Date(now+duration*60*1000);
      retryAfterSeconds=duration*60;
    }
    await client.query(
      'INSERT INTO shop_admin_attempts (id,failed_count,lock_level,locked_until,updated_at) '+
      'VALUES ($1,$2,$3,$4,now()) ON CONFLICT(id) DO UPDATE '+
      'SET failed_count=EXCLUDED.failed_count,lock_level=EXCLUDED.lock_level,'+
      'locked_until=EXCLUDED.locked_until,updated_at=now()',
      [id,errors,level,until]);
    await client.query('COMMIT');
    return retryAfterSeconds?{locked:true,retryAfterSeconds,lockLevel:level}:{locked:false,attemptsLeft:3-errors};
  }catch(e){
    try{await client.query('ROLLBACK');}catch{}
    throw e;
  }finally{client.release();}
}
function replyLocked(res,result){
  const seconds=Math.max(1,Math.ceil(result.retryAfterSeconds));
  res.setHeader('Retry-After',String(seconds));
  const display=seconds<3600?Math.ceil(seconds/60)+' мин.':Math.ceil(seconds/3600)+' ч.';
  return res.status(429).json({
    error:'Админ-панель временно заблокирована. Повторите попытку через '+display,
    retryAfterSeconds:seconds,
    lockLevel:result.lockLevel
  });
}

function register(app){
  app.post('/api/auth/register',wrap(async(req,res)=>{
    const b=req.body||{},name=safeText(b.name),phone=normPhone(b.phone),pwd=String(b.password||'');
    if(name.length<2||pwd.length<10||pwd.length>128||pwd!==b.passwordRepeat||b.consent!==true)
      throw error('Нужно указать имя, согласие и совпадающие пароли длиной от 10 символов');
    const id=clientId(req,'register');await checkRate(id);
    const hash=await bcrypt.hash(pwd,12);
    let u;
    try{
      u=(await pool.query('INSERT INTO shop_users(name,phone,password_hash) VALUES($1,$2,$3) RETURNING id,name,phone,addresses,favorites,created_at',[name,phone,hash])).rows[0];
    }catch(e){if(e.code==='23505')throw error('Этот телефон уже зарегистрирован',409);throw e;}
    await succeeded(id);issueUser(res,u);res.status(201).json({user:userShape(u)});
  }));
  app.post('/api/auth/login',wrap(async(req,res)=>{
    const phone=normPhone(req.body?.phone),pwd=String(req.body?.password||'');
    const key=clientId(req,'login:'+phone);
    await checkRate(key);
    const u=(await pool.query('SELECT * FROM shop_users WHERE phone=$1',[phone])).rows[0];
    const valid=u&&await bcrypt.compare(pwd,u.password_hash);
    if(!valid){await failed(key);throw error('Неверный телефон или пароль',401);}
    await succeeded(key);issueUser(res,u);res.json({user:userShape(u)});
  }));
  app.post('/api/auth/logout',(req,res)=>{clearCookie(res,USER_COOKIE);res.json({ok:true});});
  app.get('/api/auth/me',userAuth,wrap(async(req,res)=>{
    const u=(await pool.query('SELECT id,name,phone,addresses,favorites,created_at FROM shop_users WHERE id=$1',[req.userId])).rows[0];
    if(!u)throw error('Пользователь не найден',401);
    res.json(userShape(u));
  }));
  app.put('/api/auth/favorites',userAuth,wrap(async(req,res)=>{
    const arr=req.body?.favorites;
    if(!Array.isArray(arr)||arr.length>1000||arr.some(x=>!Number.isSafeInteger(Number(x))))throw error('Некорректное избранное');
    const favorites=[...new Set(arr.map(Number))];
    await pool.query('UPDATE shop_users SET favorites=$1::jsonb WHERE id=$2',[JSON.stringify(favorites),req.userId]);
    res.json({favorites});
  }));
  app.put('/api/auth/addresses',userAuth,wrap(async(req,res)=>{
    const a=req.body?.addresses;
    if(!Array.isArray(a)||a.length>15||a.some(x=>typeof x!=='string'||x.length>300))throw error('Некорректные адреса');
    await pool.query('UPDATE shop_users SET addresses=$1::jsonb WHERE id=$2',[JSON.stringify(a),req.userId]);
    res.json({addresses:a});
  }));
  app.post('/api/admin/login',wrap(async(req,res)=>{
    const expected=String(process.env.ADMIN_PASSWORD||'');
    if(expected.length<12)throw error('Пароль администратора должен содержать минимум 12 символов. Обновите ADMIN_PASSWORD в Vercel.',503);
    const key=clientId(req,'admin');
    const actual=String(req.body?.password||'');
    const a=Buffer.from(expected),b=Buffer.from(actual);
    const matches=a.length===b.length&&crypto.timingSafeEqual(a,b);
    const result=await recordAdminAttempt(key,matches);
    if(result.locked)return replyLocked(res,result);
    if(!matches)return res.status(401).json({
      error:'Неверный пароль. Осталось попыток: '+result.attemptsLeft,
      attemptsLeft:result.attemptsLeft
    });
    issueAdmin(res);res.json({ok:true});
  }));
  app.post('/api/admin/verify',adminAuth,(req,res)=>res.json({ok:true}));
  app.post('/api/admin/logout',adminAuth,(req,res)=>{clearCookie(res,ADMIN_COOKIE);res.json({ok:true});});
}
module.exports={register,userAuth,adminAuth,decodeUser,decodeAdmin,normPhone,safeText,wrap,error,userShape};
