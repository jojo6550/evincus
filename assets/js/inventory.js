import { api, onSignedOut } from './inventory-api.js';

const $ = id => document.getElementById(id);
const TABS = [
  { name: 'inventory', label: 'Inventory' },
  { name: 'orders', label: 'Orders' },
  { name: 'stats', label: 'Stats' },
  { name: 'finances', label: 'Finances', ownerOnly: true },
  { name: 'logs', label: 'Logs', ownerOnly: true },
];
const registry = new Map();
let me = null;
let current = null; // { name, tab } of the rendered tab; survives the sign-in overlay

// The signed-in account ({ email, role, local }), or null.
export const staff = () => me;

// Later tasks fill a tab: registerTab('orders', { render(el, params), canLeave?() }).
export function registerTab(name, tab) {
  registry.set(name, tab);
  if (me && current?.name === name) route();
}

const visibleTabs = () => TABS.filter(t => !t.ownerOnly || me?.role === 'owner');

function parseHash() {
  const [name, ...rest] = location.hash.slice(1).split('/');
  const tab = visibleTabs().find(t => t.name === name);
  try { if (tab) return { name, params: rest.map(decodeURIComponent) }; } catch { /* malformed escape: fall back below */ }
  return { name: 'inventory', params: [], fallback: true };
}

function drawTabs(active) {
  $('tabs').replaceChildren(...visibleTabs().map(t => {
    const a = document.createElement('a');
    a.href = `#${t.name}`;
    a.textContent = t.label;
    if (t.name === active) a.setAttribute('aria-current', 'page');
    return a;
  }));
}

function route() {
  const { name, params, fallback } = parseHash();
  if (fallback && location.hash !== '#inventory') { location.replace('#inventory'); return; }
  drawTabs(name);
  const view = $('view');
  const tab = registry.get(name);
  current = { name, tab };
  view.replaceChildren();
  const note = text => {
    const p = document.createElement('p');
    p.className = 'soon';
    p.textContent = text;
    view.append(p);
  };
  if (!tab) return note('Coming soon.');
  try { tab.render(view, params); }
  catch { view.replaceChildren(); note('This tab failed to load. Reload the page to try again.'); }
}

let lastHash = '';
let reverting = false;
function onHashChange() {
  if (reverting) { reverting = false; return; }
  if (!me) return;
  // A tab with unsaved work can veto leaving; put the address back.
  if (current?.tab?.canLeave && !current.tab.canLeave()) { reverting = true; location.hash = lastHash; return; }
  lastHash = location.hash;
  route();
}

let lastEmail = '';
let returnFocus = null;

function showLogin(note) {
  // A second signed-out while the form is up must not wipe a password being typed.
  if (!$('login').hidden) { if (note) $('login-error').textContent = note; return; }
  returnFocus = document.activeElement;
  $('shell').inert = true;
  $('login').hidden = false;
  $('login-error').textContent = note ?? '';
  $('login-password').value = '';
  if (lastEmail) $('login-email').value = lastEmail;
  (lastEmail ? $('login-password') : $('login-email')).focus();
}

function hideLogin() {
  $('login').hidden = true;
  $('shell').inert = false;
  if (returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
}

function showShell() {
  $('shell').hidden = false;
  $('who').textContent = me.email;
  $('local').hidden = !me.local;
}

async function loadMe() {
  me = await api('GET', '/api/inventory/me');
  lastEmail = me.email;
  showShell();
}

async function boot() {
  try { await loadMe(); }
  catch (err) {
    // signed-out shows the login form via onSignedOut. Anything else is a real failure to tell about.
    if (err.code !== 'signed-out') showLogin(err.message);
    return;
  }
  hideLogin();
  lastHash = location.hash;
  route();
}

onSignedOut(() => showLogin(me ? 'Your session ended. Sign in again.' : ''));

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const button = $('login-submit');
  const wasIn = me !== null;
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    await api('POST', '/api/inventory/login', { email: $('login-email').value.trim(), password: $('login-password').value });
    $('login-form').reset();
    await loadMe();
  } catch (err) {
    $('login-error').textContent = err.code === 'login-failed' ? 'Wrong email or password.'
      : err.code === 'rate-limited' ? 'Too many attempts. Wait a few minutes and try again.' : err.message;
    $('login-password').value = '';
    $('login-password').focus();
    return;
  } finally {
    button.disabled = false;
  }
  hideLogin();
  lastHash = location.hash;
  route(); // same route as before; a fresh sign-in as someone else must not inherit the old tab
  if (!wasIn) $('view').focus();
});

$('signout').addEventListener('click', async () => {
  $('bar-error').textContent = '';
  try { await api('POST', '/api/inventory/logout', {}); }
  catch { $('bar-error').textContent = "Couldn't sign out. You are still signed in. Try again."; return; }
  me = null;
  current = null;
  $('view').replaceChildren();
  $('shell').hidden = true;
  showLogin();
});

window.addEventListener('hashchange', onHashChange);
boot();
