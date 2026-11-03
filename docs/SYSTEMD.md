# Always-on Linux backend

A Linux host can replace the laptop. Node 24 runs under systemd, with a dedicated
HTTPS proxy and paired-device authentication. The phone needs internet access;
Tailscale on the phone is optional in this mode. Keep the server awake and funded.
The existing laptop/Tailscale configuration remains supported separately.

## Layout

- `/opt/x-for-g2/releases/<commit>/`: root-owned release source, installed dependencies,
  `dist-glasses/`, and `runtime/node` (a stable Node 24 executable outside a home directory).
- `/opt/x-for-g2/current`: symlink to the selected release.
- `/etc/x-reader/service.env`: non-secret configuration from `deploy/systemd/service.env.example`.
- `/etc/x-reader/session.env`: root-only file containing only `AUTH_TOKEN` and `CT0`.
  systemd passes it through `LoadCredential`; it is never built into the client.
- `/var/lib/x-reader/pairing.json`: persistent device-session hashes, owned by `x-reader`.
- `/etc/x-reader-proxy/`: dedicated nginx configuration; the shared nginx service is untouched.

Create dedicated system users `x-reader` and `x-reader-proxy`. Install the two units from
`deploy/systemd/` into `/etc/systemd/system/`. Build and install dependencies before
switching the `current` symlink. Replace `reader.example.com` in all three nginx
example files with the exact service hostname; install them as `nginx.conf` and
`upstream.conf` under `/etc/x-reader-proxy/`. The proxy runs as `x-reader-proxy` on port
8403; the backend stays on loopback 4043. Publish only the proxy through your
hosting provider's HTTPS service. Keep port 8403 unpublished as a raw TCP
port and restrict it to the HTTPS front through the provider network or host
firewall. Never send a device bearer over a public plain HTTP connection. Do not expose the raw backend or generic service
bearers. Keep the session file mode 600 and its parent directory mode 700.

Build the glasses package with the same public origin:

```sh
X_SERVICE_ORIGIN=https://reader.example.com npm run build:glasses
npm run pack
```

After copying the source, dependencies and glasses assets to a release directory:

```sh
sudo install -d -o x-reader -g x-reader -m 750 /var/log/x-reader
sudo install -d -o x-reader-proxy -g x-reader-proxy -m 750 /var/log/x-reader-proxy
sudo systemctl daemon-reload
sudo systemctl enable --now x-reader.service x-reader-proxy.service
sudo systemctl is-active x-reader.service x-reader-proxy.service
sudo systemctl is-enabled x-reader.service x-reader-proxy.service
```

Install `deploy/systemd/logrotate.conf` as `/etc/logrotate.d/x-reader` and verify
the host logrotate timer is enabled. Service logs are kept under
`/var/log/x-reader/` and `/var/log/x-reader-proxy/` with seven rotated copies.
Use `systemctl status` and `sudo tail -n 30 /var/log/x-reader/service.log` for diagnosis.
The units restart failed processes. Confirm your host's auto-suspend, hibernate and
auto-delete settings are disabled; enabling a unit alone does not keep a VM awake.
On a shared VM, verify process restart without rebooting unrelated services.

## Pairing and migration

For a new phone, run pairing in an interactive SSH terminal as the service user:

```sh
sudo -u x-reader env REED_PAIRING_FILE=/var/lib/x-reader/pairing.json \
  /opt/x-for-g2/current/runtime/node --import /opt/x-for-g2/current/node_modules/tsx/dist/loader.mjs \
  /opt/x-for-g2/current/scripts/pair-device.ts
```

Enter the code only in the phone companion; never paste it into chat or issue logs.
Pair codes expire after ten minutes, are one-use and lock after five wrong attempts.
The proxy also limits pairing attempts. An attacker can exhaust a pending code;
existing paired devices remain valid. Generate a new code privately if necessary.

To migrate an existing phone, copy its backend's pairing file securely to
`/var/lib/x-reader/pairing.json` and set owner `x-reader:x-reader`, mode 600.
The unchanged app identity and host-storage key retain the phone's bearer. This
must still be confirmed in the actual Even App after installing the new endpoint
build. The X session, cache namespace and media signatures remain compatible when
the same server credentials are used. Old opaque pagination cursors expire on a
server move; refresh before loading older posts if needed.

Verify HTTPS, opaque-origin CORS, unauthenticated rejection, real feed/image reads,
bookmark authorization, process restart and preservation of pairing state before
promoting a new beta. A new HTTPS origin requires a new glasses package and
network whitelist. Keep the previous service/config available until this check
passes. Then disable the laptop service and remove only its X-specific proxy
route. No request should be forwarded through the laptop.

Session expiry still requires replacing the private credentials and restarting
`x-reader`. VM hosting does not make X web sessions permanent or bypass provider
access restrictions. Back up the credentials and pairing state through the host's
protected backup system; never commit them to Git.
