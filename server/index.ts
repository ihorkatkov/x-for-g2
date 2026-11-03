import { createServer as httpServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendError, messages } from './errors.ts';
import {PairingStore} from './pairing.ts';
import {Photos} from './photos.ts';
import { DemoTimeline } from './demo.ts';
import { TimelineTransport, type Feed, type Fetcher } from './transport.ts';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
export interface ServerOptions {
  env?: NodeJS.ProcessEnv; fetcher?: Fetcher; now?: () => number;
  distDir?: string;
}
function config(env: NodeJS.ProcessEnv) {
  const mode = env.REED_MODE ?? 'live';
  if (mode !== 'demo' && mode !== 'live') throw new Error('REED_MODE must be demo or live');
  const host = env.REED_HOST ?? '127.0.0.1', port = Number(env.REED_PORT ?? 4040);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid REED_PORT');
  const remote = env.REED_REMOTE === '1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Backend must stay on loopback; use a protected HTTPS reverse proxy');
  const origin = env.REED_ORIGIN ?? `http://${host === '::1' ? '[::1]' : host}:${port}`;
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('REED_ORIGIN must be an exact origin');
  if (!remote && (url.protocol !== 'http:' || url.hostname !== (host === '::1' ? '[::1]' : host) || Number(url.port || 80) !== port)) throw new Error('Local origin must match binding');
  const access = env.REED_ACCESS_TOKEN ?? '';
  const tailnetUser=env.REED_TAILSCALE_USER??'';
  if(tailnetUser&&(!remote||tailnetUser.length>200||!/^\S+@[^\s@]+$/.test(tailnetUser)||!url.hostname.endsWith('.ts.net')))throw new Error('Invalid private Tailscale service configuration');
  if(tailnetUser&&access)throw new Error('Choose one remote authentication mode');
  if (remote && (url.protocol !== 'https:' || !tailnetUser&&!/^[A-Za-z0-9_-]{32,256}$/.test(access))) throw new Error('Remote mode requires HTTPS origin and strong REED_ACCESS_TOKEN');
  const auth = env.AUTH_TOKEN ?? '', ct0 = env.CT0 ?? '';
  for (const value of [auth, ct0]) if (value && !/^[A-Za-z0-9_%.-]{1,4096}$/.test(value)) throw new Error('Invalid private credential format');
  if (Boolean(auth) !== Boolean(ct0)) throw new Error('Set both AUTH_TOKEN and CT0 or neither');
  const homeId = env.REED_HOME_QUERY_ID, latestId = env.REED_LATEST_QUERY_ID;
  if (Boolean(homeId) !== Boolean(latestId) || [homeId, latestId].some(id => id !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(id))) throw new Error('Set both valid Reed query IDs or neither');
  const queryIds = homeId && latestId ? { HomeTimeline: homeId, HomeLatestTimeline: latestId } : {};
  const queryFormat=env.REED_QUERY_FORMAT??'relay';
  if(queryFormat!=='legacy'&&queryFormat!=='relay')throw new Error('Invalid REED_QUERY_FORMAT');
  return { mode, host, port, origin, authority: url.host, remote, access, tailnetUser, auth, ct0, queryIds, queryFormat, configured: Boolean(auth && ct0) } as const;
}
function packagedOrigin(origin:string){
 if(origin==='null')return true;
 try{const u=new URL(origin);return u.origin===origin&&['http:','https:'].includes(u.protocol)&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)}catch{return false}
}
const equal = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** HTTP entry: validates access and query inputs; delegates X workflow to transport.
 * Serves built assets only, never source/environment files. Factory opens no listener.
 * Explicit demo fixture is loaded on demand, with no network calls or live fallback.
 */
export function createServer(options: ServerOptions = {}): Server {
  const env = options.env ?? process.env, cfg = config(env), now = options.now ?? Date.now;
  // A one-way session namespace, never an authorization credential. It remains
  // stable across restarts but changes when the configured X session changes.
  const scope = cfg.mode==='demo'?'demo-v1':createHash('sha256').update('reed-cache-v2\0').update(cfg.auth).update('\0').update(cfg.ct0).digest('hex').slice(0,32);
  const transport = new TimelineTransport(cfg.auth, cfg.ct0, options.fetcher, now, cfg.queryIds, cfg.queryFormat);
  const cursors = new Map<string, { feed: Feed; upstream: string; until: number }>();
  const demo = new DemoTimeline();
  const pairing=cfg.tailnetUser?new PairingStore(env.REED_PAIRING_FILE??resolve(appRoot,'.local/beta-pairing.json'),now):null;
  const photos = new Photos(options.fetcher,createHash('sha256').update('x-photo-v1\0').update(cfg.auth).update('\0').update(cfg.ct0).digest());
  const dist = resolve(options.distDir ?? resolve(appRoot, 'dist'));
  let active = 0;
  const server = httpServer({ maxHeaderSize: 8192, requestTimeout: 20_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    let counted = false;
    const json = (status: number, body: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const origin=req.headers.origin;
      const originAllowed=origin===undefined||origin===cfg.origin||Boolean(cfg.tailnetUser&&origin!==undefined&&packagedOrigin(origin));
      if(req.headers.host!==cfg.authority||!originAllowed||req.headers['sec-fetch-site']==='cross-site'&&!cfg.tailnetUser)throw new BackendError('forbidden',403);
      // Incidental host-scoped cookies can come from other loopback ports.
      // Ignore them entirely: only private server configuration authenticates X.
      // No request headers are ever forwarded to the X transport.
      delete req.headers.cookie;
      if(cfg.remote){
        if(cfg.tailnetUser){
          // Listener stays loopback-only. Tailscale Serve strips caller identity
          // headers, then supplies the authenticated tailnet user over this hop.
          if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')||req.headers['tailscale-user-login']!==cfg.tailnetUser)throw new BackendError('forbidden',403);
        }else if(!equal(req.headers.authorization??'',`Bearer ${cfg.access}`))throw new BackendError('forbidden',403);
      }
      if(!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.length>4096)throw new BackendError('invalid_request',400);
      const url=new URL(req.url,cfg.origin);
      if(url.origin!==cfg.origin)throw new BackendError('invalid_request',400);
      if(cfg.tailnetUser&&origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Max-Age','600')}
      if(cfg.tailnetUser&&req.method==='OPTIONS'){
        if(!['GET','POST'].includes(String(req.headers['access-control-request-method']))||String(req.headers['access-control-request-headers']??'').split(',').some(h=>h.trim()&&!/^(?:content-type|authorization)$/i.test(h.trim()))||req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0)throw new BackendError('invalid_request',400);
        if(!url.pathname.startsWith('/api/')||req.headers['access-control-request-method']==='POST'&&(url.pathname!=='/api/pair'||url.search))throw new BackendError('invalid_request',400);
        res.writeHead(204);res.end();return;
      }
      if(pairing&&req.method==='POST'&&url.pathname==='/api/pair'&&!url.search){
        if(req.headers['content-type']?.split(';')[0]!=='application/json'||Number(req.headers['content-length']??0)>256)throw new BackendError('invalid_request',400);
        const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>256)throw new BackendError('invalid_request',400);chunks.push(chunk)}
        let input:unknown;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new BackendError('invalid_request',400)}
        if(!input||typeof input!=='object'||Object.keys(input).length!==1||!('code' in input)||typeof input.code!=='string')throw new BackendError('invalid_request',400);
        const token=await pairing.pair(input.code);json(200,{token});return;
      }
      if(pairing&&url.pathname.startsWith('/api/')&&!await pairing.authorized(req.headers.authorization))throw new BackendError('pairing_required',401);
      if (!cfg.remote && req.headers.authorization !== undefined) throw new BackendError('forbidden', 403);
      if (req.method !== 'GET' || req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) throw new BackendError('invalid_request', 400);
      if (active >= 8) throw new BackendError('busy', 503, 1);
      active++; counted = true;
      if (url.pathname === '/api/status') {
        if (url.search) throw new BackendError('invalid_request', 400);
        json(200, { mode: cfg.mode, configured: cfg.configured, scope });
      } else if (url.pathname.startsWith('/api/image/')) {
        if(url.search||!/^\/api\/image\/[A-Za-z0-9_-]{20,667}\.[A-Za-z0-9_-]{43}$/.test(url.pathname))throw new BackendError('invalid_request',400);
        const image=await photos.load(url.pathname.slice(11));res.writeHead(200,{'Content-Type':image.type});res.end(image.body);
      } else if (url.pathname === '/api/feed') {
        if ([...url.searchParams.keys()].some(k => !['feed', 'cursor'].includes(k)) || url.searchParams.getAll('feed').length !== 1 || url.searchParams.getAll('cursor').length > 1) throw new BackendError('invalid_request', 400);
        const feed = url.searchParams.get('feed');
        if (feed !== 'for-you' && feed !== 'following') throw new BackendError('invalid_request', 400);
        for (const [key, value] of cursors) if (value.until <= now()) cursors.delete(key);
        const token = url.searchParams.get('cursor');
        if (token !== null && !/^[A-Za-z0-9_-]{32}$/.test(token)) throw new BackendError('invalid_request', 400);
        const saved = token ? cursors.get(token) : undefined;
        if (token && (!saved || saved.feed !== feed)) throw new BackendError('cursor_expired', 410);
        let result;
        if (cfg.mode === 'demo') {
          const fixture = resolve(env.REED_FIXTURE_PATH ?? fileURLToPath(new URL('fixtures/demo.json', import.meta.url)));
          result = await demo.feed(fixture, feed, saved?.upstream);
        } else {
          if (!cfg.configured) throw new BackendError('not_configured', 503);
          result = await transport.feed(feed, saved?.upstream);
        }
        let cursor: string | null = null;
        if (result.cursor && result.cursor !== saved?.upstream) {
          if (cursors.size >= 128) cursors.delete(cursors.keys().next().value!);
          cursor = randomBytes(24).toString('base64url');
          cursors.set(cursor, { feed, upstream: result.cursor, until: now() + 10 * 60_000 });
        }
        // Demo image is an explicit local sample; live URLs become session-signed handles.
        const posts=result.posts.map(p=>({...p,...(p.images?{images:p.images.map(image=>({...('kind' in image&&image.kind?{kind:image.kind}:{}),alt:image.alt,url:cfg.mode==='demo'?'/demo-earthrise.jpg':photos.register(image.url)}))}:{})}));
        json(200, { posts, cursor, mode: cfg.mode, scope });
      } else {
        if (url.pathname.startsWith('/api/')) throw new BackendError('not_found', 404);
        let pathname: string;
        try { pathname = decodeURIComponent(url.pathname); }
        catch { throw new BackendError('invalid_request', 400); }
        if (pathname.split('/').some(p => p.startsWith('.')) || pathname.includes('\\') || pathname.includes('\0')) throw new BackendError('not_found', 404);
        let file: string;
        try { file = await realpath(resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)); }
        catch { throw new BackendError('not_found', 404); }
        const root = await realpath(dist);
        if (!file.startsWith(root + sep)) throw new BackendError('not_found', 404);
        const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
        const type = types[extname(file)];
        if (!type) throw new BackendError('not_found', 404);
        const info = await stat(file);
        if (!info.isFile() || info.size > 8_000_000) throw new BackendError('not_found', 404);
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': type }); res.end(body);
      }
    } catch (error) {
      const safe = error instanceof BackendError ? error : new BackendError('internal', 500);
      if (safe.retryAfter) res.setHeader('Retry-After', safe.retryAfter);
      json(safe.status, { error: safe.code, message: messages[safe.code] ?? messages.internal, ...(safe.retryAfter ? { retryAfter: safe.retryAfter } : {}) });
    } finally { if (counted) active--; }
  });
  server.maxConnections = 32;
  server.keepAliveTimeout = 5000;
  return server;
}

export async function start(options: ServerOptions = {}): Promise<Server> {
  const cfg = config(options.env ?? process.env), server = createServer(options);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); }); });
  return server;
}
