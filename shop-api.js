'use strict';
const {ready}=require('./shop-db');
const auth=require('./shop-auth');
const catalog=require('./shop-catalog');
const orders=require('./shop-orders');
function sellerReady(){
  const name=String(process.env.SELLER_LEGAL_NAME||'').trim();
  const ogrn=String(process.env.SELLER_OGRN||'').replace(/\D/g,'');
  const address=String(process.env.SELLER_LEGAL_ADDRESS||'').trim();
  const contact=String(process.env.SELLER_CONTACT||'').trim();
  return name.length>5 && [13,15].includes(ogrn.length) && address.length>10 && contact.length>5;
}
function ordersEnabled(){
  return process.env.SHOP_OPEN==='1' && process.env.DATA_LOCALIZATION_REVIEWED==='1' && String(process.env.JWT_SECRET||'').length>=32 && String(process.env.ADMIN_PASSWORD||'').length>=12 && sellerReady();
}
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
      const readyForOrders=ordersEnabled();
      res.set('Cache-Control','no-store');
      res.json({version:'2.1',databaseReady:true,acceptingOrders:readyForOrders,
        adminConfigured:adminOk && secretOk,sellerReady:sellerReady(),seller:sellerReady()?{name:process.env.SELLER_LEGAL_NAME,ogrn:process.env.SELLER_OGRN,address:process.env.SELLER_LEGAL_ADDRESS,contact:process.env.SELLER_CONTACT}:null,paymentMethods:['При получении','Согласовать с магазином'],
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
    if(!ordersEnabled())return res.status(503).json({error:'Приём заказов ещё не включён: проверьте данные продавца, базу и настройки запуска'});
    next();
  });
  orders.register(app);
}
module.exports=register;
