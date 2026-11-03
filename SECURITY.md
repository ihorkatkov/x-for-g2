# Security

Do not put session values, pairing codes, device tokens or private feed content in
public issues. Report a vulnerability using this repository's **Security → Report
a vulnerability** feature where available, or privately contact the maintainer
through their GitHub profile. Include a minimal reproduction with fabricated data.

## Trust boundary

- X cookies stay on the backend. Only fixed-origin timeline GETs receive them.
- Image downloads use recognized fixed-CDN JPEG/PNG targets, bounded size/dimensions,
  no redirects and no provider credentials. Clients receive session-signed handles.
- The backend listens only on loopback. Tailscale Serve supplies the remote identity.
- Remote API reads require both that identity and a separately paired device bearer.
  Opaque/loopback WebView origins alone do not authenticate a client.
- One-use laptop codes last10minutes and lock after5wrong guesses. Device sessions
  expire after30days; only hashes are stored in an owner-readable file. The app
  stores its runtime session in SDK host storage (sessionStorage for browser preview).
- API authorization and routing use the same normalized URL pathname.
- Diagnostics exclude free text, provider credentials, codes and device tokens.

A hostile browser on an already authorized tailnet device can exhaust a pending
short code's attempts. This denies pairing temporarily, not existing sessions or
feed privacy; generate a new code locally to recover. The limit resists guessing.

Keep the backend computer and phone trusted. SDK reading caches contain feed text
and are not encrypted application storage. `.env` is ignored, not a security
boundary by itself: never bundle its secrets. This is a self-hosted beta, not a
multi-tenant authentication service.

Bookmark addition is an explicit account write, available only for a post recently
served by this backend and the current account scope. Private Tailscale writes
require both the proxy identity and paired-device bearer. JSON bodies are bounded
and validated. The server sends only a fixed bookmark-add operation to X;
uncertain writes are not retried automatically. Demo saves never contact X.
