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
    const r = await send('start', { usernames: $('#users').value, minScore: Number($('#minScore').value) || 0, filters: {} });
    $('#msg').textContent = `Queued ${r.added} account(s)${r.skipped ? `, ${r.skipped} already queued` : ''}.`;
    if (r.added) { $('#users').value = ''; localStorage.removeItem('sf-draft'); }
    refresh();
  } catch (e) { $('#msg').textContent = '⚠ ' + e.message; }
};
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
