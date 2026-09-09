# TODO

- [ ] Implement the approved tenant-scoped MCP error diagnostics system: actionable public errors, bounded safe breadcrumbs, 30-day PostgreSQL retention, owner/manager read-only diagnostic tools, stdout fallback, and synchronized plugin contracts/evals.
- [ ] บังคับตรวจวงเงินคงเหลือของทุนส่วนตัว (`capital_pool`) ซ้ำที่ backend ภายใน transaction ตอนสร้าง funding allocation เพื่อป้องกันการจัดสรรเกินวงเงินจาก concurrent writes แม้ UI จะตรวจไว้แล้ว
- [ ] เพิ่ม MCP สำหรับสร้างรายการเบิกจากแหล่งทุน TTB So fast จำนวน 20,000.00 บาท ระยะ 10 เดือน ดอกเบี้ย 8.69% ต่อปี
