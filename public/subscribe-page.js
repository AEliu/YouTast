import {subscriptionLinks,podcastClients} from './subscribe-links.js';
const select=document.querySelector('#subscribe-client');
const feed=document.querySelector('#subscribe-feed');
const token=new URL(feed.value).pathname.match(/^\/feed\/([a-f0-9]{64})\.xml$/)[1];
select.addEventListener('change',()=>{
  const client=select.value,links=subscriptionLinks(location.origin,token,client);
  const open=document.querySelector('#subscribe-open');
  open.href=links[client];open.textContent=client==='manual'?'打开 RSS':`在 ${podcastClients[client]} 中打开`;
  history.replaceState(null,'',new URL(links.page).pathname+new URL(links.page).search);
});
document.querySelector('#subscribe-copy').addEventListener('click',async()=>{
  const status=document.querySelector('#subscribe-status');
  try {await navigator.clipboard.writeText(feed.value);status.textContent='RSS 链接已复制，可粘贴到播放器。';}
  catch {feed.focus();feed.select();status.textContent='已选中链接，请长按或手动复制。';}
});
