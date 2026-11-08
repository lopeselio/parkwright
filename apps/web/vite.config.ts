import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, proxy: { '/api': 'http://localhost:8790', '/mcp': 'http://localhost:8790', '/ws': { target: 'ws://localhost:8790', ws: true } } },
  build: { target: 'es2022', sourcemap: true },
});
