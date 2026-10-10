// Headless check: one fake wallet with two accounts (anvil #1 merchant, #2 payer). The active account is switched
// with accountsChanged and with "switch account" (wallet_requestPermissions). The app must re-render, sign every
// transaction from the active account, show the faucet and the testnet wrong-amount control, and refund it.
//
//   ../scripts/local-chain.sh && npx vite build --mode development && (npx vite preview --port 4173 &) && node e2e/accounts.mjs
import puppeteer from 'puppeteer-core';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:4173/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const A1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const A2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

function wallet(accounts, rpc) {
  let id = 0;
  let active = Number(sessionStorage.getItem('fake-active') ?? 0);
  const listeners = {};
  window.__sent = [];
  const emit = (e, v) => (listeners[e] ?? []).forEach((l) => l(v));
  window.__switch = (i) => {
    active = i;
    sessionStorage.setItem('fake-active', String(i));
    emit('accountsChanged', [accounts[i]]);
  };
  window.ethereum = {
    on: (e, l) => ((listeners[e] ??= []).push(l)),
    removeListener: (e, l) => (listeners[e] = (listeners[e] ?? []).filter((x) => x !== l)),
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [accounts[active]];
      if (method === 'wallet_requestPermissions') {
        window.__permissionsAsked = (window.__permissionsAsked ?? 0) + 1;
        window.__switch(1 - active); // the "account chooser" picks the other account
        return [{ parentCapability: 'eth_accounts' }];
      }
      if (method === 'eth_sendTransaction') window.__sent.push({ from: params[0].from, active: accounts[active], gas: params[0].gas });
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    },
  };
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const res = { problems: [] };
const page = await browser.newPage();
page.on('pageerror', (e) => res.problems.push(e.message));
page.on('dialog', (d) => d.accept());
await page.evaluateOnNewDocument(wallet, [A1, A2], 'http://127.0.0.1:8545');
const text = () => page.evaluate(() => document.querySelector('main').innerText);
const header = () => page.$eval('#wallet-status', (e) => e.textContent);
const waitText = async (re, t = 90_000) => {
  try {
    await page.waitForFunction((s) => new RegExp(s).test(document.querySelector('main').innerText), { timeout: t, polling: 250 }, re.source);
  } catch {
    throw new Error(`timeout waiting for ${re}\n${await text()}`);
  }
};
const click = (label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(l) && !x.disabled);
  b?.click();
  return Boolean(b);
}, label);
try {
  await page.goto(`${APP}#/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => sessionStorage.setItem('fake-active', '0'));
  await page.type('#amount', '5');
  await click('Create');
  await waitText(/Your payment link/);
  const link = await page.$eval('.out input', (i) => i.value);
  res.headerAsMerchant = await header();

  await page.goto(link, { waitUntil: 'networkidle0' });
  await waitText(/Payment request/);
  res.faucetVisible = /Mint & wrap test/.test(await text());
  res.testControlVisible = /pay a different amount to see a refund/.test(await text());

  // Switch to account 2 in the wallet: the app must follow.
  await page.evaluate(() => window.__switch(1));
  await page.waitForFunction((a) => document.querySelector('#wallet-status')?.textContent.includes(a), { timeout: 10_000 }, A2.slice(0, 6));
  res.headerAfterSwitch = await header();
  await waitText(/Mint & wrap test/);
  await click('Mint & wrap');
  await waitText(/Minted and wrapped 100 cmUSD for 0x3C44/);
  await waitText(/Confidential balance\s+[1-9][\d.,]* cmUSD \(0x3C44/);
  res.balanceShownForPayer = true;

  // Testnet control: pay a different amount -> refunded.
  await page.evaluate(() => document.querySelector('.test-box').setAttribute('open', ''));
  await page.click('#test-wrong');
  await page.type('#test-amount', '1');
  res.payButtonInTestMode = await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Pay'))?.textContent);
  await click('Pay 1 cmUSD');
  await waitText(/Payment receipt/);
  await click('Decrypt my receipt');
  await waitText(/refunded — your tokens came back/);
  res.wrongAmountRefunded = true;

  // Exact payment as account 2.
  await page.goto(link, { waitUntil: 'networkidle0' });
  await waitText(/Payment request/);
  await click('Pay 5 cmUSD');
  await waitText(/Payment receipt/);
  await click('Decrypt my receipt');
  await waitText(/accepted — the merchant was paid/);
  res.exactAccepted = true;

  // "switch account" asks the wallet for permissions (MetaMask's account chooser) and follows the result.
  await page.evaluate(() => [...document.querySelectorAll('#wallet-status a')].find((a) => a.textContent === 'switch account').click());
  await page.waitForFunction((a) => document.querySelector('#wallet-status')?.textContent.includes(a), { timeout: 10_000 }, A1.slice(0, 6));
  res.permissionsAsked = await page.evaluate(() => window.__permissionsAsked);
  res.headerAfterSwitchAccount = await header();

  const sent = await page.evaluate(() => window.__sent);
  res.txCount = sent.length;
  res.everyTxFromActiveAccount = sent.every((t) => t.from?.toLowerCase() === t.active.toLowerCase());
  res.payerTxs = sent.filter((t) => t.from?.toLowerCase() === A2.toLowerCase()).length;
  res.ok = res.faucetVisible && res.testControlVisible && /0x3C44/.test(res.headerAfterSwitch) && res.wrongAmountRefunded &&
    res.exactAccepted && res.permissionsAsked >= 1 && /0x7099/.test(res.headerAfterSwitchAccount) && res.everyTxFromActiveAccount && res.payerTxs === 5;
} catch (e) {
  res.error = String(e.message ?? e).slice(0, 1500);
} finally {
  console.log(JSON.stringify(res, null, 2));
  await browser.close();
  if (!res.ok) process.exitCode = 1;
}
