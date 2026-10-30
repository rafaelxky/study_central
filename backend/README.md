# Studyspace backend

Rust HTTP API for Studyspace accounts, per-user website shortcuts, and encrypted university-token storage. Built with Axum and SQLite.

## Run

From the project root:

```sh
./run_backend.sh
```

Or from this directory:

```sh
./run.sh
```

The API listens on `127.0.0.1:3001` by default. Cargo compiles the service the first time it is run. The frontend's Vite development server proxies `/api` requests to this address.

## Configuration

- `BIND_ADDR` — listen address; defaults to `127.0.0.1:3001`.
- `STUDYSPACE_DATA_DIR` — directory for SQLite data; defaults to `data` relative to the backend working directory. The database file is `studyspace.sqlite`.
- `COOKIE_SECURE=true` — set the session cookie's `Secure` attribute when using HTTPS. Leave unset for local HTTP development.
- `JWT_ENCRYPTION_KEY` — 32-byte AES-256 key encoded as 64 hexadecimal characters. Required to enable saving university tokens. The backend loads it from the process environment or a root `.env` file.
- `RUST_LOG` — tracing filter; defaults to `studyspace_backend=info,tower_http=info`.

The backend creates the data directory, database, and tables automatically on startup. Keep the SQLite database and its directory backed up to preserve accounts and shortcuts.

To enable token storage for local development, generate a key once and put it in a root `.env` file:

```sh
printf 'JWT_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
```

The root `.env` is ignored by Git. Keep this key stable; losing or changing it makes previously saved tokens unreadable. For public deployments, supply the key through a secret manager rather than a `.env` file.

## API

All endpoints are served under `/api`. Successful account creation and login set an HttpOnly, SameSite=Lax session cookie. Sessions expire after seven days.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create an account with `{ "username", "email", "password" }` and log in |
| `POST` | `/api/auth/login` | Log in with `{ "email", "password" }` |
| `GET` | `/api/auth/me` | Return the current user, or `{ "user": null }` |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET` | `/api/shortcuts` | List the signed-in user's shortcuts |
| `POST` | `/api/shortcuts` | Add a shortcut with `{ "name", "url" }` |
| `DELETE` | `/api/shortcuts/{id}` | Remove a shortcut owned by the signed-in user |
| `GET` | `/api/notes` | List the signed-in user's notes, with pinned notes first |
| `POST` | `/api/notes` | Create a note with `{ "title", "content", "pinned" }` |
| `PUT` | `/api/notes/{id}` | Update a note's title, content, and pin state |
| `DELETE` | `/api/notes/{id}` | Delete a note owned by the signed-in user |
| `GET` | `/api/tasks` | List the signed-in user's tasks, with incomplete tasks first |
| `POST` | `/api/tasks` | Add a task with `{ "text": "..." }` |
| `PATCH` | `/api/tasks/{id}` | Mark a task complete or incomplete with `{ "completed": true }` |
| `DELETE` | `/api/tasks/{id}` | Remove a task owned by the signed-in user |
| `GET` | `/api/integrations/university/token` | Return whether this user has a saved token and whether encrypted token storage is enabled |
| `PUT` | `/api/integrations/university/token` | Save or replace the signed-in user's JWT with `{ "token": "..." }` |
| `DELETE` | `/api/integrations/university/token` | Delete the signed-in user's saved JWT |

Shortcut responses include `id`, `name`, `url`, and `icon_data`. `icon_data` is a data URL when a supported favicon was found; otherwise it is `null`. Shortcut URLs without a scheme are treated as HTTPS. Duplicate URLs are rejected per account.

## Security notes

Passwords are hashed with Argon2id. Session tokens are random, stored in the database only as SHA-256 hashes, and sent in HttpOnly cookies. Shortcuts, notes, tasks, and deletion operations are scoped to the authenticated user. Note titles are limited to 120 characters, note content to 50,000 characters, and task text to 300 characters.

University tokens are encrypted with AES-256-GCM before being written to SQLite. The encryption key comes from `JWT_ENCRYPTION_KEY` and is never stored in the database. The API never returns a saved token; it returns only whether one is saved and its update time. Tokens may be opaque values or JWTs; input is limited to 16 KB and cannot contain whitespace or control characters. The backend does not verify the token or use it to sign in to or navigate the university website.

Favicon retrieval is best-effort. The service looks for same-origin `link rel="icon"` declarations in the website HTML and falls back to `/favicon.ico`. It disables redirects and proxy environment variables, limits response sizes and timeouts, and rejects hosts that resolve to private or special-purpose IP ranges. Favicon failures do not prevent saving a shortcut.

This backend is intended as a local-development starter. For public deployment, use HTTPS with `COOKIE_SECURE=true` and add rate limiting, account recovery, and production monitoring.

## Tests

From the project root:

```sh
cargo test --manifest-path backend/Cargo.toml
```
