'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {pool}=require('../shop-db');
const catalog=require('../shop-catalog');

test('material filter merges Вискоза and Вискозо without losing other fibers',async t=>{
  const same=['Вискоза','Вискозо','Вискоза.','  вискоза  '];
  same.forEach(v=>assert.equal(catalog.normalizedMaterialLabel(v),'Вискозо'));
  assert.equal(catalog.normalizedMaterialLabel('Вискоза, П/Э, Люрекс.'),
    'Вискозо, П/Э, Люрекс');
  assert.equal(catalog.normalizedMaterialLabel('Вискозо, П/Э, Люрекс'),
    'Вискозо, П/Э, Люрекс');
  assert.equal(catalog.normalizedMaterialLabel('Вискоза, Нейлон , Эластан.'),
    'Вискозо, Нейлон, Эластан');
  assert.equal(catalog.normalizedMaterialLabel('Шерсть'),'Шерсть');
  assert.equal(catalog.normalizedMaterialLabel('Вискозная ткань'),'Вискозная ткань');

  const originalQuery=pool.query;
  t.after(()=>{pool.query=originalQuery;});
  const materials=['Вискоза','Вискозо','Вискоза.','Вискоза, П/Э, Люрекс.',
    'Вискозо, П/Э, Люрекс','Шерсть'];
  const calls=[];
  pool.query=async (sql,params=[])=>{
    calls.push({sql,params});
    if(sql.includes('SELECT DISTINCT category'))return {rows:[{category:'Ткани'}]};
    if(sql.includes('SELECT DISTINCT material'))return {
      rows:materials.map(material=>({material}))
    };
    if(sql.includes('SELECT min(price)'))return {rows:[{min:900,max:2900}]};
    if(sql.includes('SELECT count(*)::int AS n'))return {rows:[{n:3}]};
    if(sql.includes('SELECT id,slug,name'))return {rows:[]};
    throw Error('Unexpected SQL: '+sql);
  };
  const routes=new Map();
  const app={};
  for(const method of ['get','post','put','patch','delete','use']){
    app[method]=(path,...handlers)=>{if(method==='get')routes.set(path,handlers.at(-1));return app;};
  }
  catalog.register(app);
  const response=()=>({
    data:null,
    set(){return this;},
    json(value){this.data=value;return this;}
  });
  const onError=err=>{throw err;};
  const facetResponse=response();
  await routes.get('/api/products/facets')({query:{}},facetResponse,onError);
  assert.equal(facetResponse.data.materials.filter(m=>m==='Вискозо').length,1);
  assert.deepEqual(facetResponse.data.materials.sort(),[
    'Вискозо','Вискозо, П/Э, Люрекс','Шерсть'
  ].sort());

  const listResponse=response();
  await routes.get('/api/products')(
    {query:{material:'Вискозо',page:'1',limit:'24'}},
    listResponse,onError);
  assert.equal(listResponse.data.total,3);
  const query=calls.find(c=>c.sql.includes('SELECT count(*)::int AS n'));
  assert.match(query.sql,/material=ANY\(\$1::text\[\]\)/);
  assert.deepEqual(query.params[0],['Вискоза','Вискозо','Вискоза.']);
  assert.ok(!query.params[0].includes('Вискоза, П/Э, Люрекс.'));
});
