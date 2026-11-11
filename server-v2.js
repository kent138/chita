'use strict';

const express = require('express');
const path = require('path');
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

require('./v2-api')(app);
require('./v2-import')(app);

const disabled = (req, res) => res.status(503).json({
  error: 'Это отдельная тестовая версия магазина. Оформление заказов и личные кабинеты пока отключены. Используйте основной сайт.',
});
app.use('/api/auth', disabled);
app.use('/api/orders', disabled);
app.use('/api/admin/orders', disabled);
app.use('/api/products/:id/reviews', disabled);
app.use('/api', (req, res) => res.status(404).json({error:'Неизвестный запрос'}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => {
  console.error('[V2]', req.path, err.message);
  res.status(err.statusCode && err.statusCode>=400 && err.statusCode<600 ? err.statusCode : 500)
    .json({error:err.statusCode ? err.message:'Не удалось обработать запрос. Попробуйте снова.',code:err.code||undefined});
});
const port=process.env.PORT||3000;
if(require.main===module) app.listen(port,()=>console.log('Matreshka v2 listening',port));
module.exports=app;
