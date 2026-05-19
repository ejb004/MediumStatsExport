// Service worker — coordinates popup <-> scraper messaging

let popupPort = null;

// Persists across popup open/close while service worker is alive
const exportState = {
  inProgress:    false,
  lastProgress:  null,   // { current, total, status } — catch up reconnecting popup
  pendingResult: null,   // result waiting for popup to reconnect and consume
  pendingError:  null,
  exportFormat:  'xlsx'  // echoed back in done so popup knows which format was requested
};

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'popup') return;
  popupPort = port;

  // Immediately catch up a popup that reconnected mid-export or after it finished
  if (exportState.inProgress && exportState.lastProgress) {
    port.postMessage({ action: 'progress', ...exportState.lastProgress });
  } else if (exportState.pendingResult) {
    port.postMessage({ action: 'done', data: exportState.pendingResult, exportFormat: exportState.exportFormat });
    exportState.pendingResult = null;
  } else if (exportState.pendingError) {
    port.postMessage({ action: 'error', message: exportState.pendingError });
    exportState.pendingError = null;
  }

  port.onDisconnect.addListener(() => { popupPort = null; });

  port.onMessage.addListener(async msg => {
    if (msg.action !== 'export') return;
    if (exportState.inProgress) return; // already running, ignore duplicate

    exportState.inProgress    = true;
    exportState.lastProgress  = { current: 0, total: null, status: 'Starting...' };
    exportState.pendingResult = null;
    exportState.pendingError  = null;
    exportState.exportFormat  = msg.settings.exportFormat || 'xlsx';

    await chrome.storage.local.set({ exportSettings: msg.settings });

    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: msg.tabId },
        files: ['scraper.js']
      });
      exportState.inProgress = false;
      const doneMsg = { action: 'done', data: result, exportFormat: exportState.exportFormat };
      if (popupPort) popupPort.postMessage(doneMsg);
      else exportState.pendingResult = result; // popup closed — hold until it reopens
    } catch (e) {
      exportState.inProgress = false;
      if (popupPort) popupPort.postMessage({ action: 'error', message: e.message });
      else exportState.pendingError = e.message;
    }
  });
});

// Forward progress messages from injected scraper; keep lastProgress updated
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'progress') {
    if (!msg.warning) {
      exportState.lastProgress = { current: msg.current, total: msg.total, status: msg.status };
    }
    popupPort?.postMessage(msg);
  }
  sendResponse({});
});
