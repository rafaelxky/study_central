# Study Central

Study Central is a React + TypeScript frontend with a Rust backend for local development and a Cloudflare Worker + D1 option for deployment. It supports account creation with username, email, and password, email/password login, session restore, and logout. Signed-in users can create, view, search, and remove their own website shortcuts, create and organize server-saved notes, pin notes to the dashboard, manage a server-saved to-do list, maintain a calendar of one-day events and recurring classes, and save a university token to their account.

The frontend caches only the signed-in profile in browser local storage so the dashboard can appear immediately on refresh. Passwords and session credentials stay out of local storage; the server validates the HttpOnly session cookie.

The workspace is only shown after the backend validates the session. Signed-out users are sent to `/login`; successful login or registration returns them to `/`.

## Run locally

Install frontend dependencies once:

```sh
cd frontend
npm install
cd ..
```

Start the backend and frontend in separate terminals from the project root:

```sh
./run_backend.sh
```

```sh
./run_frontend.sh
```

The frontend is served by Vite, which proxies `/api` requests to the Rust backend on `127.0.0.1:3001`. The backend creates its SQLite database at `backend/data/studyspace.sqlite`.

Open **Notes** from the left navigation to create, edit, pin, and delete notes. Notes are stored in the backend database per account; pinned notes also appear on the dashboard.

The dashboard to-do list lets you add tasks, mark them complete or incomplete, and remove them. Tasks are stored in the backend database per account.

Open **Calendar** from the left navigation to add one-day events or weekly classes with inclusive start and end dates, descriptions, times, and color labels. Set a reminder from 1 to 30 days ahead (or leave it at no reminder); reminders appear under the bell and on the Notifications page. Calendar items are stored in the backend database per account.

The local Rust backend fetches a site's `/favicon.ico` when a shortcut is added and saves a small supported image with that shortcut. If an icon is unavailable, the shortcut still works with a generic icon. Favicon requests are limited to public HTTP(S) hosts and standard web ports; private or local network addresses and redirects are not fetched. Shortcut URLs belong to the account that created them.

## Cloudflare Workers deployment

The Worker serves the frontend and handles same-origin `/api` requests using D1. There is no separate API server or `API_ORIGIN`.

1. Create a D1 database named `study-central` with `npm run d1:create`.
2. Copy the `database_id` from Wrangler's output into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`, then commit that configuration.
3. In the Worker's **Settings → Variables and Secrets**, add `JWT_ENCRYPTION_KEY` as a secret if you want to enable encrypted university-token storage. Use a randomly generated 32-byte (64-character hex) key and keep it stable; changing or losing it makes saved tokens unreadable.
4. In the Cloudflare Workers Builds settings, set the build command to `npm run build` and the deploy command to `npm run deploy:worker`. The deploy script applies D1 migrations and then deploys the Worker. Cloudflare must have permission to deploy the Worker and apply D1 migrations.

This password-hashing configuration requires the Workers Paid plan: the Worker requests a 30-second CPU limit per request, while the Free plan allows 10 ms. See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

After a successful deployment, open the Worker URL shown in Cloudflare's Worker overview. Existing SQLite data and accounts are not imported automatically. New Worker accounts use PBKDF2-SHA256 password hashes, so moving existing accounts requires a separate data and password-transition plan.

For local Worker development, run `npx wrangler dev` after setting the D1 database ID. Local D1 migrations can be applied with `npx wrangler d1 migrations apply study-central --local`.

## Nginx deployment

For deployments where the Rust API and frontend are hosted together on a VPS, the project-root [nginx.conf](./nginx.conf) serves the frontend from `/var/www/study-central` and proxies `/api` requests to the backend on `127.0.0.1:3001`. Build with `npm run build`, copy `frontend/dist/.` into the configured web root, and configure TLS before public use.

## Backend configuration

- `BIND_ADDR` — backend listen address (default `127.0.0.1:3001`)
- `STUDYSPACE_DATA_DIR` — SQLite data directory (default `backend/data` when started with `run_backend.sh`)
- `COOKIE_SECURE=true` — set the session cookie's `Secure` attribute when serving over HTTPS; leave unset for local HTTP development
- `JWT_ENCRYPTION_KEY` — 32-byte AES-256 key as 64 hexadecimal characters; required to enable encrypted university JWT storage. Loaded from the process environment or a root `.env` file for the Rust backend, and configured as a Worker secret for Cloudflare.
- `RUST_LOG` — tracing filter (default `studyspace_backend=info,tower_http=info`)

To enable token storage for local development, generate a key once and put it in a root `.env` file:

```sh
printf 'JWT_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
```

The root `.env` is ignored by Git. Keep the key stable; losing or changing it makes saved university tokens unreadable. For public deployments, supply it through a secret manager instead. Open the key icon in the signed-in header to manage the university token. The settings dialog stores the pasted JWT encrypted and never displays it again; it does not log in to or navigate the university website.

This starter is intended for local development. Before public deployment, use HTTPS, set `COOKIE_SECURE=true`, and add operational protections such as rate limiting and account recovery.
