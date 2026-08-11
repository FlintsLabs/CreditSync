import axios from "axios";

// Use relative URL to leverage Vite proxy
// Requests to /api/... will be proxied to http://localhost:3000/...
export const api = axios.create({
    baseURL: "/api",
});

export async function resolveFileAccessUrl(filePublicId: string): Promise<string> {
    return (await resolveFileAccess(filePublicId)).url;
}

export async function resolveFileAccess(filePublicId: string): Promise<{ url: string; mimeType: string | null }> {
    const response = await api.get(`/files/${filePublicId}/access-url`);
    return { url: response.data.url, mimeType: response.data.mimeType ?? null };
}

api.interceptors.request.use((config) => {
    const token = localStorage.getItem("token");
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            // Redirect to login if unauthorized
            // window.location.href = "/auth/login"; // Commented out to prevent loops during dev if token is just expired
            console.error("Unauthorized! Redirecting to login...");
        }
        return Promise.reject(error);
    }
);
