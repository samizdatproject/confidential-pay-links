// Browser smoke test of the production build (CSP + COOP/COEP) against the local cleartext FHEVM chain.
// A tiny injected EIP-1193 provider forwards to anvil's unlocked dev accounts, standing in for MetaMask.
//
//   ../scripts/local-chain.sh
//   npx vite build --mode development && (npx vite preview --port 4173 &) && node e2e/browser.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:4173/';
const RPC = 'http://127.0.0.1:8545';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ACCOUNTS = {
  merchant: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // anvil #1
  payer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // anvil #2
  auditor: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // anvil #3
};
const shots = fileURLToPath(new URL('../../e2e-results/screens/', import.meta.url));
mkdirSync(shots, { recursive: true });

function injectedProvider(account, rpc) {
  let id = 0;
  const call = async (method, params = []) => {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };
  window.ethereum = {
    isTestProvider: true,
    on() {},
    removeListener() {},
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_sendTransaction') (window.__gasSent ??= []).push(BigInt(params[0].gas ?? 0).toString());
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      return call(method, params);
    },
  };
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
const problems = [];
const results = {};

async function open(who, hash) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(injectedProvider, ACCOUNTS[who], RPC);
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`[${who}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${who}] pageerror: ${e.message}`));
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(ACCOUNTS.auditor) : d.accept()));
  await page.goto(`${APP}${hash}`, { waitUntil: 'networkidle0' });
  return page;
}
const text = (page) => page.evaluate(() => document.querySelector('main').innerText);
async function waitText(page, re, timeout = 90_000) {
  try {
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('main').innerText), { timeout, polling: 250 }, re.source);
  } catch (e) {
    throw new Error(`Timed out waiting for ${re} — page says:\n${await text(page)}`);
  }
}
async function clickText(page, label) {
  const ok = await page.evaluate((l) => {
    const b = [...document.querySelectorAll('button, a.button')].find((x) => x.textContent.trim().startsWith(l) && !x.disabled);
    b?.click();
    return Boolean(b);
  }, label);
  if (!ok) throw new Error(`No enabled button "${label}"`);
}

try {
  // 1. Merchant creates a link.
  const m = await open('merchant', '#/');
  results.crossOriginIsolated = await m.evaluate(() => globalThis.crossOriginIsolated);
  results.csp = await m.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null);
  await m.type('#amount', '25');
  await m.type('#memo', 'Invoice #42 — logo design');
  await clickText(m, 'Create confidential payment link');
  await waitText(m, /Your payment link/);
  const link = await m.$eval('.out input', (i) => i.value);
  results.link = link;
  await m.screenshot({ path: `${shots}1-created.png`, fullPage: true });

  // 2. Payer opens it, gets test tokens, pays.
  const p = await open('payer', link.slice(link.indexOf('#')));
  await waitText(p, /Payment request/);
  results.payPageShowsAmount = /25 cmUSD/.test(await text(p));
  await clickText(p, 'Mint & wrap');
  await waitText(p, /Minted and wrapped/);
  await clickText(p, 'Show my balance');
  await waitText(p, /Your balance\s+[1-9][0-9,.]* cmUSD/);
  await p.screenshot({ path: `${shots}2-pay.png`, fullPage: true });
  await clickText(p, 'Pay 25');
  await waitText(p, /Payment receipt/);
  await clickText(p, 'Decrypt my receipt');
  await waitText(p, /accepted — the merchant was paid/);
  results.payerReceipt = 'accepted';
  results.payerTxGasLimits = await p.evaluate(() => window.__gasSent);
  await p.screenshot({ path: `${shots}3-receipt.png`, fullPage: true });

  // 3. A tampered link is flagged and cannot be paid.
  const tampered = link.replace(/a=\d+/, 'a=1000000');
  const t = await open('payer', tampered.slice(tampered.indexOf('#')));
  await waitText(t, /This link was modified/);
  results.tamperedLinkBlocked = await t.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Pay'))?.disabled === true);

  // 4. Merchant dashboard: decrypt, add an auditor, publish the paid flag.
  await m.bringToFront();
  await m.goto(`${APP}#/dashboard`, { waitUntil: 'networkidle0' });
  await clickText(m, 'Connect wallet');
  await waitText(m, /Decrypt all/);
  await clickText(m, 'Decrypt all');
  await waitText(m, /Decrypted locally/);
  const dash = await text(m);
  results.dashboardShowsAmount = /25 cmUSD/.test(dash);
  results.dashboardShowsPaid = /\bpaid\b/.test(dash) && /accepted/.test(dash);
  await m.screenshot({ path: `${shots}4-dashboard.png`, fullPage: true });
  await clickText(m, 'Add viewer');
  await waitText(m, /Send them:/);
  await clickText(m, 'Publish paid status');
  await waitText(m, /Published\. Public check/);
  const invoiceId = new URL(link).hash.match(/id=(0x[0-9a-f]{64})/)[1];

  // 5. Public check, no wallet needed.
  const c = await open('payer', `#/check?c=31337&id=${invoiceId}`);
  await waitText(c, /PAID/);
  results.publicCheck = 'PAID';
  await clickText(c, 'Record this proof on chain');
  await waitText(c, /proven on chain/);
  results.publicCheckRecorded = true;
  await c.screenshot({ path: `${shots}5-public-check.png`, fullPage: true });

  // 6. Auditor sees exactly this invoice.
  const a = await open('auditor', `#/audit?c=31337&id=${invoiceId}`);
  await clickText(a, 'Connect wallet and decrypt');
  await waitText(a, /Decrypted for/);
  results.auditorSeesAmount = /25 cmUSD/.test(await text(a));
  await a.screenshot({ path: `${shots}6-auditor.png`, fullPage: true });

  // 7. A stranger (the payer's account here) cannot use the auditor view.
  const s = await open('payer', `#/audit?c=31337&id=${invoiceId}`);
  await clickText(s, 'Connect wallet and decrypt');
  await waitText(s, /not allowed|not authorized|NOT_ENTITLED|Retry/i);
  results.strangerDenied = !/Decrypted for/.test(await text(s));
} finally {
  results.problems = problems;
  writeFileSync(fileURLToPath(new URL('../../e2e-results/browser-local.json', import.meta.url)), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
