import { BackendError } from './errors.ts';
import { features } from './features.ts';
import { normalizeTimeline, obj } from './normalize.ts';

export type Feed = 'for-you' | 'following';
export type Fetcher = typeof fetch;
export type QueryIds = Partial<Record<'HomeTimeline' | 'HomeLatestTimeline', string>>;
const operations = { 'for-you': 'HomeTimeline', following: 'HomeLatestTimeline' } as const;
// Public X web-client application bearer, not a user credential (bird-search reference).
const bearer = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export {boundedText} from './bytes.ts';
import {boundedText} from './bytes.ts';
import {discoverQueries,relayProviders,type Queries} from './discovery.ts';

/** Owns read-only X workflow, query discovery/cache and account-wide cooldown.
 * Credentials are trusted validated server configuration; feed/cursor are entry-validated.
 * Only GETs fixed X/CDN URLs; does not read local sessions, persist data or log payloads.
 */
export class TimelineTransport {
  private queries: Queries = {};
  private idsUntil = 0;
  private cooldown = 0;
  private terminal: 'expired' | 'blocked' | undefined;
  private running = false;
  constructor(private auth: string, private ct0: string, private fetcher: Fetcher = fetch, private now = Date.now, private queryIds: QueryIds = {}, private queryFormat:'legacy'|'relay'='legacy') {}

  private async get(url: string, signal: AbortSignal, authenticated = false) {
    return this.fetcher(url, { method: 'GET', redirect: 'error', signal, headers: {
      'user-agent': 'Mozilla/5.0', accept: authenticated ? 'application/json' : '*/*',
      ...(authenticated ? { authorization: `Bearer ${bearer}`, cookie: `auth_token=${this.auth}; ct0=${this.ct0}`,
        'x-csrf-token': this.ct0, 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes', 'x-twitter-client-language': 'en' } : {}),
    } });
  }
  private async discover(signal: AbortSignal, force: boolean) {
    if (!force && this.idsUntil > this.now()) return;
    this.queries = {};
    this.idsUntil = 0;
    if (this.queryIds.HomeTimeline && this.queryIds.HomeLatestTimeline) {
      for (const name of ['HomeTimeline','HomeLatestTimeline'] as const) this.queries[name]={id:this.queryIds[name]!,name:this.queryFormat==='relay'?`${name}Query`:name,format:this.queryFormat,providers:this.queryFormat==='relay'?relayProviders():{}};
    } else {
      this.queries=await discoverQueries((url,signal)=>this.get(url,signal),signal);
    }
    this.idsUntil = this.now() + 3_600_000;
  }
  private failStatus(response: Response) {
    if (response.status === 401) { this.terminal = 'expired'; throw new BackendError('expired', 401); }
    if (response.status === 403) { this.terminal = 'blocked'; throw new BackendError('blocked', 403); }
    if (response.status === 429) {
      const after = response.headers.get('retry-after');
      const seconds = after && /^\d+$/.test(after) ? Number(after) : after ? (Date.parse(after) - this.now()) / 1000 : NaN;
      const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000;
      const wait = Math.min(3600, Math.max(30, Math.ceil(Number.isFinite(seconds) ? seconds : reset > this.now() ? (reset - this.now()) / 1000 : 60)));
      this.cooldown = this.now() + wait * 1000;
      throw new BackendError('rate_limited', 429, wait);
    }
    if (!response.ok) throw new BackendError('upstream_unavailable');
  }
  async feed(feed: Feed, cursor?: string) {
    if (this.terminal) throw new BackendError(this.terminal, this.terminal === 'expired' ? 401 : 403);
    if (this.now() < this.cooldown) throw new BackendError('rate_limited', 429, Math.ceil((this.cooldown - this.now()) / 1000));
    if (this.running) throw new BackendError('busy', 503, 1);
    this.running = true;
    const signal = AbortSignal.timeout(15_000);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.discover(signal, attempt > 0);
        const operation = operations[feed];
        const query=this.queries[operation];if(!query)throw new BackendError('upstream_changed');
        const variables = query.format==='relay'
          ? {count:20,requestContext:cursor?'scroll':'launch',...(cursor?{cursor}:{}),...(feed==='following'?{enableRanking:false}:{}),...query.providers}
          : {count:20,includePromotedContent:false,latestControlAvailable:true,requestContext:'launch',withCommunity:true,...(cursor?{cursor}:{})};
        const params = new URLSearchParams({ variables: JSON.stringify(variables),...(query.format==='legacy'?{features:JSON.stringify(features)}:{}) });
        const response = await this.get(`${query.format==='relay'?'https://api.x.com/graphql':'https://x.com/i/api/graphql'}/${query.id}/${query.name}?${params}`, signal, true);
        if (response.status === 404) { await response.body?.cancel(); if (!attempt) continue; throw new BackendError('upstream_changed'); }
        if (!response.ok) { await response.body?.cancel(); this.failStatus(response); }
        let data: unknown;
        try { data = JSON.parse(await boundedText(response, 2_000_000)); }
        catch (error) { if (error instanceof BackendError) throw error; throw new BackendError('upstream_changed'); }
        const errors = obj(data).errors;
        if (Array.isArray(errors) && errors.length) {
          const codes = errors.map(e => obj(e).code);
          if (codes.includes(32) || codes.includes(89) || codes.includes(215)) { this.terminal = 'expired'; throw new BackendError('expired', 401); }
          if (codes.includes(88)) { this.cooldown = this.now() + 60_000; throw new BackendError('rate_limited', 429, 60); }
          if (codes.includes(326) || codes.includes(64)) { this.terminal = 'blocked'; throw new BackendError('blocked', 403); }
          if (!attempt && errors.some(e => /query:\s*unspecified/i.test(String(obj(e).message)))) continue;
          throw new BackendError('upstream_changed');
        }
        const result = normalizeTimeline(data);
        if (!result) throw new BackendError('upstream_changed');
        return result;
      }
      throw new BackendError('upstream_changed');
    } catch (error) {
      // Discovery/schema/network failures also receive a short cooldown; never silently use fixtures.
      if (!(error instanceof BackendError) || !['expired', 'blocked', 'rate_limited'].includes(error.code)) this.cooldown = this.now() + 30_000;
      if (error instanceof BackendError) throw error;
      throw new BackendError('upstream_unavailable');
    } finally { this.running = false; }
  }
}
