'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');

if(!process.env.TEST_DATABASE_URL){
  test('PostgreSQL integration requires TEST_DATABASE_URL', {skip:true},()=>{});
}else{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET=process.env.JWT_SECRET||'test-only-jwt-secret-must-be-long-enough-2026';
  process.env.ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'test-only-admin-secret-2026';
  process.env.SHOP_OPEN='1';
  process.env.SELLER_LEGAL_NAME='ООО Проверочный Магазин';
  process.env.SELLER_OGRN='1234567890123';
  process.env.SELLER_LEGAL_ADDRESS='Российская Федерация, г. Чита, улица Тестовая, д. 10';
  process.env.SELLER_CONTACT='test@example.invalid';
  const seed=Array.from({length:500},(_,i)=>({
    id:i+1,slug:'tkan-'+(i+1),name:'Ткань '+(i+1),
    description:'Проверочная ткань для шитья '+(i+1),
    material:i%2?'Лён':'Хлопок',category:'Ткани',width:'150 см',
    composition:'100% текстиль',price:100+i,stock:5,isPopular:i%10===0,
    images:['https://sample.public.blob.vercel-storage.com/tkan-'+i+'.webp'],
    createdAt:'2026-11-01T12:00:00.000Z',
    updatedAt:'2026-11-01T12:00:00.000Z'
  }));
  const oldLoad=Module._load;
  Module._load=function(name,parent,isMain){
    if(name==='@vercel/blob')return {
      get:async()=>({stream:new Response(JSON.stringify(seed)).body}),
      put:async(path)=>({url:'https://sample.public.blob.vercel-storage.com/'+path})
    };
    return oldLoad.call(this,name,parent,isMain);
  };
  const app=require('../server-v2');
  const {pool}=require('../shop-db');
  Module._load=oldLoad;
  let base,server,userCookie,adminCookie;
  test.before(async()=>{
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    base='http://127.0.0.1:'+server.address().port;
  });
  test.after(async()=>{
    if(server)await new Promise(resolve=>server.close(resolve));
    await pool.end();
  });
  async function ask(path,options={}){
    const headers={'Content-Type':'application/json',...(options.headers||{})};
    const r=await fetch(base+path,{...options,headers});
    const data=await r.json();
    return {status:r.status,body:data,cookie:r.headers.get('set-cookie'),response:r};
  }
  test('boots 500 products into separate PostgreSQL tables',async()=>{
    const r=await ask('/api/config');
    assert.equal(r.status,200);
    assert.equal(r.body.acceptingOrders,true);
    const first=await ask('/api/products?limit=24&page=1');
    assert.equal(first.body.total,500);
    assert.equal(first.body.items.length,24);
    assert.equal(first.body.pages,21);
    assert.equal((await ask('/api/products?limit=24&page=21')).body.items.length,20);
    assert.equal((await ask('/api/products?search='+encodeURIComponent('Ткань 250')+'&limit=24')).body.total,1);
  });
  test('registers and authenticates a real cookie-backed customer',async()=>{
    const r=await ask('/api/auth/register',{method:'POST',body:undefined,headers:{},});
    assert.equal(r.status,400);
    const customer=await ask('/api/auth/register',{method:'POST',
      body:JSON.stringify({name:'Покупатель Тест',phone:'79998887766',password:'securePass123!',passwordRepeat:'securePass123!',consent:true})});
    assert.equal(customer.status,201);
    assert.match(customer.cookie,/mtr_v2_session=/);
    userCookie=customer.cookie.split(';')[0];
    const me=await ask('/api/auth/me',{headers:{Cookie:userCookie}});
    assert.equal(me.body.phone,'79998887766');
    assert.equal(me.body.name,'Покупатель Тест');
  });
  test('admin login and editing isolated stock',async()=>{
    const no=await ask('/api/admin/orders');
    assert.equal(no.status,401);
    const auth=await ask('/api/admin/login',{method:'POST',body:JSON.stringify({password:process.env.ADMIN_PASSWORD})});
    assert.equal(auth.status,200);
    adminCookie=auth.cookie.split(';')[0];
    const ok=await ask('/api/admin/verify',{method:'POST',headers:{Cookie:adminCookie}});
    assert.equal(ok.status,200);
    const list=await ask('/api/admin/products?limit=50&page=1',{headers:{Cookie:adminCookie}});
    assert.equal(list.status,200);
    assert.equal(list.body.total,500);
    assert.equal(list.body.items.length,50);
    assert.equal(list.body.pages,10);
    const found=await ask('/api/admin/products?search='+encodeURIComponent('Ткань 250')+'&limit=50',{headers:{Cookie:adminCookie}});
    assert.equal(found.status,200);
    assert.equal(found.body.total,1);
    const product=await ask('/api/admin/products/1',{method:'PUT',headers:{Cookie:adminCookie},
      body:JSON.stringify({stock:2})});
    assert.equal(product.body.stock,2);
    const add=await ask('/api/admin/products',{method:'POST',headers:{Cookie:adminCookie},
      body:JSON.stringify({name:'Новинка тест',price:1290,category:'Ткани',stock:3,images:[]})});
    assert.equal(add.status,201);
    assert.ok(add.body.id>=100000);
    assert.equal((await ask('/api/products?search='+encodeURIComponent('Новинка тест')+'&limit=24')).body.total,1);
  });
  test('creates a real order, reserves stock, prevents duplicate checkout',async()=>{
    const payload={customerName:'Тест Покупатель',customerPhone:'79998887766',
      deliveryMethod:'Самовывоз',paymentMethod:'При получении',consent:true,
      idempotencyKey:'shopping-test-order-20261111',
      items:[{id:1,quantity:1}]};
    const first=await ask('/api/orders',{method:'POST',headers:{Cookie:userCookie},body:JSON.stringify(payload)});
    assert.equal(first.status,201);
    assert.ok(first.body.orderId>=1);
    assert.equal((await ask('/api/products/1')).body.product.stock,1);
    const retry=await ask('/api/orders',{method:'POST',headers:{Cookie:userCookie},body:JSON.stringify(payload)});
    assert.equal(retry.status,200);
    assert.equal(retry.body.duplicate,true);
    assert.equal(retry.body.orderId,first.body.orderId);
    assert.equal((await ask('/api/products/1')).body.product.stock,1);
    const history=await ask('/api/auth/orders',{headers:{Cookie:userCookie}});
    assert.equal(history.body[0].id,first.body.orderId);
    const cancelled=await ask('/api/admin/orders/'+first.body.orderId+'/status',{method:'PUT',headers:{Cookie:adminCookie},
      body:JSON.stringify({status:'Отменён'})});
    assert.equal(cancelled.status,200);
    assert.equal((await ask('/api/products/1')).body.product.stock,2);
    const reCancelled=await ask('/api/admin/orders/'+first.body.orderId+'/status',{method:'PUT',headers:{Cookie:adminCookie},
      body:JSON.stringify({status:'Отменён'})});
    assert.equal(reCancelled.status,200);
    assert.equal((await ask('/api/products/1')).body.product.stock,2);
  });
  test('prevents simultaneous overselling',async()=>{
    await ask('/api/admin/products/1',{method:'PUT',headers:{Cookie:adminCookie},body:JSON.stringify({stock:1})});
    const payload=k=>({customerName:'Покупатель Тест',customerPhone:'79998887766',
      deliveryMethod:'Самовывоз',paymentMethod:'При получении',consent:true,
      idempotencyKey:'concurrent-test-order-'+k+'-2026',items:[{id:1,quantity:1}]});
    const results=await Promise.all(['A','B'].map(k=>ask('/api/orders',{method:'POST',body:JSON.stringify(payload(k))})));
    assert.deepEqual(results.map(r=>r.status).sort((a,b)=>a-b),[201,409]);
    assert.equal((await ask('/api/products/1')).body.product.stock,0);
  });
  test('reviews are moderated, enquiries are persisted and orders are not deletable',async()=>{
    const buyerOrder=await ask('/api/orders',{method:'POST',headers:{Cookie:userCookie},
      body:JSON.stringify({customerName:'Покупатель Тест',customerPhone:'79998887766',
       deliveryMethod:'Самовывоз',paymentMethod:'При получении',consent:true,
       idempotencyKey:'review-test-purchase-20261111',items:[{id:2,quantity:1}]})});
    assert.equal(buyerOrder.status,201);
    const r=await ask('/api/products/2/reviews',{method:'POST',headers:{Cookie:userCookie},
      body:JSON.stringify({rating:5,text:'Товар очень понравился'})});
    assert.equal(r.status,201);
    const inQueue=await ask('/api/admin/reviews',{headers:{Cookie:adminCookie}});
    assert.ok(inQueue.body.some(x=>Number(x.id)===r.body.id));
    await ask('/api/admin/reviews/'+r.body.id,{method:'PUT',headers:{Cookie:adminCookie},body:JSON.stringify({approved:true})});
    const reviews=await ask('/api/products/2');
    assert.ok(reviews.body.reviews.some(x=>Number(x.id)===r.body.id));
    assert.equal((await ask('/api/admin/orders/1',{method:'DELETE',headers:{Cookie:adminCookie}})).status,405);
    const message=await ask('/api/feedback',{method:'POST',body:JSON.stringify({name:'Тест клиент',phone:'79998887766',message:'Можно ли купить шёлк?'})});
    assert.equal(message.status,200);
    assert.ok((await ask('/api/admin/requests',{headers:{Cookie:adminCookie}})).body.length>0);
  });
}
