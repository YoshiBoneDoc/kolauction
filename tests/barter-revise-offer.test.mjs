import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const {outputFiles}=buildSync({stdin:{contents:`export {default as Form} from './src/components/BarterOfferForm.jsx'; export {default as Review} from './src/components/BarterOfferReview.jsx'; export {default as Images} from './src/components/BarterOfferImages.jsx'; export {UserContext} from './src/context/UserContext.jsx';`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'jsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',define:{'import.meta.env':'{}'}});
const mod={exports:{}};
new Function('require','module','exports',outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {Form,Review,Images,UserContext}=mod.exports;
const offer={id:'prior',meat:4000000,value:5000000,status:'changes_requested',rejectedItems:[2],raiseRequested:true,items:[{id:2,name:'Apple',quantity:4,image:'/apple.gif'},{id:3,name:'Clover',quantity:1,image:'/clover.gif'}]};
const render=element=>renderToStaticMarkup(React.createElement(UserContext.Provider,{value:{currentUser:{id:'bidder'}}},element));
test('revision initializes the offer form with exact Meat and every offered item quantity without submission',()=>{
 const html=render(React.createElement(Form,{auction:{id:'auction'},initialOffer:offer,onSubmitted(){throw new Error('No automatic submission');}}));
 assert.match(html,/value="4,000,000"/);
 assert.match(html,/Quantity of Apple[^>]*value="4"/);
 assert.match(html,/Quantity of Clover[^>]*value="1"/);
 assert.match(html,/2 \/ 10/);
 assert.match(html,/Submit offer/);
});
test('change feedback uses image markers, raise message and the revision control',()=>{
 const html=render(React.createElement(Review,{offer,host:false,active:true,onUpdated(){},onRevise(){}}));
 assert.match(html,/Revise Offer/);
 assert.match(html,/Apple: not accepted/);
 assert.match(html,/Clover: acceptable/);
 assert.match(html,/The host would like you to raise the offer/);
 assert.doesNotMatch(html,/Not accepted:|Acceptable:/);
 const history=render(React.createElement(Images,{offer}));
 assert.doesNotMatch(history,/not accepted|acceptable/);
});
test('accepted and rejected offers show only a short status sentence to the bidder',()=>{
 for(const status of ['accepted','rejected']) {
  const html=render(React.createElement(Review,{offer:{...offer,status},host:false,current:status==='accepted',active:true,onUpdated(){}}));
  assert.match(html,new RegExp(`Your previous bid was <span class="text-${status==='accepted'?'green':'red'}-600">${status}</span> by the host`));
  assert.doesNotMatch(html,/Offered items|Revise Offer|estimated value|426|Apple/);
 }
});

test('a superseded accepted offer reports that the host accepted another offer',()=>{
 const html=render(React.createElement(Review,{offer:{...offer,status:'accepted'},host:false,current:false,active:true,onUpdated(){}}));
 assert.match(html,/The host has accepted another offer\./);
 assert.doesNotMatch(html,/Your previous bid was/);
});
