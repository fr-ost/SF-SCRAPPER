export function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from background'));
      if (!res.ok) return reject(new Error(res.error));
      resolve(res.data);
    });
  });
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const fmt = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString());
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

export function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function usageHtml(st) {
  const used = st.usage?.count || 0;
  const lim = st.settings?.monthlyLimit || 1;
  const pct = Math.min(100, (used / lim) * 100);
  return `<div class="k">Requests this month (${esc(st.usage?.month || '')})</div>
    <div class="v">${fmt(used)} <span class="muted small">/ ${fmt(lim)}</span></div>
    <div class="bar"><i style="width:${pct.toFixed(2)}%"></i></div>`;
}

export function statusLine(st) {
  if (st.running) {
    const p = st.pausedFor > 0 ? ` · paused ${Math.ceil(st.pausedFor / 1000)}s (rate limit)` : '';
    return `<span class="badge running">RUNNING</span> ${fmt(st.rpmNow)} req/min · ${fmt(st.inflight)} in flight${p}`;
  }
  const paused = st.counts?.paused || 0;
  if (paused) return `<span class="badge paused">PAUSED</span> ${paused} account(s) can be resumed${st.stopReason ? ' · ' + esc(st.stopReason) : ''}`;
  return `<span class="badge">IDLE</span>${st.stopReason ? ' <span class="muted">' + esc(st.stopReason) + '</span>' : ''}`;
}

export function jobRow(j) {
  const reason = j.error || j.stopWhy || '';
  return `<tr>
    <td><a href="https://x.com/${esc(j.source)}" target="_blank">@${esc(j.source)}</a></td>
    <td><span class="badge ${esc(j.status)}">${esc(j.status)}</span></td>
    <td class="num">${fmt(j.minScore)}</td>
    <td class="num">${fmt(j.pagesDone)}${j.totalPages ? '/' + fmt(j.totalPages) : ''}</td>
    <td class="num">${fmt(j.requests)}</td>
    <td class="num">${fmt(j.found)}${j.total ? ' <span class="muted small">/ ' + fmt(j.total) + '</span>' : ''}</td>
    <td class="num"><b>${fmt(j.saved)}</b></td>
    <td class="num">${fmt(j.newAccounts)}</td>
    <td class="num">${fmt(j.skipped)}</td>
    <td class="small ${j.error ? '' : 'muted'}" style="${j.error ? 'color:var(--err)' : ''}">${esc(reason)}${j.failed ? ` · ${j.failed} failed page(s)` : ''}</td>
  </tr>`;
}

export const JOB_HEAD = `<tr><th>Account</th><th>Status</th><th class="num">Min</th><th class="num">Pages</th><th class="num">Req</th><th class="num">Found</th><th class="num">Saved</th><th class="num">New</th><th class="num">Skipped</th><th>Note</th></tr>`;

/** Big run/stop toggle: green pulsing while running (click = stop), "Run" when idle/paused (click = resume). */
export function bindRunToggle(btn, onChange) {
  let running = false;
  btn.onclick = async () => {
    btn.disabled = true;
    try { await send(running ? 'stop' : 'resume'); } finally { btn.disabled = false; onChange && onChange(); }
  };
  return (st) => {
    running = st.running;
    const paused = !st.running && (st.counts?.paused || 0) > 0;
    btn.classList.toggle('on', st.running);
    btn.classList.toggle('paused', paused);
    btn.textContent = st.running ? '● Running · Stop' : paused ? '▶ Resume' : '▶ Run';
    btn.title = st.running ? 'Click to stop' : paused ? 'Resume paused scans' : 'Start/resume queued scans';
  };
}
