import axios from "axios";

// Use relative URL to leverage Vite proxy
// Requests to /api/... will be proxied to http://localhost:3000/...
export const api = axios.create({
    baseURL: "/api",
});

export async function resolveFileAccessUrl(filePublicId: string): Promise<string> {
    const response = await api.get(`/files/${filePublicId}/access-url`);
    return response.data.url;
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
