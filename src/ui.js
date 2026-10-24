/**
 * ui.js
 * Small DOM helpers and shell-level UI (drawers, toast, modals, status bar).
 * No framework, no external icon fonts: every icon is inline SVG or text.
 */

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function iconButton(label, path, className = 'icon-button') {
  const button = el('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" class="icon"><path d="${path}" /></svg>`;
  return button;
}

export function createUI() {
  const refs = {
    topbar: qs('#topbar'),
    btnOpen: qs('#btnOpen'),
    btnToc: qs('#btnToc'),
    btnSearch: qs('#btnSearch'),
    btnSettings: qs('#btnSettings'),
    btnOriginal: qs('#btnOriginal'),
    btnPaged: qs('#btnPaged'),
    readerMount: qs('#readerMount'),
    statusbar: qs('#statusbar'),
    landing: qs('#landing'),
    landingError: qs('#landingError'),
    docTitle: qs('#docTitle'),
    docMeta: qs('#docMeta'),
    extractionBar: qs('#extractionBar'),
    extractionFill: qs('#extractionFill'),
    extractionStatus: qs('#extractionStatus'),
    progressFill: qs('#progressFill'),
    pageReadout: qs('#pageReadout'),
    gotoForm: qs('#gotoForm'),
    gotoPage: qs('#gotoPage'),
    prevScreen: qs('#prevScreen'),
    nextScreen: qs('#nextScreen'),
    tocDrawer: qs('#tocDrawer'),
    tocBody: qs('#tocBody'),
    settingsDrawer: qs('#settingsDrawer'),
    settingsBody: qs('#settingsBody'),
    searchDrawer: qs('#searchDrawer'),
    searchInput: qs('#searchInput'),
    searchStatus: qs('#searchStatus'),
    searchResults: qs('#searchResults'),
    searchPrev: qs('#searchPrev'),
    searchNext: qs('#searchNext'),
    scrim: qs('#scrim'),
    dropOverlay: qs('#dropOverlay'),
    fileInput: qs('#fileInput'),
    toast: qs('#toast'),
    opening: qs('#opening'),
    openingTitle: qs('#openingTitle'),
    openingStatus: qs('#openingStatus'),
    openingFill: qs('#openingFill'),
    openingCancel: qs('#openingCancel'),
    passwordDialog: qs('#passwordDialog'),
    passwordForm: qs('#passwordForm'),
    passwordInput: qs('#passwordInput'),
    passwordError: qs('#passwordError'),
    passwordCancel: qs('#passwordCancel'),
    originalDialog: qs('#originalDialog'),
    originalCanvas: qs('#originalCanvas'),
    originalCanvasWrap: qs('#originalCanvasWrap'),
    originalPageLabel: qs('#originalPageLabel'),
    originalZoomLabel: qs('#originalZoomLabel'),
    originalLoading: qs('#originalLoading'),
    originalPrev: qs('#originalPrev'),
    originalNext: qs('#originalNext'),
    originalZoomIn: qs('#originalZoomIn'),
    originalZoomOut: qs('#originalZoomOut'),
    originalClose: qs('#originalClose'),
  };

  let activeDrawer = null;
  let toastTimer = 0;
  let openingCancel = null;

  function setScrim() {
    const anyOpen = Boolean(activeDrawer);
    refs.scrim.hidden = !anyOpen;
    document.body.classList.toggle('drawer-open', anyOpen);
  }

  function closeDrawers() {
    for (const drawer of [refs.tocDrawer, refs.settingsDrawer, refs.searchDrawer]) {
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
    }
    activeDrawer = null;
    setScrim();
  }

  function openDrawer(drawer) {
    if (!drawer) return;
    closeDrawers();
    activeDrawer = drawer;
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    setScrim();
  }

  function drawerIsOpen(drawer) {
    return activeDrawer === drawer;
  }

  refs.scrim.addEventListener('click', closeDrawers);
  for (const button of qsa('[data-close-drawer]')) {
    button.addEventListener('click', closeDrawers);
  }

  function toast(message, { error = false, duration = 3800 } = {}) {
    window.clearTimeout(toastTimer);
    refs.toast.textContent = message;
    refs.toast.classList.toggle('is-error', error);
    refs.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => {
      refs.toast.classList.remove('is-visible');
    }, duration);
  }

  function showLandingError(message) {
    refs.landingError.textContent = message || '';
    refs.landingError.hidden = !message;
  }

  function enterReader() {
    refs.landing.hidden = true;
    refs.topbar.hidden = false;
    refs.statusbar.hidden = false;
    refs.readerMount.hidden = false;
    showLandingError('');
    window.scrollTo(0, 0);
  }

  function leaveReader() {
    closeDrawers();
    refs.landing.hidden = false;
    refs.topbar.hidden = true;
    refs.statusbar.hidden = true;
    refs.readerMount.hidden = true;
    refs.readerMount.replaceChildren();
    document.title = 'Reflow — a PDF reader for reading';
    window.scrollTo(0, 0);
  }

  function setDocumentInfo({ title, detail }) {
    refs.docTitle.textContent = title || 'Untitled PDF';
    refs.docTitle.title = title || '';
    refs.docMeta.textContent = detail || '';
    document.title = `${title || 'PDF'} — Reflow`;
  }

  function setOpening(visible, { title, status, progress } = {}) {
    refs.opening.hidden = !visible;
    if (!visible) return;
    if (title !== undefined) refs.openingTitle.textContent = title;
    if (status !== undefined) refs.openingStatus.textContent = status;
    if (progress === null || progress === undefined) {
      refs.opening.classList.add('is-indeterminate');
      refs.openingFill.style.width = '35%';
    } else {
      refs.opening.classList.remove('is-indeterminate');
      refs.openingFill.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
    }
  }

  function onOpeningCancel(handler) {
    openingCancel = handler;
  }

  refs.openingCancel.addEventListener('click', () => {
    openingCancel?.();
  });

  function setProgress(ratio) {
    const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    refs.progressFill.style.width = `${percent}%`;
  }

  function setPageReadout(text) {
    refs.pageReadout.textContent = text;
  }

  function setExtractionProgress({ ratio = null, label = '' } = {}) {
    if (ratio === null || ratio === undefined) {
      if (label) {
        refs.extractionStatus.textContent = label;
      }
      return;
    }
    const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    refs.extractionBar.hidden = false;
    refs.extractionFill.style.width = `${percent}%`;
    refs.extractionStatus.textContent = label;
  }

  function finishExtraction() {
    refs.extractionBar.hidden = true;
    refs.extractionStatus.textContent = '';
  }

  function setDropOverlay(visible) {
    refs.dropOverlay.hidden = !visible;
  }

  function openOriginalDialog() {
    if (!refs.originalDialog.open) refs.originalDialog.showModal();
  }

  function closeOriginalDialog() {
    if (refs.originalDialog.open) refs.originalDialog.close();
  }

  let passwordResolver = null;

  function finishPassword(value) {
    if (!passwordResolver) return;
    const resolve = passwordResolver;
    passwordResolver = null;
    if (refs.passwordDialog.open) refs.passwordDialog.close();
    refs.passwordForm.reset();
    resolve(value);
  }

  function promptPassword(incorrect = false) {
    // Cancel any earlier prompt rather than stacking dialogs.
    if (passwordResolver) finishPassword(null);
    refs.passwordError.hidden = !incorrect;
    refs.passwordInput.value = '';
    refs.passwordDialog.showModal();
    window.setTimeout(() => refs.passwordInput.focus(), 30);

    return new Promise((resolve) => {
      passwordResolver = resolve;
    });
  }

  refs.passwordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = refs.passwordInput.value;
    if (!value) {
      refs.passwordInput.focus();
      return;
    }
    finishPassword(value);
  });
  refs.passwordCancel.addEventListener('click', () => finishPassword(null));
  refs.passwordDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    finishPassword(null);
  });

  refs.originalDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeOriginalDialog();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (activeDrawer) {
      closeDrawers();
      return;
    }
    if (refs.originalDialog.open) closeOriginalDialog();
  });

  return {
    refs,
    openDrawer,
    closeDrawers,
    drawerIsOpen,
    toast,
    showLandingError,
    enterReader,
    leaveReader,
    setDocumentInfo,
    setOpening,
    onOpeningCancel,
    setProgress,
    setPageReadout,
    setExtractionProgress,
    finishExtraction,
    setDropOverlay,
    openOriginalDialog,
    closeOriginalDialog,
    promptPassword,
  };
}
