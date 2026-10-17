import { defineConfig } from 'astro/config';

// Everything the page calls goes through this dev server, so the browser never
// makes a cross-origin request and the backend needs no CORS entry for it.
//   /api/*   -> the Nest backend started by `npm run stack`
//   /fake/*  -> the stand-in Netpay control API started by `npm run stack`
export default defineConfig({
  server: { port: 4321, host: '127.0.0.1' },
  vite: {
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:4062', changeOrigin: true },
        '/fake': {
          target: 'http://127.0.0.1:4070',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/fake/, '/__control'),
        },
      },
    },
  },
});
