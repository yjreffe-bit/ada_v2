import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    base: './', // Important for Electron
    server: {
        host: '0.0.0.0',
        port: 5173,
        strictPort: true,
        proxy: {
            '/socket.io': {
                target: 'http://127.0.0.1:8000',
                ws: true,
                changeOrigin: true,
            },
        },
    },
    preview: {
        host: '0.0.0.0',
        port: 4173,
        strictPort: true,
    },
})
