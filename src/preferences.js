import {requireValue} from './lib.js';
import {SORT_MODES} from './sorting.js';
export const DEFAULT_SETTINGS = {retention_days:0,text_language:'zh-CN',bitrate:64,scan_limit:30,latest_limit:0,sync_hours:6,feed_limit:500,sort_mode:'source',storage_cleanup:'off'};
export const TEXT_LANGUAGES=['original','zh-CN','zh-TW','en','ja','ko','es','fr','de'];
export const SETTING_OPTIONS = {retention_days:[0,7,30,90,180,365],text_language:TEXT_LANGUAGES,bitrate:[48,64,96,128],scan_limit:[10,30,50,100],latest_limit:[0,10,30,50,100],sync_hours:[6,12,24,48],feed_limit:[50,100,200,500],sort_mode:SORT_MODES,storage_cleanup:['off','oldest']};
export const SETTING_RANGES={retention_days:{min:0,max:3650},scan_limit:{min:1,max:100},latest_limit:{min:0,max:100},sync_hours:{min:1,max:168},feed_limit:{min:1,max:1000}};
export function validateSettings(value, channel=false) {
  requireValue(value && typeof value==='object' && !Array.isArray(value),400,'设置格式无效');
  const result={};
  for(const [key,v] of Object.entries(value)) {
    const range=SETTING_RANGES[key];
    requireValue(Object.hasOwn(SETTING_OPTIONS,key)&&(range?Number.isInteger(v)&&v>=range.min&&v<=range.max:SETTING_OPTIONS[key].includes(v)),400,`设置值无效：${key}`);
    requireValue(!channel||key!=='storage_cleanup',400,'空间清理策略请在用户设置中配置');
    result[key]=v;
  }
  return result;
}
export function imageUrl(value, youtubeOnly=false) {
  if(!value) return '';
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port||value.length>1000) return '';
    if(youtubeOnly&&!['i.ytimg.com','yt3.ggpht.com','yt3.googleusercontent.com'].includes(u.hostname))return '';
    if(!youtubeOnly&&(u.hostname==='localhost'||!u.hostname.includes('.')||/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)))return '';
    return u.href;
  } catch{return '';}
}
export function cleanMetadata(value={}) {
  requireValue(value && typeof value==='object'&&!Array.isArray(value),400,'视频元数据格式无效');
  const text=(key,max)=> typeof value[key]==='string'?value[key].slice(0,max):'';
  const seen=new Set();
  const chapters=(Array.isArray(value.chapters)?value.chapters:[]).slice(0,100).filter(c=>c&&Number.isFinite(c.startTime)&&c.startTime>=0&&c.startTime<=86400&&typeof c.title==='string')
    .sort((a,b)=>a.startTime-b.startTime).filter(c=>{if(seen.has(c.startTime))return false;seen.add(c.startTime);return true;}).map(c=>({startTime:c.startTime,title:c.title.slice(0,200)}));
  return {description:text('description',20000),author:text('author',200),thumbnail:imageUrl(value.thumbnail,true),language:text('language',30),chapters,...(TEXT_LANGUAGES.includes(value.text_language)?{text_language:value.text_language}:{}),...(typeof value.complete==='boolean'?{complete:value.complete}:{})};
}
export const audioProfile = c => `mp3:${c.bitrate}:original`;
