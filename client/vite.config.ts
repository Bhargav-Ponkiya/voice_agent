import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            // Silence ECONNREFUSED/ECONNRESET verbose logs, only print one-line warning
            if (err.message.includes('ECONNREFUSED')) {
              console.warn('[Vite Proxy] Backend API server is offline (ECONNREFUSED)');
            } else {
              console.warn('[Vite Proxy] API error:', err.message);
            }
          });
        }
      },
      '/socket.io': {
        target: 'http://127.0.0.1:3001',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            // Silence websocket proxy errors, only print one-line warning
            if (err.message.includes('ECONNREFUSED')) {
              console.warn('[Vite Proxy] Backend WebSocket server is offline (ECONNREFUSED)');
            } else if (err.message.includes('ECONNRESET')) {
              console.warn('[Vite Proxy] Backend WebSocket connection reset (ECONNRESET)');
            } else {
              console.warn('[Vite Proxy] WebSocket error:', err.message);
            }
          });
        }
      },
    },
  },
  build: {
    // Raise the warning threshold to 800KB (our split chunks will be well under)
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React runtime — rarely changes, excellent cache hit rate
          'vendor-react': ['react', 'react-dom'],
          // Routing
          'vendor-router': ['react-router-dom'],
          // Socket.IO client
          'vendor-socket': ['socket.io-client'],
          // Lucide icon set
          'vendor-icons': ['lucide-react'],
          // Recharts charting library
          'vendor-charts': ['recharts'],
        },
      },
    },
  },
});

