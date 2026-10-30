# Studyspace

A dark, responsive React and TypeScript frontend with account login and registration and a dashboard for personal website shortcuts.

## Getting started

```sh
npm install
npm start
```

From the project root, you can also start the frontend with `./run_frontend.sh`.

## Available scripts

- `npm start` — start the frontend development server
- `npm run dev` — start the Vite development server
- `npm run build` — type-check and create a production build
- `npm run lint` — lint the project with Oxlint
- `npm run preview` — preview the production build

The Vite development server proxies `/api` requests to the Rust backend at `127.0.0.1:3001`. See the [project README](../README.md) for backend startup instructions.

Signed-in users can add shortcuts by entering a name and website URL. The dashboard lists only shortcuts belonging to the current account.
