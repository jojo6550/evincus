import { products, site } from '../assets/js/store.js';
import { card } from '../assets/js/ui.js';

export const home = {
  render() {
    const LOOKBOOK = site().lookbook;
    const drop = products().filter(p => p.era === 'catastrophe');
    const more = products().filter(p => p.era !== 'catastrophe').slice(0, 4);
    return /* html */`
<section class="hero" aria-label="Catastrophe Collection">
  <div class="hero-photo"><img src="${LOOKBOOK[0]}" alt="Model wearing the Disaster Zone Tee" fetchpriority="high"></div>
  <div class="flash" aria-hidden="true"></div>
  <div class="wrap hero-copy">
    <p class="hero-kicker">The Catastrophe Collection is out now.</p>
    <h1 class="hero-word">Evincus</h1>
    <div class="hero-actions">
      <a href="#/shop" class="btn btn-light">Shop the collection</a>
      <button type="button" class="btn btn-line" data-scroll="lookbook">See the lookbook</button>
    </div>
  </div>
</section>

<section class="block">
  <div class="wrap">
    <div class="block-head">
      <h2 class="display-md">Catastrophe</h2>
      <p class="block-sub">Zip fleece, heavyweight cotton and distressed washes. In black, brown and bold prints.</p>
    </div>
    <div class="grid grid-drop">
      ${drop.map((p, i) => card(p, { eager: i < 2 })).join('')}
    </div>
  </div>
</section>

<section class="lookbook" id="lookbook" aria-label="Lookbook">
  <div class="wrap block-head">
    <h2 class="display-md">Lookbook</h2>
    <p class="block-sub">Scroll sideways for more.</p>
  </div>
  <div class="strip" tabindex="0" aria-label="Lookbook photos, scroll horizontally">
    ${LOOKBOOK.map((src, i) => `<figure class="strip-item${i === 0 ? ' strip-wide' : ''}"><img src="${src}" alt="Evincus lookbook photo ${i + 1}" loading="lazy"></figure>`).join('')}
  </div>
</section>

<section class="block">
  <div class="wrap">
    <div class="block-head">
      <h2 class="display-md">Staples</h2>
      <a href="#/shop" class="link">Shop everything</a>
    </div>
    <div class="grid">
      ${more.map(p => card(p)).join('')}
    </div>
  </div>
</section>

<section class="statement" aria-label="About Evincus">
  <div class="wrap">
    <p class="statement-text">Streetwear for the bold, with effortless comfort and style.</p>
    <p class="statement-sign">Be you.</p>
    <a href="#/about" class="btn btn-dark">About Evincus</a>
  </div>
</section>

<section class="block socials">
  <div class="wrap">
    <h2 class="display-md">Catch the next drop first</h2>
    <p class="block-sub">Drops, restocks and collabs land on our socials before anywhere else.</p>
    <div class="social-links">
      <a href="https://www.instagram.com/evincus.sw/" target="_blank" rel="noopener noreferrer" class="social">
        <span>Instagram</span><span class="social-handle">@evincus.sw</span>
      </a>
      <a href="https://www.tiktok.com/@_evincus_" target="_blank" rel="noopener noreferrer" class="social">
        <span>TikTok</span><span class="social-handle">@_evincus_</span>
      </a>
    </div>
  </div>
</section>`;
  },

  init() {
    document.querySelector('[data-scroll="lookbook"]')?.addEventListener('click', () => {
      document.getElementById('lookbook').scrollIntoView({ behavior: 'smooth' });
    });
    // Flash plays once per visit; returning to Home doesn't re-flash.
    const hero = document.querySelector('.hero');
    if (sessionStorageGet('evincus_flashed')) hero.classList.add('no-flash');
    else sessionStorageSet('evincus_flashed', '1');
  },
};

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }
