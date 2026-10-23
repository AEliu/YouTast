export const podcastClients = {choose:'扫码后选择',apple:'Apple Podcasts',overcast:'Overcast',pocketcasts:'Pocket Casts',manual:'其他客户端 / RSS'};

export function subscriptionLinks(origin, token, client='choose') {
  const base=new URL(origin);
  if(base.origin!==origin || !['http:','https:'].includes(base.protocol) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid subscription address');
  const feed=`${origin}/feed/${token}.xml`;
  const address=feed.replace(/^https?:\/\//,'');
  const selected=Object.hasOwn(podcastClients,client)?client:'choose';
  return {feed,page:`${origin}/subscribe/${token}${selected==='choose'?'':`?client=${selected}`}`,
    apple:`podcast://${address}`,overcast:`overcast://x-callback-url/add?url=${encodeURIComponent(feed)}`,
    pocketcasts:`pktc://subscribe/${address}`,manual:feed};
}
