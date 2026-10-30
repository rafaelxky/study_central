# Studyspace

Studyspace is a React + TypeScript frontend with a Rust backend. It supports account creation with username, email, and password, email/password login, session restore, and logout. Signed-in users can create, view, search, and remove their own website shortcuts, create and organize server-saved notes, pin notes to the dashboard, manage a server-saved to-do list, maintain a calendar of one-day events and recurring classes, and save a university token to their account.

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

The backend fetches a site's `/favicon.ico` when a shortcut is added and saves a small supported image with that shortcut. If an icon is unavailable, the shortcut still works with a generic icon. Favicon requests are limited to public HTTP(S) hosts and standard web ports; private or local network addresses and redirects are not fetched. Shortcut URLs belong to the account that created them.

## Nginx deployment

Build the frontend and make sure the backend is running on `127.0.0.1:3001`:

```sh
npm run build --prefix frontend
./run_backend.sh
```

The project-root [nginx.conf](./nginx.conf) serves the frontend from `/var/www/studyspace`, proxies `/api` requests to the local backend, enables client-side route fallback, and disables API caching. Copy the build output to that web root, change `server_name` to your domain (and `root` if desired), then install the server block and reload Nginx:

```sh
sudo mkdir -p /var/www/studyspace
sudo cp -r frontend/dist/. /var/www/studyspace/
sudo cp nginx.conf /etc/nginx/sites-available/studyspace
sudo ln -s /etc/nginx/sites-available/studyspace /etc/nginx/sites-enabled/studyspace
sudo nginx -t
sudo systemctl reload nginx
```

This configuration serves HTTP only. Configure TLS with your deployment's certificate before exposing the site publicly, then set `COOKIE_SECURE=true` for the backend.

## Cloudflare Pages

The repository root is configured as an npm workspace so Cloudflare can install dependencies from the repository root. For a Cloudflare Pages project, set the build command to `npm run build` and the build output directory to `frontend/dist`. Do not use `npx wrangler deploy`, which deploys a Worker. For a manual CLI deployment, build first and deploy the Pages output:

```sh
npm run build
npm run deploy:pages
```

The Pages project named `study-central` must already exist in Cloudflare. The Rust API is not deployed by Pages and must be hosted separately, with `/api` routed to that backend.

## Backend configuration

- `BIND_ADDR` — backend listen address (default `127.0.0.1:3001`)
- `STUDYSPACE_DATA_DIR` — SQLite data directory (default `backend/data` when started with `run_backend.sh`)
- `COOKIE_SECURE=true` — set the session cookie's `Secure` attribute when serving over HTTPS; leave unset for local HTTP development
- `JWT_ENCRYPTION_KEY` — 32-byte AES-256 key as 64 hexadecimal characters; required to enable encrypted university JWT storage. Loaded from the process environment or a root `.env` file.
- `RUST_LOG` — tracing filter (default `studyspace_backend=info,tower_http=info`)

To enable token storage for local development, generate a key once and put it in a root `.env` file:

```sh
printf 'JWT_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
```

The root `.env` is ignored by Git. Keep the key stable; losing or changing it makes saved university tokens unreadable. For public deployments, supply it through a secret manager instead. Open the key icon in the signed-in header to manage the university token. The settings dialog stores the pasted JWT encrypted and never displays it again; it does not log in to or navigate the university website.

This starter is intended for local development. Before public deployment, use HTTPS, set `COOKIE_SECURE=true`, and add operational protections such as rate limiting and account recovery.
