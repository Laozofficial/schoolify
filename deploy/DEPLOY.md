# Deploying Schoolify

Production: **https://schoolify.twelveai.app** on the shared VPS `185.252.235.149`.

## Layout on the server

```
/opt/schoolify/
  backend/    this repo (+ the real .env, never committed)
  frontend/   the Next.js app (own repo to follow)
```

One compose project (`schoolify`) runs everything: `web`, `backend`, `worker`,
`postgres`, `redis`. Only `127.0.0.1:4200` (API) and `127.0.0.1:4201` (web)
are bound; host nginx (`deploy/nginx-schoolify.conf`) serves the domain and
routes `/api/` to the API and everything else to the web app.

## Deploy / update

The VPS cannot pull private GitHub repos, so code is shipped as a tarball:

1. Tar `git ls-files` of this repo and the frontend source (no node_modules,
   no .next, no .env files) and upload to `/opt/schoolify/{backend,frontend}`.
2. On the server:

```sh
cd /opt/schoolify/backend
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

Migrations run automatically when the backend starts.

## First run only

```sh
# Production runs the compiled build, so seeder paths end in .js
for f in demo_seeder demo_assignments_seeder demo_scores_seeder demo_exams_seeder; do
  docker compose -f docker-compose.prod.yml exec -T backend node ace db:seed --files ./database/seeders/$f.js
done
docker compose -f docker-compose.prod.yml exec backend node ace demo:secure --admin=superadmin@demo-academy.test
```

`demo:secure` replaces every demo password with a random one and prints a
one-time super admin password (must be changed at first login). Never leave
the seeders' default passwords on a public server.

## Gotchas

- The backend image pins **Node 24.18**: Node 24.21 breaks `jsonschema` 1.5,
  which makes every app ace command (including the worker) fail to load.
- Ace loads command files before the app boots. Import app modules lazily
  inside `run()` in new commands.

## Useful commands

```sh
docker compose -f docker-compose.prod.yml logs -f backend worker
docker compose -f docker-compose.prod.yml exec backend node ace risk:scan
docker compose -f docker-compose.prod.yml exec postgres pg_dump -U schoolify schoolify > backup.sql
```
