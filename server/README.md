# Backend

Start with the [project README](../README.md), [configuration](../docs/CONFIGURATION.md)
and [security boundary](../SECURITY.md).

| Route | Purpose |
| --- | --- |
| `GET /api/status` | Live/demo mode, configuration and session cache namespace |
| `GET /api/feed?feed=for-you\|following[&cursor=...]` | Up to30 normalized posts and an opaque cursor |
| `GET /api/image/<signed-handle>` | Bounded JPEG/PNG download through the fixed CDN adapter |
| `POST /api/bookmark` | Explicit add-only save of a recently served original post, bound to the current account scope |
| `POST /api/pair` | One-use code → runtime device session, in Tailscale or explicit paired HTTPS mode |
| `OPTIONS /api/...` | Restricted packaged-client preflight in Tailscale or paired HTTPS mode |

All API reads in private Tailscale mode need the proxy identity and device bearer.
The pairing POST needs the proxy identity and laptop code. Bookmark writes require the same identity and device authentication as reads.
Static files are served from a confined build directory. Bookmark addition is the
only account mutation; there are no publishing, like or deletion routes.

`transport.ts` discovers current Relay home-feed queries through credential-free
public assets, with bounded traversal and legacy support. Only fixed-origin X
feed GETs and the explicit bookmark-add POST receive the server cookies. Bookmark
discovery is also public and credential-free. A dispatched mutation is never
automatically retried; only X confirmation or a duplicate-bookmark response counts
as saved. Auth/block errors latch, rate limits cool
down, schema/network failures are explicit and live failure never becomes demo.
`normalize.ts` validates notes, quotes, repost originals, modules and media; it
preserves full supported text instead of silently shortening it.

`photos.ts` issues HMAC-signed fixed-CDN handles that survive same-session service
restarts. Downloads reject redirects, unsupported MIME/magic and excessive bytes
or decoded dimensions. No incoming cookie or device bearer is sent to the CDN.
`pairing.ts` serializes code/session writes and stores hashes with expiry and
attempt bounds using an owner-readable file and atomic rename.

The HTTP entry parses the URL once for authorization and dispatch. Host, origin,
method, body, query and path constraints are enforced before provider calls.
Cursors are feed-bound, opaque, bounded and expire after ten minutes. Feed state
is capped and cached on the phone separately; this server is not a database or
multi-user hosted service. Tests inject fabricated responses and ephemeral ports.

For public HTTPS hosting, explicit paired mode requires a valid device bearer on
every API read/write without trusting any Tailscale header. See
[Linux/systemd hosting](../docs/SYSTEMD.md).
