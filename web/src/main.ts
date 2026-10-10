import './style.css';
import { viewAudit, viewCheck, viewCreate, viewDashboard, viewHow, viewMyPayments, viewPay, viewReceipt } from './views';

function route() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  if (path === '/pay') return void viewPay(query);
  if (path === '/receipt') return void viewReceipt(query);
  if (path === '/receipts') return void viewMyPayments();
  if (path === '/dashboard') return viewDashboard();
  if (path === '/check') return void viewCheck(query);
  if (path === '/audit') return void viewAudit(query);
  if (path === '/how') return viewHow();
  return viewCreate();
}
window.addEventListener('hashchange', route);
route();
