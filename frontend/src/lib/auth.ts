// Basic Auth Mock
export interface User {
    id: string;
    name: string;
    email: string;
    role: "owner" | "manager" | "collector" | "viewer";
    tenantId: string;
}

export const loginWithGoogle = async () => {
    // Simulating Google Login Redirect
    console.log("Redirecting to Google...");
    return new Promise((resolve) => setTimeout(resolve, 1000));
}

export const mockUser: User = {
    id: "uuid-1",
    name: "Demo Owner",
    email: "demo@creditsync.app",
    role: "owner",
    tenantId: "tenant_001"
};
