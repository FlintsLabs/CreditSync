# 1. Selection of Technology Stack

Date: 2025-12-08

## Status
Accepted

## Context
We need to build a high-performance, cost-effective, and modern Loan Management System (CreditSync). The system requires a fast backend API, a responsive/interactive frontend (SPA), and type safety across the entire stack.

## Decision
We have selected the following stack:

1.  **Runtime**: **Bun**
    *   *Why*: Faster startup and execution time than Node.js. Built-in bundler and test runner reduce tooling complexity.
2.  **Backend Framework**: **ElysiaJS**
    *   *Why*: Designed specifically for Bun. Extremely high performance. Best-in-class end-to-end type safety (Eden Treaty) with the frontend.
3.  **Frontend Framework**: **React (via Vite)**
    *   *Why*: Industry standard, rich ecosystem. Vite provides instant HMR. We chose "SPA mode" over Next.js/SSR because SEO is not a priority for this internal dashboard app, and it simplifies deployment (static files + API).
4.  **Database**: **PostgreSQL** with **Drizzle ORM**
    *   *Why*: PostgreSQL is reliable for financial data. Drizzle is lightweight, type-safe, and generates efficient SQL queries compared to heavier ORMs like Prisma.

## Consequences
*   **Positive**: High development speed due to unified TypeScript stack. Excellent runtime performance. Clean separation of concerns (Client/Server).
*   **Negative**: Bun ecosystem is newer than Node.js, might encounter some edge-case compatibility issues (though rarely for standard web apps).
