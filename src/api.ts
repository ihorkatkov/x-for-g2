export class FeedError extends Error {
 constructor(readonly code:string,message:string,readonly retryAfter=0){super(message)}
}
/** Only approved error codes become UI text; never render arbitrary backend bodies. */
export function feedError(status:number,payload:unknown,retryHeader:string|null):FeedError {
 const value=payload&&typeof payload==='object'&&'error' in payload?payload.error:null
 const code=typeof value==='string'?value:''
 const messages:Record<string,string>={
  bookmark_failed:'X did not save the bookmark. Try again in X.',
  bookmark_unknown:'Bookmark result uncertain. Check X before retrying.',
  post_unavailable:'Refresh this post before bookmarking it.',
  pairing_required:'Pair this phone using the server pairing code in X setup.',
  cursor_expired:'Older-page cursor expired. Refresh to continue; your current reading stays pinned.',
  busy:'Another feed request is running. Try again shortly.',
  not_configured:'Live service needs private server setup. No X account is connected.',
  expired:'X session expired. Update private server configuration and restart.',
  blocked:'X blocked access. Check your account outside X.',
  forbidden:'Request denied. Check the exact server origin and protected access configuration.',
  upstream_changed:'X response format changed. Live feed unavailable; no demo fallback.',
  upstream_unavailable:'X is offline or timed out. Cached posts remain readable.'
 }
 if(code==='rate_limited'||status===429){
  const retry=Number(retryHeader),wait=Number.isFinite(retry)&&retry>0?Math.min(3600,Math.ceil(retry)):60
  return new FeedError('rate_limited',`Rate limited. Wait ${wait}s before refreshing. Cached posts remain readable.`,wait)
 }
 return new FeedError(code,messages[code]??`Feed unavailable (${status}). Retry or check private server setup.`)
}
