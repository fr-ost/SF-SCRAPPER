import { send, $, fmt, esc, usageHtml, statusLine, bindRunToggle } from './common.js';

const openDash = (hash = '') => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html' + hash) });
$('#openDash').onclick = () => openDash();
$('#toSettings').onclick = (e) => { e.preventDefault(); openDash('#settings'); };

const draft = localStorage.getItem('sf-draft');
if (draft) $('#users').value = draft;
$('#users').oninput = () => localStorage.setItem('sf-draft', $('#users').value);

send('getSettings').then((s) => { $('#minScore').value = s.defaultMinScore || 0; }).catch(() => {});

$('#start').onclick = async () => {
  $('#msg').textContent = '';
  try {
    const r = await send('start', { usernames: $('#users').value, minScore: Number($('#minScore').value) || 0, filters: {}, skipScanned: $('#skipScanned').checked });
    $('#msg').textContent = startMsg(r);
    if (r.added) { $('#users').value = ''; localStorage.removeItem('sf-draft'); }
    refresh();
  } catch (e) { $('#msg').textContent = '⚠ ' + e.message; }
};
function startMsg(r) {
  const parts = [`Queued ${r.added} account(s)`];
  if (r.alreadyScanned && r.alreadyScanned.length) parts.push(`⏭ skipped ${r.alreadyScanned.length} already scanned: ${r.alreadyScanned.slice(0, 5).map((s) => '@' + s).join(', ')}${r.alreadyScanned.length > 5 ? '…' : ''} (untick "Skip accounts already scanned" to rescan)`);
  if (r.busy) parts.push(`${r.busy} already in the queue`);
  return parts.join(' · ');
}
chrome.storage.local.get('settings').then(({ settings }) => { if (settings && settings.skipScanned === false) $('#skipScanned').checked = false; });
$('#skipScanned').onchange = () => send('saveSettings', { settings: { skipScanned: $('#skipScanned').checked } }).catch(() => {});
const updateToggle = bindRunToggle($('#runToggle'), () => refresh());
$('#saveDefault').onclick = async () => {
  try {
    await send('saveSettings', { settings: { defaultMinScore: Number($('#minScore').value) || 0 } });
    $('#msg').textContent = `💾 Saved: min score ${Number($('#minScore').value) || 0} is now the default`;
  } catch (e) { $('#msg').textContent = '⚠ ' + e.message; }
};

async function refresh() {
  try {
    const st = await send('getState');
    $('#noKey').hidden = st.settings.hasKey;
    updateToggle(st);
    $('#status').innerHTML = statusLine(st);
    $('#usage').innerHTML = usageHtml(st);
    $('#saved').textContent = fmt(st.stats.saved);
    $('#newAcc').textContent = fmt(st.stats.newAccounts);
    $('#jobs').innerHTML = st.jobs.slice(0, 8).map((j) => `<tr>
      <td>@${esc(j.source)}</td><td><span class="badge ${esc(j.status)}">${esc(j.status)}</span></td>
      <td class="num">${fmt(j.saved)}</td><td class="num">${fmt(j.requests)}</td></tr>`).join('') ||
      '<tr><td colspan="4" class="muted">No scans yet</td></tr>';
  } catch (e) { $('#status').textContent = e.message; }
}
refresh();
setInterval(refresh, 700);
