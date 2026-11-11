'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'..','public','js','local-account.js'),'utf8');
function storage(){
  const records=new Map();
  return {
    getItem:key=>records.has(key)?records.get(key):null,
    setItem:(key,val)=>records.set(key,String(val)),
    removeItem:key=>records.delete(key),
    clear:()=>records.clear(),
    key:i=>Array.from(records.keys())[i]||null,
    get length(){return records.size}
  };
}
function setup(existingLocal,existingSession){
  const localStorage=existingLocal||storage(),sessionStorage=existingSession||storage();
  const window={};
  vm.runInNewContext(source,{window,localStorage,sessionStorage,crypto:webcrypto,TextEncoder,Uint8Array,Date,Error});
  return {accounts:window.LocalAccounts,localStorage,sessionStorage};
}
test('register signs in locally and saves only a salted password hash',async()=>{
  const {accounts,localStorage}=setup();
  const user=await accounts.register({name:'Покупатель',username:'fabricfriend',password:'uncommon-local-password!23',passwordRepeat:'uncommon-local-password!23'});
  assert.equal(user.name,'Покупатель');
  assert.equal(accounts.current().username,'fabricfriend');
  const raw=localStorage.getItem('mtr_local_accounts_v1');
  assert.ok(raw);
  assert.equal(raw.includes('uncommon-local-password!23'),false,'plaintext password must not be stored');
  const parsed=JSON.parse(raw).fabricfriend;
  assert.match(parsed.hash,/^[a-f0-9]{64}$/);
  assert.match(parsed.salt,/^[a-f0-9]{32}$/);
  assert.notEqual(parsed.hash,parsed.salt);
});
test('login validates the password and rejects duplicate usernames',async()=>{
  const {accounts}=setup();
  await accounts.register({name:'Швея',username:'Craft_User',password:'strong-password-1',passwordRepeat:'strong-password-1'});
  await assert.rejects(()=>accounts.register({name:'Швея',username:'craft_user',password:'strong-password-2',passwordRepeat:'strong-password-2'}),/уже есть/);
  accounts.logout();
  await assert.rejects(()=>accounts.login({username:'craft_user',password:'incorrect'}),/Неверный логин/);
  assert.equal(accounts.current(),null);
  const user=await accounts.login({username:'CRAFT_USER',password:'strong-password-1'});
  assert.equal(user.username,'craft_user');
});
test('profiles survive reload; sessions end on logout; separate users have separate storage keys',async()=>{
  const env=setup();
  const first=await env.accounts.register({name:'Первый',username:'userone',password:'passphrase-one-2026',passwordRepeat:'passphrase-one-2026'});
  const firstKeys=env.accounts.keys(first);
  env.localStorage.setItem(firstKeys.favorites,'[1,2]');
  const afterReload=setup(env.localStorage,env.sessionStorage);
  assert.equal(afterReload.accounts.current().id,first.id);
  afterReload.accounts.logout();
  assert.equal(afterReload.accounts.current(),null);
  const second=await afterReload.accounts.register({name:'Второй',username:'usertwo',password:'passphrase-two-2026',passwordRepeat:'passphrase-two-2026'});
  assert.notEqual(afterReload.accounts.keys(second).favorites,firstKeys.favorites);
  assert.equal(afterReload.localStorage.getItem(firstKeys.favorites),'[1,2]');
});
test('rejects short passwords and malformed usernames',async()=>{
  const {accounts}=setup();
  await assert.rejects(()=>accounts.register({username:'ab',name:'X',password:'valid-password',passwordRepeat:'valid-password'}),/Логин/);
  await assert.rejects(()=>accounts.register({username:'validlogin',name:'Person',password:'short',passwordRepeat:'short'}),/Пароль/);
});