# Development

Node24 and npm are the baseline. SDK0.0.16, CLI0.2.0, simulator0.9.5 and pretext0.1.4
are exact pins. The repository has no parent-workspace dependency.

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Phone companion and SDK adapter |
| `src/model.ts`, `reader.ts` | Validation, measured pagination, feeds and bounded cache |
| `src/photo.ts` | Grayscale/tiles, gallery and automatic attachment state |
| `src/service.ts` | Explicit service URL and runtime device authentication |
| `src/telemetry.ts` | Bounded local numeric/boolean diagnostics |
| `server/` | HTTP, X discovery/transport/normalization, image proxy and pairing |
| `config/glasses.ts` | Public endpoint validation for build/manifest |
| `tests/` | Controlled fixtures, HTTP boundaries and state/race regressions |
| `scripts/` | Pairing, manifest generation and opt-in simulator/live checks |

## Local checks

```sh
npm ci
npm test
npm run build
X_SERVICE_ORIGIN=https://reader.example.ts.net:8449 npm run build:glasses
npm run pack
```

The example hostname is for build validation, not a reachable service. Use your own
endpoint for a real installation. Packing needs no Even Hub login; uploading does.

## Simulator

Run the production demo server and simulator, then `npm run test:simulator`.
The harness refuses live mode. Image and feed harnesses are available as
`npm run test:images` and `node scripts/simulator-feeds.mjs`. Use a freshly started
demo for the feed harness: the refresh arrival is shared per server/feed and can
already have been consumed by another browser. Generated captures go to ignored
`artifacts/`, including RGBA originals and black-composited previews.

For an isolated port pair:

```sh
REED_PORT=4050 npm run demo
npm exec -- evenhub-simulator http://127.0.0.1:4050/ --automation-port 9905
X_READER_URL=http://127.0.0.1:4050 X_SIM_URL=http://127.0.0.1:9905 npm run test:simulator
```

On Windows, set environment variables using your shell's syntax. The default npm
commands work without inline environment assignments.

The native skip/bookmark demo check is:

```sh
node scripts/simulator-bookmarks.mjs
```

It refuses live mode. It skips unread pages, bookmarks a fixture, verifies
post-bound confirmation, and checks that the footer stays empty.

## Optional live validation

Start a local live backend with your authorized session first. Then explicitly opt in:

```sh
X_ALLOW_LIVE=1 node scripts/live-feed-test.mjs
```

This read-only provider check targets the local API by default. It does not perform
device pairing against a remote beta. Its generated report omits post text, handles,
IDs, cursors and image URLs. Never commit real feed screenshots or session files.
The ordinary unit suite and CI need no account and never execute live checks.

## Rendering contract

The canvas is576×288. Keep app/status information in the header, compact logo left,
page count right, user content below and no footer chrome. Native text is measured;
images are explicit stills, with complete text/alt access on return. Serialize all
bridge and storage operations, and create one startup page per WebView boot.
Use the actual installed SDK declarations over copied examples. Do not import
background-state APIs absent from0.0.16. Image acceptance is not a visible frame.
