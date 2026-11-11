/* Local, per-device shopper profiles.
 * No name, identifier or password is sent to the server. This is NOT a
 * cross-device/customer-service account and does not authenticate API calls.
 * Upgrade to backend identities only after legally compliant buyer-data
 * storage is configured.
 */
(function(){
  'use strict';
  const ACCOUNTS='mtr_local_accounts_v1';
  const ACTIVE='mtr_local_active_v1';
  const ITERATIONS=310000;
  const encoder=new TextEncoder();

  function readAccounts(){
    try {
      const val=JSON.parse(localStorage.getItem(ACCOUNTS)||'{}');
      return val&&typeof val==='object'&&!Array.isArray(val)?val:{};
    }catch{return {};}
  }
  function normalize(login){return String(login||'').trim().toLowerCase();}
  function display(record){
    return record?{id:record.id,username:record.username,name:record.name||record.username,local:true}:null;
  }
  function bytesToHex(bytes){
    return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  }
  function hexToBytes(hex){
    if(typeof hex!=='string'||hex.length%2)throw Error('Неверные данные профиля');
    const bytes=new Uint8Array(hex.length/2);
    for(let i=0;i<bytes.length;i++){
      const part=hex.slice(i*2,i*2+2);
      if(!/^[a-f0-9]{2}$/i.test(part))throw Error('Неверные данные профиля');
      bytes[i]=parseInt(part,16);
    }
    return bytes;
  }
  function randomHex(n){
    if(!crypto?.getRandomValues)throw Error('Ваш браузер не поддерживает безопасную регистрацию');
    return bytesToHex(crypto.getRandomValues(new Uint8Array(n)));
  }
  async function hashPassword(password,salt){
    if(!crypto?.subtle)throw Error('Для регистрации откройте сайт по HTTPS в современном браузере');
    const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:hexToBytes(salt),iterations:ITERATIONS,hash:'SHA-256'},material,256);
    return bytesToHex(new Uint8Array(bits));
  }
  function sameHash(a,b){
    if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
    let mismatch=0;
    for(let i=0;i<a.length;i++)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);
    return mismatch===0;
  }
  function validLogin(login){
    return /^[a-zа-яё0-9_.-]{3,32}$/i.test(login);
  }
  function current(){
    const active=sessionStorage.getItem(ACTIVE);
    if(!active)return null;
    const accounts=readAccounts();
    const record=Object.values(accounts).find(a=>a&&a.id===active);
    if(!record){sessionStorage.removeItem(ACTIVE);return null;}
    return display(record);
  }
  function keys(user){
    if(!user?.id||!/^[a-f0-9]{32}$/.test(user.id))throw Error('Неизвестный локальный профиль');
    return {cart:'mtr_local_cart_'+user.id,favorites:'mtr_local_fav_'+user.id};
  }
  function activate(record){
    sessionStorage.setItem(ACTIVE,record.id);
    return display(record);
  }
  async function register({username,password,passwordRepeat,name}){
    const login=normalize(username);
    if(!validLogin(login))throw Error('Логин: 3–32 символа, буквы, цифры, точка, дефис или подчёркивание');
    if(typeof password!=='string'||password.length<10||password.length>128)
      throw Error('Пароль должен содержать от 10 до 128 символов');
    if(password!==passwordRepeat)throw Error('Пароли не совпадают');
    const displayName=String(name||login).trim();
    if(displayName.length<2||displayName.length>48)
      throw Error('Имя должно содержать от 2 до 48 символов');
    if(Object.prototype.hasOwnProperty.call(readAccounts(),login))
      throw Error('Такой логин уже есть на этом устройстве');
    const salt=randomHex(16);
    const derived=await hashPassword(password,salt);
    // Repeat this check after PBKDF2, which may run concurrently with login.
    const accounts=readAccounts();
    if(Object.prototype.hasOwnProperty.call(accounts,login))
      throw Error('Такой логин уже есть на этом устройстве');
    const record={id:randomHex(16),username:login,name:displayName,salt,hash:derived,createdAt:new Date().toISOString()};
    try {
      accounts[login]=record;
      localStorage.setItem(ACCOUNTS,JSON.stringify(accounts));
    } catch {throw Error('Не удалось сохранить профиль. Проверьте настройки браузера');}
    return activate(record);
  }
  async function login({username,password}){
    const loginName=normalize(username);
    const record=readAccounts()[loginName];
    // Do not send credentials to the API. Invalid input gets the same message.
    if(!record||typeof record.salt!=='string'||typeof record.hash!=='string')
      throw Error('Неверный логин или пароль на этом устройстве');
    const hash=await hashPassword(String(password||''),record.salt);
    if(!sameHash(hash,record.hash))
      throw Error('Неверный логин или пароль на этом устройстве');
    return activate(record);
  }
  function logout(){sessionStorage.removeItem(ACTIVE);}
  window.LocalAccounts={register,login,logout,current,keys};
})();