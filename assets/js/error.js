// Error pages: show the path that failed and offer a retry on 5xx pages.
const path = document.getElementById('errPath');
if (path) path.textContent = location.pathname + location.search;
const retry = document.getElementById('retry');
if (retry) retry.addEventListener('click', () => location.reload());
