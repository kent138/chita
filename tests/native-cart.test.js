'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateCart,userShape}=require('../shop-auth');

test('native PostgreSQL cart validates IDs, quantities, and duplicate items',()=>{
  assert.deepEqual(validateCart([{id:1,quantity:2},{id:1,quantity:4},{id:5,quantity:1}]),
    [{id:1,quantity:4},{id:5,quantity:1}]);
  for(const cart of [
    null,'not-an-array',[null],[{id:0,quantity:1}],[{id:1,quantity:0}],
    [{id:1,quantity:101}],[{id:'1',quantity:1}],[{id:2,quantity:1.5}],
    Array.from({length:151},(_,i)=>({id:i+1,quantity:1}))
  ])assert.throws(()=>validateCart(cart));
});

test('native buyer response contains saved basket but never password hash',()=>{
  const user=userShape({id:42,name:'Покупатель',phone:'79990000000',
    addresses:[],favorites:[3],cart:[{id:2,quantity:3}],
    password_hash:'this-must-not-leak',created_at:'2026-11-15T00:00:00Z'});
  assert.equal(user.id,42);
  assert.deepEqual(user.cart,[{id:2,quantity:3}]);
  assert(!('password_hash' in user));
});
