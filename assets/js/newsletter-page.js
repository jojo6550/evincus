// newsletter.html: confirms a signup on load, or unsubscribes after a button press so link scanners can't.
import { api } from './api.js';

const q = new URLSearchParams(location.search);
const action = q.get('a');
const params = { id: q.get('id') ?? '', t: q.get('t') ?? '' };
const title = document.getElementById('nlTitle');
const text = document.getElementById('nlText');
const button = document.getElementById('nlAction');

const show = (heading, body) => { title.textContent = heading; text.textContent = body; };

async function confirm() {
  show('Confirming…', 'One second.');
  try {
    await api('POST', '/api/newsletter/confirm', params);
    show("You're on the list", "Drops, sales and early access land in your inbox first. One email a day at most, only when something's new.");
  } catch (err) {
    show("That didn't work", err.message);
  }
}

function unsubscribe() {
  show('Unsubscribe?', "You'll stop getting What's new emails from Evincus.");
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api('POST', '/api/newsletter/unsubscribe', params);
      button.hidden = true;
      show("You're unsubscribed", 'No more emails. Changed your mind? Sign up again at the bottom of the store page.');
    } catch (err) {
      button.disabled = false;
      show("That didn't work", err.message);
    }
  }, { once: true });
}

if (action === 'confirm') confirm();
else if (action === 'unsubscribe') unsubscribe();
else show('Nothing to do here', 'This page handles links from Evincus emails.');
