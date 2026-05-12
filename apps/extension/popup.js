const listEl = document.getElementById('list');

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render(statuses) {
  if (!statuses || statuses.length === 0) {
    listEl.innerHTML =
      '<p>No accounts yet. Set the tracker URL + key in Options, and make sure accounts exist in the tracker (Accounts page).</p>';
    return;
  }
  listEl.innerHTML = '';
  for (const s of [...statuses].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))) {
    const state = s.state || 'idle';
    const div = document.createElement('div');
    div.className = 'acct';
    div.innerHTML =
      `<span class="state s-${escapeHtml(state)}">${escapeHtml(state)}</span>` +
      `<div class="name">${escapeHtml(s.name || s.accountId)}</div>` +
      `<div class="meta">${escapeHtml(s.platform || '')} · last: ${fmtTime(s.lastFinishedAt)}` +
      (s.orderCount != null ? ` · ${s.orderCount} orders` : '') +
      (s.newOrderCount != null ? ` (${s.newOrderCount} new)` : '') +
      `</div>` +
      `<div class="meta">next: ${fmtTime(s.nextRunAt)}</div>` +
      (s.lastError ? `<div class="meta err">${escapeHtml(s.lastError)}</div>` : '');
    const btn = document.createElement('button');
    btn.className = 'sm';
    btn.textContent = 'Scrape now';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Running…';
      chrome.runtime.sendMessage({ type: 'scrapeNow', accountId: s.accountId }, () => {
        setTimeout(refresh, 1500);
      });
    });
    div.appendChild(btn);
    listEl.appendChild(div);
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
    if (chrome.runtime.lastError) {
      listEl.textContent = 'Background not ready — try reopening the popup.';
      return;
    }
    render(resp && resp.statuses);
  });
}

document.getElementById('all').addEventListener('click', (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Running…';
  chrome.runtime.sendMessage({ type: 'scrapeNow' }, () => setTimeout(refresh, 1500));
});
document.getElementById('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 3000);
