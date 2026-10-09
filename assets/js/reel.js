// Model reel: native scroll-snap track; autoplay advances when the active dot's fill animation ends,
// so pausing the animation (hover, focus, offscreen, hidden tab, reduced motion) pauses the slideshow.
export function initReel() {
  const root = document.getElementById('models');
  const track = document.getElementById('reelTrack');
  if (!root || !track) return;
  const slides = [...track.children];
  const dotsEl = document.getElementById('reelDots');
  const now = document.getElementById('reelNow');
  const play = document.getElementById('reelPlay');
  const wide = matchMedia('(min-width: 761px)');
  dotsEl.innerHTML = slides.map((_, i) => `<button type="button" class="reel__dot" aria-label="Show photo ${i + 1}"></button>`).join('');
  const dots = [...dotsEl.children];
  let active = -1, programmatic = 0, stopped = false, hovered = false, focused = false, visible = false;

  const snapLeft = s => wide.matches
    ? s.offsetLeft - parseFloat(getComputedStyle(track).paddingLeft)
    : s.offsetLeft - (track.clientWidth - s.offsetWidth) / 2;

  function setActive(i) {
    if (i === active) return;
    active = i;
    slides.forEach((s, j) => s.classList.toggle('is-on', j === i));
    dots.forEach((d, j) => {
      d.classList.toggle('is-done', j < i);
      d.classList.remove('is-on');
      d.toggleAttribute('aria-current', j === i);
    });
    void dots[i].offsetWidth; // restart the fill animation
    dots[i].classList.add('is-on');
    now.textContent = String(i + 1).padStart(2, '0');
  }

  function go(i) {
    i = (i + slides.length) % slides.length;
    setActive(i);
    clearTimeout(programmatic);
    programmatic = setTimeout(() => { programmatic = 0; }, 1500);
    track.scrollTo({ left: snapLeft(slides[i]), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  let raf = 0;
  track.addEventListener('scroll', () => {
    if (programmatic || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      let best = 0, dist = Infinity;
      slides.forEach((s, j) => { const d = Math.abs(snapLeft(s) - track.scrollLeft); if (d < dist) { dist = d; best = j; } });
      setActive(best);
    });
  }, { passive: true });
  track.addEventListener('scrollend', () => { clearTimeout(programmatic); programmatic = 0; });

  const sync = () => {
    root.classList.toggle('is-stopped', stopped);
    root.classList.toggle('is-paused', hovered || focused || !visible || document.hidden);
    play.setAttribute('aria-pressed', String(stopped));
    play.setAttribute('aria-label', stopped ? 'Play slideshow' : 'Pause slideshow');
    play.textContent = stopped ? '▶' : '❚❚';
  };

  dotsEl.addEventListener('animationend', e => { if (e.target === dots[active] && !stopped) go(active + 1); });
  dotsEl.addEventListener('click', e => { const i = dots.indexOf(e.target.closest('.reel__dot')); if (i >= 0) go(i); });
  document.getElementById('reelPrev').addEventListener('click', () => go(active - 1));
  document.getElementById('reelNext').addEventListener('click', () => go(active + 1));
  play.addEventListener('click', () => {
    stopped = !stopped;
    if (!stopped) { const i = active; active = -1; setActive(i); }
    sync();
  });
  track.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); go(active + (e.key === 'ArrowRight' ? 1 : -1)); }
  });
  track.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { hovered = true; sync(); } });
  track.addEventListener('pointerleave', () => { hovered = false; sync(); });
  // A touch swipe is a deliberate pick: stop autoplay so the slide doesn't move under the viewer's thumb.
  track.addEventListener('touchstart', () => { if (!stopped) { stopped = true; sync(); } }, { passive: true });
  root.addEventListener('focusin', e => { focused = e.target.matches(':focus-visible'); sync(); });
  root.addEventListener('focusout', e => { if (!root.contains(e.relatedTarget)) { focused = false; sync(); } });
  document.addEventListener('visibilitychange', sync);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); }, { threshold: .35 }).observe(root);
  wide.addEventListener('change', () => go(active));

  setActive(0);
  sync();
}
