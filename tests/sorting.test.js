import test from 'node:test';
import assert from 'node:assert/strict';
import {sortEpisodes} from '../src/sorting.js';
import {makeFeed} from '../src/lib.js';
const ep=(id,source_order,source_kind,source_position,published_at=null)=>({id,source_order,source_kind,source_position,published_at,created_at:100,title:id,video_id:'abcdefghijk',size:3,duration:1});
test('source defaults preserve playlist order, author chronology and source addition order',()=>{
  const list=[ep('single-later',4,'video',1),ep('author-new',2,'author',1,300),ep('playlist-two',1,'playlist',2,50),ep('single-first',3,'video',1),ep('author-old',2,'author',2,200),ep('playlist-one',1,'playlist',1,400)];
  assert.deepEqual(sortEpisodes(list).map(e=>e.id),['playlist-one','playlist-two','author-old','author-new','single-first','single-later']);
  assert.deepEqual(sortEpisodes(list,'published_desc').map(e=>e.id),['playlist-one','author-new','author-old','playlist-two','single-first','single-later']);
  assert.deepEqual(sortEpisodes(list,'added_desc').map(e=>e.id),['single-later','single-first','author-old','author-new','playlist-two','playlist-one']);
});
test('missing author dates use one consistent tab-order fallback and missing global dates come last',()=>{
  const list=[ep('newest',1,'author',1,300),ep('oldest',1,'author',3),ep('middle',1,'author',2,200)];
  assert.deepEqual(sortEpisodes(list).map(e=>e.id),['oldest','middle','newest']);
  assert.deepEqual(sortEpisodes(list,'published_asc').map(e=>e.id),['middle','newest','oldest']);
});
test('RSS uses real publication dates, keeps GUIDs stable, and supplies serial hints',()=>{
  const episode=ep('stable',1,'playlist',1,200);
  const c={title:'Example',feed_token:'test',sort_mode:'source'};
  const feed=makeFeed(c,[episode],'https://example.com');
  assert.ok(feed.includes('<itunes:type>serial</itunes:type>'));
  assert.ok(feed.includes('<itunes:episode>1</itunes:episode>'));
  assert.ok(feed.includes(new Date(200000).toUTCString()));
  assert.ok(feed.includes('<guid isPermaLink="false">stable</guid>'));
  assert.ok(makeFeed({...c,sort_mode:'published_desc'},[episode],'https://example.com').includes('<itunes:type>episodic</itunes:type>'));
});
