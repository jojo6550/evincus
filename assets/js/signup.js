// Footer newsletter form. The API sends a confirm email; nothing is sent until the address is confirmed.
import { api } from './api.js';

export function initSignup() {
  const form = document.getElementById('signup');
  if (!form) return;
  const input = form.querySelector('#email');
  const note = document.getElementById('note');
  const button = form.querySelector('button');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      note.textContent = 'Enter a valid email address.';
      input.focus();
      return;
    }
    button.disabled = true;
    note.textContent = 'Signing you up…';
    try {
      await api('POST', '/api/newsletter/subscribe', { email, company: form.elements.company?.value ?? '' });
      form.reset();
      note.textContent = 'Check your inbox and tap Confirm to get on the list.';
    } catch (err) {
      note.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}
