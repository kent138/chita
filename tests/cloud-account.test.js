'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const {Pool}=require('pg');
const cloud=require('../shop-cloud-accounts');

test('cloud accounts are disabled until a Russian account database and approvals are configured',()=>{
  if(process.env.TEST_ACCOUNT_DATABASE_URL)return;
  assert.equal(cloud.open(),false);
});
test('cross-device registration, login, logout, favorites and basket in isolated test PostgreSQL',async t=>{
  const url=process.env.TEST_ACCOUNT_DATABASE_URL;
  if(!url){t.skip('Requires a separate disposable local TEST_ACCOUNT_DATABASE_URL');return;}
  process.env.ACCOUNT_DATABASE_URL=url;
  process.env.ACCOUNT_REGISTRATION_ENABLED='1';
  process.env.ACCOUNT_DATA_LOCATION_CONFIRMED='RU';
  process.env.ACCOUNT_PRIVACY_POLICY_APPROVED='1';
  process.env.JWT_SECRET='test-only-secret-for-account-tests-2026-long';
  const p=new Pool({connectionString:url});
  await p.query(fs.readFileSync(path.join(__dirname,'..','sql','russian-customer-accounts.sql'),'utf8'));
  const app=express();
  app.use(express.json());
  cloud.register(app);
  app.use((err,req,res,next)=>res.status(err.statusCode||500).json({error:err.message}));
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  const root='http://127.0.0.1:'+server.address().port+'/api/cloud-auth';
  let cookie='';
  const login='mtr'+crypto.randomBytes(7).toString('hex');
  const payload={username:login,password:'superlong-test-passphrase-2026',passwordRepeat:'superlong-test-passphrase-2026',consent:true};
  async function call(route,method='GET',body,session){
    const res=await fetch(root+route,{method,headers:{'Content-Type':'application/json',...(session?{'Cookie':session}:{})},
      body:body?JSON.stringify(body):undefined});
    return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')};
  }
  try{
    const reg=await call('/register','POST',payload);
    assert.equal(reg.status,201,JSON.stringify(reg.body));
    assert.equal(reg.body.user.username,login);
    assert(!reg.body.user.password_hash);
    assert.match(reg.cookie,/HttpOnly/);
    cookie=reg.cookie.split(';')[0];

    const unauthed=await call('/me');
    assert.equal(unauthed.status,401);
    const fav=await call('/favorites','PUT',{favorites:[2,5,2]},cookie);
    assert.equal(fav.status,200);
    assert.deepEqual(fav.body.favorites,[2,5]);
    const cart=await call('/cart','PUT',{cart:[{id:2,quantity:3},{id:5,quantity:2}]},cookie);
    assert.equal(cart.status,200);
    assert.equal(cart.body.cart.length,2);
    const logout=await call('/logout','POST',undefined,cookie);
    assert.equal(logout.status,200);

    // Simulate a new device: no cookies, log in with username/password.
    const wrong=await call('/login','POST',{username:login,password:'incorrect'});
    assert.equal(wrong.status,401);
    const second=await call('/login','POST',{username:login,password:payload.password});
    assert.equal(second.status,200,JSON.stringify(second.body));
    const secondCookie=second.cookie.split(';')[0];
    assert.notEqual(secondCookie,'');
    const account=await call('/me','GET',undefined,secondCookie);
    assert.equal(account.status,200);
    assert.deepEqual(account.body.favorites,[2,5]);
    assert.deepEqual(account.body.cart,[{id:2,quantity:3},{id:5,quantity:2}]);
    const malformed=await call('/cart','PUT',{cart:[{id:5,quantity:-100}]},secondCookie);
    assert.equal(malformed.status,400);
    const found=await p.query('SELECT password_hash FROM customer_profiles WHERE login=$1',[login]);
    assert(!found.rows[0].password_hash.includes(payload.password));
  }finally{
    await p.query('DELETE FROM customer_profiles WHERE login=$1',[login]);
    await new Promise(resolve=>server.close(resolve));
    await p.end();
  }
});
