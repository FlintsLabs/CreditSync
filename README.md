# CreditSync

## 🚀 Running Locally (Development)

### 1. Start Database (Docker)
You need PostgreSQL running for the backend.
```bash
docker run --name creditsync-pg \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_USER=user \
  -e POSTGRES_DB=creditsync \
  -p 5432:5432 \
  -d postgres:15-alpine
```

### 2. Backend (Bun + Elysia)
```bash
cd backend
bun install
bun run migrate # Create tables
bun run dev
```
*API will be running at http://localhost:3000*
*Swagger UI: http://localhost:3000/swagger*

### 3. Frontend (React + Vite)
```bash
cd frontend
npm install
npm run dev
```
*Web App will be running at http://localhost:5173*

---

## ☸️ Running on Kubernetes
```bash
kubectl apply -f k8s/
```
