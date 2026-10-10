import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Content-Security-Policy for production builds (dev needs inline HMR scripts and websockets).
 * connect-src lists the RPC, the Zama testnet relayer and the bucket the relayer points to for the FHE public key.
 * 'wasm-unsafe-eval' lets the Zama SDK compile its WASM; workers run from blob: URLs.
 */
function csp(env: Record<string, string>): Plugin {
  const connect = [
    "'self'",
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://relayer.testnet.zama.org',
    'https://zama-mpc-testnet-public-efd88e2b.s3.eu-west-1.amazonaws.com',
  ];
  if (env.VITE_LOCAL_PAYLINKS) connect.push('http://127.0.0.1:8545');
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src ${connect.join(' ')}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

// Cross-origin isolation lets the SDK run FHE work on several threads (SharedArrayBuffer). Production hosts must
// send the same headers: see public/_headers (Cloudflare Pages / Netlify) and vercel.json.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [csp(loadEnv(mode, process.cwd(), 'VITE_'))],
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: 'es2022' },
  worker: { format: 'es' },
}));
