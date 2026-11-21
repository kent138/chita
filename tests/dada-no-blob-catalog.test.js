'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

test('DADA without database/blob token serves storefront and 43 public products',async t=>{
  const keys=['DATABASE_URL','POSTGRES_URL','BLOB_READ_WRITE_TOKEN','VERCEL_OIDC_TOKEN'];
  const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  for(const k of keys)delete process.env[k];
  let server;
  t.after(async()=>{
    if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    for(const k of keys){
      if(original[k]===undefined)delete process.env[k];
      else process.env[k]=original[k];
    }
  });

  const app=require('../server-v2');
  server=http.createServer(app).listen(0,'127.0.0.1');
  await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;

  const home=await fetch(base+'/');
  assert.equal(home.status,200);
  assert.match(await home.text(),/Матрёшка/);

  const config=await fetch(base+'/api/config');
  assert.equal(config.status,200);
  const state=await config.json();
  assert.equal(state.databaseReady,false);
  assert.equal(state.acceptingOrders,false);

  const products=await fetch(base+'/api/products?limit=48&page=1');
  assert.equal(products.status,200);
  const catalog=await products.json();
  assert.equal(catalog.total,43);
  assert.equal(catalog.items.length,43);
  assert.equal(catalog.items.reduce((n,p)=>n+p.images.length,0),43);

  const facets=await fetch(base+'/api/products/facets');
  assert.equal(facets.status,200);
  assert.ok((await facets.json()).categories.length>0);

  const auth=await fetch(base+'/api/auth/me');
  assert.equal(auth.status,503);
});
