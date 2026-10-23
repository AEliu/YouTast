import {xml} from './lib.js';
import {subscriptionLinks,podcastClients} from '../public/subscribe-links.js';

export function subscriptionPage(channel,origin,client) {
  const links=subscriptionLinks(origin,channel.feed_token,client);
  const selected=Object.hasOwn(podcastClients,client)&&client!=='choose'?client:'apple';
  const name=podcastClients[selected];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>订阅 ${xml(channel.title)} · YouTast</title><link rel="stylesheet" href="/style.css"><script type="module" src="/subscribe-page.js"></script></head><body class="subscribe-body"><main class="subscribe-panel"><a class="subscribe-brand" href="/">YouTast <small>PRIVATE PODCAST</small></a><p class="eyebrow">把声音带到你的播放器</p><h1>${xml(channel.title)}</h1><p>选择已安装的播放器，在客户端中确认关注。</p><label>播放器<select id="subscribe-client">${Object.entries(podcastClients).filter(([key])=>key!=='choose').map(([key,label])=>`<option value="${key}" ${key===selected?'selected':''}>${label}</option>`).join('')}</select></label><a class="subscribe-open" id="subscribe-open" href="${xml(links[selected])}">${selected==='manual'?'打开 RSS':`在 ${name} 中打开`}</a><p class="muted" id="subscribe-help">没有打开？请确认已安装所选应用，或复制下方 RSS 链接手动添加。Apple Podcasts：资料库 → 右上角菜单 → 通过 URL 关注节目。</p><label>私人 RSS 链接<input id="subscribe-feed" readonly value="${xml(links.feed)}"></label><button type="button" class="small-button" id="subscribe-copy">复制 RSS 链接</button><p role="status" id="subscribe-status"></p><p class="subscribe-privacy">此页面和二维码包含私人收听凭证。仅向你选择的播放器提供订阅链接；不要公开分享。链接轮换后，此页面和旧二维码会失效。</p><noscript><p>可直接使用上面的打开按钮，或手动复制 RSS 链接。</p></noscript></main></body></html>`;
}
