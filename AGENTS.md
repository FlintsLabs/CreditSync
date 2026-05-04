# AGENTS.md

ตอบเป็นภาษาไทยเป็นหลัก เว้นแต่ผู้ใช้ถามเป็นอังกฤษหรือขอภาษาอังกฤษ

## Working Rules

- อ่านโค้ดจริงก่อนสรุปหรือแก้ โดยเฉพาะ route/module/component ที่เกี่ยวข้อง
- แก้ให้จบพร้อม verify/build/test เท่าที่ environment อนุญาต
- สรุปไฟล์ที่แก้และผลทดสอบสั้น ๆ
- ถ้า workspace มี dirty changes ห้าม revert งานเดิมของผู้ใช้โดยไม่ถาม
- ใช้ `rg` / `rg --files` ก่อนเครื่องมือค้นหาที่ช้ากว่า
- ทำ commit แบบ scoped และอย่า stage ไฟล์ที่ไม่เกี่ยวกับงาน

## Project Context

- Repo นี้เป็น CreditSync: Bun + Elysia backend และ React + Vite frontend
- Backend route modules อยู่ที่ `backend/src/modules/`
- Auth middleware อยู่ที่ `backend/src/middleware/auth.ts`
- Database schema อยู่ที่ `backend/src/db/schema.ts`
- Frontend dashboard shell อยู่ที่ `frontend/src/layouts/DashboardLayout.tsx`
- Shared UI components ใช้ path lowercase เช่น `frontend/src/components/ui/button`

## Package Management

- ใช้ Bun เป็น package manager หลักใน `backend/` และ `frontend/`
- อัปเดต dependency ด้วย `bun update --latest`
- Commit `package.json` และ `bun.lock` คู่กันเมื่อ dependency เปลี่ยน
- ถ้าแก้ backend dependency และยังมี `backend/package-lock.json` อยู่ ให้ sync lock file นี้ด้วย
- ห้ามเพิ่ม lockfile จาก package manager อื่นโดยไม่จำเป็น

## Verification Gates

ใช้คำสั่งเหล่านี้เมื่อแตะ code ที่เกี่ยวข้อง:

```bash
cd backend
bun build src/index.ts --target=bun --outdir=/tmp/creditsync-backend-build

cd frontend
bun run lint
bun run build
```

## Review Notes

- Endpoint ที่รับ auth ต้องรักษา tenant boundary เสมอ
- ห้ามส่งรายละเอียด error ภายในระบบกลับ client โดยตรง
- AI tool endpoint ควรรักษา schema validation ให้แคบตาม tool
- Tailwind CSS 4 ต้องใช้ `@tailwindcss/postcss` และ `src/index.css` โหลด config ด้วย `@config "../tailwind.config.js"`
- งาน UUID/refactor schema ต้องมี migration/backfill plan ชัดเจนก่อน merge
