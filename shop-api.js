'use strict';
const {ready}=require('./shop-db');
const auth=require('./shop-auth');
const catalog=require('./shop-catalog');
const orders=require('./shop-orders');
function register(app){
  app.use('/api',(req,res,next)=>{
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
      const o=req.get('Origin');
      if(o){
        try{if(new URL(o).host!==req.get('host'))return res.status(403).json({error:'Запрос с другого сайта запрещён'});}
        catch{return res.status(403).json({error:'Некорректный источник запроса'});}
      }
    }
    next();
  });
  app.get('/api/config',async(req,res)=>{
    try{
      await ready();
      const secretOk=String(process.env.JWT_SECRET||'').length>=32;
      const adminOk=String(process.env.ADMIN_PASSWORD||'').length>=12;
      const readyForOrders=secretOk && process.env.SHOP_OPEN==='1';
      res.set('Cache-Control','no-store');
      res.json({version:'2.1',databaseReady:true,acceptingOrders:readyForOrders,
        adminConfigured:adminOk,paymentMethods:['При получении','Согласовать с магазином'],
        paymentsOnline:false,shippingPrice:'Уточняется магазином при подтверждении'});
    }catch(e){
      console.error('[SHOP-BOOT]',e.message);
      res.status(503).json({databaseReady:false,acceptingOrders:false,error:'Подключение отдельной базы ещё не завершено'});
    }
  });
  app.use('/api',async(req,res,next)=>{
    try{await ready();next();}
    catch(e){console.error('[SHOP-DATABASE]',e.message);res.status(503).json({error:'База магазина временно недоступна'});}
  });
  auth.register(app);
  catalog.register(app);
  app.post('/api/orders',(req,res,next)=>{
    if(process.env.SHOP_OPEN!=='1')return res.status(503).json({error:'Приём заказов ещё не включён'});
    next();
  });
  orders.register(app);
}
module.exports=register;
