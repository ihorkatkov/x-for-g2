# Contributing

Start with the demo and [Development](docs/DEVELOPMENT.md). Use Node24 and the exact
lockfile. Run tests and both builds before opening a pull request. A glasses build
needs a non-secret HTTPS service origin; a placeholder is fine for build-only checks.

Keep changes focused and describe the user-visible behavior and validation. Add
behavioral regression tests for feed/cursor races, pairing, authorization, image
cleanup or content loss. Do not assert hardware behavior from a mock or simulator.

Never attach credentials, device sessions or real feed data to issues/PRs. Use
invented fixtures for reproductions. Generated artifacts, .env, .local and .ehpk
files are ignored. Report security problems through [SECURITY.md](SECURITY.md).

Public source does not grant access to the maintainer's private beta/backend.
Fork publishers need their own package ID, endpoint, session and tester roster.
