import { site } from '../assets/js/store.js';

export const about = {
  render() {
    const LOOKBOOK = site().lookbook;
    return /* html */`
<section class="about-hero">
  <div class="wrap">
    <h1 class="display-xl">Be you.</h1>
    <p class="about-lede">Evincus is neo-gen alternative streetwear from Jamaica. Streetwear for the bold, with effortless comfort and style.</p>
  </div>
</section>

<section class="about-split">
  <div class="wrap about-grid">
    <figure class="about-photo"><img src="${LOOKBOOK[1]}" alt="Evincus lookbook" loading="lazy"></figure>
    <div class="about-copy">
      <h2 class="display-md">What we make</h2>
      <dl class="facts">
        <div><dt>Tees</dt><dd>Oversized, 100% cotton at 300 g/m². Heavy enough to hold its shape.</dd></div>
        <div><dt>Fleece</dt><dd>Cotton-blend fleece at 360 g/m² for the zip hoodie and sweatpants.</dd></div>
        <div><dt>Track sets</dt><dd>Striped jacket and pants in a cotton-rich 365 g/m² knit.</dd></div>
      </dl>
    </div>
  </div>
</section>

<section class="statement">
  <div class="wrap">
    <p class="statement-text">New drops, restocks and collabs are announced on Instagram and TikTok first.</p>
    <div class="social-links social-links-dark">
      <a href="https://www.instagram.com/evincus.sw/" target="_blank" rel="noopener noreferrer" class="social"><span>Instagram</span><span class="social-handle">@evincus.sw</span></a>
      <a href="https://www.tiktok.com/@_evincus_" target="_blank" rel="noopener noreferrer" class="social"><span>TikTok</span><span class="social-handle">@_evincus_</span></a>
    </div>
  </div>
</section>`;
  },
};
