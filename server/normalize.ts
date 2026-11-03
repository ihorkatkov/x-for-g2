import {photoURL} from './photos.ts';
import { BackendError } from './errors.ts';

export const MAX_POST_TEXT = 32000;
export const MAX_POSTS = 30;

export interface Post {
  id: string; author: string; handle: string; text: string; createdAt: string; url: string;
  quote?: { author: string; handle: string; text: string }; repostedBy?: string; repostedByHandle?: string; images?: {url:string;alt:string;kind?:'video-still'|'gif-still'}[];
}
// Untrusted JSON is narrowed at every access, never passed through to clients.
export function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
const str = (v: unknown, max = 30000): string => typeof v === 'string' && v.length <= max ? v : '';
function unwrap(value: unknown) {
  let r = obj(value);
  for (let i = 0; i < 3 && r.tweet; i++) r = obj(r.tweet);
  return r;
}
function author(r: Record<string, unknown>) {
  const result = obj(obj(obj(r.core).user_results).result),u=obj(result.user??result);
  const legacy = obj(u.legacy), core = obj(u.core);
  return { author: str(core.name ?? legacy.name, 200), handle: str(core.screen_name ?? legacy.screen_name, 30) };
}
/** Use the same validated, deduplicated media selection for text cleanup and
 * output. Unsupported or over-budget attachments keep their link readable. */
function mediaRecords(r:Record<string,unknown>){
 const legacy=obj(r.legacy),note=obj(obj(obj(r.note_tweet).note_tweet_results).result);
 const sets=[note.entity_set,obj(r.details).entities,legacy.entities,r.entities].map(obj);
 return [...(Array.isArray(r.media_entities2)?r.media_entities2.slice(0,20):[]),...(Array.isArray(obj(legacy.extended_entities).media)?(obj(legacy.extended_entities).media as unknown[]).slice(0,20):[]),...sets.flatMap(e=>Array.isArray(e.media)?e.media.slice(0,20):[])].map(obj)
  .filter(m=>['photo','video','animated_gif'].includes(String(m.type))&&photoURL(m.media_url_https))
  .filter((m,i,a)=>a.findIndex(n=>n.media_url_https===m.media_url_https)===i).slice(0,4);
}
/** Decode X's text entities once, never interpreting markup or recursively decoding. */
function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/gi, (entity: string, key: string) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? entity;
    const hex = key[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
}
function text(r: Record<string, unknown>) {
  const hasNote = r.note_tweet !== undefined && r.note_tweet !== null;
  const value = hasNote
    ? obj(obj(obj(r.note_tweet).note_tweet_results).result).text
    : obj(r.details).full_text ?? obj(r.legacy).full_text;
  if (hasNote && (typeof value !== 'string' || !value)) throw new BackendError('upstream_changed');
  // Reject the response instead of presenting a silently shortened long post or quote.
  if (typeof value === 'string' && value.length > MAX_POST_TEXT) throw new BackendError('upstream_changed');
  const original=str(value, MAX_POST_TEXT);let visible=original;
  const legacy=obj(r.legacy),detail=obj(r.details),note=obj(obj(obj(r.note_tweet).note_tweet_results).result);
  const sets=[note.entity_set,detail.entities,legacy.entities,r.entities].map(obj);
  const media=mediaRecords(r);
  for(const item of media){
    const m=obj(item),urls=[str(m.url,1000)];
    // Current Relay media has indices instead of a short URL. Handle UTF-16
    // and code-point indices defensively; remove only an exact t.co token.
    if(Array.isArray(m.indices)&&m.indices.length===2&&m.indices.every(n=>Number.isInteger(n)&&n>=0&&n<=MAX_POST_TEXT)){
      const [start,end]=m.indices as number[];urls.push(original.slice(start,end),Array.from(original).slice(start,end).join(''));
    }
    for(const url of urls)if(/^https:\/\/t\.co\/[A-Za-z0-9]+$/.test(url))visible=visible.split(url).join('');
  }
  const quoted=unwrap(obj(r.quoted_status_result??r.quoted_tweet_results).result),quoteId=str(quoted.rest_id??obj(quoted.legacy).id_str,30);
  const quoteBody=obj(obj(obj(quoted.note_tweet).note_tweet_results).result).text??obj(quoted.details).full_text??obj(quoted.legacy).full_text;
  const readableQuote=typeof quoteBody==='string'&&quoteBody.length>0&&Boolean(author(quoted).handle);
  const permalink=str(obj(r.quoted_status_permalink??legacy.quoted_status_permalink).url,1000);
  if(readableQuote&&/^https:\/\/t\.co\/[A-Za-z0-9]+$/.test(permalink))visible=visible.split(permalink).join('');
  const urls=[...sets.flatMap(e=>Array.isArray(e.urls)?e.urls.slice(0,100):[]),...(Array.isArray(r.url_entities)?r.url_entities.slice(0,100):[])];
  for(const item of urls){
    const e=obj(item),url=str(e.url,1000),expanded=str(e.expanded_url,2000),label=str(e.display_url,2000);
    if(!/^https:\/\/t\.co\/[A-Za-z0-9]+$/.test(url))continue;
    const isQuote=readableQuote&&quoteId&&new RegExp(`^https://(?:x|twitter)\\.com/[^/]+/status/${quoteId}(?:[/?#]|$)`).test(expanded);
    visible=visible.split(url).join(isQuote?'':label||expanded||url);
  }
  if(visible.length>MAX_POST_TEXT)throw new BackendError('upstream_changed');
  return decodeEntities(visible===original?visible:visible.trim());
}
function isReply(r:Record<string,unknown>){
  return [r.reply_to_results,r.reply_to_user_results].some(value=>{const v=obj(value);return Boolean(v.rest_id||obj(v.result).rest_id)})
}
function post(value: unknown): Post | null {
  const wrapper = unwrap(value), outer = obj(wrapper.legacy);
  const repostField=outer.retweeted_status_result??outer.retweeted_status_results;
  const isRepost=repostField!==undefined&&repostField!==null;
  const repost = obj(repostField).result;
  const r = isRepost ? unwrap(repost) : wrapper, legacy = obj(r.legacy);
  // A reposted reply is still a post explicitly placed in the home feed. Do
  // not fetch its conversation; only plain un-reposted replies are filtered.
  if (!isRepost&&(isReply(wrapper) || outer.in_reply_to_status_id_str || outer.in_reply_to_user_id_str)) return null;
  const id = str(r.rest_id ?? legacy.id_str, 30);
  const user = author(r), body = text(r);
  const createdMs=obj(r.details).created_at_ms;
  const date = typeof createdMs==='number'||typeof createdMs==='string'&&/^\d{1,16}$/.test(createdMs)?Number(createdMs):Date.parse(str(legacy.created_at,100));
  if (!/^\d{1,30}$/.test(id) || !/^[A-Za-z0-9_]{1,30}$/.test(user.handle) || !Number.isFinite(date)) return null;
  const result: Post = { id, ...user, text: body, createdAt: new Date(date).toISOString(), url: `https://x.com/${user.handle}/status/${id}` };
  const media=mediaRecords(r);
  const images=media.map(m=>({url:m.media_url_https as string,alt:str(m.ext_alt_text,2000),...(m.type==='video'?{kind:'video-still' as const}:m.type==='animated_gif'?{kind:'gif-still' as const}:{})})).filter((m,i,a)=>a.findIndex(n=>n.url===m.url)===i).slice(0,4);
  if(images.length)result.images=images;
  const q = unwrap(obj(r.quoted_status_result ?? r.quoted_tweet_results).result), qt = text(q), qa = author(q);
  if(!body&&!images.length&&!(qt&&qa.handle))return null;
  if (qt && qa.handle) result.quote = { ...qa, text: qt };
  if (isRepost){const who=author(wrapper);result.repostedBy=who.author||who.handle;if(/^[A-Za-z0-9_]{1,30}$/.test(who.handle))result.repostedByHandle=who.handle;}
  return result;
}
export function normalizeTimeline(value: unknown): { posts: Post[]; cursor: string | null } | null {
  const data=obj(obj(value).data);
  const home=obj(data.home??data.home_timeline??data.home_latest_timeline);
  const instructions = obj(home.home_timeline_urt).instructions;
  if (!Array.isArray(instructions) || instructions.length > 100) return null;
  const posts: Post[] = [], seen = new Map<string,Post>();
  let cursor: string | null = null;
  function item(value: unknown) {
    const c = obj(value);
    if ((c.promotedMetadata || c.promoted_metadata) || posts.length >= MAX_POSTS) return;
    const p = post(obj(c.tweet_results).result);
    if (p) {
      const original=seen.get(p.id);
      if(original){if(p.repostedBy&&!original.repostedBy){original.repostedBy=p.repostedBy;original.repostedByHandle=p.repostedByHandle;}return;}
      posts.push(p);seen.set(p.id,p);
    }
  }
  for (const instruction of instructions) {
    const ins = obj(instruction);
    const entries = Array.isArray(ins.entries) ? ins.entries : ins.entry ? [ins.entry] : [];
    for (const entry of entries.slice(0, 200)) {
      const e = obj(entry), c = obj(e.content);
      if (c.promotedMetadata || c.promoted_metadata || str(e.entryId ?? e.entry_id).includes('promoted')) continue;
      if ((c.cursorType ?? c.cursor_type) === 'Bottom' && typeof c.value === 'string' && c.value.length <= 2048) cursor = c.value;
      item(c.itemContent ?? c.content);
      if (Array.isArray(c.items)) for (const m of c.items.slice(0, 100)) item(obj(obj(m).item).itemContent ?? obj(obj(m).item).content);
    }
  }
  return { posts, cursor };
}
