const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const F = require('../app-features');
function storage(initial={}) {
  return { data: initial, getItem(k) { return this.data[k] ?? null; }, setItem(k,v) { this.data[k]=v; } };
}
const item = (name, platform='twitch', extra={}) => ({ name,platform,url:'https://cdn/emote',source:'Global',...extra });

test('works in an ordinary browser without Node or extension globals', () => {
  const source = fs.readFileSync(require.resolve('../app-features'),'utf8');
  for(const context of [{}, {globalThis:undefined}]) {
    vm.runInNewContext(source, context, {filename:require.resolve('../app-features')});
    assert.equal(typeof context.ChatFeatures.groups, 'function');
  }
});
test('favorites precede alphabetical streamers, then categories; each emote appears once', () => {
  const list = [item('a','twitch',{owner:'Zed'}),item('b','kick',{owner:'Amy'}),item('c'),item('d','kick',{source:'Emoji'}),item('f')];
  const groups = F.groups(list,['twitch:f'],'');
  assert.deepEqual(groups.map(g=>g.label), ['Favorites','Amy · Kick','Zed · Twitch','Emoji','Global']);
  assert.equal(groups.flatMap(g=>g.items).length,5);
  assert.equal(F.groups(list,[],' A ')[0].items[0].name,'a');
  assert.deepEqual(F.groups([item('x','twitch',{selectable:false}),item('y','kick',{url:''})],[],'x'),[]);
});
test('favorite toggles persist separately for identical names and survive unavailable emotes', () => {
  const s=storage(), p=F.preferences(s);
  p.toggle(item('a'));p.toggle(item('a','kick'));p.toggle(item('a'));p.toggle(item('b'));
  assert.deepEqual(F.preferences(s).favorites,['kick:a','twitch:b']);
  assert.deepEqual(F.groups([item('b','twitch',{selectable:false})],p.favorites,''),[]);
  assert.deepEqual(p.favorites,['kick:a','twitch:b']);
});
test('recents remember only successfully usable platform emotes and filter before the hard eight limit', () => {
  const s=storage(),p=F.preferences(s);
  const list=Array.from({length:30},(_,i)=>item('e'+i, i%2 ? 'kick':'twitch'));
  p.remember('twitch','ordinary text',list);
  assert.deepEqual(p.order,[]);
  for(const e of list) p.remember(e.platform,e.name,list);
  assert.equal(p.order.length,24);
  assert.equal(JSON.parse(s.data['friendly_chat_recent_emotes_v1:twitch']).length,12);
  assert.equal(JSON.parse(s.data['friendly_chat_recent_emotes_v1:kick']).length,12);
  assert.equal(p.recent(list,{twitch:'joined',kick:'joined'},1000).length,8);
  const filtered=p.recent(list,{twitch:'joined'},1000);
  assert.equal(filtered.length,8);assert(filtered.every(e=>e.platform==='twitch'));
  assert.equal(p.recent(list,{twitch:true,kick:true},68).length,2);
  assert.equal(p.recent(list,{twitch:true},0).length,0);
  assert.deepEqual(p.recent(list,{},400),[]);
  p.remember('kick','e29 e29',list);p.remember('kick','e29',list);
  assert.equal(p.order[0],'kick:e29');assert.equal(new Set(p.order).size,p.order.length);
  assert.deepEqual(F.preferences(s).order,p.order);
});
test('invalid or inaccessible storage is harmless', () => {
  for(const value of ['not json','null','{}','["twitch:a",1,"twitch:a"]']) {
    const p=F.preferences(storage({'friendly_chat_emote_favorites_v1':value}));
    assert.deepEqual(p.favorites,value.startsWith('[')?['twitch:a']:[]);
  }
  const s={getItem(){throw Error('blocked');},setItem(){throw Error('quota');}};
  const p=F.preferences(s);p.toggle(item('a'));p.remember('twitch','a',[item('a')]);
  assert.deepEqual(p.order,['twitch:a']);
});
test('Kick native emotes serialize correctly; unavailable/invalid/third-party tokens stay plain', () => {
  const native={a:item('a','kick',{id:10}),b:item('b','kick',{id:11,selectable:false}),c:item('c','kick',{id:'invalid'}),d:item('d','kick',{id:12,url:''})};
  assert.equal(F.outgoing('kick','a b c d missing [emote:10:a]',native),'[emote:10:a] b c d missing [emote:10:a]');
  assert.equal(F.outgoing('twitch','a',native),'a');
});
test('emote-only routing requires each destination to support every emote and isolates Cheer', () => {
  const entries=[item('a'),item('a','kick'),item('b','kick'),item('blocked','kick',{selectable:false})];
  assert.deepEqual(F.destinations('a',['twitch','kick'],entries),['twitch','kick']);
  assert.deepEqual(F.destinations('a b',['twitch','kick'],entries),['kick']);
  assert.deepEqual(F.destinations('blocked',['twitch','kick'],entries),[]);
  assert.deepEqual(F.destinations('hello a',['twitch','kick'],entries),['twitch','kick']);
  assert.deepEqual(F.destinations('hello Cheer100',['twitch','kick'],entries),['twitch']);
  assert.deepEqual(F.destinations('cheer1',['kick'],entries),[]);
});
test('bounded exponential retries resume after a five minute cooldown', () => {
  assert.deepEqual(F.retry(0),{delay:2000,attempt:1});
  assert.deepEqual(F.retry(9),{delay:30000,attempt:10});
  assert.deepEqual(F.retry(10),{delay:300000,attempt:0});
});
test('only validated Pusher descriptors can become socket URLs', () => {
  const response = credentials => ({data:{mode:'websocket',connections:[null,{provider:'other'},{provider:'pusher',credentials}]}});
  assert.match(F.pusherUrl(response({app_key:'ABC123',cluster:'us2'})),/^wss:\/\/ws-us2\.pusher\.com\/app\/ABC123\?/);
  const bad=[null,{}, {data:{mode:'poll'}},{data:{mode:'websocket',connections:{}}},{data:{mode:'websocket',connections:[]}}, response(null),response({}),
    response({app_key:10,cluster:'us2'}),response({app_key:'bad/path',cluster:'us2'}),response({app_key:'ok',cluster:10}),response({app_key:'ok',cluster:'evil.com/path'})];
  for(const data of bad) assert.throws(()=>F.pusherUrl(data));
});
test('moderation refuses unknown actions and invalid durations', () => {
  for(const a of ['delete','ban','unban']) assert(F.validModeration(a));
  assert(F.validModeration('timeout',1));assert(F.validModeration('timeout',1209600));
  for(const d of [0,-1,1.5,1209601,'10',null]) assert(!F.validModeration('timeout',d));
  for(const a of ['pin','BAN','',null,{},[]]) assert(!F.validModeration(a));
});
test('pin parameters use exact message IDs, encode query strings, and validate durations', () => {
  assert.equal(F.pinParameters('pin','id&other=1',300),'message_id=id%26other%3D1&duration_seconds=300');
  assert.equal(F.pinParameters('pin','id'),'message_id=id');
  assert.equal(F.pinParameters('unpin','id',300),'message_id=id');
  for(const seconds of [30,1800]) assert(F.pinParameters('pin','id',seconds));
  for(const seconds of [0,29,1801,'30',30.5,null]) assert.equal(F.pinParameters('pin','id',seconds),null);
  for(const id of ['',null,1]) assert.equal(F.pinParameters('pin',id),null);
  assert.equal(F.pinParameters('ban','id'),null);
});
test('YouTube badge images require trusted HTTPS image hosts with no credentials', () => {
  assert.equal(F.youtubeBadgeUrl('https://yt3.ggpht.com/badge.png'),'https://yt3.ggpht.com/badge.png');
  assert.equal(F.youtubeBadgeUrl('https://www.gstatic.com/badge.png'),'https://www.gstatic.com/badge.png');
  for(const url of ['',null,'javascript:alert(1)','http://yt3.ggpht.com/x','https://evil.test/x','https://user@yt3.ggpht.com/x','https://:password@yt3.ggpht.com/x']) assert.equal(F.youtubeBadgeUrl(url),'');
});
test('offscreen/hidden feed media suspends sources, restores dimensions, and releases removed rows/listeners', () => {
  const { JSDOM } = require('jsdom');
  const dom=new JSDOM('<div id="feed"><div id="row"><img src="https://cdn/a" style="width:40px"><img></div><div id="plain">text</div></div>',{pretendToBeVisual:true});
  const document=dom.window.document,feed=document.getElementById('feed'),row=document.getElementById('row'),image=row.querySelector('img');
  let observer,cb,observed=0,unobserved=0,disconnected=0;
  class Observer {constructor(callback){cb=callback;observer=this;} observe(){observed++;} unobserve(){unobserved++;} disconnect(){disconnected++;}}
  const controller=F.mediaLifecycle(feed,Observer);
  controller.attach(document.getElementById('plain'));controller.attach(row);controller.attach(row);assert.equal(observed,1);
  cb([{target:feed,isIntersecting:false},{target:row,isIntersecting:false}]);
  assert(!image.hasAttribute('src'));assert.equal(image.dataset.chatSrc,'https://cdn/a');assert.equal(image.style.height,'28px');
  cb([{target:row,isIntersecting:false}]);cb([{target:row,isIntersecting:true}]);
  assert.equal(image.getAttribute('src'),'https://cdn/a');assert.equal(image.style.width,'40px');assert.equal(image.style.height,'');
  image.getBoundingClientRect=()=>({width:42,height:30});
  Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(image.style.width,'42px');assert.equal(image.style.height,'30px');
  cb([{target:row,isIntersecting:true}]);assert(!image.hasAttribute('src'));
  const newRow=document.createElement('div');newRow.innerHTML='<img src="https://cdn/new">';feed.appendChild(newRow);controller.attach(newRow);assert(!newRow.firstChild.hasAttribute('src'));
  Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new dom.window.Event('visibilitychange'));assert(image.hasAttribute('src'));
  controller.prune();assert.equal(unobserved,0);row.remove();controller.prune();assert.equal(unobserved,1);
  controller.stop();assert.equal(disconnected,1);document.dispatchEvent(new dom.window.Event('visibilitychange'));
  const unavailable=F.mediaLifecycle(feed,null);unavailable.attach(newRow);unavailable.prune();unavailable.stop();
  assert(observer);dom.window.close();
});
