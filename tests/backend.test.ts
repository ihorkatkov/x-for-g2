import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer, type ServerOptions } from '../server/index.ts';
import { normalizeTimeline, MAX_POST_TEXT } from '../server/normalize.ts';
import { TimelineTransport, boundedText, type Fetcher } from '../server/transport.ts';

const tweet = (id = '1', body = 'Original &amp; full text') => ({ rest_id: id,
  core: { user_results: { result: { legacy: { name: 'Writer', screen_name: 'writer' } } } },
  legacy: { full_text: body, created_at: '2026-11-01T12:00:00Z' } });
const entry = (result: unknown) => ({ content: { itemContent: { tweet_results: { result } } } });
const timeline = (entries: unknown[] = [entry(tweet())], cursor?: string) => ({ data: { home: { home_timeline_urt: { instructions: [{ entries: [...entries, ...(cursor ? [{ content: { cursorType: 'Bottom', value: cursor } }] : [])] }] } } } });
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const ids = { HomeTimeline: 'home-id', HomeLatestTimeline: 'latest-id' };
const liveEnv = { REED_MODE: 'live', REED_QUERY_FORMAT:'legacy', AUTH_TOKEN: 'private-auth', CT0: 'private-csrf', REED_HOME_QUERY_ID: ids.HomeTimeline, REED_LATEST_QUERY_ID: ids.HomeLatestTimeline };
async function listening(options: ServerOptions = {}) {
  const server = createServer({ env: { REED_MODE: 'demo' }, ...options });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function http(server: Server, path: string, headers: Record<string, string> = {}, method = 'GET') {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string; body: () => any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method, headers: { Host: '127.0.0.1:4040', ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, headers: res.headers, text, body: () => JSON.parse(text) }); });
    });
    req.on('error', reject); req.end();
  });
}

test('main.ts import is side-effect free and CLI binds a real demo HTTP server', { timeout: 10000 }, async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const imported = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await import('./server/main.ts'); console.log('imported')"], { cwd, timeout: 5000 });
  assert.equal(imported.stdout.trim(), 'imported'); assert.equal(imported.stderr, '');
  const reservation = await listening();
  const address = reservation.address(); assert.ok(address && typeof address === 'object');
  const port = address.port; await close(reservation);
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], { cwd,
    env: { ...process.env, REED_MODE: 'demo', REED_HOST: '127.0.0.1', REED_PORT: String(port), REED_REMOTE: '0',
      REED_ORIGIN: `http://127.0.0.1:${port}`, AUTH_TOKEN: '', CT0: '', REED_HOME_QUERY_ID: undefined, REED_LATEST_QUERY_ID: undefined } });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('CLI did not become ready')), 5000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('X backend ready')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`CLI exited ${code}: ${errors}`)); });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { mode: 'demo', configured: false, scope: 'demo-v1' });
    assert.equal(errors, ''); assert.equal(output.trim(), 'X backend ready (no private values logged).');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM'); await exited;
    }
  }
});

test('normalizer preserves long notes, quoted notes, repost attribution and decodes text once', () => {
  const original = { ...tweet(), note_tweet: { note_tweet_results: { result: { text: 'L'.repeat(25000) + ' &lt;b&gt; &amp;lt; &#x1f642;' } } },
    quoted_status_result: { result: { ...tweet('2'), note_tweet: { note_tweet_results: { result: { text: 'quoted &quot;text&quot; &#39;x&#39;' } } } } } };
  const repost = { ...tweet('3'), legacy: { ...tweet('3').legacy, retweeted_status_result: { result: original } } };
  const result = normalizeTimeline(timeline([entry(repost), entry(original)]));
  assert.equal(result?.posts.length, 1);
  assert.equal(result?.posts[0].text, 'L'.repeat(25000) + ' <b> &lt; 🙂');
  assert.equal(result?.posts[0].quote?.text, 'quoted "text" \'x\'');
  assert.equal(result?.posts[0].repostedBy, 'Writer');
  assert.equal(result?.posts[0].url, 'https://x.com/writer/status/1');
});
test('normalizer rejects oversized or malformed notes instead of legacy fallback', () => {
  for (const text of ['x'.repeat(MAX_POST_TEXT + 1), '', null]) {
    assert.throws(() => normalizeTimeline(timeline([entry({ ...tweet(), note_tweet: { note_tweet_results: { result: { text } } } })])), /upstream_changed/);
  }
  assert.throws(() => normalizeTimeline(timeline([entry(tweet('1', 'x'.repeat(MAX_POST_TEXT + 1)))])), /upstream_changed/);
});
test('normalizer bounds batches, filters replies/promotions and handles modules and cursor', () => {
  const reply = { ...tweet('90'), legacy: { ...tweet().legacy, in_reply_to_status_id_str: '1' } };
  const promoted = { entryId: 'promoted-1', ...entry(tweet('91')) };
  const module = { content: { items: [{ item: { itemContent: { tweet_results: { result: tweet('92') } } } }] } };
  const result = normalizeTimeline(timeline([entry(reply), promoted, module, ...Array.from({ length: 40 }, (_, i) => entry(tweet(String(i + 1))))], 'secret-cursor'));
  assert.equal(result?.posts.length, 30); assert.equal(result?.posts[0].id, '92'); assert.equal(result?.cursor, 'secret-cursor');
  assert.equal(normalizeTimeline({}), null);
  assert.deepEqual(normalizeTimeline(timeline([])), { posts: [], cursor: null });
});
test('bounded reader rejects declared and streamed oversize', async () => {
  await assert.rejects(boundedText(new Response('small', { headers: { 'content-length': '100' } }), 10), /upstream_changed/);
  await assert.rejects(boundedText(new Response('a'.repeat(20)), 10), /upstream_changed/);
  assert.equal(await boundedText(new Response('🙂'), 4), '🙂');
});
test('pinned query IDs skip discovery; both feeds carry only server credentials and cursor', async () => {
  const calls: URL[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('cookie'), 'auth_token=private-auth; ct0=private-csrf');
    assert.equal(headers.get('x-csrf-token'), 'private-csrf');
    return json(timeline(undefined, 'next'));
  };
  const transport = new TimelineTransport('private-auth', 'private-csrf', fetcher, Date.now, ids);
  await transport.feed('for-you'); await transport.feed('following', 'prior');
  assert.equal(calls[0].pathname, '/i/api/graphql/home-id/HomeTimeline');
  assert.equal(calls[1].pathname, '/i/api/graphql/latest-id/HomeLatestTimeline');
  assert.equal(JSON.parse(calls[1].searchParams.get('variables')!).cursor, 'prior');
});
test('legacy discovery is cached, never sends credentials to public assets and retries stale IDs once', async () => {
  let discoveries = 0, feeds = 0;
  const fetcher: Fetcher = async (input, init) => {
    const url = String(input), headers = new Headers(init?.headers);
    if (url.startsWith('https://x.com/?')) {
      discoveries++; assert.equal(headers.get('cookie'), null);
      return new Response('https://abs.twimg.com/responsive-web/client-web/main.js');
    }
    if (url.includes('abs.twimg.com')) {
      assert.equal(headers.get('authorization'), null);
      return new Response('queryId:"home-id",operationName:"HomeTimeline"; operationName:"HomeLatestTimeline",queryId:"latest-id"');
    }
    feeds++; return feeds === 1 ? json({}, 404) : json(timeline());
  };
  const transport = new TimelineTransport('a', 'b', fetcher);
  await transport.feed('for-you'); await transport.feed('following');
  assert.equal(discoveries, 2); assert.equal(feeds, 3);
});
test('modern discovery without recognized IDs fails explicitly with no demo fallback', async () => {
  let calls = 0;
  const transport = new TimelineTransport('a', 'b', async () => { calls++; return new Response('<script src="https://abs.twimg.com/x-web/startup.js"></script>'); });
  await assert.rejects(transport.feed('for-you'), /upstream_changed/);
  await assert.rejects(transport.feed('for-you'), /rate_limited/);
  assert.equal(calls, 1);
});
test('HTTP and GraphQL auth/block errors stop subsequent upstream calls', async () => {
  for (const [status, payload, error] of [[401, {}, 'expired'], [403, {}, 'blocked'], [200, { errors: [{ code: 89 }] }, 'expired'], [200, { errors: [{ code: 326 }] }, 'blocked']] as const) {
    let calls = 0;
    const transport = new TimelineTransport('a', 'b', async () => { calls++; return json(payload, status); }, Date.now, ids);
    await assert.rejects(transport.feed('for-you'), new RegExp(error));
    await assert.rejects(transport.feed('following'), new RegExp(error)); assert.equal(calls, 1);
  }
});
test('rate-limit retry-after and expiry are account-wide; network/schema errors cool down', async () => {
  let now = 1000, calls = 0;
  const transport = new TimelineTransport('a', 'b', async () => { calls++; return calls === 1 ? json({}, 429, { 'retry-after': '120' }) : json(timeline()); }, () => now, ids);
  await assert.rejects(transport.feed('for-you'), error => error instanceof Error && 'retryAfter' in error && error.retryAfter === 120);
  await assert.rejects(transport.feed('following'), /rate_limited/); assert.equal(calls, 1);
  now += 120000; await transport.feed('following'); assert.equal(calls, 2);
  for (const fetcher of [async () => { throw Error('private network detail'); }, async () => json({ unexpected: true })]) {
    const other = new TimelineTransport('a', 'b', fetcher, () => now, ids);
    await assert.rejects(other.feed('for-you'), /upstream_/); await assert.rejects(other.feed('following'), /rate_limited/);
  }
});
test('concurrent upstream requests fail busy rather than overlap', async () => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const transport = new TimelineTransport('a', 'b', async () => { await hold; return json(timeline()); }, Date.now, ids);
  const pending = transport.feed('for-you'); await assert.rejects(transport.feed('following'), /busy/);
  release(); await pending;
});
test('HTTP demo/status are explicit, bounded and make no upstream calls', async () => {
  const server = await listening({ fetcher: async () => { throw Error('must not fetch'); } });
  try {
    const status = await http(server, '/api/status'); assert.deepEqual(status.body(), { mode: 'demo', configured: false, scope: 'demo-v1' });
    const response = await http(server, '/api/feed?feed=for-you'); assert.equal(response.status, 200);
    assert.equal(response.body().mode, 'demo'); assert.match(response.body().cursor, /^[A-Za-z0-9_-]{32}$/); assert.equal(response.body().posts.length, 3);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.ok(response.headers['content-security-policy']);
    assert.equal((await http(server, '/api/feed?feed=following')).body().mode, 'demo');
  } finally { await close(server); }
});
test('HTTP entry rejects foreign hosts/origins, auth, bodies, methods and invalid queries', async () => {
  const server = await listening();
  try {
    const rejectedHeaders: Record<string, string>[] = [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { Authorization: 'Bearer no' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of rejectedHeaders) {
      assert.equal((await http(server, '/api/status', headers)).status, 403);
    }
    assert.equal((await http(server, '/api/status', {}, 'POST')).status, 400);
    assert.equal((await http(server, '/api/status', { 'Content-Length': '1' })).status, 400);
    for (const path of ['/api/feed', '/api/feed?feed=no', '/api/feed?feed=for-you&feed=following', '/api/feed?feed=following&unknown=x', '/api/feed?feed=following&cursor=bad', '/api/feed?feed=following&cursor=&cursor=', '/api/status?a=1', '//evil.example/api/status', '/%zz']) {
      assert.equal((await http(server, path)).status, 400, path);
    }
    assert.equal((await http(server, '/api/no')).status, 404);
  } finally { await close(server); }
});
test('HTTP live is the safe default and missing credentials do not fall back to demo', async () => {
  const server = await listening({ env: {} });
  try {
    const status=(await http(server, '/api/status')).body();assert.equal(status.mode,'live');assert.equal(status.configured,false);assert.match(status.scope,/^[a-f0-9]{32}$/);
    assert.equal((await http(server, '/api/feed?feed=for-you')).body().error, 'not_configured');
  } finally { await close(server); }
});
test('HTTP cursors are opaque, feed-bound, expire and prevent repeated upstream cursors', async () => {
  let now = 1000; const upstream: Array<string | undefined> = [];
  const server = await listening({ env: liveEnv, now: () => now, fetcher: async input => {
    upstream.push(JSON.parse(new URL(String(input)).searchParams.get('variables')!).cursor);
    return json(timeline(undefined, 'private-upstream-cursor'));
  } });
  try {
    const response = await http(server, '/api/feed?feed=for-you');
    assert.equal(response.status, 200); assert.equal(response.body().mode, 'live');
    const cursor = response.body().cursor; assert.match(cursor, /^[A-Za-z0-9_-]{32}$/); assert.ok(!response.text.includes('private-'));
    assert.equal((await http(server, `/api/feed?feed=following&cursor=${cursor}`)).status, 410);
    assert.equal((await http(server, `/api/feed?feed=for-you&cursor=${cursor}`)).body().cursor, null);
    assert.deepEqual(upstream, [undefined, 'private-upstream-cursor']);
    now += 600001;
    assert.equal((await http(server, `/api/feed?feed=for-you&cursor=${cursor}`)).status, 410);
  } finally { await close(server); }
});
test('HTTP upstream failures are sanitized with retry headers and never fixture success', async () => {
  const server = await listening({ env: liveEnv, fetcher: async () => json({}, 429, { 'retry-after': '65' }) });
  try {
    const response = await http(server, '/api/feed?feed=for-you');
    assert.equal(response.status, 429); assert.equal(response.headers['retry-after'], '65');
    assert.equal(response.body().error, 'rate_limited'); assert.equal(response.body().posts, undefined);
    assert.ok(!response.text.includes('private'));
  } finally { await close(server); }
});
test('remote binding requires explicit HTTPS, strong token and exact host/origin/access', async () => {
  for (const env of [{ REED_HOST: '0.0.0.0' }, {REED_REMOTE:'1', REED_HOST:'0.0.0.0', REED_ORIGIN:'https://reed.example.org',REED_ACCESS_TOKEN:'a'.repeat(32)}, { REED_REMOTE: '1' }, { AUTH_TOKEN: 'a' }, { AUTH_TOKEN: 'bad;cookie', CT0: 'b' }, { REED_HOME_QUERY_ID: 'a' }, { REED_HOME_QUERY_ID: 'bad/id', REED_LATEST_QUERY_ID: 'b' }, { REED_ORIGIN: 'http://localhost:4040' }, { REED_MODE: 'mock' }, {REED_QUERY_FORMAT:'unknown'}]) assert.throws(() => createServer({ env }));
  const token = 'a'.repeat(32);
  const server = await listening({ env: { REED_MODE: 'demo', REED_REMOTE: '1', REED_ORIGIN: 'https://reed.example.org', REED_ACCESS_TOKEN: token } });
  try {
    assert.equal((await http(server, '/api/status', { Host: 'reed.example.org' })).status, 403);
    assert.equal((await http(server, '/api/status', { Host: 'reed.example.org', Authorization: `Bearer ${token}`, Origin: 'https://reed.example.org' })).status, 200);
    assert.equal((await http(server, '/', { Host: 'reed.example.org', Authorization: `Bearer ${token}`, Origin: 'https://evil.example' })).status, 403);
  } finally { await close(server); }
});
test('static server exposes only bounded built assets, not hidden files or symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reed-http-'));
  const dist = join(root, 'dist'); await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<p>Reed</p>'); await writeFile(join(dist, '.env'), 'private-auth');
  await writeFile(join(root, 'outside.js'), 'private-auth'); await symlink(join(root, 'outside.js'), join(dist, 'escape.js'));
  const server = await listening({ distDir: dist });
  try {
    assert.equal((await http(server, '/')).text, '<p>Reed</p>');
    for (const path of ['/.env', '/%2eenv', '/escape.js', '/server/main.ts', '/%2e%2e/outside.js']) assert.equal((await http(server, path)).status, 404, path);
  } finally { await close(server); await rm(root, { recursive: true, force: true }); }
});

test('demo fixture pagination, long text, quote, repost and refresh are explicit and isolated', async () => {
 const server=await listening({fetcher:async()=>{throw Error('No live calls in demo')}});
 try {
  const first=(await http(server,'/api/feed?feed=for-you')).body();
  assert.ok(first.posts.some((p:any)=>p.text.length>700));assert.ok(first.posts.some((p:any)=>p.quote));
  const older=(await http(server,`/api/feed?feed=for-you&cursor=${first.cursor}`)).body();
  assert.equal(older.mode,'demo');assert.equal(older.cursor,null);assert.ok(older.posts.some((p:any)=>p.repostedBy));
  const refreshed=(await http(server,'/api/feed?feed=for-you')).body();assert.equal(refreshed.posts.length,4);
  const following=(await http(server,'/api/feed?feed=following')).body();assert.equal(following.posts.length,3);assert.notEqual(following.posts[0].id,first.posts[0].id,'Ranked demo and chronological demo should differ');
 } finally {await close(server)}
});

test('incidental loopback cookies are ignored, never used as X credentials',async()=>{
 const server=await listening({env:liveEnv,fetcher:async(_input,init)=>{
  assert.equal(new Headers(init?.headers).get('cookie'),'auth_token=private-auth; ct0=private-csrf');return json(timeline())
 }});
 try {assert.equal((await http(server,'/api/feed?feed=for-you',{Cookie:'auth_token=untrusted-client; _liveview=incidental'})).status,200)}finally{await close(server)}
});

test('private current Relay query overrides bypass discovery and select only fixed read-only operations',async()=>{
 const calls:string[]=[];
 const server=await listening({env:{...liveEnv,REED_QUERY_FORMAT:'relay'},fetcher:async input=>{
  const url=new URL(String(input));calls.push(url.href);assert.equal(url.origin,'https://api.x.com');assert.ok(url.pathname.endsWith('Query'));assert.equal(url.searchParams.has('features'),false);return json(timeline())
 }});
 try{assert.equal((await http(server,'/api/feed?feed=for-you')).status,200);assert.equal((await http(server,'/api/feed?feed=following')).status,200);assert.equal(calls.length,2)}finally{await close(server)}
});

test('session namespace is stable across restarts, changes with private session, and never exposes cookies',async()=>{
 const a=await listening({env:liveEnv}),b=await listening({env:liveEnv}),c=await listening({env:{...liveEnv,AUTH_TOKEN:'different-session'}});
 try{
  const one=(await http(a,'/api/status')).body(),two=(await http(b,'/api/status')).body(),other=(await http(c,'/api/status')).body();
  assert.match(one.scope,/^[a-f0-9]{32}$/);assert.equal(one.scope,two.scope);assert.notEqual(one.scope,other.scope);
  assert.ok(!JSON.stringify(one).includes(liveEnv.AUTH_TOKEN));assert.ok(!JSON.stringify(one).includes(liveEnv.CT0));
 }finally{await Promise.all([close(a),close(b),close(c)])}
});
test('text reader removes known media/quote permalinks and expands ordinary link labels without slicing Unicode',()=>{
 const q=tweet('2','Quoted text'),p=tweet('1','🌱 Read https://t.co/article then look https://t.co/media https://t.co/quote');
 const result=normalizeTimeline(timeline([entry({...p,quoted_status_result:{result:q},quoted_status_permalink:{url:'https://t.co/quote'},legacy:{...p.legacy,entities:{urls:[{url:'https://t.co/article',display_url:'example.org/read',expanded_url:'https://example.org/read'}],media:[{url:'https://t.co/media',type:'photo',media_url_https:'https://pbs.twimg.com/media/fixture.jpg'}]}}})]));
 assert.equal(result?.posts[0].text,'🌱 Read example.org/read then look');assert.equal(result?.posts[0].quote?.text,'Quoted text');
});
