# Configuration

Copy `.env.example` to `.env` and keep it private. Normal startup and beta startup
load `.env`; demo mode uses invented fixtures without loading session credentials.

| Variable | Purpose |
| --- | --- |
| `AUTH_TOKEN`, `CT0` | Authorized X session pair, backend only |
| `REED_MODE` | `live` by default; `demo` selects fixtures explicitly |
| `REED_HOST` | Loopback listener only, default `127.0.0.1` |
| `REED_PORT` | Local listener, default 4040; beta launcher defaults 4043 |
| `X_SERVICE_ORIGIN` | Public HTTPS origin used by the glasses build and beta launcher |
| `REED_ORIGIN` | Exact server origin; overrides `X_SERVICE_ORIGIN` at beta runtime |
| `REED_TAILSCALE_USER` | Exact Tailscale user login allowed through Serve |
| `REED_SESSION_ENV` | Optional explicit server-side session file; no unrelated configuration is read automatically |
| `REED_PAIRING_FILE` | Optional device-session hash file; defaults to `.local/beta-pairing.json` |
| `REED_HOME_QUERY_ID`, `REED_LATEST_QUERY_ID` | Optional paired public query-ID overrides if discovery changes |
| `REED_QUERY_FORMAT` | `relay` by default; `legacy` for old query overrides |

Keep `X_SERVICE_ORIGIN` in the shared `.env` so the glasses build and beta backend
use the same endpoint. The glasses build reads only this public setting. Vite
mode files can override it for a build, but the backend does not load those files;
if using an override, export the same value when starting `beta:server`. Generated
`app.glasses.json` is ignored and must match the packaged endpoint. No private
value should use a `VITE_` prefix.

Local `npm start` ignores the beta-only `REED_TAILSCALE_USER` unless advanced remote
mode is explicitly enabled. Use `X_SERVICE_ORIGIN` for the shared configuration;
`REED_ORIGIN` is an advanced runtime override and must match the selected server.

For another session file, leave the template credential values blank and set
`REED_SESSION_ENV` explicitly. Non-empty process credential values take precedence.
Changing or expiring the X session does not change the device pairing, but a changed
X account/session namespace invalidates old reading caches. Restart the backend
after replacing X credentials; blocked/expired upstream access is latched.

## Other reverse proxies

The core server also supports `REED_REMOTE=1` with an exact HTTPS `REED_ORIGIN` and
server-only `REED_ACCESS_TOKEN`. This is an advanced proxy integration, not the
paired Tailscale setup above. A trusted proxy authenticates its client, strips
incoming Authorization/Cookie headers, injects its backend bearer and keeps the
upstream loopback/private. Do not bundle that service bearer in the app. A custom
proxy also needs a deliberate packaged-client authentication/CORS design.

Do not configure both the generic proxy bearer and Tailscale authentication.
