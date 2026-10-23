import test from 'node:test';
import assert from 'node:assert/strict';
import {listOptions,pageInfo} from '../src/listing.js';
import {renderChannelDetail} from '../public/channel-detail.js';
import {renderCollection,listRoute} from '../public/list-ui.js';
const escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
test('list input validates query length and paging bounds',()=>{
 assert.deepEqual(listOptions(new URL('https://example.test/?q=%20hi%20&offset=30')),{query:'hi',offset:30,limit:30});
 for(const input of ['offset=-1','offset=1.1','offset=1000001','offset=NaN','q='+'x'.repeat(201)])assert.throws(()=>listOptions(new URL('https://example.test/?'+input)));
 assert.equal(pageInfo({offset:30,limit:30},30).offset,0);
});
test('collection search survives pagination links and escapes the search field',()=>{
 const query='"<script>&%',model={query,episodes:[],page:{offset:30,limit:30,total:90,hasMore:true}};
 const html=renderCollection(model,'episodes',{escape,statusNames:{},channels:[]});
 assert.ok(html.includes(listRoute('episodes',60,query)));
 assert.match(html,/value="&quot;&lt;script&gt;&amp;%"/);
 assert.doesNotMatch(html,/<script>/);
});
test('channel search with no matches does not claim the channel is empty',()=>{
 const html=renderChannelDetail({channel:{id:'sample',title:'Title'},counts:{episodes:40,ready:0,archived:0,jobs:0,active:0},sources:[],episodes:[],jobs:[],query:'none',tab:'episodes',page:{offset:0,limit:30,total:0,hasMore:false}},{escape,sortNames:{},statusNames:{}});
 assert.match(html,/没有找到匹配的内容/);
 assert.doesNotMatch(html,/这个频道还没有节目/);
});
