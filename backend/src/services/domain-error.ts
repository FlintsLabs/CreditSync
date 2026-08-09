export class DomainError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly status: number,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = "DomainError";
    }
}

export function presentDomainError(error: unknown) {
    if (error instanceof DomainError) {
        return {
            status: error.status,
            body: {
                error: error.message,
                code: error.code,
                ...(error.details ? { details: error.details } : {}),
            },
        };
    }
    throw error;
}
