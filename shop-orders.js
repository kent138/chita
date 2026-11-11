'use strict';
const crypto=require('crypto');
const {pool}=require('./shop-db');
const {wrap,error,userAuth,adminAuth,decodeUser,normPhone,safeText}=require('./shop-auth');

const STATUSES=['Новый','В обработке','Готов к выдаче','Отправлен','Выполнен','Отменён'];
const DELIVERY=['Самовывоз','Почта России','СДЭК'];
const PAYMENTS=['При получении','Согласовать с магазином'];
const serializeOrder=o=>({
 ...o,id:Number(o.id),user_id:o.user_id===null?null:Number(o.user_id),
 total_price:Number(o.total_price),gift_wrap:!!o.gift_wrap,
 items:o.items||[]
});
async function itemsForOrders(orders){
 if(!orders.length)return [];
 const ids=orders.map(o=>o.id);
 const r=await pool.query('SELECT order_id,product_id,product_name,product_price,quantity FROM shop_order_items WHERE order_id=ANY($1::bigint[]) ORDER BY id',[ids]);
 const byOrder=new Map();
 for(const x of r.rows){
   const k=String(x.order_id);
   if(!byOrder.has(k))byOrder.set(k,[]);
   byOrder.get(k).push({...x,product_id:x.product_id===null?null:Number(x.product_id),
       order_id:Number(x.order_id),product_price:Number(x.product_price)});
 }
 return orders.map(o=>serializeOrder({...o,items:byOrder.get(String(o.id))||[]}));
}
function checkoutInput(body){
 const b=body||{};
 const customerName=safeText(b.customerName,150);
 const customerPhone=normPhone(b.customerPhone);
 const deliveryMethod=safeText(b.deliveryMethod,70);
 const paymentMethod=safeText(b.paymentMethod,70);
 const deliveryAddress=safeText(b.deliveryAddress,600);
 const comment=safeText(b.comment,2000);
 const giftWrap=!!b.giftWrap;
 const promoCode=safeText(b.promoCode,40).toUpperCase().normalize('NFC');
 if(customerName.length<2||!DELIVERY.includes(deliveryMethod)||!PAYMENTS.includes(paymentMethod))
   throw error('Заполните имя и выберите доступную доставку и оплату');
 if(deliveryMethod!=='Самовывоз'&&deliveryAddress.length<8)throw error('Укажите полный адрес доставки');
 if(!Array.isArray(b.items)||b.items.length<1||b.items.length>80)throw error('В заказе должно быть от 1 до 80 позиций');
 const quantities=new Map();
 for(const item of b.items){
   const id=Number(item.id),qty=Number(item.quantity);
   if(!Number.isSafeInteger(id)||id<=0||!Number.isInteger(qty)||qty<1||qty>100)
     throw error('Некорректное количество товара');
   quantities.set(id,(quantities.get(id)||0)+qty);
   if(quantities.get(id)>100)throw error('Слишком большое количество товара');
 }
 const idempotencyKey=String(b.idempotencyKey||crypto.randomUUID());
 if(idempotencyKey.length<20||idempotencyKey.length>128||!/^[a-z0-9_-]+$/i.test(idempotencyKey))
   throw error('Некорректный идентификатор заказа');
 return {customerName,customerPhone,deliveryMethod,paymentMethod,deliveryAddress,
   comment,giftWrap,promoCode,quantities,idempotencyKey,consent:b.consent===true};
}
function priceTotal(items){
  // Only the actual listed goods are charged. Delivery and payment are confirmed with the shop.
  // No fictional coupons or unapproved gift-wrap fees.
  const kopeks=items.reduce((sum,p)=>sum+Math.round(Number(p.price)*100)*p.qty,0);
  return Number((kopeks/100).toFixed(2));
}

function register(app){
 app.post('/api/orders',wrap(async(req,res)=>{
   const b=checkoutInput(req.body);
   if(!b.consent)throw error('Подтвердите согласие на обработку данных заказа');
   const c=await pool.connect();
   try{
     await c.query('BEGIN');
     let row;
     try{
       row=(await c.query(
        "INSERT INTO shop_orders(user_id,customer_name,customer_phone,delivery_method,delivery_address,payment_method,comment,gift_wrap,promo_code,total_price,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10) RETURNING id",
        [decodeUser(req),b.customerName,b.customerPhone,b.deliveryMethod,b.deliveryAddress,
         b.paymentMethod,b.comment,b.giftWrap,b.promoCode,b.idempotencyKey]
       )).rows[0];
     }catch(e){
       if(e.code==='23505'){
         await c.query('ROLLBACK');
         const existing=(await pool.query('SELECT id,total_price FROM shop_orders WHERE idempotency_key=$1',[b.idempotencyKey])).rows[0];
         if(existing)return res.json({ok:true,orderId:Number(existing.id),total:Number(existing.total_price),duplicate:true});
       }
       throw e;
     }
     const orderId=Number(row.id),orderedIds=[...b.quantities.keys()].sort((a,b)=>a-b);
     const products=[];
     for(const id of orderedIds){
       const qty=b.quantities.get(id);
       const updated=await c.query(
         "UPDATE shop_products SET stock=stock-$2,updated_at=now() WHERE id=$1 AND active=true AND stock>=$2 RETURNING id,name,price,stock",
         [id,qty]);
       if(!updated.rowCount)throw error('Товар закончился или количество превышает остаток. Обновите корзину.',409);
       const p=updated.rows[0];products.push({...p,qty});
       await c.query(
          'INSERT INTO shop_order_items(order_id,product_id,product_name,product_price,quantity) VALUES($1,$2,$3,$4,$5)',
          [orderId,id,p.name,p.price,qty]);
     }
     const total=priceTotal(products);
     await c.query('UPDATE shop_orders SET total_price=$2 WHERE id=$1',[orderId,total]);
     await c.query('COMMIT');
     res.status(201).json({ok:true,orderId,total,paymentStatus:'Ожидает оплаты',
       message:'Магазин свяжется с вами для подтверждения заказа и условий оплаты и доставки'});
   }catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}
   finally{c.release();}
 }));
 app.get('/api/auth/orders',userAuth,wrap(async(req,res)=>{
   const r=await pool.query('SELECT * FROM shop_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200',[req.userId]);
   res.json(await itemsForOrders(r.rows));
 }));
 app.get('/api/admin/orders',adminAuth,wrap(async(req,res)=>{
   const r=await pool.query('SELECT * FROM shop_orders ORDER BY created_at DESC LIMIT 250');
   res.json(await itemsForOrders(r.rows));
 }));
 app.put('/api/admin/orders/:id/status',adminAuth,wrap(async(req,res)=>{
   const id=Number(req.params.id),status=safeText(req.body?.status,50);
   if(!Number.isSafeInteger(id)||!STATUSES.includes(status))throw error('Недопустимый статус заказа');
   const c=await pool.connect();
   try{
     await c.query('BEGIN');
     const existing=(await c.query('SELECT status FROM shop_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
     if(!existing)throw error('Заказ не найден',404);
     if(existing.status===status){await c.query('COMMIT');return res.json({ok:true,status});}
     if(['Отменён','Выполнен'].includes(existing.status))throw error('Завершённый заказ нельзя изменить');
     if(status==='Отменён'){
       await c.query('UPDATE shop_products p SET stock=p.stock+i.qty,updated_at=now() FROM (SELECT product_id,sum(quantity)::int AS qty FROM shop_order_items WHERE order_id=$1 AND product_id IS NOT NULL GROUP BY product_id) i WHERE p.id=i.product_id',[id]);
     }
     await c.query('UPDATE shop_orders SET status=$2,updated_at=now() WHERE id=$1',[id,status]);
     await c.query('COMMIT');
     res.json({ok:true,status});
   }catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}
   finally{c.release();}
 }));
 app.put('/api/admin/orders/:id/payment',adminAuth,wrap(async(req,res)=>{
   const payment=safeText(req.body?.status,50);
   if(!['Ожидает оплаты','Оплачен','Возврат'].includes(payment))throw error('Некорректный статус оплаты');
   const r=await pool.query('UPDATE shop_orders SET payment_status=$2,updated_at=now() WHERE id=$1 RETURNING id',[Number(req.params.id),payment]);
   if(!r.rowCount)throw error('Заказ не найден',404);
   res.json({ok:true,paymentStatus:payment});
 }));
 app.delete('/api/admin/orders/:id',adminAuth,(req,res)=>res.status(405).json({error:'Историю заказов нельзя удалять. Используйте отмену заказа.'}));
 for(const [path,type] of [['/api/b2b','b2b'],['/api/feedback','feedback'],['/api/subscribe','subscribe']]){
   app.post(path,wrap(async(req,res)=>{
      const b=req.body||{};
      const name=safeText(b.name,120),phone=safeText(b.phone,24);
      const email=safeText(b.email,255),message=safeText(b.message,3000),company=safeText(b.company,255);
      if(type==='subscribe'? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email):name.length<2|| (type==='b2b'?phone.length<10:message.length<4))
        throw error('Проверьте обязательные поля');
      await pool.query('INSERT INTO shop_requests(type,name,phone,email,message,company) VALUES($1,$2,$3,$4,$5,$6)',[type,name,phone,email,message,company]);
      res.json({ok:true});
   }));
 }
 app.get('/api/admin/requests',adminAuth,wrap(async(req,res)=>{
   const r=await pool.query('SELECT * FROM shop_requests ORDER BY created_at DESC LIMIT 200');
   res.json(r.rows);
 }));
}
module.exports={register,checkoutInput,priceTotal,STATUSES};
