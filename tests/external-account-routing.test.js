'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'..','public','js','app.js'),'utf8');
const start=app.indexOf('async function api(');
const end=app.indexOf('// -------------------- Утилиты',start);
assert(start>=0&&end>start,'API wrapper section must exist');
const apiCode=app.slice(start,end);
function mock(cloudAccountApiBase){
  const sent=[];
  const context={
    State:{cloudSession:null},Shop:{cloudAccountApiBase},
    fetch:async(url,options)=>{
      sent.push({url,options});
      return {ok:true,status:200,json:async()=>({ok:true})};
    },
    console,Error,JSON,URL,encodeURIComponent
  };
  vm.runInNewContext(apiCode+';this.testApi=api;',context);
  return {sent,context,api:context.testApi};
}
test('registration and password go directly to the Russian HTTPS host, not via Vercel',async()=>{
  const {sent,api}=mock('https://shopuser.temp.swtest.ru/api.php');
  await api('/cloud-auth/register',{
    method:'POST',body:{username:'buyer123',password:'example-test-pass',consent:true}
  });
  assert.equal(sent.length,1);
  assert.equal(sent[0].url,'https://shopuser.temp.swtest.ru/api.php?action=register');
  assert.equal(sent[0].options.credentials,'omit');
  assert.equal(sent[0].options.method,'POST');
  assert.equal(JSON.parse(sent[0].options.body).username,'buyer123');
  assert(!('Authorization' in sent[0].options.headers));
});
test('favorites, cart and /me request use only the bearer session when available',async()=>{
  const {sent,api,context}=mock('https://shopuser.temp.swtest.ru/api.php');
  context.State.cloudSession='e'.repeat(64);
  await api('/cloud-auth/favorites',{method:'PUT',body:{favorites:[4]}});
  await api('/cloud-auth/cart',{method:'PUT',body:{cart:[{id:4,quantity:2}]}});
  await api('/cloud-auth/me');
  assert.equal(sent.length,3);
  assert.deepEqual(sent.map(x=>x.url.split('action=')[1]),['favorites','cart','me']);
  assert(sent.every(x=>x.options.credentials==='omit'));
  assert(sent.every(x=>x.options.headers.Authorization==='Bearer '+'e'.repeat(64)));
});
test('merchandise requests still use the existing same-origin API',async()=>{
  const {sent,api}=mock('https://shopuser.temp.swtest.ru/api.php');
  await api('/products?limit=24');
  assert.equal(sent[0].url,'/api/products?limit=24');
  assert.equal(sent[0].options.credentials,'same-origin');
});
test('unknown account actions never reach the external host',async()=>{
  const {sent,api}=mock('https://shopuser.temp.swtest.ru/api.php');
  await assert.rejects(api('/cloud-auth/delete-database'),/Неверный запрос аккаунта/);
  assert.equal(sent.length,0);
});
