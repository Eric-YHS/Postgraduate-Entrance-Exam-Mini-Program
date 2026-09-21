import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import http from 'node:http';
import https from 'node:https';

const ALLOWED_MODEL_HOSTS = String(process.env.VITE_LOCAL_MODEL_ALLOWED_HOSTS || '')
  .split(',')
  .map(value => value.trim().toLowerCase())
  .filter(Boolean);
const isAllowedModelTarget = target => {
  if (process.env.NODE_ENV === 'production') return false;
  if (!ALLOWED_MODEL_HOSTS.length) return false;
  const hostname = target.hostname.toLowerCase();
  return ALLOWED_MODEL_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
};

/**
 * Local development bridge for explicitly allowlisted OpenAI-compatible providers.
 * It is disabled unless VITE_LOCAL_MODEL_ALLOWED_HOSTS is configured.
 */
const localModelBridge = () => ({
  name: 'local-model-bridge',
  configureServer(server) {
    server.middlewares.use('/__local_model_probe', (req, res, next) => {
      if (req.method !== 'POST') return next();
      let raw = '';
      req.on('data', chunk => {
        raw += chunk;
        if (raw.length > 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(raw || '{}');
          const target = new URL(String(payload.url || ''));
          if (!['http:', 'https:'].includes(target.protocol)) throw new Error('仅支持 http 或 https 接口地址');
          if (!isAllowedModelTarget(target)) throw new Error('模型接口域名未加入 VITE_LOCAL_MODEL_ALLOWED_HOSTS 白名单');
          const body = payload.body == null ? '' : JSON.stringify(payload.body);
          const client = target.protocol === 'https:' ? https : http;
          const upstream = client.request(target, {
            method: String(payload.method || 'GET').toUpperCase(),
            headers: {
              Accept: 'application/json',
              ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
              ...(payload.apiKey ? { Authorization: `Bearer ${payload.apiKey}` } : {}),
            },
            timeout: 30000,
          }, upstreamRes => {
            let responseText = '';
            upstreamRes.on('data', chunk => { responseText += chunk; });
            upstreamRes.on('end', () => {
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ status: upstreamRes.statusCode || 502, body: responseText }));
            });
          });
          upstream.on('timeout', () => upstream.destroy(new Error('连接超时（30 秒）')));
          upstream.on('error', error => {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ status: 502, body: JSON.stringify({ message: error.message }) }));
          });
          if (body) upstream.write(body);
          upstream.end();
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ status: 400, body: JSON.stringify({ message: error.message }) }));
        }
      });
    });
  },
});

export default defineConfig({
  plugins: [react(), localModelBridge()],
  server: {
    host: '127.0.0.1',
    allowedHosts: ['localhost', '127.0.0.1'],
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:4000', changeOrigin: true }
    }
  },
});
