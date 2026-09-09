# TODO

- [x] Implement the approved tenant-scoped MCP error diagnostics system from [`design`](./docs/superpowers/specs/2026-09-09-mcp-error-diagnostics-design.md) and [`plan`](./docs/superpowers/plans/2026-09-09-mcp-error-diagnostics.md): actionable public errors, bounded safe breadcrumbs, 30-day PostgreSQL retention, owner/manager read-only diagnostic tools, stdout fallback, and synchronized plugin contracts/evals. Merged into `main` through `3b28de1`; not yet deployed.
- [ ] Deploy MCP error diagnostics and verify migration, diagnostic reads, and retention scheduling using the [operations guide](./docs/operations/mcp-error-diagnostics.md), after explicit deployment approval.
- [x] Repair frontend test-runner/fixture drift: compatible Vitest workers disable native webstorage automatically, deferral tests use Vitest, sidebar assertions follow release metadata, and repayment fixtures supply the separate schedule summary. Verified with the normal `bun run test` command (252 passing tests), lint, and build; production financial logic is unchanged.
- [ ] บังคับตรวจวงเงินคงเหลือของทุนส่วนตัว (`capital_pool`) ซ้ำที่ backend ภายใน transaction ตอนสร้าง funding allocation เพื่อป้องกันการจัดสรรเกินวงเงินจาก concurrent writes แม้ UI จะตรวจไว้แล้ว
- [ ] เพิ่ม MCP สำหรับสร้างรายการเบิกจากแหล่งทุน TTB So fast จำนวน 20,000.00 บาท ระยะ 10 เดือน ดอกเบี้ย 8.69% ต่อปี
