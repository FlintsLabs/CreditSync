# CreditSync 💸

A Modern, High-Performance **Loan Management System** built for speed and precision.

## 🚀 Technology Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Runtime** | ![Bun](https://img.shields.io/badge/Bun-000000?style=flat&logo=bun&logoColor=white) | Ultra-fast JavaScript runtime |
| **Backend** | ![Elysia](https://img.shields.io/badge/ElysiaJS-FE5F50?style=flat&logo=bun&logoColor=white) | High-performance API Framework |
| **Frontend** | ![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB) | UI Library (Vite Build) |
| **Styling** | ![Tailwind](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=flat&logo=tailwind-css&logoColor=white) | Utility-first CSS |
| **Database** | ![Postgres](https://img.shields.io/badge/PostgreSQL-316192?style=flat&logo=postgresql&logoColor=white) | Relational Database |
| **ORM** | ![Drizzle](https://img.shields.io/badge/Drizzle_ORM-C5F74F?style=flat&logo=drizzle&logoColor=black) | TypeScript ORM |
| **Storage** | ![MinIO](https://img.shields.io/badge/MinIO-C72E49?style=flat&logo=minio&logoColor=white) | S3 Compatible Object Storage |

## 📂 Project Structure

```text
├── backend/            # Bun + Elysia API Server
│   ├── src/
│   │   ├── modules/    # API Feature Modules (auth, loans, transactions)
│   │   ├── db/         # Drizzle Schema & Connection
│   │   └── lib/        # Shared Utilities (calculator, storage)
│
├── frontend/           # React + Vite Application
│   ├── src/
│   │   ├── components/ # Reusable UI (shadcn/ui)
│   │   ├── pages/      # Feature Pages (Dashboard, Wizard)
│   │   └── layouts/    # App Shells
│
├── docs/               # Project Documentation
│   ├── adr/            # Architecture Decision Records
│   └── implementation_plan.md
```

## 🛠️ Getting Started

### Prerequisites
*   [Bun](https://bun.sh) (v1.x)
*   [MinIO](https://min.io) (Running on port 9000/9001)
*   PostgreSQL

### Running Locally

1.  **Backend**
    ```bash
    cd backend
    bun install
    bun run dev
    ```

2.  **Frontend**
    ```bash
    cd frontend
    npm install
    npm run dev
    ```

## 📖 Documentation
See [docs/](./docs) for detailed design documents and architecture decisions.

---
*Generated: 2025-12-08*
