import './style.css';
import { startDiscovery } from './discovery';
import { viewAudit, viewCheck, viewCreate, viewDashboard, viewFaucet, viewHow, viewMyPayments, viewPay, viewReceipt } from './views';
import { restoreWallet, WALLET_CHANGED } from './wallet';

function route() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  if (path === '/pay') return void viewPay(query);
  if (path === '/receipt') return void viewReceipt(query);
  if (path === '/receipts') return void viewMyPayments();
  if (path === '/dashboard') return viewDashboard();
  if (path === '/check') return void viewCheck(query);
  if (path === '/audit') return void viewAudit(query);
  if (path === '/how') return viewHow();
  if (path === '/faucet') return viewFaucet();
  return viewCreate();
}
// Ask EIP-6963 wallets to announce themselves early, so the picker is ready on the first click.
startDiscovery();
void restoreWallet().catch(() => undefined);
window.addEventListener('hashchange', route);
// Account or chain changed in the wallet: re-render, so no view keeps a stale account or decrypted values.
window.addEventListener(WALLET_CHANGED, route);
route();
