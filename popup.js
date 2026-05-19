// popup.js — UI logic + XLSX/CSV generation

const $ = id => document.getElementById(id);

const state = {
  tab: null,
  mode: 'none',    // 'all' | 'single' | 'none'
  postId: null,
  exporting: false,
  startTime: 0,
  port: null,
  exportFormat: 'xlsx', // for single-story mode
  settings: {
    dateRange: 'all',
    includeZero: false,
    splitMembership: true,
    exportCsv: false
  }
};

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  applySettingsToUI();
  await detectMode();
  setupListeners();
  loadLastExport();
  await restoreCachedResult();
  connectToBackground(); // eager — catches in-progress or pending result
});

async function loadSettings() {
  const { popupSettings } = await chrome.storage.local.get('popupSettings');
  if (popupSettings) Object.assign(state.settings, popupSettings);
}

async function saveSettings() {
  await chrome.storage.local.set({ popupSettings: state.settings });
}

function applySettingsToUI() {
  $('include-zero').checked = state.settings.includeZero;
  $('split-membership').checked = state.settings.splitMembership;
  $('export-csv').checked = state.settings.exportCsv;
  document.querySelectorAll('.pill').forEach(p => {
    p.classList.toggle('active', p.dataset.val === state.settings.dateRange);
  });
}

async function detectMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  const url = tab?.url || '';

  const singleMatch = url.match(/medium\.com\/me\/stats\/post\/([a-f0-9]+)/);
  const allMatch = /medium\.com\/me\/stats\/?$/.test(url) || /medium\.com\/me\/stats\?/.test(url);

  if (singleMatch) {
    state.mode = 'single';
    state.postId = singleMatch[1];
    showMode('single');
    fetchStoryTitle(tab.id, state.postId);
  } else if (allMatch) {
    state.mode = 'all';
    showMode('all');
    fetchStoryCount(tab.id);
    fetchUserInfo(tab.id);
  } else {
    state.mode = 'none';
    showMode('none');
  }

  // Hide CSV toggle for single-story mode (has its own buttons instead)
  $('csv-toggle-row').classList.toggle('hidden', state.mode === 'single');
}

async function restoreCachedResult() {
  if (state.mode === 'none') return;
  const { lastResult } = await chrome.storage.local.get('lastResult');
  if (!lastResult) return;
  if (lastResult.mode !== state.mode) return;
  if (state.mode === 'single' && lastResult.postId !== state.postId) return;
  renderResultSummary(lastResult, true);
}

function showMode(mode) {
  ['none', 'all', 'single'].forEach(m => $(`mode-${m}`).classList.toggle('hidden', m !== mode));
}

async function fetchStoryTitle(tabId, postId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (pid) => {
        return document.querySelector('h1, h2')?.textContent?.trim() || pid;
      },
      args: [postId]
    });
    $('story-title').textContent = result;
  } catch {}
}

async function fetchStoryCount(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => new Set(
        [...document.querySelectorAll('a[href*="/stats/post/"]')]
          .map(a => a.href.match(/\/stats\/post\/([a-f0-9]+)/)?.[1])
          .filter(Boolean)
      ).size
    });
    if (result) $('story-count').textContent = `${result} stories found`;
  } catch {}
}

async function fetchUserInfo(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const avatar = document.querySelector('nav img[src*="cdn-images"], img[alt*="avatar"], .avatar img');
        const name = document.querySelector('[data-testid="headerUserName"], nav .username, [data-action="navigate-to-profile"] span')?.textContent?.trim();
        return { avatar: avatar?.src, name };
      }
    });
    if (result?.avatar) {
      const img = $('avatar');
      img.src = result.avatar;
      img.classList.remove('hidden');
    }
    if (result?.name) {
      const el = $('username');
      el.textContent = result.name;
      el.classList.remove('hidden');
    }
  } catch {}
}

function loadLastExport() {
  chrome.storage.local.get('lastExport', ({ lastExport }) => {
    if (!lastExport) return;
    const el = $('last-export');
    const diff = Math.floor((Date.now() - lastExport) / 86400000);
    const label = diff === 0 ? 'today' : diff === 1 ? 'yesterday' : `${diff} days ago`;
    el.textContent = `Last exported: ${label}`;
    el.classList.remove('hidden');
  });
}

// ── Date range ───────────────────────────────────────────────────────────────

function getDateRange(range) {
  const now = Date.now();
  const endAt = now + 86400000;
  const map = {
    '7d':  now - 7   * 86400000,
    '30d': now - 30  * 86400000,
    '6m':  now - 180 * 86400000,
    '1y':  now - 365 * 86400000,
    'all': 1325376000000
  };
  return { startAt: map[range] ?? 1325376000000, endAt };
}

// ── Listeners ────────────────────────────────────────────────────────────────

function setupListeners() {
  // Settings toggle
  $('settings-toggle').addEventListener('click', () => {
    $('settings-panel').classList.toggle('hidden');
  });

  // Date range pills
  document.querySelectorAll('.pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.settings.dateRange = pill.dataset.val;
      saveSettings();
    });
  });

  // Toggles
  ['include-zero', 'split-membership', 'export-csv'].forEach(id => {
    $(id).addEventListener('change', e => {
      const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      state.settings[key] = e.target.checked;
      saveSettings();
    });
  });

  // Export buttons
  $('export-all-btn')?.addEventListener('click', startExport);
  $('export-single-xlsx-btn')?.addEventListener('click', () => { state.exportFormat = 'xlsx'; startExport(); });
  $('export-single-csv-btn')?.addEventListener('click',  () => { state.exportFormat = 'csv';  startExport(); });
}

// ── Background connection ────────────────────────────────────────────────────

function connectToBackground() {
  state.port = chrome.runtime.connect({ name: 'popup' });

  state.port.onMessage.addListener(msg => {
    if (msg.action === 'progress') {
      if (!state.exporting) {
        // Popup reopened mid-export — restore in-progress UI without user clicking anything
        state.exporting = true;
        state.startTime = Date.now();
        setExportButtonsDisabled(true);
        $('progress-area').classList.remove('hidden');
        $('result-summary').classList.add('hidden');
        $('error-area').classList.add('hidden');
        $('warning-area').classList.add('hidden');
      }
      if (msg.warning) showWarning(msg.warning);
      else updateProgress(msg.current, msg.total, msg.status);
    } else if (msg.action === 'done') {
      if (msg.exportFormat) state.exportFormat = msg.exportFormat;
      onExportDone(msg.data);
    } else if (msg.action === 'error') {
      onExportError(msg.message);
    }
  });

  state.port.onDisconnect.addListener(() => {
    state.port = null;
    if (state.exporting) onExportError('Background process stopped — please try again.');
  });
}

// ── Export ───────────────────────────────────────────────────────────────────

function startExport() {
  if (state.exporting) return;
  state.exporting = true;
  state.startTime = Date.now();

  const { startAt, endAt } = getDateRange(state.settings.dateRange);
  // Snapshot settings used for naming/building — user may change UI during the fetch
  state.exportSnapshot = {
    dateRange: state.settings.dateRange,
    splitMembership: state.settings.splitMembership,
  };
  const settings = {
    ...state.settings,
    startAt,
    endAt,
    mode: state.mode,
    postId: state.postId,
    exportFormat: state.exportFormat
  };

  setExportButtonsDisabled(true);
  $('progress-area').classList.remove('hidden');
  $('warning-area').classList.add('hidden');
  $('error-area').classList.add('hidden');
  $('result-summary').classList.add('hidden');
  updateProgress(0, state.mode === 'all' ? null : 1, 'Connecting...');

  state.port.postMessage({ action: 'export', tabId: state.tab.id, settings });
}

function updateProgress(current, total, status) {
  const pct = total ? Math.round((current / total) * 100) : 0;
  $('progress-bar').style.width = `${pct}%`;
  $('progress-text').textContent = total ? `${current} / ${total} — ${status}` : status;

  if (current > 0 && total && total > 1) {
    const elapsed = Date.now() - state.startTime;
    const rate = current / elapsed;
    const remaining = (total - current) / rate;
    $('progress-eta').textContent = remaining > 1000 ? `~${Math.ceil(remaining / 1000)}s left` : '';
  } else {
    $('progress-eta').textContent = '';
  }
}

function showWarning(text) {
  const el = $('warning-area');
  el.textContent = text;
  el.classList.remove('hidden');
}

function onExportError(message) {
  state.exporting = false;
  setExportButtonsDisabled(false);
  $('progress-area').classList.add('hidden');
  const el = $('error-area');
  el.textContent = `Export failed: ${message}`;
  el.classList.remove('hidden');
}

async function onExportDone({ results, failed }) {
  state.exporting = false;

  if (!results?.length) {
    onExportError('No data returned. Make sure you are logged in to Medium.');
    return;
  }

  try {
    const today = fmtDateFile(localTodayISO());

    const { dateRange, splitMembership } = state.exportSnapshot;
    const rangeSuffix = dateRange !== 'all' ? `_${dateRange}` : '';

    if (state.mode === 'single') {
      const story = results[0];
      const slug = sanitizeFilename(story.title || story.postId);
      if (state.exportFormat === 'xlsx') {
        const xlsxBuf = await buildXLSX(results, splitMembership, dateRange);
        downloadBlob(
          new Blob([xlsxBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
          `medium_${slug}_${today}${rangeSuffix}.xlsx`
        );
      } else {
        downloadBlob(
          new Blob([toCSV(story.days.map(d => ({ ...d, date: fmtDate(d.date) })))], { type: 'text/csv' }),
          `medium_${slug}_${today}.csv`
        );
      }
    } else {
      const xlsxBuf = await buildXLSX(results, splitMembership, dateRange);
      downloadBlob(
        new Blob([xlsxBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `medium_stats_export_${today}${rangeSuffix}.xlsx`
      );

      if (state.settings.exportCsv) {
        await new Promise(r => setTimeout(r, 500));
        const { summaryRows, timeseriesRows } = buildFlatCSV(results, splitMembership);
        downloadBlob(new Blob([toCSV(summaryRows)], { type: 'text/csv' }), `medium_summary_${today}.csv`);
        await new Promise(r => setTimeout(r, 300));
        downloadBlob(new Blob([toCSV(timeseriesRows)], { type: 'text/csv' }), `medium_timeseries_${today}.csv`);
      }
    }

    await chrome.storage.local.set({ lastExport: Date.now() });
    loadLastExport();
    showResultSummary(results, failed);
  } catch (e) {
    onExportError(`File generation failed: ${e.message}`);
    return;
  }

  setExportButtonsDisabled(false);
  $('progress-area').classList.add('hidden');

  if (failed.length) {
    const el = $('error-area');
    el.innerHTML = `<strong>${failed.length} story/stories failed:</strong><br>${failed.join(', ')}`;
    el.classList.remove('hidden');
  }
}

function showResultSummary(results, failed) {
  const data = { stories: results.length, views: 0, earningsCents: 0, minDate: '9999', maxDate: '0000', failedCount: failed.length, mode: state.mode, postId: state.postId };

  for (const s of results) {
    for (const d of s.days) {
      data.views += d.views ?? ((d.memberViews || 0) + (d.nonMemberViews || 0));
      data.earningsCents += d.earningsCents || 0;
      if (d.date < data.minDate) data.minDate = d.date;
      if (d.date > data.maxDate) data.maxDate = d.date;
    }
  }

  chrome.storage.local.set({ lastResult: { ...data, timestamp: Date.now() } });
  renderResultSummary(data, false);
}

function renderResultSummary(data, fromCache) {
  const el = $('result-summary');
  const cacheNote = fromCache ? `<span class="cache-note">· last export</span>` : '';
  el.innerHTML = `
    <div class="summary-title">Export complete ✓ ${cacheNote}</div>
    <div class="summary-grid">
      <div class="summary-stat">
        <span class="stat-value">${data.stories}</span>
        <span class="stat-label">Stories</span>
      </div>
      <div class="summary-stat">
        <span class="stat-value">${fmtNum(data.views)}</span>
        <span class="stat-label">Total views</span>
      </div>
      <div class="summary-stat">
        <span class="stat-value">$${(data.earningsCents / 100).toFixed(2)}</span>
        <span class="stat-label">Earnings</span>
      </div>
      <div class="summary-stat">
        <span class="stat-value" style="font-size:11px">${data.minDate !== '9999' ? fmtDate(data.minDate) : '—'}</span>
        <span class="stat-label">From date</span>
      </div>
    </div>
    <button class="export-again-btn" id="export-again-btn">Export again</button>
  `;
  el.classList.remove('hidden');
  $('export-again-btn').addEventListener('click', () => {
    el.classList.add('hidden');
    startExport();
  });
}

function setExportButtonsDisabled(disabled) {
  ['export-all-btn', 'export-single-xlsx-btn', 'export-single-csv-btn']
    .map($).filter(Boolean).forEach(b => b.disabled = disabled);
}

// ── XLSX design system ────────────────────────────────────────────────────────

const XL = {
  P: { // palette
    hdrBg: '111827', hdrFg: 'FFFFFF',
    subBg: '374151', subFg: 'FFFFFF',
    kpiBg: 'F3F4F6', kpiFg: '111827', kpiMuted: '6B7280',
    monthBg: 'E5E7EB', monthFg: '111827',
    altBg: 'F7F8FA',
    viewsBg: 'DBEAFE', viewsFg: '1E40AF',
    readsBg: 'D1FAE5', readsFg: '065F46',
    engageBg: 'FFE4E6', engageFg: '9F1239',
    followsBg: 'EDE9FE', followsFg: '5B21B6',
    earnBg: 'FEF3C7',  earnFg: '92400E',
    muted: '9CA3AF',
  },

  s(bg, fg, bold, sz, align) {
    const o = { font: { bold: !!bold, sz: sz || 10, color: { rgb: fg || '111827' } }, alignment: { horizontal: align || 'left', vertical: 'center' } };
    if (bg) o.fill = { type: 'pattern', patternType: 'solid', fgColor: { rgb: bg }, bgColor: { indexed: 64 } };
    return o;
  },

  put(ws, r, c, v, style, numFmt) {
    const addr = XLSX.utils.encode_cell({ r, c });
    const t = typeof v === 'number' ? 'n' : 's';
    ws[addr] = { v: v ?? '', t: v == null ? 's' : t };
    if (style) ws[addr].s = style;
    if (numFmt) ws[addr].z = numFmt;
  },

  fill(ws, r, c1, c2, style) {
    for (let c = c1; c <= c2; c++) XL.put(ws, r, c, ws[XLSX.utils.encode_cell({ r, c })]?.v ?? '', style);
  },

  merge(ws, r1, c1, r2, c2) {
    (ws['!merges'] = ws['!merges'] || []).push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
  },

  ref(ws) {
    let mr = 0, mc = 0;
    Object.keys(ws).filter(k => k[0] !== '!').forEach(k => { const { r, c } = XLSX.utils.decode_cell(k); if (r > mr) mr = r; if (c > mc) mc = c; });
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: mr, c: mc } });
  },

  row(ws, r, opts) { (ws['!rows'] = ws['!rows'] || [])[r] = opts; },
};

// Sum all numeric fields across an array of day objects
function sumDays(days) {
  const t = {};
  for (const d of days) for (const [k, v] of Object.entries(d)) if (typeof v === 'number' && k !== 'earningsUSD') t[k] = (t[k] || 0) + v;
  t.earningsUSD = (t.earningsCents || 0) / 100;
  // derived totals for split mode
  t._totalViews   = (t.memberViews   || 0) + (t.nonMemberViews   || 0) || t.views   || 0;
  t._totalReads   = (t.memberReads   || 0) + (t.nonMemberReads   || 0) || t.reads   || 0;
  t._totalFollows = (t.memberFollows || 0) + (t.nonMemberFollows || 0) || t.follows || 0;
  return t;
}

function xlCols(split) {
  const P = XL.P;
  if (split) return [
    { k: 'date',             h: 'Date',                w: 13, bg: null,       fg: null       },
    { k: 'memberViews',      h: 'Member Views',         w: 15, bg: P.viewsBg,  fg: P.viewsFg  },
    { k: 'nonMemberViews',   h: 'Non-member Views',     w: 18, bg: P.viewsBg,  fg: P.viewsFg  },
    { k: '_totalViews',      h: 'Total Views',          w: 13, bg: P.viewsBg,  fg: P.viewsFg, bold: true },
    { k: 'memberReads',      h: 'Member Reads',         w: 15, bg: P.readsBg,  fg: P.readsFg  },
    { k: 'nonMemberReads',   h: 'Non-member Reads',     w: 18, bg: P.readsBg,  fg: P.readsFg  },
    { k: '_totalReads',      h: 'Total Reads',          w: 13, bg: P.readsBg,  fg: P.readsFg, bold: true },
    { k: 'claps',            h: 'Claps',                w: 8,  bg: P.engageBg, fg: P.engageFg },
    { k: 'replies',          h: 'Replies',              w: 9,  bg: P.engageBg, fg: P.engageFg },
    { k: 'highlights',       h: 'Highlights',           w: 12, bg: P.engageBg, fg: P.engageFg },
    { k: 'memberFollows',    h: 'Member Follows',       w: 16, bg: P.followsBg,fg: P.followsFg},
    { k: 'nonMemberFollows', h: 'Non-member Follows',   w: 20, bg: P.followsBg,fg: P.followsFg},
    { k: '_totalFollows',    h: 'Total Follows',        w: 14, bg: P.followsBg,fg: P.followsFg, bold: true },
    { k: 'earningsUSD',      h: 'Earnings (USD)',        w: 15, bg: P.earnBg,   fg: P.earnFg, fmt: '$#,##0.00' },
  ];
  return [
    { k: 'date',       h: 'Date',          w: 13, bg: null,       fg: null       },
    { k: 'views',      h: 'Views',          w: 10, bg: P.viewsBg,  fg: P.viewsFg  },
    { k: 'reads',      h: 'Reads',          w: 10, bg: P.readsBg,  fg: P.readsFg  },
    { k: 'claps',      h: 'Claps',          w: 8,  bg: P.engageBg, fg: P.engageFg },
    { k: 'replies',    h: 'Replies',         w: 9,  bg: P.engageBg, fg: P.engageFg },
    { k: 'highlights', h: 'Highlights',     w: 12, bg: P.engageBg, fg: P.engageFg },
    { k: 'follows',    h: 'Follows',         w: 10, bg: P.followsBg,fg: P.followsFg},
    { k: 'earningsUSD',h: 'Earnings (USD)', w: 15, bg: P.earnBg,   fg: P.earnFg, fmt: '$#,##0.00' },
  ];
}

// ── XLSX generation ───────────────────────────────────────────────────────────

async function buildXLSX(results, splitMembership, dateRange) {
  const wb   = XLSX.utils.book_new();
  const cols = xlCols(splitMembership);
  const today = fmtDate(localTodayISO());
  const storySheets = []; // { story, sheetIndex } for chart embedding

  xlSummarySheet(wb, results, cols, today, dateRange);
  const sdData = xlSummaryDataSheet(wb, results); // _sd = sheet2

  const usedNames = new Set(['Summary', '_sd']);
  let si = 3; // Summary=sheet1, _sd=sheet2, first story=sheet3
  for (const s of results) {
    if (!s.days.length) continue;
    const sheetName = safeSheetName(s.title, usedNames);
    xlStorySheet(wb, s, cols, sheetName);
    const storyIdx = si++;
    // Hidden chart-data sheet: clean daily time series, no grouping
    const dataName = `_d${storyIdx}`;
    xlChartDataSheet(wb, s, splitMembership, dataName);
    si++; // data sheet consumes the next sheet index
    storySheets.push({ sheetIndex: storyIdx, sheetName, dataSheetName: dataName, days: s.days });
  }

  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true });

  if (window.JSZip && (storySheets.length > 0 || sdData)) {
    try { return await embedChartsInXLSX(buf, storySheets, splitMembership, sdData); }
    catch (e) { console.warn('Chart embed failed, returning unstyled file:', e); }
  }
  return buf;
}

function xlSummarySheet(wb, results, cols, today, dateRange) {
  const ws = {};
  const P  = XL.P;
  const NC = 12; // fixed columns on summary
  let r = 0;

  const rangeLabelMap = { '7d': 'Last 7 days', '30d': 'Last 30 days', '6m': 'Last 6 months', '1y': 'Last year', 'all': 'All time' };
  const rangeLabel = rangeLabelMap[dateRange] || 'All time';

  // ── Title banner ──
  XL.put(ws, r, 0, 'Medium Stats Export', XL.s(P.hdrBg, P.hdrFg, true, 15));
  for (let c = 1; c < 9; c++) XL.put(ws, r, c, '', XL.s(P.hdrBg, P.hdrFg));
  XL.merge(ws, r, 0, r, 8);
  XL.put(ws, r, 9, 'by Ethan Beddard', XL.s(P.hdrBg, '6B7280', false, 9, 'right'));
  for (let c = 10; c < NC; c++) XL.put(ws, r, c, '', XL.s(P.hdrBg, P.hdrFg));
  XL.merge(ws, r, 9, r, NC - 1);
  ws[XLSX.utils.encode_cell({ r, c: 9 })].l = { Target: 'https://ko-fi.com/ethanbeddard' };
  XL.row(ws, r, { hpt: 28 }); r++;

  XL.put(ws, r, 0, `Exported ${today} · ${rangeLabel} · ${results.length} ${results.length === 1 ? 'story' : 'stories'}`, XL.s(P.subBg, P.subFg, false, 10));
  for (let c = 1; c < NC; c++) XL.put(ws, r, c, '', XL.s(P.subBg, P.subFg));
  XL.merge(ws, r, 0, r, NC - 1);
  XL.row(ws, r, { hpt: 17 }); r++;
  r++; // blank

  // ── KPI strip ──
  const grand = sumDays(results.flatMap(s => s.days));
  const kpis  = [
    ['Stories',        results.length,              null],
    ['Total Views',    grand._totalViews,            '#,##0'],
    ['Total Reads',    grand._totalReads,            '#,##0'],
    ['Total Follows',  grand._totalFollows,          '#,##0'],
    ['Total Earnings', grand.earningsUSD,            '$#,##0.00'],
  ];
  kpis.forEach(([lbl], i) => XL.put(ws, r,   i * 2, lbl, XL.s(P.kpiBg, P.kpiMuted, false, 9)));
  XL.row(ws, r, { hpt: 14 }); r++;
  kpis.forEach(([, val, fmt], i) => XL.put(ws, r, i * 2, val, XL.s(P.kpiBg, P.kpiFg, true, 15, 'left'), fmt));
  XL.row(ws, r, { hpt: 26 }); r++;
  r++; // blank

  // ── Aggregate derived KPIs ──
  const dkpis = [
    ['Read Ratio',       grand._totalViews  > 0 ? grand._totalReads  / grand._totalViews         : 0, '0.0%'     ],
    ['$/1k Reads',       grand._totalReads  > 0 ? grand.earningsUSD  / grand._totalReads * 1000  : 0, '$#,##0.00'],
    ['Avg $/Story',      results.length     > 0 ? grand.earningsUSD  / results.length             : 0, '$#,##0.00'],
    ['Avg Views/Story',  results.length     > 0 ? Math.round(grand._totalViews / results.length)  : 0, '#,##0'    ],
  ];
  dkpis.forEach(([lbl], i) => XL.put(ws, r, i * 2, lbl, XL.s(P.kpiBg, P.kpiMuted, false, 9)));
  XL.row(ws, r, { hpt: 13 }); r++;
  dkpis.forEach(([, val, fmt], i) => XL.put(ws, r, i * 2, val, XL.s(P.kpiBg, P.kpiFg, true, 13, 'left'), fmt));
  XL.row(ws, r, { hpt: 22 }); r++;

  // ── Table header ──
  const summaryHdrRow = r;
  const hdrs = ['Title', 'Views', 'Reads', 'Claps', 'Replies', 'Highlights', 'Follows', 'Earnings (USD)', 'Post ID', 'Read %', '$/1k R', 'URL'];
  hdrs.forEach((h, c) => XL.put(ws, r, c, h, XL.s(P.hdrBg, P.hdrFg, true, 10, c > 0 && c < 9 ? 'right' : 'left')));
  XL.row(ws, r, { hpt: 18 }); r++;

  // ── Story rows ──
  results.forEach((story, i) => {
    const t  = sumDays(story.days);
    const bg = i % 2 ? P.altBg : null;
    const tx = XL.s(bg, '111827', false, 10, 'left');
    const tn = XL.s(bg, '111827', false, 10, 'right');
    const tm = XL.s(bg, P.muted,  false, 9,  'left');
    const td = XL.s(bg, P.kpiMuted, false, 10, 'right');
    XL.put(ws, r, 0,  story.title,                                           tx);
    XL.put(ws, r, 1,  t._totalViews,                                         tn, '#,##0');
    XL.put(ws, r, 2,  t._totalReads,                                         tn, '#,##0');
    XL.put(ws, r, 3,  t.claps        || 0,                                   tn, '#,##0');
    XL.put(ws, r, 4,  t.replies      || 0,                                   tn, '#,##0');
    XL.put(ws, r, 5,  t.highlights   || 0,                                   tn, '#,##0');
    XL.put(ws, r, 6,  t._totalFollows,                                       tn, '#,##0');
    XL.put(ws, r, 7,  t.earningsUSD,                                         tn, '$#,##0.00');
    XL.put(ws, r, 8,  story.postId,                                          tm);
    XL.put(ws, r, 9,  t._totalViews > 0 ? t._totalReads / t._totalViews : 0, td, '0.0%');
    XL.put(ws, r, 10, t._totalReads > 0 ? t.earningsUSD / t._totalReads * 1000 : 0, td, '$#,##0.00');
    XL.put(ws, r, 11, `https://medium.com/p/${story.postId}`, XL.s(bg, '2563EB', false, 9, 'left'));
    XL.row(ws, r, { hpt: 16 }); r++;
  });

  XL.ref(ws);
  ws['!cols']   = [{ wch: 30 }, { wch: 9 }, { wch: 9 }, { wch: 7 }, { wch: 8 }, { wch: 10 }, { wch: 9 }, { wch: 13 }, { wch: 12 }, { wch: 7 }, { wch: 8 }, { wch: 22 }, { wch: 2 }];
  ws['!freeze'] = { xSplit: 0, ySplit: summaryHdrRow + 1 };
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');
}

function xlStorySheet(wb, story, cols, sheetName) {
  const ws = {};
  const P  = XL.P;
  const NC = cols.length;
  const t  = sumDays(story.days);
  let r = 0;

  // ── Title banner ──
  XL.put(ws, r, 0, story.title, XL.s(P.hdrBg, P.hdrFg, true, 16));
  for (let c = 1; c < NC; c++) XL.put(ws, r, c, '', XL.s(P.hdrBg, P.hdrFg));
  XL.merge(ws, r, 0, r, NC - 1);
  XL.row(ws, r, { hpt: 26 }); r++;

  const dates = story.days.map(d => d.date);
  const sub   = dates.length ? `${fmtDate(dates[0])}  →  ${fmtDate(dates[dates.length - 1])}` : '';
  XL.put(ws, r, 0, sub, XL.s(P.subBg, P.subFg, false, 9));
  for (let c = 1; c < NC; c++) XL.put(ws, r, c, '', XL.s(P.subBg, P.subFg));
  XL.merge(ws, r, 0, r, NC - 1);
  XL.row(ws, r, { hpt: 15 }); r++;
  r++; // blank

  // ── KPI strip ──
  const kpis = [
    ['Total Views',    t._totalViews,   '#,##0'],
    ['Total Reads',    t._totalReads,   '#,##0'],
    ['Total Earnings', t.earningsUSD,   '$#,##0.00'],
    ['Total Follows',  t._totalFollows, '#,##0'],
  ];
  kpis.forEach(([lbl, val], i) => {
    const zero = val === 0;
    XL.put(ws, r, i * 3, lbl, XL.s(zero ? 'E8EAED' : P.kpiBg, zero ? P.muted : P.kpiMuted, true, 10));
  });
  XL.row(ws, r, { hpt: 16 }); r++;
  kpis.forEach(([, val, fmt], i) => {
    const zero = val === 0;
    XL.put(ws, r, i * 3, val, XL.s(zero ? 'E8EAED' : P.kpiBg, zero ? P.muted : P.kpiFg, true, 18, 'left'), fmt);
  });
  XL.row(ws, r, { hpt: 30 }); r++;
  r++; // blank

  // Rows r..(r+34) are the chart image area — JSZip embeds charts here
  const chartFromRow = r;
  r += 35;

  // ── Derived KPIs ──
  const dkpis = [
    ['Read Ratio',   t._totalViews  > 0 ? t._totalReads  / t._totalViews              : 0, '0.0%'      ],
    ['$/1k Reads',   t._totalReads  > 0 ? t.earningsUSD  / t._totalReads  * 1000      : 0, '$#,##0.00' ],
    ['Clap Rate',    t._totalViews  > 0 ? (t.claps || 0) / t._totalViews              : 0, '0.00%'     ],
    ['Follow Rate',  t._totalViews  > 0 ? t._totalFollows / t._totalViews             : 0, '0.000%'    ],
  ];
  dkpis.forEach(([lbl], i) => XL.put(ws, r, i * 3, lbl, XL.s(P.kpiBg, P.kpiMuted, true, 9)));
  XL.row(ws, r, { hpt: 14 }); r++;
  dkpis.forEach(([, val, fmt], i) => XL.put(ws, r, i * 3, val, XL.s(P.kpiBg, P.kpiFg, true, 15, 'left'), fmt));
  XL.row(ws, r, { hpt: 24 }); r++;

  // ── Column headers ──
  const hdrRow = r;
  cols.forEach(({ h, bg, fg, bold }, c) => {
    const useBg = bg || P.hdrBg;
    const useFg = fg || P.hdrFg;
    XL.put(ws, r, c, h, XL.s(useBg, useFg, true, 11, c === 0 ? 'left' : 'right'));
  });
  XL.row(ws, r, { hpt: 20 }); r++;

  // ── Data grouped by month (daily rows collapsed, month totals visible) ──
  const monthMap = {};
  for (const d of story.days) {
    const m = d.date.slice(0, 7);
    (monthMap[m] = monthMap[m] || []).push(d);
  }

  let alt = 0;
  for (const [month, days] of Object.entries(monthMap).sort()) {
    const mt    = sumDays(days);
    const mName = new Date(month + '-15').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    // Daily detail rows at level 1 (collapsed by default — summary is below them)
    for (const d of days) {
      const bg = alt++ % 2 ? P.altBg : null;
      cols.forEach(({ k, fmt }, c) => {
        let v   = k.startsWith('_') ? mt[k] : (d[k] ?? '');
        if (k === 'date' && typeof v === 'string') v = fmtDate(v);
        const isN = typeof v === 'number';
        XL.put(ws, r, c, v, XL.s(bg, '4B5563', false, 9, c === 0 ? 'left' : 'right'), fmt || (isN && c > 0 ? '#,##0' : null));
      });
      XL.row(ws, r, { level: 1, hidden: true }); r++;
    }

    // Month summary row (level 0, always visible — acts as group header)
    cols.forEach(({ k, fmt, bold }, c) => {
      if (c === 0) {
        XL.put(ws, r, c, mName, XL.s(P.monthBg, P.monthFg, true, 11, 'left'));
      } else {
        const v = mt[k] ?? 0;
        XL.put(ws, r, c, v, XL.s(P.monthBg, P.monthFg, true, 11, 'right'), fmt || '#,##0');
      }
    });
    XL.row(ws, r, { hpt: 18 }); r++;
  }

  XL.ref(ws);
  ws['!cols']   = cols.map(({ w }) => ({ wch: w }));
  ws['!freeze'] = { xSplit: 1, ySplit: hdrRow + 1 };
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

// ── Native OOXML chart generation ─────────────────────────────────────────────
// Charts reference a separate hidden data sheet with clean daily time-series rows.
// That sheet has no outline grouping so every row is always visible — full time series.

function xlsSheetRef(name) {
  return "'" + name.replace(/'/g, "''") + "'";
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Data sheet layout (both modes): A=date B=v1 C=v2 D=earnings E=follows F=v3 G=v4
// Row 1 = headers, rows 2+ = daily data
function chartSpecs(splitMembership) {
  if (splitMembership) {
    // B=totalViews C=totalReads D=earningsUSD E=totalFollows F=memberViews G=nonMemberViews
    return [
      { title: 'Views & Reads', type: 'area', series: [
          { col: 'B', label: 'Total Views', color: 'BFDBFE' },
          { col: 'C', label: 'Total Reads',  color: 'A7F3D0' },
        ]},
      { title: 'Member vs Non-member Views', type: 'area', stacked: true, series: [
          { col: 'G', label: 'Non-member',   color: '93C5FD' },
          { col: 'F', label: 'Member',       color: '818CF8' },
        ]},
      { title: 'Daily Earnings (USD)', type: 'bar', numFmt: '$#,##0.00', series: [
          { col: 'D', label: 'Earnings',     color: 'F59E0B' },
        ]},
      { title: 'New Followers', type: 'line', series: [
          { col: 'E', label: 'Follows',      color: '8B5CF6' },
        ]},
    ];
  }
  // B=views C=reads D=earningsUSD E=follows F=claps G=highlights
  return [
    { title: 'Views & Reads', type: 'area', series: [
        { col: 'B', label: 'Views',      color: 'BFDBFE' },
        { col: 'C', label: 'Reads',      color: 'A7F3D0' },
      ]},
    { title: 'Engagement', type: 'line', series: [
        { col: 'F', label: 'Claps',      color: 'EC4899' },
        { col: 'G', label: 'Highlights', color: 'F97316' },
      ]},
    { title: 'Daily Earnings (USD)', type: 'bar', numFmt: '$#,##0.00', series: [
        { col: 'D', label: 'Earnings',   color: 'F59E0B' },
      ]},
    { title: 'New Followers', type: 'line', series: [
        { col: 'E', label: 'Follows',    color: '8B5CF6' },
      ]},
  ];
}

// dataSheetName = hidden daily-data sheet; catData = date strings array; colData = {col: values[]}
function makeChartXml(spec, dataSheetName, catData, colData) {
  const ref     = xlsSheetRef(dataSheetName);
  const isBar   = spec.type === 'bar';
  const isArea  = spec.type === 'area';
  const numFmt  = spec.numFmt || '#,##0';
  const n       = catData.length;
  const endRow  = n + 1; // data occupies rows 2..(n+1)
  const catF    = `${ref}!$A$2:$A$${endRow}`;

  // Pre-populated category cache — Excel renders immediately, no click needed
  const catCache = `<c:ptCount val="${n}"/>` +
    catData.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEsc(v)}</c:v></c:pt>`).join('');

  const serXml = spec.series.map((s, i) => {
    const titleF = `${ref}!$${s.col}$1`;
    const valF   = `${ref}!$${s.col}$2:$${s.col}$${endRow}`;
    const vals   = colData[s.col] || [];
    let spPr;
    if (isBar) {
      spPr = `<a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill>`;
    } else if (isArea) {
      spPr = `<a:solidFill><a:srgbClr val="${s.color}"><a:alpha val="55000"/></a:srgbClr></a:solidFill>` +
             `<a:ln w="6350"><a:solidFill><a:srgbClr val="${s.color}"><a:alpha val="70000"/></a:srgbClr></a:solidFill></a:ln>`;
    } else {
      spPr = `<a:ln w="19050"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></a:ln>`;
    }
    const numCache = `<c:formatCode>${xmlEsc(numFmt)}</c:formatCode><c:ptCount val="${vals.length}"/>` +
      vals.map((v, j) => `<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>`).join('');
    return `<c:ser>` +
      `<c:idx val="${i}"/><c:order val="${i}"/>` +
      `<c:tx><c:strRef><c:f>${xmlEsc(titleF)}</c:f>` +
      `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEsc(s.label)}</c:v></c:pt></c:strCache>` +
      `</c:strRef></c:tx>` +
      `<c:spPr>${spPr}</c:spPr>` +
      (isBar || isArea ? '' : `<c:marker><c:symbol val="none"/></c:marker>`) +
      `<c:cat><c:strRef><c:f>${xmlEsc(catF)}</c:f>` +
      `<c:strCache>${catCache}</c:strCache></c:strRef></c:cat>` +
      `<c:val><c:numRef><c:f>${xmlEsc(valF)}</c:f>` +
      `<c:numCache>${numCache}</c:numCache>` +
      `</c:numRef></c:val>` +
      (isBar || isArea ? '' : `<c:smooth val="1"/>`) +
      `</c:ser>`;
  }).join('');

  const areaGrouping = spec.stacked ? 'stacked' : 'standard';
  const chartBody = isBar
    ? `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>` +
      `<c:varyColors val="0"/>${serXml}<c:axId val="1"/><c:axId val="2"/></c:barChart>`
    : isArea
    ? `<c:areaChart><c:grouping val="${areaGrouping}"/>` +
      `<c:varyColors val="0"/>${serXml}<c:axId val="1"/><c:axId val="2"/></c:areaChart>`
    : `<c:lineChart><c:grouping val="standard"/>` +
      `<c:varyColors val="0"/>${serXml}<c:axId val="1"/><c:axId val="2"/></c:lineChart>`;

  const titleXml =
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr><a:defRPr b="1" sz="1000"/></a:pPr>` +
    `<a:r><a:t>${xmlEsc(spec.title)}</a:t></a:r></a:p>` +
    `</c:rich></c:tx><c:overlay val="0"/></c:title>`;

  const axLine = `<c:spPr><a:ln><a:solidFill><a:srgbClr val="D1D5DB"/></a:solidFill></a:ln></c:spPr>`;
  const tickSkip = Math.max(1, Math.round(n / 10));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:roundedCorners val="0"/>` +
    `<c:chart>${titleXml}<c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>${chartBody}` +
    `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/>${axLine}` +
    `<c:crossAx val="2"/><c:auto val="1"/><c:lblAlgn val="ctr"/>` +
    `<c:lblOffset val="100"/><c:tickLblSkip val="${tickSkip}"/><c:tickMarkSkip val="${tickSkip}"/><c:noMultiLvlLbl val="0"/>` +
    `<c:txPr><a:bodyPr rot="-2700000"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr></a:p></c:txPr></c:catAx>` +
    `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="l"/>` +
    `<c:numFmt formatCode="${xmlEsc(numFmt)}" sourceLinked="0"/>` +
    `<c:tickLblPos val="nextTo"/>${axLine}` +
    `<c:crossAx val="1"/><c:crossBetween val="midCat"/></c:valAx>` +
    `</c:plotArea>` +
    `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>` +
    `<c:dispBlanksAs val="gap"/>` +
    `</c:chart></c:chartSpace>`;
}

function makeEmptyChartXml(title) {
  const titleXml =
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr><a:defRPr b="1" sz="1000"/></a:pPr>` +
    `<a:r><a:t>${xmlEsc(title)}</a:t></a:r></a:p>` +
    `</c:rich></c:tx><c:overlay val="0"/></c:title>`;
  const axLine = `<c:spPr><a:ln><a:solidFill><a:srgbClr val="D1D5DB"/></a:solidFill></a:ln></c:spPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:roundedCorners val="0"/><c:chart>${titleXml}<c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
    `<c:axId val="1"/><c:axId val="2"/></c:lineChart>` +
    `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/>${axLine}<c:crossAx val="2"/></c:catAx>` +
    `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="l"/>` +
    `<c:numFmt formatCode="#,##0" sourceLinked="0"/>` +
    `<c:tickLblPos val="nextTo"/>${axLine}` +
    `<c:crossAx val="1"/><c:crossBetween val="midCat"/></c:valAx>` +
    `</c:plotArea><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function makeDrawingXml(rIds) {
  // 2×2 grid: top row 6–22, bottom row 23–40; left cols 0–6, right cols 7–13
  const anchors = [
    [[0, 6],  [6, 22]],
    [[7, 6],  [13, 22]],
    [[0, 23], [6, 40]],
    [[7, 23], [13, 40]],
  ];
  const frames = rIds.map((rId, i) => {
    const [[fc, fr], [tc, tr]] = anchors[i];
    return `<xdr:twoCellAnchor editAs="oneCell">` +
      `<xdr:from><xdr:col>${fc}</xdr:col><xdr:colOff>0</xdr:colOff>` +
      `<xdr:row>${fr}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:to><xdr:col>${tc}</xdr:col><xdr:colOff>0</xdr:colOff>` +
      `<xdr:row>${tr}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
      `<xdr:graphicFrame macro="">` +
      `<xdr:nvGraphicFramePr>` +
      `<xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/>` +
      `<xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr>` +
      `</xdr:nvGraphicFramePr>` +
      `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
      `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rId}"/>` +
      `</a:graphicData></a:graphic>` +
      `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `${frames}</xdr:wsDr>`;
}

function makeSummaryDrawingXml(rId) {
  // Chart sits to the RIGHT of the data table (cols 12–25, rows 0–34)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<xdr:twoCellAnchor editAs="oneCell">` +
    `<xdr:from><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>25</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>34</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>` +
    `<xdr:cNvPr id="2" name="Summary Chart"/>` +
    `<xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr>` +
    `</xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rId}"/>` +
    `</a:graphicData></a:graphic>` +
    `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
}

function drawingRelsXml(chartPaths) {
  const rels = chartPaths.map((path, i) =>
    `<Relationship Id="rId${i + 1}"` +
    ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"` +
    ` Target="${path}"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `${rels}</Relationships>`;
}

// ── JSZip post-processing: inject native OOXML charts into xlsx ───────────────

async function embedChartsInXLSX(buf, storySheets, splitMembership, sdData) {
  const zip   = await JSZip.loadAsync(buf);
  let   ctXml = await zip.file('[Content_Types].xml').async('string');
  const specs = chartSpecs(splitMembership);

  // Hide the _sd and _d{n} data sheets in workbook.xml
  let wbXml = await zip.file('xl/workbook.xml')?.async('string') || '';
  const sheetsToHide = storySheets.map(s => s.dataSheetName);
  if (sdData) sheetsToHide.push('_sd');
  for (const name of sheetsToHide) {
    const esc = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    wbXml = wbXml.replace(
      new RegExp(`(<sheet[^>]*name="${esc}"[^>]*?)(/?>)`, 'g'),
      (m, pre, end) => pre.includes('state=') ? m : `${pre} state="hidden"${end}`
    );
  }
  zip.file('xl/workbook.xml', wbXml);

  // Embed summary chart in sheet1 (Summary)
  if (sdData) {
    const summaryChartFn = 'chart_summary.xml';
    zip.file(`xl/charts/${summaryChartFn}`, makeSummaryChartXml(sdData));
    if (!ctXml.includes(summaryChartFn))
      ctXml = ctXml.replace('</Types>',
        `<Override PartName="/xl/charts/${summaryChartFn}"` +
        ` ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);

    zip.file('xl/drawings/drawing1.xml', makeSummaryDrawingXml('rId1'));
    zip.file('xl/drawings/_rels/drawing1.xml.rels', drawingRelsXml([`../charts/${summaryChartFn}`]));

    let wsXml1 = await zip.file('xl/worksheets/sheet1.xml')?.async('string') || '';
    if (!wsXml1.includes('<drawing')) {
      if (!wsXml1.includes('xmlns:r='))
        wsXml1 = wsXml1.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
      wsXml1 = wsXml1.replace('</worksheet>', `<drawing r:id="rId_draw"/></worksheet>`);
    }
    zip.file('xl/worksheets/sheet1.xml', wsXml1);

    const drawRel1 =
      `<Relationship Id="rId_draw"` +
      ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing"` +
      ` Target="../drawings/drawing1.xml"/>`;
    const existing1 = zip.file('xl/worksheets/_rels/sheet1.xml.rels');
    if (existing1) {
      const rx = await existing1.async('string');
      zip.file('xl/worksheets/_rels/sheet1.xml.rels', rx.replace('</Relationships>', `${drawRel1}</Relationships>`));
    } else {
      zip.file('xl/worksheets/_rels/sheet1.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `${drawRel1}</Relationships>`);
    }

    if (!ctXml.includes('drawing1.xml'))
      ctXml = ctXml.replace('</Types>',
        `<Override PartName="/xl/drawings/drawing1.xml"` +
        ` ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
  }

  for (const { sheetIndex, dataSheetName, days } of storySheets) {
    const drawNum = sheetIndex - 1;
    const drawFn  = `drawing${drawNum}.xml`;
    const sheetFn = `sheet${sheetIndex}.xml`;

    // Pre-extract column data for cache population and exact row ranges
    const gapDays = fillDailyGaps(days);
    const catData = gapDays.map(d => fmtDate(d.date));
    const colData = splitMembership ? {
      B: gapDays.map(d => (d.memberViews   || 0) + (d.nonMemberViews   || 0) || d.views   || 0),
      C: gapDays.map(d => (d.memberReads   || 0) + (d.nonMemberReads   || 0) || d.reads   || 0),
      D: gapDays.map(d => d.earningsUSD || 0),
      E: gapDays.map(d => (d.memberFollows || 0) + (d.nonMemberFollows || 0) || d.follows || 0),
      F: gapDays.map(d => d.memberViews    || 0),
      G: gapDays.map(d => d.nonMemberViews || 0),
    } : {
      B: gapDays.map(d => d.views   || 0),
      C: gapDays.map(d => d.reads   || 0),
      D: gapDays.map(d => d.earningsUSD || 0),
      E: gapDays.map(d => d.follows || 0),
      F: gapDays.map(d => d.claps   || 0),
      G: gapDays.map(d => d.highlights || 0),
    };

    // Write 4 chart XML files and build relationship lists
    const rIds       = [];
    const chartPaths = [];
    specs.forEach((spec, ci) => {
      const chartFn  = `chart_s${sheetIndex}_c${ci + 1}.xml`;
      const allZero  = spec.series.every(s => (colData[s.col] || []).every(v => v === 0));
      const chartXml = allZero ? makeEmptyChartXml(spec.title) : makeChartXml(spec, dataSheetName, catData, colData);
      zip.file(`xl/charts/${chartFn}`, chartXml);
      rIds.push(`rId${ci + 1}`);
      chartPaths.push(`../charts/${chartFn}`);
      if (!ctXml.includes(chartFn))
        ctXml = ctXml.replace('</Types>',
          `<Override PartName="/xl/charts/${chartFn}"` +
          ` ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
    });

    // Drawing XML and its rels
    zip.file(`xl/drawings/${drawFn}`,        makeDrawingXml(rIds));
    zip.file(`xl/drawings/_rels/${drawFn}.rels`, drawingRelsXml(chartPaths));

    // Patch worksheet XML to reference the drawing
    const wsPath = `xl/worksheets/${sheetFn}`;
    let wsXml = await zip.file(wsPath)?.async('string') || '';
    if (!wsXml.includes('<drawing')) {
      if (!wsXml.includes('xmlns:r='))
        wsXml = wsXml.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
      wsXml = wsXml.replace('</worksheet>', `<drawing r:id="rId_draw"/></worksheet>`);
    }
    zip.file(wsPath, wsXml);

    // Worksheet → drawing relationship
    const relsPath = `xl/worksheets/_rels/${sheetFn}.rels`;
    const drawRel  =
      `<Relationship Id="rId_draw"` +
      ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing"` +
      ` Target="../drawings/${drawFn}"/>`;
    const existing = zip.file(relsPath);
    if (existing) {
      const rx = await existing.async('string');
      zip.file(relsPath, rx.replace('</Relationships>', `${drawRel}</Relationships>`));
    } else {
      zip.file(relsPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `${drawRel}</Relationships>`);
    }

    if (!ctXml.includes(drawFn))
      ctXml = ctXml.replace('</Types>',
        `<Override PartName="/xl/drawings/${drawFn}"` +
        ` ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
  }

  zip.file('[Content_Types].xml', ctXml);
  return await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// Fill in missing calendar dates between first and last day with zero values
function fillDailyGaps(days) {
  if (days.length < 2) return days;
  const byDate = Object.fromEntries(days.map(d => [d.date, d]));
  const zero = Object.fromEntries(Object.entries(days[0]).map(([k, v]) => [k, typeof v === 'number' ? 0 : '']));
  const result = [];
  const cur = new Date(days[0].date);
  const end = new Date(days[days.length - 1].date);
  while (cur <= end) {
    const iso = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
    result.push(byDate[iso] ?? { ...zero, date: iso, earningsUSD: 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

// Hidden sheet that holds clean daily rows — no outline grouping — so charts
// always reference the full unfiltered time series.
// Columns: A=date B=v1 C=v2 D=earningsUSD E=follows F=v3 G=v4
// Non-split: B=views C=reads F=claps G=highlights
// Split:     B=totalViews C=totalReads F=memberViews G=nonMemberViews
function xlChartDataSheet(wb, story, splitMembership, sheetName) {
  const ws   = {};
  const days = fillDailyGaps(story.days);
  const hdrs = splitMembership
    ? ['date', 'Total Views', 'Total Reads', 'Earnings (USD)', 'Total Follows', 'Member Views', 'Non-member Views']
    : ['date', 'Views',       'Reads',       'Earnings (USD)', 'Follows',       'Claps',        'Highlights'];
  hdrs.forEach((h, c) => { ws[XLSX.utils.encode_cell({ r: 0, c })] = { v: h, t: 's' }; });
  days.forEach((d, i) => {
    const dd = fmtDate(d.date);
    const vals = splitMembership
      ? [dd,
         (d.memberViews   || 0) + (d.nonMemberViews   || 0) || d.views   || 0,
         (d.memberReads   || 0) + (d.nonMemberReads   || 0) || d.reads   || 0,
         d.earningsUSD || 0,
         (d.memberFollows || 0) + (d.nonMemberFollows || 0) || d.follows || 0,
         d.memberViews    || 0,
         d.nonMemberViews || 0]
      : [dd, d.views || 0, d.reads || 0, d.earningsUSD || 0,
         d.follows || 0, d.claps || 0, d.highlights || 0];
    vals.forEach((v, c) => {
      ws[XLSX.utils.encode_cell({ r: i + 1, c })] = { v, t: typeof v === 'number' ? 'n' : 's' };
    });
  });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: days.length, c: 6 } });
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

// Aggregate all story days, compute 7-day trailing MA, track publication dates.
// Returns sdData object used to build the summary chart, or null if no data.
function xlSummaryDataSheet(wb, results) {
  const dailyTotals = {};
  const pubDates = new Set();

  for (const s of results) {
    if (!s.days.length) continue;
    const firstActive = s.days.find(d => {
      const v = (d.memberViews || 0) + (d.nonMemberViews || 0) || d.views || 0;
      const r = (d.memberReads || 0) + (d.nonMemberReads || 0) || d.reads || 0;
      return v > 0 || r > 0;
    });
    if (firstActive) pubDates.add(firstActive.date);
    for (const d of s.days) {
      const v = (d.memberViews || 0) + (d.nonMemberViews || 0) || d.views || 0;
      const r = (d.memberReads || 0) + (d.nonMemberReads || 0) || d.reads || 0;
      if (!dailyTotals[d.date]) dailyTotals[d.date] = { views: 0, reads: 0 };
      dailyTotals[d.date].views += v;
      dailyTotals[d.date].reads += r;
    }
  }

  const sorted = Object.keys(dailyTotals).sort();
  if (sorted.length === 0) return null;

  // Fill date gaps
  const filled = [];
  const cur = new Date(sorted[0]), end = new Date(sorted[sorted.length - 1]);
  while (cur <= end) {
    const iso = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
    filled.push({ date: iso, views: dailyTotals[iso]?.views || 0, reads: dailyTotals[iso]?.reads || 0 });
    cur.setDate(cur.getDate() + 1);
  }

  // 7-day trailing moving average
  const maViews = [], maReads = [];
  for (let i = 0; i < filled.length; i++) {
    const w = filled.slice(Math.max(0, i - 6), i + 1);
    maViews.push(+(w.reduce((s, d) => s + d.views, 0) / w.length).toFixed(1));
    maReads.push(+(w.reduce((s, d) => s + d.reads, 0) / w.length).toFixed(1));
  }

  const catData = filled.map(d => fmtDate(d.date));
  const rawViews = filled.map(d => d.views);
  const rawReads = filled.map(d => d.reads);
  const pubIndices = filled.map((d, i) => pubDates.has(d.date) ? i : -1).filter(i => i >= 0);

  // y-axis bounds computed here so pub strip bar values match the chart scale
  const axMax = Math.ceil(Math.max(...rawViews, 1) * 1.1);
  const axMin = -Math.ceil(axMax * 0.06);  // 6% strip below x-axis for pub markers

  // Write hidden _sd sheet — A=date B=maViews C=maReads D=pubStrip E=dailyViews F=dailyReads
  // Column D: axMin at publication dates, 0 elsewhere — bars fill the strip below the x-axis
  const ws = {};
  ['Date', '7d MA Views', '7d MA Reads', 'Publication', 'Daily Views', 'Daily Reads'].forEach((h, c) => {
    ws[XLSX.utils.encode_cell({ r: 0, c })] = { v: h, t: 's' };
  });
  filled.forEach((d, i) => {
    [fmtDate(d.date), maViews[i], maReads[i]].forEach((v, c) => {
      ws[XLSX.utils.encode_cell({ r: i + 1, c })] = { v, t: typeof v === 'number' ? 'n' : 's' };
    });
    ws[XLSX.utils.encode_cell({ r: i + 1, c: 3 })] = { v: pubDates.has(d.date) ? axMin : 0, t: 'n' };
    ws[XLSX.utils.encode_cell({ r: i + 1, c: 4 })] = { v: rawViews[i], t: 'n' };
    ws[XLSX.utils.encode_cell({ r: i + 1, c: 5 })] = { v: rawReads[i], t: 'n' };
  });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filled.length, c: 5 } });
  XLSX.utils.book_append_sheet(wb, ws, '_sd');

  return { n: filled.length, catData, maViews, maReads, dailyViews: rawViews, dailyReads: rawReads, pubIndices, axMin, axMax };
}

function makeSummaryChartXml(sdData) {
  const ref      = xlsSheetRef('_sd');
  const n        = sdData.n;
  const endRow   = n + 1;
  const catF     = `${ref}!$A$2:$A$${endRow}`;
  const tickSkip = Math.max(1, Math.round(n / 10));

  const catCache = `<c:ptCount val="${n}"/>` +
    sdData.catData.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEsc(v)}</c:v></c:pt>`).join('');

  const { axMin, axMax } = sdData;

  function numRef(col, vals) {
    const f = `${ref}!$${col}$2:$${col}$${endRow}`;
    const cache = `<c:formatCode>#,##0</c:formatCode><c:ptCount val="${vals.length}"/>` +
      vals.map((v, j) => `<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>`).join('');
    return `<c:numRef><c:f>${xmlEsc(f)}</c:f><c:numCache>${cache}</c:numCache></c:numRef>`;
  }

  // Filled area from 0 — smoothed daily values
  function mkAreaSer(idx, col, label, vals, fillColor, lineColor) {
    return `<c:ser>` +
      `<c:idx val="${idx}"/><c:order val="${idx}"/>` +
      `<c:tx><c:strRef><c:f>${xmlEsc(`${ref}!$${col}$1`)}</c:f>` +
      `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEsc(label)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
      `<c:spPr>` +
      `<a:solidFill><a:srgbClr val="${fillColor}"><a:alpha val="55000"/></a:srgbClr></a:solidFill>` +
      `<a:ln w="6350"><a:solidFill><a:srgbClr val="${lineColor}"><a:alpha val="70000"/></a:srgbClr></a:solidFill></a:ln>` +
      `</c:spPr>` +
      `<c:cat><c:strRef><c:f>${xmlEsc(catF)}</c:f><c:strCache>${catCache}</c:strCache></c:strRef></c:cat>` +
      `<c:val>${numRef(col, vals)}</c:val></c:ser>`;
  }

  // Bold MA line
  function mkLineSer(idx, col, label, color, vals) {
    return `<c:ser>` +
      `<c:idx val="${idx}"/><c:order val="${idx}"/>` +
      `<c:tx><c:strRef><c:f>${xmlEsc(`${ref}!$${col}$1`)}</c:f>` +
      `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEsc(label)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
      `<c:spPr><a:ln w="25400"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>` +
      `<c:marker><c:symbol val="none"/></c:marker>` +
      `<c:cat><c:strRef><c:f>${xmlEsc(catF)}</c:f><c:strCache>${catCache}</c:strCache></c:strRef></c:cat>` +
      `<c:val>${numRef(col, vals)}</c:val>` +
      `<c:smooth val="1"/></c:ser>`;
  }

  // Publication strip: column D has axMin at pub dates, 0 elsewhere — bars go from 0 down to axMin
  const pubStripCache = `<c:formatCode>#,##0</c:formatCode><c:ptCount val="${n}"/>` +
    sdData.pubIndices.map(i => `<c:pt idx="${i}"><c:v>${axMin}</c:v></c:pt>`).join('');
  const pubStripSer = `<c:ser>` +
    `<c:idx val="4"/><c:order val="4"/>` +
    `<c:tx><c:strRef><c:f>${xmlEsc(`${ref}!$D$1`)}</c:f>` +
    `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Published</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
    `<c:invertIfNegative val="0"/>` +
    `<c:spPr>` +
    `<a:solidFill><a:srgbClr val="C4B5FD"/></a:solidFill>` +
    `<a:ln><a:noFill/></a:ln>` +
    `</c:spPr>` +
    `<c:cat><c:strRef><c:f>${xmlEsc(catF)}</c:f><c:strCache>${catCache}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>${xmlEsc(`${ref}!$D$2:$D$${endRow}`)}</c:f>` +
    `<c:numCache>${pubStripCache}</c:numCache></c:numRef></c:val></c:ser>`;

  const titleXml =
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr><a:defRPr b="1" sz="1000"/></a:pPr>` +
    `<a:r><a:t>Overall Engagement Trend</a:t></a:r></a:p>` +
    `<a:p><a:pPr><a:defRPr sz="800"/></a:pPr>` +
    `<a:r><a:rPr><a:solidFill><a:srgbClr val="9CA3AF"/></a:solidFill></a:rPr>` +
    `<a:t>Filled: daily  ·  Lines: 7-day MA  ·  Strip below: publication dates</a:t></a:r></a:p>` +
    `</c:rich></c:tx><c:overlay val="0"/></c:title>`;

  const axLine = `<c:spPr><a:ln><a:solidFill><a:srgbClr val="D1D5DB"/></a:solidFill></a:ln></c:spPr>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:roundedCorners val="0"/><c:chart>${titleXml}<c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>` +
    // Filled areas from 0: raw daily views (behind) and reads (in front)
    `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
    `${mkAreaSer(0, 'E', 'Daily Views', sdData.dailyViews, 'BFDBFE', '93C5FD')}` +
    `${mkAreaSer(1, 'F', 'Daily Reads', sdData.dailyReads, 'A7F3D0', '6EE7B7')}` +
    `<c:axId val="1"/><c:axId val="2"/></c:areaChart>` +
    // Bold MA lines on top
    `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
    `${mkLineSer(2, 'B', '7d MA Views', '2563EB', sdData.maViews)}` +
    `${mkLineSer(3, 'C', '7d MA Reads', '059669', sdData.maReads)}` +
    `<c:axId val="1"/><c:axId val="2"/></c:lineChart>` +
    // Publication strip — bar chart, bars go from 0 down to axMin (below x-axis)
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
    `${pubStripSer}` +
    `<c:axId val="1"/><c:axId val="2"/></c:barChart>` +
    // catAx crosses at y=0 so x-axis line sits between main chart and pub strip
    `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="low"/>${axLine}` +
    `<c:crossAx val="2"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/>` +
    `<c:lblOffset val="100"/><c:tickLblSkip val="${tickSkip}"/><c:tickMarkSkip val="${tickSkip}"/><c:noMultiLvlLbl val="0"/>` +
    `<c:txPr><a:bodyPr rot="-2700000"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr></a:p></c:txPr></c:catAx>` +
    // valAx: min=axMin (strip below zero), max=axMax; hide negative labels with custom numFmt
    `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:min val="${axMin}"/><c:max val="${axMax}"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="l"/>` +
    `<c:numFmt formatCode="[&gt;=0]#,##0;" sourceLinked="0"/>` +
    `<c:tickLblPos val="nextTo"/>${axLine}` +
    `<c:crossAx val="1"/><c:crossBetween val="midCat"/></c:valAx>` +
    `</c:plotArea>` +
    // Hide "Published" from legend (idx 4) — strip is self-explanatory
    `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>` +
    `<c:legendEntry><c:idx val="4"/><c:delete val="1"/></c:legendEntry>` +
    `</c:legend>` +
    `<c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function safeSheetName(title, usedNames) {
  let name = (title || 'Sheet').replace(/[[\]\\:*?/]/g, '_').trim().slice(0, 31) || 'Sheet';
  if (!usedNames.has(name)) { usedNames.add(name); return name; }
  for (let i = 2; i < 1000; i++) {
    const suffix = ` ${i}`;
    const candidate = name.slice(0, 31 - suffix.length) + suffix;
    if (!usedNames.has(candidate)) { usedNames.add(candidate); return candidate; }
  }
  return name;
}

// ── CSV generation ────────────────────────────────────────────────────────────

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
}

function buildFlatCSV(results, splitMembership) {
  const summaryRows = [], timeseriesRows = [];

  for (const s of results) {
    const totals = { views: 0, reads: 0, claps: 0, replies: 0, highlights: 0, follows: 0, earningsCents: 0 };
    for (const d of s.days) {
      totals.views      += d.views ?? ((d.memberViews || 0) + (d.nonMemberViews || 0));
      totals.reads      += d.reads ?? ((d.memberReads || 0) + (d.nonMemberReads || 0));
      totals.claps      += d.claps ?? ((d.memberClaps || 0) + (d.nonMemberClaps || 0));
      totals.replies    += d.replies ?? ((d.memberReplies || 0) + (d.nonMemberReplies || 0));
      totals.highlights += d.highlights ?? ((d.memberHighlights || 0) + (d.nonMemberHighlights || 0));
      totals.follows    += d.follows ?? ((d.memberFollows || 0) + (d.nonMemberFollows || 0));
      totals.earningsCents += d.earningsCents || 0;

      timeseriesRows.push({ postId: s.postId, title: s.title, ...d, date: fmtDate(d.date) });
    }
    summaryRows.push({
      postId: s.postId, title: s.title, ...totals,
      earningsUSD: +(totals.earningsCents / 100).toFixed(2)
    });
  }

  return { summaryRows, timeseriesRows };
}

// ── Utils ─────────────────────────────────────────────────────────────────────

// YYYY-MM-DD → DD/MM/YYYY (UK display); hyphens variant for filenames
function fmtDate(iso) {
  if (!iso || iso.length < 10) return iso || '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
function fmtDateFile(iso) { return fmtDate(iso).replace(/\//g, '-'); }
// Local-timezone today as YYYY-MM-DD (avoids UTC-date-rollover issues)
function localTodayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function sanitizeFilename(s) {
  return String(s).replace(/[^\w\s\-]/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'story';
}

function fmtNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
