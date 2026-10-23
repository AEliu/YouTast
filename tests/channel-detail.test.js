import assert from 'node:assert/strict';
import test from 'node:test';
import {renderChannelDetail} from '../public/channel-detail.js';

const options={escape:String,sortNames:{},statusNames:{}};
const model={channel:{id:'example',title:'Example',sync_hours:6},counts:{episodes:0,ready:0,archived:0,jobs:0,active:0},sources:[],episodes:[],jobs:[],tab:'episodes',page:{offset:0,limit:30,total:0,hasMore:false}};

test('detail distinguishes an empty channel from an empty page with a recovery link',()=>{
 const empty=renderChannelDetail(model,options);
 assert.match(empty,/这个频道还没有节目/);
 assert.doesNotMatch(empty,/详情分页|返回第一页/);
 for(const tab of ['episodes','archive','jobs']){
  const html=renderChannelDetail({...model,tab,page:{offset:90,limit:30,total:31,hasMore:false}},options);
  assert.match(html,/本页暂无内容，列表可能已更新/);
  assert.ok(html.includes(`href="#channel/example/${tab}/0">返回第一页`));
  assert.match(html,/共 31 条/);
  assert.doesNotMatch(html,/这个频道还没有节目|第 31–31 条|第 91–/);
 }
});

test('detail displays actual last-page range and links without phantom entries',()=>{
 const episodes=[{id:'31',title:'Thirty-one',duration:60},{id:'32',title:'Thirty-two',duration:60}];
 const html=renderChannelDetail({...model,episodes,page:{offset:30,limit:30,total:32,hasMore:false}},options);
 assert.match(html,/第 31–32 条 \/ 共 32 条/);
 assert.ok(html.includes('href="#channel/example/episodes/0">上一页'));
 assert.doesNotMatch(html,/下一页|本页暂无内容/);
});
