import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSettings,cleanMetadata,imageUrl} from '../src/preferences.js';
import {makeFeed} from '../src/lib.js';
test('preferences reject unbounded values and metadata neutralizes unsafe content',()=>{
  for(const value of [{scan_limit:100000},{bitrate:320},{retention_days:-1},{sort_mode:'random'},{preferred_language:'en; curl bad'}])assert.throws(()=>validateSettings(value));
  assert.deepEqual(validateSettings({bitrate:128,retention_days:30}),{bitrate:128,retention_days:30});
  assert.deepEqual(validateSettings({scan_limit:7,latest_limit:13,retention_days:19,sync_hours:3,feed_limit:17}),{scan_limit:7,latest_limit:13,retention_days:19,sync_hours:3,feed_limit:17});
  assert.throws(()=>validateSettings({storage_cleanup:'oldest'},true));
  const meta=cleanMetadata({description:'<script>alert(1)</script>',thumbnail:'javascript:bad',chapters:[{startTime:5,title:'B'},{startTime:-1,title:'bad'},{startTime:0,title:'A'},{startTime:5,title:'duplicate'}]});
  assert.equal(meta.thumbnail,'');assert.equal(meta.chapters.length,2);assert.equal(meta.chapters[0].startTime,0);
  assert.equal(imageUrl('http://example.com/image.jpg'),'');assert.equal(imageUrl('https://user:pass@example.com/image.jpg'),'');
  const feed=makeFeed({title:'Channel',rss_metadata:JSON.stringify({author:'Me & You',image:'https://example.com/cover.jpg',explicit:true}),rss_language:'en',feed_token:'private'},[{id:'ep',title:'Title',video_id:'abcdefghijk',created_at:1,metadata:JSON.stringify(meta),size:3,duration:10}],'https://example.org');
  assert.ok(!feed.includes('<script>'));assert.ok(feed.includes('<language>en</language>'));assert.ok(feed.includes('application/json+chapters'));assert.ok(feed.includes('Me &amp; You'));assert.ok(feed.includes('<itunes:explicit>true</itunes:explicit>'));
  assert.ok(feed.includes('<description>00:00:00 A\n00:00:05 B\n\n'));
});
