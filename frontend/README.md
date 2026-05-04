# CreditSync Frontend

React 19 + Vite 8 frontend for the CreditSync dashboard.

## Commands

```bash
bun install
bun run dev
bun run lint
bun run build
```

## Notes

- API requests are centralized through `src/lib/api.ts`.
- Auth state lives in `src/lib/auth.ts` and the dashboard shell is in `src/layouts/DashboardLayout.tsx`.
- Shared UI primitives are local shadcn-style components under `src/components/ui/`.
- Tailwind CSS 4 is wired through `@tailwindcss/postcss`; `src/index.css` explicitly loads the legacy config with `@config "../tailwind.config.js"`.
