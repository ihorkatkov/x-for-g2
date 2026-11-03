# X for G2 development

This standalone repo contains a phone-hosted Even Hub app and a private Node backend.
Use Node24, `npm ci`, `npm test`, `npm run build`. `npm run build:glasses` needs an
operator-provided `X_SERVICE_ORIGIN`; `npm run pack` uses app.glasses.json and the
pinned SDK0.0.16 / CLI0.2.0. The generated manifest/builds are not source files.

Keep X credentials backend-only. Never commit .env, .local, generated artifacts,
paired-device sessions, real feed screenshots, private endpoint configs or .ehpk
files. Tests use fabricated data; live reads require explicit authorization and
`X_ALLOW_LIVE=1`. Only an explicit user action may add the currently read original post to X bookmarks.
No posting, likes, repost publishing, bookmark deletion or other account mutations.
Never automatically retry a dispatched bookmark write; uncertain results must say so.

G2 is576x288, with at most8 text/list and4 images. Startup succeeds numerically at0
and happens once per WebView boot. Exactly one text/list captures events. Give all
containers unique z-order values. Serialize host calls/storage; a timeout must
not unlock the queue. Images are at most288x144; acceptance is not visible pixels.
Native firmware fonts require measured pagination. Metadata belongs in the header,
page count upper-right, content below, no footer chrome. Keep accessible text and
image descriptions; auto-image boundaries return to the same text page.

Use public SDK exports only; no setBackgroundState/onBackgroundRestore in0.0.16.
Normalize zero enum fields only inside an existing event envelope. Root double-tap
uses shutDownPageContainer(1); keep listeners alive if the user cancels. Persist
validated state with SDK storage. Do not assume phone-lock/background execution.

API authorization and routing must share the same normalized URL. Private remote
reads require authenticated Tailscale identity AND a paired-device bearer; a null
origin alone is not authentication. Pair codes are one-use, time/attempt bounded,
and generated locally. Never log a code, bearer, provider cookie or post content.
Diagnostics are bounded numeric/boolean metrics. Keep fixture, live-provider,
simulator and user-reported physical evidence distinct.
