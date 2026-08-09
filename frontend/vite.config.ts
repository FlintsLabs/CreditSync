import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(import.meta.dirname, './src'),
        },
    },
    server: {
        host: '0.0.0.0',
        port: 5173,
        // Allow Cloudflare Tunnel domain and Docker
        allowedHosts: ['creditsync.beflints.com', 'host.docker.internal'],
        // Enable HMR through tunnel
        hmr: {
            clientPort: 443,
            protocol: 'wss',
        },
        // Proxy API requests to backend
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ''),
            },
        },
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
        include: ['tests/**/*.{test,vitest}.{ts,tsx}'],
    },
})
