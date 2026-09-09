CREATE TABLE "mcp_diagnostic_events" (
    "id" serial PRIMARY KEY,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "tool_name" text NOT NULL,
    "request_id" uuid NOT NULL,
    "correlation_id" uuid NOT NULL,
    "category" text NOT NULL,
    "failure_class" text NOT NULL,
    "error_code" text NOT NULL,
    "terminal_stage" text NOT NULL,
    "retryable" boolean NOT NULL,
    "review_required" boolean NOT NULL,
    "upstream_status" integer,
    "duration_ms" integer NOT NULL,
    "breadcrumbs" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "occurred_at" timestamp DEFAULT now() NOT NULL,
    "expires_at" timestamp NOT NULL,
    CONSTRAINT "mcp_diagnostic_events_tool_name_check" CHECK (length(tool_name) BETWEEN 1 AND 120),
    CONSTRAINT "mcp_diagnostic_events_category_check" CHECK (category IN ('domain','validation','authorization','database','cache','network','storage','external_service','timeout','internal')),
    CONSTRAINT "mcp_diagnostic_events_failure_class_check" CHECK (length(failure_class) BETWEEN 1 AND 80),
    CONSTRAINT "mcp_diagnostic_events_error_code_check" CHECK (length(error_code) BETWEEN 1 AND 160),
    CONSTRAINT "mcp_diagnostic_events_terminal_stage_check" CHECK (length(terminal_stage) BETWEEN 1 AND 120),
    CONSTRAINT "mcp_diagnostic_events_duration_check" CHECK (duration_ms >= 0),
    CONSTRAINT "mcp_diagnostic_events_upstream_status_check" CHECK (upstream_status IS NULL OR upstream_status BETWEEN 100 AND 599),
    CONSTRAINT "mcp_diagnostic_events_expiry_check" CHECK (expires_at > occurred_at),
    CONSTRAINT "mcp_diagnostic_events_breadcrumbs_check" CHECK (jsonb_typeof(breadcrumbs) = 'array')
);
CREATE INDEX "mcp_diagnostic_events_tenant_correlation_idx" ON "mcp_diagnostic_events" (tenant_id, correlation_id, occurred_at DESC);
CREATE INDEX "mcp_diagnostic_events_tenant_request_idx" ON "mcp_diagnostic_events" (tenant_id, request_id, occurred_at DESC);
CREATE INDEX "mcp_diagnostic_events_tenant_occurred_idx" ON "mcp_diagnostic_events" (tenant_id, occurred_at DESC);
CREATE INDEX "mcp_diagnostic_events_expires_idx" ON "mcp_diagnostic_events" (expires_at);
