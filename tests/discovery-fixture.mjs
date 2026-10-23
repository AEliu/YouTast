// Existing API suites supply a complete, small offline playlist in each scan.
// Exercise the inventory handshake instead of bypassing the new capability gate.
const jobs=new Map();
export async function fetchWithDiscovery(input,options={}){
 const url=new URL(typeof input==='string'?input:input.url);
 const remote=process.env.TEST_ALLOW_REMOTE==='1'&&process.env.TEST_ORIGIN&&url.origin===new URL(process.env.TEST_ORIGIN).origin;
 if(url.hostname!=='127.0.0.1'&&!remote)throw new Error('Remote discovery fixtures require an explicit verification runner');
 const headers=new Headers(options.headers);
 if(url.pathname==='/api/executor/claim')headers.set('X-Executor-Discovery-Control','1');
 const match=url.pathname.match(/^\/api\/executor\/jobs\/([\w-]+)\/scan$/);
 let body=options.body;
 if(match&&jobs.get(match[1])?.source?.kind==='playlist'){
  headers.set('X-Executor-Discovery-Control','1');
  const scan=JSON.parse(body),entries=scan.entries.map((e,i)=>({...e,position:e.position??i+1}));
  const inventory=await globalThis.fetch(new URL(url.pathname.replace(/scan$/,'inventory'),url),{...options,headers,body:JSON.stringify({items:entries.map(e=>({id:e.video_id,position:e.position}))})});
  if(!inventory.ok)return inventory;
  const selected=new Set((await inventory.json()).selected.map(e=>e.id));
  body=JSON.stringify({...scan,entries:entries.filter(e=>selected.has(e.video_id))});
 }
 const response=await globalThis.fetch(input,{...options,headers,body});
 if(url.pathname==='/api/executor/claim'&&response.ok){const {job}=await response.clone().json();if(job)jobs.set(job.id,job);}
 return response;
}
