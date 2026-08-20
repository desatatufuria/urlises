# Production Deployment

## Architecture

```text
Internet -> Traefik (VPS, public IP, TLS termination)
              |
              | WireGuard tunnel
              v
         10.77.0.2 (this host, private)
              |
              +-- urlises-api    (backend, container port 8080)
              +-- urlises-admin  (admin-web, container port 80)
              +-- postgres       (never published to the host)
```

Traefik lives on a separate VPS and is not part of this repository. It reaches
this host only through the WireGuard tunnel at `10.77.0.2`. TLS terminates at
Traefik; traffic inside the tunnel is plain HTTP. Nothing in this repo binds
to a public interface — only `BIND_ADDR` (the WireGuard IP by default) is
published, and Postgres is never exposed to the host at all.

Two public subdomains route through Traefik:

- `https://api.urlises.lab.dtfuria.xyz` -> backend API
- `https://admin.urlises.lab.dtfuria.xyz` -> admin-web panel

## Bringing it up

```bash
cp .env.example .env
# edit .env: set real secrets, DB credentials, and confirm BIND_ADDR

docker compose -f docker-compose.prod.yml up -d --build
```

See `.env.example` for the full list of required variables. `admin-web` is
built with `VITE_API_BASE_URL` baked in at build time, so the admin panel
calls the API subdomain directly from the browser instead of going through
the dev-only nginx proxy.

After Traefik is configured (see below), copy `deploy/traefik/urlises.yml` to
`/opt/traefik/dynamic/urlises.yml` on the VPS.

## Validation

Run these in order.

```bash
# 1. From the .33 host itself, confirm the containers bind where expected
curl http://10.77.0.2:8080/healthz
curl -I http://10.77.0.2:8082
```

Confirms the backend and admin-web containers are up and listening on the
configured `BIND_ADDR`, before involving the network at all.

```bash
# 2. From the VPS, confirm it can reach the host over WireGuard (do this BEFORE touching Traefik config)
curl http://10.77.0.2:8080/healthz
curl -I http://10.77.0.2:8082
```

Confirms the WireGuard tunnel itself is up and routes correctly, independent
of any Traefik configuration.

```bash
# 3. After creating the DNS wildcard record (*.urlises.lab -> VPS public IP), confirm resolution
dig A api.urlises.lab.dtfuria.xyz +short
dig A admin.urlises.lab.dtfuria.xyz +short
```

Confirms both subdomains resolve to the VPS public IP before requesting a
certificate.

```bash
# 4. After deploying deploy/traefik/urlises.yml to /opt/traefik/dynamic/ on the VPS, confirm HTTPS works
curl -Ik https://api.urlises.lab.dtfuria.xyz
curl -Ik https://admin.urlises.lab.dtfuria.xyz
```

Confirms Traefik picked up the dynamic config, obtained a certificate, and
routes to the host over the tunnel.

```bash
# 5. If something looks wrong, check Traefik's logs (do not restart it — the file provider hot-reloads)
docker logs traefik --tail 100
```

The file provider reloads `urlises.yml` automatically on change; restarting
Traefik is never required for a config update.

## Safety notes

- Never expose Postgres to the host — it has no `ports:` mapping in
  `docker-compose.prod.yml`, only `expose: ["5432"]` on the internal network.
- Never bind services to `0.0.0.0`. Both `backend` and `admin-web` publish
  through `${BIND_ADDR:-10.77.0.2}` only.
- Only publish on `BIND_ADDR`. If the WireGuard IP changes, update `.env` —
  no other file needs to change.
