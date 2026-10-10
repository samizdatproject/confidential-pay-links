// Smoke test of a hosted production build against live Sepolia (no funds spent, nothing signed):
//  1. the public "paid?" page for invoice (a) of the live run shows PAID;
//  2. the create page encrypts an amount with the real Zama relayer (FHE WASM + input proof) and simulates
//     createInvoice on Sepolia; a stand-in wallet then rejects the transaction, so nothing is sent.
//
//   APP_URL=https://samizdatproject.github.io/confidential-pay-links/ node e2e/hosted-check.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:4180/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const live = JSON.parse(readFileSync(fileURLToPath(new URL('../../e2e-results/sepolia-live.json', import.meta.url)), 'utf8'));
const INVOICE_A = live.values.invoiceA;
const MERCHANT = live.merchant;
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

function standInWallet(account, rpc) {
  let id = 0;
  window.__walletCalls = [];
  window.__statuses = [];
  new MutationObserver(() => {
    const t = document.querySelector('.status')?.textContent;
    if (t && window.__statuses.at(-1) !== t) window.__statuses.push(t);
  }).observe(document, { subtree: true, childList: true, characterData: true });
  window.ethereum = {
    on() {},
    removeListener() {},
    async request({ method, params }) {
      window.__walletCalls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_sendTransaction') window.__sentGas = params?.[0]?.gas;
      if (method === 'eth_sendTransaction' || method.startsWith('eth_sign') || method.startsWith('personal_sign'))
        throw Object.assign(new Error('User rejected the request (stand-in wallet)'), { code: 4001 });
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    },
  };
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const out = { app: APP, at: new Date().toISOString(), problems: [] };
const mainText = (p) => p.evaluate(() => document.querySelector('main')?.innerText ?? '');
try {
  const p = await browser.newPage();
  p.on('pageerror', (e) => out.problems.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && out.problems.push(`console: ${m.text().slice(0, 300)}`));
  await p.evaluateOnNewDocument(standInWallet, MERCHANT, RPC);

  await p.goto(`${APP}#/check?c=11155111&id=${INVOICE_A}`, { waitUntil: 'networkidle0', timeout: 120_000 });
  await p.waitForFunction(() => /PAID|no public status|Retry/.test(document.querySelector('main')?.innerText ?? ''), { timeout: 120_000, polling: 500 });
  out.crossOriginIsolated = await p.evaluate(() => globalThis.crossOriginIsolated);
  out.serviceWorker = await p.evaluate(() => Boolean(navigator.serviceWorker?.controller));
  out.publicCheck = (await mainText(p)).match(/PAID[^\n]*/)?.[0] ?? (await mainText(p)).slice(0, 300);

  await p.goto(`${APP}#/`, { waitUntil: 'networkidle0', timeout: 120_000 });
  await p.waitForSelector('#amount');
  await p.type('#amount', '1.5');
  await p.type('#memo', 'hosted smoke test (never sent)');
  const statuses = [];
  const t0 = Date.now();
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Create'))?.click());
  for (;;) {
    const s = await p.evaluate(() => document.querySelector('.status')?.textContent ?? '');
    if (s && statuses.at(-1) !== s) statuses.push(s);
    if (/rejected|stand-in|error|failed/i.test(s) || Date.now() - t0 > 240_000) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  out.createStatuses = await p.evaluate(() => window.__statuses);
  out.walletCalls = await p.evaluate(() => [...new Set(window.__walletCalls)]);
  out.sentGasLimit = await p.evaluate(() => (window.__sentGas ? BigInt(window.__sentGas).toString() : null));
  out.encryptAndSimulateSeconds = Math.round((Date.now() - t0) / 1000);
  out.encryptedAndSimulated = out.createStatuses.some((s) => /Confirm the transaction in your wallet/.test(s));
} finally {
  console.log(JSON.stringify(out, null, 2));
  const dir = fileURLToPath(new URL('../../e2e-results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}hosted-${new URL(APP).hostname.replace(/\W/g, '_')}.json`, JSON.stringify(out, null, 2));
  await browser.close();
}
