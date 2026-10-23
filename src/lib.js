import {audioMedia} from './audio.js';
export const now = () => Math.floor(Date.now() / 1000);
export const id = () => crypto.randomUUID();
export const secret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
export async function hash(value) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export const xml = (value) =>
  String(value ?? "")
    .replace(
      /[<>&"']/g,
      (c) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          '"': "&quot;",
          "'": "&apos;",
        })[c],
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
export function youtubeSource(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error("请输入完整的 YouTube 链接");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(
      u.hostname,
    )
  )
    throw new Error("仅支持 HTTPS YouTube 链接");
  const validVideo = (v) => /^[\w-]{11}$/.test(v || "");
  const video =
    u.hostname === "youtu.be"
      ? u.pathname.slice(1)
      : u.pathname === "/watch"
        ? u.searchParams.get("v")
        : /^\/(shorts|live)\//.test(u.pathname)
          ? u.pathname.split("/")[2]
          : null;
  if (validVideo(video))
    return { kind: "video", url: `https://www.youtube.com/watch?v=${video}` };
  if (
    u.pathname === "/playlist" &&
    /^[\w-]{10,100}$/.test(u.searchParams.get("list") || "")
  )
    return {
      kind: "playlist",
      url: `https://www.youtube.com/playlist?list=${u.searchParams.get("list")}`,
    };
  if (
    /^\/(channel\/UC[\w-]{22}|@[\p{L}\p{N}_.%-]{1,100})(\/(videos|streams))?\/?$/u.test(
      u.pathname,
    )
  )
    return {
      kind: "author",
      url: `https://www.youtube.com${u.pathname.replace(/\/(videos|streams)?\/?$/, "")}/${/\/streams\/?$/.test(u.pathname)?'streams':'videos'}`,
    };
  throw new Error("请使用视频、playlist、作者主页或作者直播列表链接");
}
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function requireValue(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}
export function makeFeed(channel, episodes, origin) {
  const base = `${origin}/media/${channel.feed_token}`;
  const serial = !["published_desc", "added_desc"].includes(channel.sort_mode);
  const info=JSON.parse(channel.rss_metadata||'{}');
  const artwork=info.image?`<itunes:image href="${xml(info.image)}"/><image><url>${xml(info.image)}</url><title>${xml(channel.title)}</title><link>${xml(origin)}</link></image>`:'';
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>${xml(channel.title)}</title><description>${xml(channel.description || channel.title)}</description><link>${xml(origin)}</link><language>${xml(channel.rss_language||'zh-CN')}</language>${info.author?`<itunes:author>${xml(info.author)}</itunes:author>`:''}${artwork}${info.category?`<itunes:category text="${xml(info.category)}"/>`:''}<itunes:type>${serial ? "serial" : "episodic"}</itunes:type><itunes:explicit>${info.explicit?'true':'false'}</itunes:explicit><atom:link href="${xml(`${origin}/feed/${channel.feed_token}.xml`)}" rel="self" type="application/rss+xml"/>${episodes.map((e, i) => {
    const meta=JSON.parse(e.metadata||'{}');
    const chapters=meta.chapters||[];
    const stamp=seconds=>`${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
    const original=`https://www.youtube.com/watch?v=${e.video_id}`;
    const chapterText=chapters.map(c=>`${stamp(c.startTime)} ${c.title}`).join('\n');
    // Keep timecodes in a single contiguous block instead of separated paragraphs.
    const description=[chapterText,meta.description||e.title,meta.author,original].filter(Boolean).join('\n\n');
    const html=`<p>${xml(description).replace(/\n/g,'<br/>')}</p>`;
    return `<item><title>${xml(e.title)}</title><guid isPermaLink="false">${xml(e.id)}</guid><link>${xml(original)}</link><description>${xml(description)}</description><content:encoded>${xml(html)}</content:encoded>${meta.author?`<itunes:author>${xml(meta.author)}</itunes:author>`:''}${meta.thumbnail?`<itunes:image href="${xml(meta.thumbnail)}"/>`:''}${chapters.length?`<podcast:chapters url="${xml(`${origin}/chapters/${channel.feed_token}/${e.id}.json`)}" type="application/json+chapters"/>`:''}<pubDate>${new Date((e.published_at ?? e.created_at) * 1000).toUTCString()}</pubDate>${serial ? `<itunes:episode>${i + 1}</itunes:episode>` : ""}<enclosure url="${xml(`${base}/${e.id}.${audioMedia(e).extension}`)}" length="${e.size}" type="${audioMedia(e).mime}"/><itunes:duration>${e.duration}</itunes:duration></item>`;
  }).join('')}</channel></rss>`;
}
