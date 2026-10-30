# Studyspace project guidelines

Studyspace helps students organize school work and quickly reach the websites they use. Keep the product simple, direct, and easy to understand. Speed and organization are priorities.

## Design and UX

- Keep the existing dark theme, typography, spacing, and responsive behavior. Check `frontend/src/index.css` and `frontend/src/App.css` before introducing new styles.
- Keep the interface uncluttered. Make important actions easy to find, label buttons clearly, and avoid unnecessary steps, decoration, or surprise interactions.
- Do not add invented sample content, placeholder features, or navigation unless requested.
- Preserve the current header and shortcut dashboard behavior unless a request explicitly changes them.
- Keep controls accessible: use semantic elements, provide input labels and button names, and preserve visible keyboard focus.
- Keep in mind how many times a feature will be accessed, frequently used features should be evident and quick to access, less used ones can be pushed to the side to take up less space.

## Frontend

- Use React and TypeScript in `frontend/`. Keep types explicit and avoid unsafe casts.
- Reuse existing styles and components where practical; keep responsive layouts working on narrow screens.
- Vite proxies `/api` requests to the Rust backend during development.

## Backend and data

- Use Rust and Axum for backend changes. Keep database access in SQLite through SQLx.
- Scope private data and every read, update, and delete operation to the authenticated user.
- Never store passwords in plain text. Keep session credentials in secure, HttpOnly cookies; do not expose session tokens or server secrets to frontend code.
- When a requested feature handles user-pasted external credentials, scope them to that user, encrypt them at rest, and never return saved credentials to the browser.
- Treat user-provided URLs as untrusted. Validate schemes and hosts, and prevent favicon fetching from reaching local or private network addresses.
- Return clear API errors; do not hide failed operations behind success-shaped responses.

## Verification

- For frontend changes, run `cd frontend && npm run build && npm run lint`.
- For backend changes, run `cargo fmt --manifest-path backend/Cargo.toml` and `cargo test --manifest-path backend/Cargo.toml`.
- Start the backend with `./run_backend.sh` and the frontend with `./run_frontend.sh` in separate terminals when manual integration checks are needed.
- Update the relevant README when setup or user-facing behavior changes.


