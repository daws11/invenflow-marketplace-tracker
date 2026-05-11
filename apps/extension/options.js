const $ = (id) => document.getElementById(id);

function show(kind, text) {
  const m = $('msg');
  m.style.display = 'block';
  m.className = 'msg ' + (kind || '');
  m.textContent = text;
}

function normalizeUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/** Ask for host permission for the tracker origin so background fetch works
 *  without CORS. Returns true if granted (or already held), false otherwise. */
async function ensurePermission(url) {
  try {
    const origin = new URL(url).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    // Some origins (e.g. localhost) may not need it; don't block on errors.
    return true;
  }
}

(async () => {
  const { trackerBaseUrl, extensionKey } = await chrome.storage.sync.get(['trackerBaseUrl', 'extensionKey']);
  $('url').value = trackerBaseUrl || 'https://tracker.ptunicorn.id';
  if (extensionKey) $('key').value = extensionKey;
})();

$('save').addEventListener('click', async () => {
  const url = normalizeUrl($('url').value);
  const key = $('key').value.trim();
  if (!/^https?:\/\//.test(url)) {
    show('err', 'Enter a valid http(s) URL.');
    return;
  }
  if (!key) {
    show('err', 'Enter the extension key.');
    return;
  }
  const granted = await ensurePermission(url);
  if (granted === false) {
    show('err', 'Host permission for the tracker URL was not granted; the extension cannot reach it.');
    return;
  }
  await chrome.storage.sync.set({ trackerBaseUrl: url, extensionKey: key });
  chrome.runtime.sendMessage({ type: 'configChanged' }, () => void chrome.runtime.lastError);
  show('ok', 'Saved.');
});

$('test').addEventListener('click', async () => {
  const url = normalizeUrl($('url').value);
  const key = $('key').value.trim();
  if (!/^https?:\/\//.test(url) || !key) {
    show('err', 'Fill in the URL and key first.');
    return;
  }
  const granted = await ensurePermission(url);
  if (granted === false) {
    show('err', 'Host permission for the tracker URL was not granted.');
    return;
  }
  show('', 'Testing…');
  try {
    const res = await fetch(url + '/api/extension/accounts', { headers: { 'x-extension-key': key } });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      show('err', `HTTP ${res.status}` + (body && body.error ? ` — ${body.error}` : ''));
      return;
    }
    const n = (body && body.accounts && body.accounts.length) || 0;
    show('ok', `OK — ${n} account(s) configured in the tracker.`);
  } catch (e) {
    show('err', 'Request failed: ' + ((e && e.message) || e));
  }
});
