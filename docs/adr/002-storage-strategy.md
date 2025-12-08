# 2. Storage Strategy for Documents and Images

Date: 2025-12-08

## Status
Accepted

## Context
The system needs to store borrower documents (ID Cards, Contracts) and transaction slips.
1.  Files are binary and large; storing them directly in PostgreSQL is inefficient (bloats DB size/backups).
2.  We need strict access control (not public URLs).
3.  We need a unified way to handle files in both Local Dev and Production.

## Decision
We will use **S3-Compatible Object Storage**:
*   **Local Development**: **MinIO** (Self-hosted S3 compatible server via Docker).
*   **Production**: **Cloudflare R2** or **AWS S3** (Switchable via env vars).

We will store **Metadata** in PostgreSQL (`files` table):
*   `bucket`, `key`, `mime_type`, `original_name`.

## Consequences
*   **Positive**: Database remains lightweight. Files are stored securely. Easy migration between cloud providers (S3 standard).
*   **Negative**: Requires managing an extra infrastructure component (MinIO) during local development.
