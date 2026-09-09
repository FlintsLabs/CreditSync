export interface StoredUser {
    id: number;
    name: string;
    email: string;
    picture?: string;
    role: string;
    tenantId?: string;
}

const adminRoles = new Set(["owner", "manager"]);

export function getStoredUser(): StoredUser | null {
    try {
        const storedUser = localStorage.getItem("user");
        return storedUser ? JSON.parse(storedUser) as StoredUser : null;
    } catch (error) {
        console.error("Failed to parse stored user", error);
        return null;
    }
}

export function isTenantAdminUser(user: StoredUser | null) {
    return !!user && adminRoles.has(user.role);
}
