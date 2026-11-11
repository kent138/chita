'use strict';
const express=require('express');
const path=require('path');
const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'16mb'}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=()');
  next();
});
app.use(express.static(path.join(__dirname,'public'),{
  maxAge:'1h',
  setHeaders(res,p){if(/\.html$/.test(p))res.setHeader('Cache-Control','no-cache');}
}));

if(process.env.DATABASE_URL){
  require('./shop-api')(app);
}else{
  // Catalogue remains online until a separate transactional database is configured.
  app.get('/api/config',(req,res)=>{
    res.set('Cache-Control','no-store');
    res.json({version:'2.1',databaseReady:false,acceptingOrders:false,
      adminConfigured:false,paymentsOnline:false,
      message:'Каталог работает. Для оформления заказов нужна отдельная PostgreSQL-база.'});
  });
  // No transactional DB means no durable brute-force protection. Fail closed:
  // never expose the legacy direct-password admin endpoints.
  app.use('/api/admin',(req,res)=>res.status(503).json({
    error:'Админ-панель будет доступна после подключения отдельной защищённой PostgreSQL-базы.'
  }));
  require('./v2-api')(app);
  const disabled=(req,res)=>res.status(503).json({
    error:'Оформление заказов и личный кабинет будут включены после подключения защищённой базы данных.'
  });
  app.use('/api/auth',disabled);
  app.use('/api/orders',disabled);
  app.use('/api/admin/orders',disabled);
  app.use('/api/products/:id/reviews',disabled);
}
app.use('/api',(req,res)=>res.status(404).json({error:'Неизвестный запрос'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{
  if(err.type==='entity.too.large')return res.status(413).json({error:'Файл слишком большой'});
  console.error('[MATRESHKA-V2]',req.path,err.message);
  const status=Number(err.statusCode);
  res.status(status>=400&&status<=599?status:500).json({
    error:status>=400&&status<=499?err.message:'Не удалось обработать запрос. Попробуйте ещё раз.'
  });
});
const port=process.env.PORT||3000;
if(require.main===module)app.listen(port,()=>console.log('Matreshka v2 listening',port));
module.exports=app;
