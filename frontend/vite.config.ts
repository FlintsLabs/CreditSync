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
        // Node's native storage shadows jsdom's origin-scoped browser storage.
        // Disable it in test workers only, on runtimes that expose this flag.
        execArgv: process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
            ? ['--no-experimental-webstorage']
            : [],
        setupFiles: ['./tests/setup.ts'],
        include: ['tests/**/*.{test,vitest}.{ts,tsx}', 'src/**/*.{test,vitest}.{ts,tsx}'],
    },
})
