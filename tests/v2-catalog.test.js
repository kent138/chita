'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const items = Array.from({length:500},(_,i)=>({
  id:i+1,
  slug:'tkan-'+(i+1),
  name:'Ткань '+(i+1),
  description:'Ткань для шитья '+(i+1),
  category:'Ткани',
  material:i%2 ? 'Лён':'Хлопок',
  width:'150 см',
  price:100+(i%20)*10,
  stock:i%7?10:0,
  isPopular:i%12===0,
  images:['https://example.invalid/tkan-'+i+'.webp']
}));
const originalLoad = Module._load;
Module._load = function(request,parent,isMain){
  if (request==='@vercel/blob') {
    return {
      head:async()=>({etag:'mock-v1'}),
      get:async()=>({stream:new Response(JSON.stringify(items)).body}),
      put:async()=>{throw new Error('Cannot write test blob');}
    };
  }
  return originalLoad.call(this,request,parent,isMain);
};
const app = require('../server-v2');
Module._load=originalLoad;
let server, base;
test.before(async ()=>{
  server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
  base='http://127.0.0.1:'+server.address().port;
});
test.after(async ()=>{if(server)await new Promise((r,j)=>server.close(err=>err?j(err):r()));});
async function request(path,opts){
  const response=await fetch(base+path,opts);
  const data=await response.json();
  return {response,data};
}
test('shows 500 products in isolated catalogue',async()=>{
  const {response,data}=await request('/api/v2/status');
  assert.equal(response.status,200);
  assert.equal(data.total,500);
  assert.equal(data.photos,500);
});
test('paginates 500 products into 24-item pages',async()=>{
  const first=await request('/api/products?limit=24&page=1');
  const last=await request('/api/products?limit=24&page=21');
  assert.equal(first.response.status,200);
  assert.equal(first.data.total,500);
  assert.equal(first.data.items.length,24);
  assert.equal(first.data.pages,21);
  assert.equal(last.data.items.length,20);
  assert.equal(last.data.items.at(-1).id,500);
});
test('filters by Cyrillic text, material, stock and maximum price',async()=>{
  const r=await request('/api/products?search='+encodeURIComponent('Ткань 33')+'&material='+encodeURIComponent('Хлопок')+'&inStock=1&maxPrice=300&limit=24');
  assert.equal(r.response.status,200);
  assert.ok(r.data.total>0);
  assert.ok(r.data.items.every(x=>x.name.includes('33')&&x.material==='Хлопок'&&x.stock>0&&x.price<=300));
});
test('returns product and facet metadata',async()=>{
  const p=await request('/api/products/tkan-12');
  const f=await request('/api/products/facets');
  assert.equal(p.data.product.id,12);
  assert.deepEqual(f.data.materials,['Лён','Хлопок']);
});
test('rejects orders and anonymous admin on a preview',async()=>{
  const order=await request('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const admin=await request('/api/admin/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(order.response.status,503);
  assert.equal(admin.response.status,403);
});