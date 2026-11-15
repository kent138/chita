'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','shop-api.js'),'utf8');
const start=source.indexOf('function sellerReady(){');
const end=source.indexOf('function register(app){',start);
if(start<0||end<start)throw Error('Cannot locate buyer-data readiness guards');
const readiness=source.slice(start,end);
function check(config){
  const env={
    SELLER_LEGAL_NAME:'ООО Матрёшка Тест',
    SELLER_OGRN:'1234567890123',
    SELLER_LEGAL_ADDRESS:'Россия, тестовый адрес магазина, дом 44',
    SELLER_CONTACT:'+70000000000',
    JWT_SECRET:'x'.repeat(40),
    ADMIN_PASSWORD:'a'.repeat(16),
    DATA_LOCALIZATION_REVIEWED:'1',
    SHOP_OPEN:'1',
    ...config
  };
  const ctx={process:{env},URL};
  vm.runInNewContext(readiness+';this.result={customer:personalDataEnabled(),orders:ordersEnabled(),external:externalAccountsUrl()};',ctx);
  return ctx.result;
}
test('managed foreign Supabase remains blocked even with launch flags forced on',()=>{
  const result=check({DB_SCHEMA_MANAGED:'1',POSTGRES_URL:'postgresql://ignored@aws-0-eu-north-1.pooler.supabase.com:6543/postgres'});
  assert.equal(result.customer,false);
  assert.equal(result.orders,false);
});
test('Supabase host remains blocked when DB_SCHEMA_MANAGED is accidentally omitted',()=>{
  const result=check({DB_SCHEMA_MANAGED:'0',POSTGRES_URL:'postgresql://ignored@db.odaitemhtecieklsbnpd.supabase.co:5432/postgres'});
  assert.equal(result.customer,false);
  assert.equal(result.orders,false);
});
test('approved, isolated Russian PostgreSQL can be eligible for buyers and orders',()=>{
  const result=check({DB_SCHEMA_MANAGED:'0',DATABASE_URL:'postgresql://ignored@db.in-russia.invalid:5432/accounts'});
  assert.equal(result.customer,true);
  assert.equal(result.orders,true);
});
test('seller and localization gates are still required on any domestic DB',()=>{
  const result=check({DB_SCHEMA_MANAGED:'0',DATABASE_URL:'postgresql://ignored@db.in-russia.invalid:5432/accounts',DATA_LOCALIZATION_REVIEWED:'0'});
  assert.equal(result.customer,false);
  assert.equal(result.orders,false);
});
test('Russian account service is independent of catalogue buyer-data gate',()=>{
  const result=check({DB_SCHEMA_MANAGED:'1',ACCOUNT_REGISTRATION_ENABLED:'1',ACCOUNT_DATA_LOCATION_CONFIRMED:'RU',ACCOUNT_PRIVACY_POLICY_APPROVED:'1',RU_ACCOUNT_API_URL:'https://customer.example.ru/api.php'});
  assert.equal(result.customer,false);
  assert.equal(result.orders,false);
  assert.equal(result.external,'https://customer.example.ru/api.php');
});
