import './styles.css';
import { PdfBook, PasswordException } from './pdfLoader.js';
import { Reader } from './reader.js';
import { createUI } from './ui.js';
import {
  DEFAULT_SETTINGS,
  applySettings,
  mountSettingsPanel,
  normalizeSettings,
} from './settings.js';
import {
  getDocState,
  getStoredSettings,
  hashFile,
  saveDocState,
  saveStoredSettings,
} from './storage.js';

const BASE = import.meta.env.BASE_URL || './';

const ui = createUI();
let globalSettings = normalizeSettings(getStoredSettings() || DEFAULT_SETTINGS);
let currentDoc = null;
let reader = null;
let openToken = 0;
let docSaveTimer = 0;
const pendingDocSaves = new Map();

applySettings(document.documentElement, globalSettings);

const settingsPanel = mountSettingsPanel(ui.refs.settingsBody, {
  settings: globalSettings,
  onChange: (next) => handleSettingsChange(next),
});

function flushPendingDocSaves() {
  for (const [key, progress] of pendingDocSaves) {
    saveDocState(key, { progress });
  }
  pendingDocSaves.clear();
}

function saveDocProgress(progress) {
  const doc = currentDoc;
  if (!doc) return;
  doc.progress = progress;
  pendingDocSaves.set(doc.key, progress);
  window.clearTimeout(docSaveTimer);
  docSaveTimer = window.setTimeout(flushPendingDocSaves, 350);
}

function handleSettingsChange(next) {
  globalSettings = normalizeSettings(next);
  applySettings(document.documentElement, globalSettings);
  settingsPanel.refresh(globalSettings);
  saveStoredSettings(globalSettings);

  if (reader) reader.updateSettings(globalSettings);

  if (currentDoc) {
    saveDocState(currentDoc.key, {
      settings: globalSettings,
      title: currentDoc.title,
      pageCount: currentDoc.pageCount,
      filename: currentDoc.filename,
    });
  }
}

function friendlyError(error) {
  if (!error) return 'The PDF could not be opened.';
  if (error.name === 'InvalidPDFException') {
    return 'That file is not a valid PDF, or it is damaged.';
  }
  if (error.name === 'MissingPDFException') {
    return 'The PDF file is missing.';
  }
  if (error.name === 'UnexpectedResponseException') {
    return 'The PDF could not be loaded.';
  }
  if (error instanceof PasswordException) {
    return 'A password is required to open this PDF.';
  }
  return error.message || 'The PDF could not be opened.';
}

async function buildBook(file, token) {
  const data = new Uint8Array(await file.arrayBuffer());
  if (token !== openToken) return null;

  let password;
  for (;;) {
    if (token !== openToken) return null;
    try {
      return await PdfBook.open({
        data,
        password,
        onProgress: ({ ratio }) => {
          if (token !== openToken) return;
          ui.setOpening(true, {
            title: file.name,
            status: 'Parsing PDF…',
            progress: Number.isFinite(ratio) ? 0.05 + ratio * 0.35 : null,
          });
        },
        requestPassword: async ({ incorrect }) => {
          if (token !== openToken) return null;
          ui.setOpening(false);
          const value = await ui.promptPassword(incorrect);
          if (token !== openToken) return null;
          if (value === null) return null;
          ui.setOpening(true, {
            title: file.name,
            status: 'Unlocking document…',
            progress: null,
          });
          return value;
        },
      });
    } catch (error) {
      if (error instanceof PasswordException && error.incorrect) {
        password = undefined;
        continue;
      }
      if (error instanceof PasswordException) {
        // User cancelled the password prompt, or no password was supplied.
        const cancelled = new Error('OPEN_CANCELLED');
        cancelled.name = 'OpenCancelled';
        throw cancelled;
      }
      throw error;
    }
  }
}

async function openFile(file) {
  if (!(file instanceof File)) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    ui.toast('Please choose a PDF file.', { error: true });
    return;
  }

  const token = ++openToken;
  ui.showLandingError('');
  ui.setOpening(true, {
    title: file.name,
    status: 'Reading file…',
    progress: null,
  });
  ui.onOpeningCancel(() => {
    if (token !== openToken) return;
    openToken += 1;
    ui.setOpening(false);
    ui.toast('Opening cancelled.');
  });

  let book = null;
  try {
    const docKey = await hashFile(file);
    if (token !== openToken) return;

    book = await buildBook(file, token);
    if (!book || token !== openToken) {
      book?.destroy().catch(() => {});
      return;
    }

    const savedState = getDocState(docKey) || {};
    const inferredTitle = file.name.replace(/\.pdf$/i, '').trim() || 'Untitled PDF';
    const title = book.metadata.title || inferredTitle;
    const author = book.metadata.author;
    const metaDetail = `${book.numPages} page${book.numPages === 1 ? '' : 's'}${
      author ? ` · ${author}` : ''
    }`;

    // Tear down the previous document only after the new one has opened
    // successfully, so a failed or cancelled open leaves the reader intact.
    if (reader) {
      reader.destroy();
      reader = null;
    }
    currentDoc = null;

    if (savedState.settings) {
      globalSettings = normalizeSettings({
        ...globalSettings,
        ...savedState.settings,
      });
      applySettings(document.documentElement, globalSettings);
      settingsPanel.refresh(globalSettings);
      saveStoredSettings(globalSettings);
    }

    currentDoc = {
      key: docKey,
      title,
      pageCount: book.numPages,
      filename: file.name,
      progress: savedState.progress || { page: 1, offset: 0 },
    };

    saveDocState(docKey, {
      title,
      pageCount: book.numPages,
      filename: file.name,
      author: author || '',
      settings: globalSettings,
      progress: currentDoc.progress,
    });

    ui.setDocumentInfo({ title, detail: metaDetail });
    ui.closeDrawers();
    ui.enterReader();
    ui.setOpening(true, {
      title,
      status: 'Preparing the reading view…',
      progress: null,
    });

    reader = new Reader({
      book,
      docKey,
      title,
      metaDetail,
      savedState,
      settings: globalSettings,
      mount: ui.refs.readerMount,
      ui,
      onPositionChange: saveDocProgress,
    });

    await reader.init({
      onPrepare: ({ ratio, label }) => {
        if (token !== openToken) return;
        ui.setOpening(true, {
          title,
          status: label,
          progress: 0.45 + ratio * 0.5,
        });
      },
    });

    if (token !== openToken) {
      reader.destroy();
      reader = null;
      return;
    }

    ui.setOpening(false);
  } catch (error) {
    if (error?.name === 'OpenCancelled') {
      ui.setOpening(false);
      if (!reader) {
        ui.toast('Opening cancelled.');
      }
      return;
    }
    if (token !== openToken) return;

    book?.destroy().catch(() => {});
    ui.setOpening(false);
    if (reader && reader.book === book) {
      reader.destroy();
      reader = null;
      currentDoc = null;
      ui.leaveReader();
    }
    const message = friendlyError(error);
    if (reader) ui.toast(message, { error: true, duration: 6500 });
    else ui.showLandingError(message);
    console.error('[pdfreader] open failed', error);
  }
}

async function openSample() {
  try {
    ui.showLandingError('');
    const response = await fetch(`${BASE}sample.pdf`, { cache: 'no-store' });
    if (!response.ok) throw new Error('The sample PDF is missing. Run npm run sample.');
    const blob = await response.blob();
    const file = new File([blob], 'The Quiet Art of Reading.pdf', {
      type: 'application/pdf',
    });
    await openFile(file);
  } catch (error) {
    ui.showLandingError(error?.message || 'The sample PDF could not be loaded.');
  }
}

/* ------------------------------------------------------------------ */
/* shell events                                                       */
/* ------------------------------------------------------------------ */

ui.refs.fileInput.addEventListener('change', () => {
  const file = ui.refs.fileInput.files?.[0];
  ui.refs.fileInput.value = '';
  if (file) openFile(file);
});

for (const button of [ui.refs.btnOpen, document.querySelector('#chooseFile')]) {
  button?.addEventListener('click', () => ui.refs.fileInput.click());
}

document.querySelector('#openSample')?.addEventListener('click', openSample);

ui.refs.btnToc?.addEventListener('click', () => {
  if (!reader) return;
  if (ui.drawerIsOpen(ui.refs.tocDrawer)) ui.closeDrawers();
  else ui.openDrawer(ui.refs.tocDrawer);
});

ui.refs.btnSearch?.addEventListener('click', () => {
  if (!reader) return;
  if (ui.drawerIsOpen(ui.refs.searchDrawer)) {
    ui.closeDrawers();
    return;
  }
  ui.openDrawer(ui.refs.searchDrawer);
  window.setTimeout(() => ui.refs.searchInput.focus(), 60);
});

ui.refs.btnSettings?.addEventListener('click', () => {
  if (ui.drawerIsOpen(ui.refs.settingsDrawer)) ui.closeDrawers();
  else ui.openDrawer(ui.refs.settingsDrawer);
});

ui.refs.btnOriginal?.addEventListener('click', () => {
  reader?.openOriginalOverlay(reader.currentPage);
});

ui.refs.btnPaged?.addEventListener('click', () => {
  handleSettingsChange({ ...globalSettings, paginated: !globalSettings.paginated });
});

window.addEventListener('beforeunload', () => {
  if (reader) reader.emitPosition();
  if (currentDoc) pendingDocSaves.set(currentDoc.key, currentDoc.progress);
  flushPendingDocSaves();
});
window.addEventListener('pagehide', flushPendingDocSaves);

ui.refs.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    ui.closeDrawers();
  }
});

/* Drag and drop */
let dragDepth = 0;

document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  ui.setDropOverlay(true);
});

document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) ui.setDropOverlay(false);
});

document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  dragDepth = 0;
  ui.setDropOverlay(false);
  const file = [...event.dataTransfer.files].find(
    (candidate) => candidate.type === 'application/pdf' || /\.pdf$/i.test(candidate.name),
  );
  if (!file) {
    ui.toast('That file is not a PDF.', { error: true });
    return;
  }
  openFile(file);
});

window.addEventListener('error', (event) => {
  if (event.error?.name === 'RenderingCancelledException') event.preventDefault();
});
