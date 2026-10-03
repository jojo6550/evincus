const count = document.getElementById('count');
document.querySelectorAll('[data-add]').forEach(c => c.addEventListener('click', e => {
  e.preventDefault();
  count.value = (+count.value || 0) + 1;
  count.textContent = count.value;
}));
document.getElementById('signup').addEventListener('submit', e => {
  e.preventDefault();
  const v = document.getElementById('email').value.trim();
  document.getElementById('note').textContent = /.+@.+\..+/.test(v) ? "You're on the list. Demo only, nothing was sent." : 'Enter a valid email address.';
});
