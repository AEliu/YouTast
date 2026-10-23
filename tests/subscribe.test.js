import test from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionLinks} from '../public/subscribe-links.js';
import {subscriptionPage} from '../src/subscribe.js';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {PNG} from 'pngjs';

test('private QR targets a first-party HTTPS chooser and only explicit client links leave it',()=>{
  const token='a'.repeat(64),origin='https://example.com';
  const links=subscriptionLinks(origin,token,'overcast');
  assert.equal(links.page,`${origin}/subscribe/${token}?client=overcast`);
  assert.equal(new URL(links.overcast).searchParams.get('url'),links.feed);
  assert.equal(links.apple,`podcast://example.com/feed/${token}.xml`);
  assert.equal(links.pocketcasts,`pktc://subscribe/example.com/feed/${token}.xml`);
  assert.equal(subscriptionLinks(origin,token,'evil').page,`${origin}/subscribe/${token}`);
  assert.throws(()=>subscriptionLinks('javascript:alert(1)',token));
  assert.throws(()=>subscriptionLinks(origin,'../../escape'));
  const page=subscriptionPage({title:'Private <script> & "channel"',feed_token:token},origin,'pocketcasts');
  assert.ok(page.includes('value="pocketcasts" selected'));
  assert.ok(page.includes('noindex,nofollow,noarchive'));
  assert.ok(!page.includes('<script>'));
  assert.ok(!page.includes('location.href='));
  assert.ok(!page.includes('https://api.qrserver'));
});

test('camera QR decoder recovers the exact HTTPS subscription URL for each client',async()=>{
  for(const client of ['choose','apple','overcast','pocketcasts','manual']) {
    const links=subscriptionLinks('https://example.com','b'.repeat(64),client);
    const png=PNG.sync.read(await QRCode.toBuffer(links.page,{width:280,margin:4,errorCorrectionLevel:'M'}));
    const decoded=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
    assert.equal(decoded?.data,links.page);
  }
});
