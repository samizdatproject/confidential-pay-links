// Headless check of EIP-6963 wallet selection with two fake wallets. "Phantom (fake)" also grabs window.ethereum and
// rejects everything; "MetaMask (fake)" forwards to anvil. The app must ask, use the chosen wallet, remember it, and
// ask again after "switch wallet".
//
//   ../scripts/local-chain.sh && npx vite build --mode development && (npx vite preview --port 4173 &) && node e2e/wallet-picker.mjs
import puppeteer from 'puppeteer-core';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:4173/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function fakeWallets(account, rpc) {
  let id = 0;
  const icon = (c) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="${c}"/></svg>`)}`;
  const good = {
    on() {}, removeListener() {},
    async request({ method, params }) {
      window.__used = 'metamask';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    },
  };
  const hijacker = { on() {}, removeListener() {}, async request() { window.__used = 'phantom'; throw Object.assign(new Error('Phantom (fake) was used'), { code: 4001 }); } };
  window.ethereum = hijacker; // what Phantom does
  const announce = () => {
    for (const [info, provider] of [
      [{ uuid: 'p-1', name: 'Phantom (fake)', icon: icon('#ab9ff2'), rdns: 'app.phantom' }, hijacker],
      [{ uuid: 'm-1', name: 'MetaMask (fake)', icon: icon('#f6851b'), rdns: 'io.metamask' }, good],
    ]) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const res = {};
const problems = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  await page.evaluateOnNewDocument(fakeWallets, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 'http://127.0.0.1:8545');
  await page.goto(`${APP}#/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  const create = async () => {
    await page.$eval('#amount', (e) => (e.value = ''));
    await page.type('#amount', '3');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Create'))?.click());
  };
  const pickerNames = () => page.evaluate(() => [...document.querySelectorAll('.wallet-picker .wallet-option')].map((b) => b.textContent));

  await create();
  await page.waitForSelector('.wallet-picker', { timeout: 10_000 });
  res.pickerShows = await pickerNames();
  res.iconsAreImgs = await page.evaluate(() => [...document.querySelectorAll('.wallet-picker img')].every((i) => i.src.startsWith('data:image/')));
  await page.evaluate(() => [...document.querySelectorAll('.wallet-option')].find((b) => b.textContent.includes('MetaMask'))?.click());
  await page.waitForFunction(() => /Your payment link/.test(document.querySelector('main').innerText), { timeout: 90_000, polling: 250 });
  res.createdWithChosenWallet = await page.evaluate(() => window.__used);
  res.headerShows = await page.$eval('#wallet-status', (e) => e.textContent);

  await page.reload({ waitUntil: 'networkidle0' });
  await create();
  await page.waitForFunction(() => /Your payment link/.test(document.querySelector('main').innerText), { timeout: 90_000, polling: 250 });
  res.rememberedNoPicker = (await page.$('.wallet-picker')) === null && (await page.evaluate(() => window.__used)) === 'metamask';

  await page.evaluate(() => [...document.querySelectorAll('#wallet-status a')].find((a) => a.textContent === 'switch wallet')?.click());
  res.headerClearedAfterSwitch = (await page.$eval('#wallet-status', (e) => e.textContent)) === '';
  await create();
  await page.waitForSelector('.wallet-picker', { timeout: 10_000 });
  res.pickerAgainAfterSwitch = (await pickerNames()).length === 2;
  res.ok = res.pickerShows.length === 2 && res.iconsAreImgs && res.createdWithChosenWallet === 'metamask' &&
    /MetaMask \(fake\)/.test(res.headerShows) && res.rememberedNoPicker && res.headerClearedAfterSwitch && res.pickerAgainAfterSwitch;
} finally {
  res.problems = problems;
  console.log(JSON.stringify(res, null, 2));
  await browser.close();
  if (!res.ok) process.exitCode = 1;
}
