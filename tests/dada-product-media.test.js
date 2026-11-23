'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {pool}=require('../shop-db');
const catalog=require('../shop-catalog');

test('DADA can persist an uploaded public product photo and reuse its URL',async t=>{
 const originalQuery=pool.query;
 const oldBlob=process.env.BLOB_READ_WRITE_TOKEN;
 const oldManaged=process.env.DB_SCHEMA_MANAGED;
 t.after(()=>{
   pool.query=originalQuery;
   if(oldBlob===undefined)delete process.env.BLOB_READ_WRITE_TOKEN;
   else process.env.BLOB_READ_WRITE_TOKEN=oldBlob;
   if(oldManaged===undefined)delete process.env.DB_SCHEMA_MANAGED;
   else process.env.DB_SCHEMA_MANAGED=oldManaged;
 });
 delete process.env.BLOB_READ_WRITE_TOKEN;
 process.env.DB_SCHEMA_MANAGED='0';
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
 const writes=[];
 pool.query=async(sql,values)=>{
   writes.push({sql,values});
   return {rowCount:1,rows:[]};
 };
 const urls=await catalog.normalizeImages(['data:image/png;base64,'+png.toString('base64')],100015);
 assert.equal(urls.length,1);
 assert.match(urls[0],/^\/api\/media\/[0-9a-f-]{36}$/);
 assert.equal(writes.length,1);
 assert.match(writes[0].sql,/INSERT INTO shop_media/);
 assert.equal(writes[0].values[1],'image/png');
 assert.deepEqual(writes[0].values[2],png);
 const reused=await catalog.normalizeImages(urls,100015);
 assert.deepEqual(reused,urls);
 assert.equal(writes.length,1,'reuse should not duplicate database media');
 const legacy=await catalog.normalizeImages(
   ['https://images.public.blob.vercel-storage.com/v2/media/old.webp'],100015);
 assert.equal(legacy.length,1);
 assert.equal(writes.length,1,'legacy product photos remain untouched');
});

test('oversized images are rejected before database write on DADA',async t=>{
 const oldBlob=process.env.BLOB_READ_WRITE_TOKEN;
 const oldManaged=process.env.DB_SCHEMA_MANAGED;
 t.after(()=>{
   if(oldBlob===undefined)delete process.env.BLOB_READ_WRITE_TOKEN;
   else process.env.BLOB_READ_WRITE_TOKEN=oldBlob;
   if(oldManaged===undefined)delete process.env.DB_SCHEMA_MANAGED;
   else process.env.DB_SCHEMA_MANAGED=oldManaged;
 });
 delete process.env.BLOB_READ_WRITE_TOKEN;
 process.env.DB_SCHEMA_MANAGED='0';
 const large=Buffer.alloc(3*1024*1024+1,0);
 large[0]=0xff; large[1]=0xd8;
 await assert.rejects(
   catalog.normalizeImages(['data:image/jpeg;base64,'+large.toString('base64')],100015),
   /Фото слишком большое/
 );
});
