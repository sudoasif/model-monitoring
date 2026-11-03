# Aperture MLOps — frontend

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Radix-based UI components, React Query and Recharts.

See the [root README](../README.md) for the full platform setup and the [deployment guide](../docs/deployment.md) for container deployment.

## Development

The backend must be running first (default `http://localhost:8000/api`).

```bash
npm ci
npm run dev
```

Open <http://localhost:3000>. Override the API base URL with `NEXT_PUBLIC_API_URL` if needed. It is a build-time value, so rebuild after changing it.

## Checks

```bash
npm run lint
npm run typecheck
npm run test:run
npm run build
```

End-to-end tests start their own backend and frontend:

```bash
npx playwright install chromium   # once
npm run test:e2e
```

## Structure

- `src/app/(app)/` — ten dashboard pages
- `src/app/(auth)/` — login and registration
- `src/components/` — app shell, charts, feature panels and UI primitives
- `src/lib/api.ts` — typed fetch client with auth refresh and workspace header
- `src/lib/hooks.ts` — React Query hooks
- `src/lib/types.ts` — API contracts
- `e2e/` — Playwright main journey
