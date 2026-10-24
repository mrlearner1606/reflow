/**
 * reader.js
 * The reading experience: lazy page extraction, reflow rendering, scrolling
 * and paginated layouts, TOC, search, original-page comparison and persistence.
 */

import {
  REFLOW_VERSION,
  addPageMarginals,
  createMarginalIndex,
  findRepeatedMarginals,
  reflowLines,
} from './reflow.js';
import { getCachedPage, setCachedPage } from './storage.js';
import { isPageBackgroundImage } from './imagePlacement.js';
import { isOcrAvailable, recognizePage } from './ocr.js';
import { el, qs } from './ui.js';

const IDLE_TIMEOUT = 160;
const SEARCH_LIMIT = 500;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nextIdle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT });
    } else {
      setTimeout(resolve, 16);
    }
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export class Reader {
  constructor({
    book,
    docKey,
    title,
    metaDetail,
    savedState,
    settings,
    mount,
    ui,
    onPositionChange,
    onUserSettingsChange,
  }) {
    this.book = book;
    this.numPages = book.numPages;
    this.docKey = docKey;
    this.title = title;
    this.metaDetail = metaDetail;
    this.savedState = savedState || {};
    this.settings = { ...settings };
    this.mount = mount;
    this.ui = ui;
    this.onPositionChange = onPositionChange;
    this.onUserSettingsChange = onUserSettingsChange;

    this.currentPage = 1;
    this.mode = this.settings.paginated ? 'paged' : 'scroll';
    this.renderEpoch = 1;

    this.rawPages = new Map();
    this.rawPromises = new Map();
    this.data = new Map();
    this.pageEls = new Map();
    this.renderedPages = new Set();
    this.visiblePages = new Set();
    this.originalPages = new Set();
    this.pendingPages = new Set();
    this.pageWaiters = new Map();
    this.imagePromises = new Map();
    this.priorityQueue = [];
    this.backgroundQueue = [];
    this.processing = false;
    this.stopped = false;
    this.marginals = createMarginalIndex();
    this.marginalPages = new Set();
    this.repeated = new Set();
    this.marginalsLocked = false;
    this.extractionHideTimer = 0;

    this.search = {
      query: '',
      matches: [],
      current: -1,
      running: false,
      token: 0,
      scannedPage: 0,
    };
    this.searchDebounce = 0;

    this.paged = {
      flow: null,
      stage: null,
      viewport: null,
      metaLabel: null,
      screenCount: null,
      quality: null,
      toggle: null,
      width: 0,
      gap: 52,
      screens: 1,
      screen: 0,
      original: false,
    };
    this.pagedToken = 0;
    this.navigating = false;

    this.positionTimer = 0;
    this.scrollRaf = 0;
    this.anchorGuard = 0;
    this.anchorPage = null;
    this.anchorRaf = 0;
    this.anchorTimer = 0;
    this.resizeTimer = 0;
    this.lastWheel = 0;
    this.touchStart = null;
    this.cleanup = [];
    this.observer = null;

    this.handleScroll = this.handleScroll.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleBeforeUnload = this.handleBeforeUnload.bind(this);
  }

  async init({ onPrepare } = {}) {
    this.mount.replaceChildren();

    this.scrollView = el('div', 'scroll-view');
    this.column = el('div', 'reading-column');
    this.scrollView.append(this.column);

    this.pagedView = el('div', 'paged-view');
    this.pagedView.hidden = true;
    this.pagedView.innerHTML = `
      <div class="paged-meta">
        <span class="paged-page-label"></span>
        <span class="paged-quality-label"></span>
        <button type="button" class="page-original-toggle" data-page-toggle="1">Original</button>
      </div>
      <div class="paged-stage">
        <div class="paged-viewport">
          <div class="paged-flow"></div>
        </div>
      </div>
      <div class="paged-hint">
        <span>Use ← → or swipe to turn the page</span>
        <span class="paged-screen-count"></span>
      </div>
    `;
    this.mount.append(this.scrollView, this.pagedView);

    this.paged.stage = qs('.paged-stage', this.pagedView);
    this.paged.viewport = qs('.paged-viewport', this.pagedView);
    this.paged.flow = qs('.paged-flow', this.pagedView);
    this.paged.metaLabel = qs('.paged-page-label', this.pagedView);
    this.paged.screenCount = qs('.paged-screen-count', this.pagedView);
    this.paged.quality = qs('.paged-quality-label', this.pagedView);
    this.paged.toggle = qs('.page-original-toggle', this.pagedView);

    this.buildSections();
    this.renderToc();
    this.bindUi();

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number(entry.target.dataset.page);
          if (!Number.isFinite(page)) continue;
          if (entry.isIntersecting) {
            this.visiblePages.add(page);
            this.requestPage(page, { priority: true })
              .then(() => {
                if (this.visiblePages.has(page) && this.mode === 'scroll') {
                  this.renderPageSection(page);
                }
              })
              .catch(() => {});
          } else {
            this.visiblePages.delete(page);
          }
        }
      },
      { root: null, rootMargin: '1400px 0px', threshold: 0.01 },
    );

    await this.prepareMarginals(onPrepare);

    // Start observing only after the marginal sample has been collected: the
    // first extraction must already know which running heads to drop.
    for (const section of this.pageEls.values()) this.observer.observe(section);

    this.mode = this.settings.paginated ? 'paged' : 'scroll';
    this.applyModeDom();

    const savedPage = Number(this.savedState?.progress?.page);
    const startPage = clamp(Number.isFinite(savedPage) ? savedPage : 1, 1, this.numPages);
    this.currentPage = startPage;

    if (this.mode === 'paged') {
      await this.renderPaged({ preserveScreen: false });
    } else {
      await this.goToPage(startPage, {
        behavior: 'auto',
        offset: Number(this.savedState?.progress?.offset) || 0,
      });
    }

    this.startBackground(startPage);
    this.updateChrome();
    this.schedulePositionSave();

    if (document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          if (this.stopped) return;
          if (this.mode === 'paged') this.renderPaged({ preserveScreen: true });
        })
        .catch(() => {});
    }
  }

  /* ------------------------------------------------------------------ */
  /* page scaffolding                                                   */
  /* ------------------------------------------------------------------ */

  buildSections() {
    const fragment = document.createDocumentFragment();

    for (let page = 1; page <= this.numPages; page += 1) {
      const section = el('section', 'pdf-page');
      section.id = `page-${page}`;
      section.dataset.page = String(page);
      section.setAttribute('aria-label', `Page ${page}`);

      const header = el('div', 'page-header');
      const number = el('span', 'page-number');
      number.append(el('span', 'page-number-rule'), document.createTextNode(`Page ${page}`));

      const badge = el('span', 'page-badge');
      badge.hidden = true;

      const toggle = el('button', 'page-original-toggle', 'Original');
      toggle.type = 'button';
      toggle.dataset.pageToggle = String(page);
      toggle.setAttribute('aria-label', `View original page ${page}`);

      header.append(number, badge, toggle);

      const body = el('div', 'page-body');
      const placeholder = el('div', 'page-placeholder');
      placeholder.append(el('span', 'loading-dot'), document.createTextNode('Loading text…'));
      body.append(placeholder);

      section.append(header, body);
      fragment.append(section);
      this.pageEls.set(page, section);
    }

    this.column.append(fragment);
    this.sectionList = [...this.pageEls.values()];
  }

  bindUi() {
    const refs = this.ui.refs;

    const onMountClick = (event) => {
      const toggle = event.target.closest('[data-page-toggle]');
      if (toggle) {
        const page = Number(toggle.dataset.pageToggle) || this.currentPage;
        this.toggleOriginal(page);
        return;
      }
      const viewOriginal = event.target.closest('[data-view-original]');
      if (viewOriginal) {
        this.toggleOriginal(Number(viewOriginal.dataset.page));
        return;
      }
      const ocr = event.target.closest('[data-ocr-page]');
      if (ocr) {
        this.runOcr(Number(ocr.dataset.ocrPage), ocr);
      }
    };
    this.mount.addEventListener('click', onMountClick);
    this.cleanup.push(() => this.mount.removeEventListener('click', onMountClick));

    const onGoto = (event) => {
      event.preventDefault();
      const value = Number.parseInt(refs.gotoPage.value, 10);
      if (!Number.isFinite(value)) return;
      refs.gotoPage.value = '';
      refs.gotoPage.blur();
      this.goToPage(value);
    };
    refs.gotoForm.addEventListener('submit', onGoto);
    this.cleanup.push(() => refs.gotoForm.removeEventListener('submit', onGoto));

    const onPrev = () => this.prevScreen();
    const onNext = () => this.nextScreen();
    refs.prevScreen.addEventListener('click', onPrev);
    refs.nextScreen.addEventListener('click', onNext);
    this.cleanup.push(() => {
      refs.prevScreen.removeEventListener('click', onPrev);
      refs.nextScreen.removeEventListener('click', onNext);
    });

    window.addEventListener('scroll', this.handleScroll, { passive: true });
    window.addEventListener('keydown', this.handleKeydown);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    this.cleanup.push(() => {
      window.removeEventListener('scroll', this.handleScroll);
      window.removeEventListener('keydown', this.handleKeydown);
      window.removeEventListener('resize', this.handleResize);
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    });

    // Original-page dialog
    refs.originalClose.addEventListener('click', () => this.ui.closeOriginalDialog());
    refs.originalPrev.addEventListener('click', () => this.shiftOriginalOverlay(-1));
    refs.originalNext.addEventListener('click', () => this.shiftOriginalOverlay(1));
    refs.originalZoomIn.addEventListener('click', () => this.zoomOriginalOverlay(1));
    refs.originalZoomOut.addEventListener('click', () => this.zoomOriginalOverlay(-1));

    const onDialogKey = (event) => {
      if (!refs.originalDialog.open) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.shiftOriginalOverlay(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.shiftOriginalOverlay(1);
      }
    };
    refs.originalDialog.addEventListener('keydown', onDialogKey);
    this.cleanup.push(() =>
      refs.originalDialog.removeEventListener('keydown', onDialogKey),
    );

    const cancelOnUser = () => this.cancelAnchorHold();
    window.addEventListener('wheel', cancelOnUser, { passive: true });
    window.addEventListener('touchstart', cancelOnUser, { passive: true });
    window.addEventListener('pointerdown', cancelOnUser, { passive: true });
    this.cleanup.push(() => {
      window.removeEventListener('wheel', cancelOnUser);
      window.removeEventListener('touchstart', cancelOnUser);
      window.removeEventListener('pointerdown', cancelOnUser);
    });

    const onWheel = (event) => this.handlePagedWheel(event);
    this.paged.stage.addEventListener('wheel', onWheel, { passive: false });
    this.cleanup.push(() => this.paged.stage.removeEventListener('wheel', onWheel));

    const onTouchStart = (event) => {
      const touch = event.changedTouches[0];
      this.touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    };
    const onTouchEnd = (event) => {
      if (!this.touchStart) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - this.touchStart.x;
      const dy = touch.clientY - this.touchStart.y;
      this.touchStart = null;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) this.nextScreen();
      else this.prevScreen();
    };
    this.paged.stage.addEventListener('touchstart', onTouchStart, { passive: true });
    this.paged.stage.addEventListener('touchend', onTouchEnd, { passive: true });
    this.cleanup.push(() => {
      this.paged.stage.removeEventListener('touchstart', onTouchStart);
      this.paged.stage.removeEventListener('touchend', onTouchEnd);
    });

    this.bindSearch();
  }

  /* ------------------------------------------------------------------ */
  /* extraction pipeline                                                */
  /* ------------------------------------------------------------------ */

  async prepareMarginals(onPrepare) {
    const sample = new Set([1, this.numPages, 2]);
    const slots = Math.min(8, this.numPages);
    if (slots > 1) {
      for (let i = 0; i < slots; i += 1) {
        sample.add(1 + Math.round((i * (this.numPages - 1)) / (slots - 1)));
      }
    }
    const pages = [...sample]
      .filter((page) => page >= 1 && page <= this.numPages)
      .sort((a, b) => a - b);

    for (let i = 0; i < pages.length; i += 1) {
      onPrepare?.({
        ratio: (i + 1) / pages.length,
        label: `Reading page layout · ${i + 1} of ${pages.length}`,
      });
      try {
        await this.loadRawLines(pages[i]);
      } catch {
        /* A single bad page should not prevent opening the document. */
      }
      await nextIdle();
    }

    this.marginalsLocked = true;
    this.repeated = findRepeatedMarginals(this.marginals, {
      removeHeaderFooter: this.settings.removeHeaderFooter,
    });
  }

  async loadRawLines(pageNumber) {
    const page = clamp(Math.round(pageNumber), 1, this.numPages);
    if (this.rawPages.has(page)) return this.rawPages.get(page);
    if (!this.rawPromises.has(page)) {
      const promise = (async () => {
        let value = null;
        try {
          const cached = await getCachedPage(this.docKey, page);
          if (
            cached &&
            cached.v === REFLOW_VERSION &&
            Array.isArray(cached.lines) &&
            Array.isArray(cached.tables) &&
            Number.isFinite(cached.pageWidth) &&
            Number.isFinite(cached.pageHeight)
          ) {
            value = cached;
          }
        } catch {
          /* cache unavailable */
        }

        if (!value) {
          const result = await this.book.getPageLines(page);
          value = {
            v: REFLOW_VERSION,
            lines: result.lines,
            tables: Array.isArray(result.tables) ? result.tables : [],
            pageWidth: result.pageWidth,
            pageHeight: result.pageHeight,
          };
          setCachedPage(this.docKey, page, value).catch(() => {});
        }

        this.rawPages.set(page, value);
        if (!this.marginalsLocked && !this.marginalPages.has(page)) {
          addPageMarginals(this.marginals, value.lines, value.pageHeight);
          this.marginalPages.add(page);
        }
        return value;
      })();

      this.rawPromises.set(page, promise);
      promise
        .finally(() => this.rawPromises.delete(page))
        .catch(() => {});
    }
    return this.rawPromises.get(page);
  }

  async extractPage(pageNumber) {
    if (this.data.has(pageNumber)) return this.data.get(pageNumber);

    let raw;
    try {
      raw = await this.loadRawLines(pageNumber);
    } catch (error) {
      const failure = {
        lines: [],
        pageWidth: 612,
        pageHeight: 792,
        blocks: [],
        layout: { columns: [], gutters: [], isMultiColumn: false },
        quality: {
          scanned: false,
          lowQuality: true,
          score: 0,
          reasons: ['This page could not be read.'],
        },
        stats: { lineCount: 0, blockCount: 0, imageCount: 0, charCount: 0 },
        images: [],
        error: error?.message || 'Unknown PDF error',
      };
      this.data.set(pageNumber, failure);
      return failure;
    }

    const hasText = raw.lines.some((line) => line.text && line.text.trim());
    let images = [];
    try {
      const placements = await this.book.getPageImages(pageNumber);
      // On a text page, page-sized rasters are backgrounds: a scan with an
      // invisible OCR layer, a screenshot of the page, a watermark. Keeping
      // one would repeat the page next to its own reflowed text. The test is
      // geometric: does most of the page's text sit on top of the image?
      images = hasText
        ? placements.filter(
            (image) =>
              !image.fullPage &&
              !isPageBackgroundImage({
                image,
                lines: raw.lines,
                pageWidth: raw.pageWidth,
                pageHeight: raw.pageHeight,
              }),
          )
        : placements;
    } catch {
      images = [];
    }

    const result = reflowLines({
      lines: raw.lines,
      tables: raw.tables,
      pageNumber,
      pageWidth: raw.pageWidth,
      pageHeight: raw.pageHeight,
      marginalSignatures: this.repeated,
      images,
      options: {
        removeHeaderFooter: this.settings.removeHeaderFooter,
      },
    });

    const data = {
      ...result,
      lines: raw.lines,
      images,
      pageWidth: raw.pageWidth,
      pageHeight: raw.pageHeight,
    };
    this.data.set(pageNumber, data);

    // Never switch to the original page automatically. Reflow whenever the
    // page produced blocks (text or images); the original view is one click
    // away. A page with no blocks at all has nothing to reflow, so the reader
    // falls back to the page canvas in the render step.

    if (this.stopped) return data;

    if (this.mode === 'scroll') {
      if (this.visiblePages.has(pageNumber) || pageNumber === this.currentPage) {
        this.renderPageSection(pageNumber);
      }
    } else if (pageNumber === this.currentPage) {
      this.renderPaged({ preserveScreen: false });
    }

    return data;
  }

  requestPage(pageNumber, { priority = false } = {}) {
    const page = clamp(Math.round(pageNumber), 1, this.numPages);
    if (this.data.has(page)) return Promise.resolve(this.data.get(page));

    return new Promise((resolve) => {
      const waiters = this.pageWaiters.get(page) || [];
      waiters.push(resolve);
      this.pageWaiters.set(page, waiters);

      if (!this.pendingPages.has(page)) {
        this.pendingPages.add(page);
        if (priority) {
          this.priorityQueue.unshift(page);
        } else {
          this.backgroundQueue.push(page);
        }
      } else if (priority) {
        // A visible page should not wait behind the background sweep.
        const index = this.backgroundQueue.indexOf(page);
        if (index >= 0) this.backgroundQueue.splice(index, 1);
        if (!this.priorityQueue.includes(page)) this.priorityQueue.unshift(page);
      }
      this.pump();
    });
  }

  settlePage(page, data) {
    this.pendingPages.delete(page);
    const waiters = this.pageWaiters.get(page) || [];
    this.pageWaiters.delete(page);
    for (const resolve of waiters) resolve(data);
  }

  async pump() {
    if (this.processing || this.stopped) return;
    this.processing = true;

    try {
      while (!this.stopped) {
        let page = null;
        if (this.priorityQueue.length) page = this.priorityQueue.shift();
        else if (this.backgroundQueue.length) page = this.backgroundQueue.shift();
        else break;

        if (!this.pendingPages.has(page)) continue;
        if (this.data.has(page)) {
          this.settlePage(page, this.data.get(page));
          continue;
        }

        let data = null;
        try {
          data = await this.extractPage(page);
        } catch {
          data = null;
        }
        this.settlePage(page, data);
        this.updateExtractionUi();

        await (this.priorityQueue.length ? nextFrame() : nextIdle());
      }
    } finally {
      this.processing = false;
    }

    if (!this.stopped && (this.priorityQueue.length || this.backgroundQueue.length)) {
      this.pump();
    }
  }

  startBackground(startPage) {
    const order = [];
    for (let offset = 1; offset < this.numPages; offset += 1) {
      if (startPage + offset <= this.numPages) order.push(startPage + offset);
      if (startPage - offset >= 1) order.push(startPage - offset);
    }
    for (const page of order) {
      if (this.data.has(page) || this.pendingPages.has(page)) continue;
      this.pendingPages.add(page);
      this.backgroundQueue.push(page);
    }
    this.updateExtractionUi();
    this.pump();
  }

  updateExtractionUi() {
    const loaded = this.rawPages.size;
    if (loaded >= this.numPages) {
      this.ui.setExtractionProgress({
        ratio: 1,
        label: 'All pages ready',
      });
      window.clearTimeout(this.extractionHideTimer);
      this.extractionHideTimer = window.setTimeout(() => {
        if (!this.stopped) this.ui.finishExtraction();
      }, 1400);
      return;
    }
    this.ui.setExtractionProgress({
      ratio: loaded / this.numPages,
      label: `Preparing text · ${loaded} of ${this.numPages} pages`,
    });
  }

  /* ------------------------------------------------------------------ */
  /* rendering a page                                                   */
  /* ------------------------------------------------------------------ */

  isOriginalPage(page) {
    return this.originalPages.has(page);
  }

  async toggleOriginal(page) {
    if (this.isOriginalPage(page)) {
      this.originalPages.delete(page);
    } else {
      this.originalPages.add(page);
    }

    await this.requestPage(page, { priority: true });
    if (this.mode === 'scroll') {
      this.renderPageSection(page, { force: true });
    } else if (page === this.currentPage) {
      this.renderPaged({ preserveScreen: false });
    }
  }

  renderPageSection(page, { force = false } = {}) {
    const section = this.pageEls.get(page);
    const data = this.data.get(page);
    if (!section) return;
    if (!data) return;
    if (!force && section.dataset.renderEpoch === String(this.renderEpoch)) return;

    section.dataset.renderEpoch = String(this.renderEpoch);
    this.renderedPages.add(page);

    const body = section.querySelector('.page-body');
    const badge = section.querySelector('.page-badge');
    const toggle = section.querySelector('.page-original-toggle');
    const original = this.isOriginalPage(page);
    const hasBlocks = data.blocks.length > 0;

    body.replaceChildren();
    section.classList.toggle('is-original-page', original);
    section.dataset.original = original ? 'true' : 'false';

    if (data.quality.scanned) {
      badge.hidden = false;
      badge.textContent = 'Image-only page';
      badge.className = 'page-badge is-warning';
      // Image-only pages that produced image blocks are shown in the reading
      // flow; keep the toggle so the original page is still one click away.
      toggle.hidden = !hasBlocks;
    } else if (data.quality.lowQuality) {
      badge.hidden = false;
      badge.textContent = 'Check layout';
      badge.className = 'page-badge';
      toggle.hidden = !hasBlocks;
    } else {
      badge.hidden = true;
      toggle.hidden = !hasBlocks;
    }

    if (toggle) {
      toggle.textContent = original ? 'Reflowed text' : 'Original page';
      toggle.setAttribute('aria-pressed', String(original));
    }

    if (data.error) {
      const notice = el('div', 'page-warning is-error');
      notice.append(el('strong', '', 'This page could not be read.'));
      notice.append(el('span', '', data.error));
      body.append(notice);
      return;
    }

    if (data.quality.lowQuality && !data.quality.scanned) {
      const notice = el('div', 'page-warning');
      const text = el('span', '', data.quality.reasons.join(' ') || 'Reflow confidence is low on this page.');
      const button = el('button', 'text-button', 'View original page');
      button.type = 'button';
      button.dataset.viewOriginal = String(page);
      notice.append(text, button);
      body.append(notice);
    }

    if (original || !hasBlocks) {
      this.renderInlineOriginal(page, body, data);
    } else {
      if (data.quality.scanned) {
        const notice = el('div', 'scan-notice');
        notice.append(el('strong', '', 'No text layer on this page.'));
        notice.append(
          el(
            'span',
            '',
            'Showing the page image in the reading flow. Use Original page to inspect the source.',
          ),
        );
        body.append(notice);
      }
      this.renderBlocks(page, body, data);
      this.hydrateImages(page, body);
    }

    if (this.search.matches.length && this.search.query.length >= 2) {
      const active =
        this.search.current >= 0 && this.search.matches[this.search.current]?.page === page
          ? this.search.matches[this.search.current].ordinal
          : -1;
      this.markText(body, this.search.query, active);
    }
  }

  renderBlocks(page, container, data) {
    if (!data.blocks.length) {
      const notice = el('div', 'page-warning');
      notice.append(
        el(
          'span',
          '',
          data.quality.scanned
            ? 'No text layer was found on this page.'
            : 'No readable text remains on this page after removing running heads.',
        ),
      );
      const button = el('button', 'text-button', 'View original page');
      button.type = 'button';
      button.dataset.viewOriginal = String(page);
      notice.append(button);
      container.append(notice);
    }

    for (const block of data.blocks) {
      if (block.type === 'image') {
        const figure = el('figure', 'reflow-figure');
        const img = document.createElement('img');
        img.alt = `Image from page ${page}`;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.dataset.imageId = block.imageId;
        figure.append(img);
        container.append(figure);
        continue;
      }
      if (block.type === 'list') {
        container.append(this.renderList(block));
        continue;
      }
      if (block.type === 'toc') {
        container.append(this.renderTocBlock(block));
        continue;
      }
      if (block.type === 'table') {
        container.append(this.renderTable(block));
        continue;
      }
      let node;
      if (block.type === 'heading') {
        node = document.createElement(block.level === 2 ? 'h2' : 'h3');
        node.className = 'reflow-heading';
      } else {
        node = document.createElement('p');
        node.className = 'reflow-paragraph';
      }
      if (block.small) node.classList.add('is-small');
      node.textContent = block.text;
      container.append(node);
    }
  }

  /**
   * Render a ruled table. Cells keep their row/column position, so a page of
   * boxed cells reads as a table instead of a run of loose paragraphs.
   */
  renderTable(block) {
    const rows = Array.isArray(block.rows) ? block.rows : [];
    if (!rows.length) return document.createDocumentFragment();

    const wrap = el('div', 'reflow-table-wrap');
    const table = el('table', 'reflow-table');
    const head = block.header ? el('thead') : null;
    const body = el('tbody');

    /**
     * A cell can carry paragraphs of styled runs (a label like `Metrics:`
     * followed by its text). Render those as real paragraphs so the cell keeps
     * the structure it has on the page instead of one run-on block.
     */
    const fillCell = (node, cell) => {
      const paragraphs = Array.isArray(cell.paragraphs) ? cell.paragraphs : [];
      if (!paragraphs.length) {
        node.textContent = cell.text || '';
        return;
      }
      for (const paragraph of paragraphs) {
        const p = el('p', 'reflow-table-paragraph');
        for (const run of paragraph.runs || []) {
          if (run.bold) {
            p.append(el('strong', null, run.text));
          } else if (run.text) {
            p.append(document.createTextNode(run.text));
          }
        }
        node.append(p);
      }
    };

    const makeRow = (cells, cellTag) => {
      const tr = document.createElement('tr');
      for (const cell of cells) {
        const node = document.createElement(cellTag);
        fillCell(node, cell);
        if (cell.bold) node.classList.add('is-strong');
        if (cell.colspan > 1) node.colSpan = cell.colspan;
        if (cell.rowspan > 1) node.rowSpan = cell.rowspan;
        tr.append(node);
      }
      return tr;
    };

    rows.forEach((row, index) => {
      const tag = block.header && index === 0 ? 'th' : 'td';
      const tr = makeRow(row, tag);
      if (block.header && index === 0) head.append(tr);
      else body.append(tr);
    });

    if (head) table.append(head);
    table.append(body);
    wrap.append(table);
    return wrap;
  }

  /**
   * Render a table-of-contents block: title on the left, dotted leader, page
   * number on the right, indentation per level.
   */
  renderTocBlock(block) {
    const nav = el('div', 'reflow-toc');
    nav.setAttribute('role', 'list');
    for (const item of block.items || []) {
      const row = el('div', 'reflow-toc-entry');
      row.setAttribute('role', 'listitem');
      row.style.setProperty('--toc-level', String(Math.max(0, item.level || 0)));
      const title = el('span', 'reflow-toc-title', item.title);
      if (item.bold) title.classList.add('is-strong');
      const dots = el('span', 'reflow-toc-dots');
      dots.setAttribute('aria-hidden', 'true');
      const page = el('span', 'reflow-toc-page', item.page);
      row.append(title, dots, page);
      nav.append(row);
    }
    return nav;
  }

  /**
   * Render a reflow list block as nested <ul>/<ol> elements. The flat item
   * list carries a level per item; the stack turns it back into a tree.
   */
  renderList(block) {
    const items = Array.isArray(block.items) ? block.items : [];
    if (!items.length) return document.createDocumentFragment();

    const baseLevel = items[0].level || 0;
    const root = document.createElement(items[0].ordered ? 'ol' : 'ul');
    root.className = 'reflow-list';
    if (block.small) root.classList.add('is-small');
    if (items[0].ordered && Number.isFinite(items[0].number) && items[0].number > 1) {
      root.start = items[0].number;
    }

    const stack = [{ level: 0, list: root, item: null }];

    for (const entry of items) {
      const level = Math.max(0, Math.min(3, (entry.level || 0) - baseLevel));
      while (stack.length > 1 && level < stack[stack.length - 1].level) stack.pop();

      let frame = stack[stack.length - 1];
      if (level > frame.level) {
        const nested = document.createElement(entry.ordered ? 'ol' : 'ul');
        nested.className = 'reflow-list';
        if (entry.ordered && Number.isFinite(entry.number) && entry.number > 1) {
          nested.start = entry.number;
        }
        if (frame.item) frame.item.append(nested);
        else frame.list.append(nested);
        frame = { level: frame.level + 1, list: nested, item: null };
        stack.push(frame);
      }

      const li = document.createElement('li');
      li.className = 'reflow-list-item';
      li.textContent = entry.text;
      frame.list.append(li);
      frame.item = li;
    }

    return root;
  }

  renderInlineOriginal(page, container, data) {
    const wrap = el('div', 'page-original');
    const shell = el('div', 'original-canvas-shell');
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    canvas.setAttribute('aria-label', `Original PDF page ${page}`);
    shell.append(canvas);
    const loading = el('div', 'original-loading', 'Rendering original page…');
    shell.append(loading);
    wrap.append(shell);

    if (data.quality.scanned) {
      const notice = el('div', 'scan-notice');
      notice.append(el('strong', '', 'No text layer on this page.'));
      notice.append(
        el(
          'span',
          '',
          'This looks like a scanned or image-only page. Showing the original page instead of reflowed text.',
        ),
      );
      wrap.append(notice);

      if (this.settings.ocrEnabled) {
        const ocrButton = el('button', 'text-button', 'Try OCR on this page');
        ocrButton.type = 'button';
        ocrButton.dataset.ocrPage = String(page);
        if (!isOcrAvailable()) {
          ocrButton.title = 'No OCR engine registered. See README.';
        }
        const output = el('div', 'ocr-output');
        output.hidden = true;
        wrap.append(ocrButton, output);
      }
    } else {
      wrap.append(el('p', 'original-caption', 'Original page from the PDF.'));
    }

    container.append(wrap);

    const width = Math.max(
      240,
      Math.min(window.innerWidth - 40, this.settings.textWidth + 80, 860),
    );

    this.book
      .renderPage(page, canvas, { width })
      .then(() => {
        loading.remove();
        shell.classList.add('is-ready');
      })
      .catch((error) => {
        loading.textContent = 'Could not render this page.';
        loading.classList.add('is-error');
        if (error?.name !== 'RenderingCancelledException') {
          this.ui.toast('The original page could not be rendered.', { error: true });
        }
      });
  }

  async runOcr(page, button) {
    if (!this.settings.ocrEnabled) {
      this.ui.toast('Enable the OCR hook in Reading settings first.');
      return;
    }
    if (!isOcrAvailable()) {
      this.ui.toast(
        'No OCR engine is bundled. Register a local one with registerOcrEngine() — see the README.',
        { duration: 6000 },
      );
      return;
    }

    const section = this.pageEls.get(page);
    const canvas = section?.querySelector('canvas');
    const output = section?.querySelector('.ocr-output');
    if (!canvas || !output) {
      this.ui.toast('Wait for the page image to finish rendering, then try again.');
      return;
    }

    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = 'Running OCR…';
    try {
      const text = await recognizePage({ canvas, pageNumber: page });
      if (!text || !text.trim()) {
        output.textContent = 'OCR ran but found no text.';
      } else {
        const heading = el('strong', '', 'OCR result');
        const pre = el('div', 'ocr-text');
        pre.textContent = text.trim();
        output.replaceChildren(heading, pre);
      }
      output.hidden = false;
    } catch (error) {
      this.ui.toast(`OCR failed: ${error?.message || 'unknown error'}`, { error: true });
    } finally {
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }

  hydrateImages(page, container) {
    const nodes = [...container.querySelectorAll('img[data-image-id]')];
    if (!nodes.length) return;
    const data = this.data.get(page);
    const images = data?.images || [];
    if (!images.length) return;

    let promise = this.imagePromises.get(page);
    if (!promise) {
      promise = this.book
        .renderPageImages(page, images, { maxWidth: 1400 })
        .catch(() => new Map());
      this.imagePromises.set(page, promise);
    }

    promise.then((urls) => {
      for (const img of nodes) {
        if (!img.isConnected) continue;
        const url = urls.get(img.dataset.imageId);
        if (url) {
          img.src = url;
          img.classList.add('is-ready');
        } else {
          img.closest('figure')?.remove();
        }
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* table of contents                                                  */
  /* ------------------------------------------------------------------ */

  renderToc() {
    const body = this.ui.refs.tocBody;
    body.replaceChildren();

    if (!this.book.outline?.length) {
      const empty = el('div', 'toc-empty');
      empty.append(el('p', 'drawer-empty', 'This PDF has no outline.'));
      empty.append(
        el(
          'p',
          'setting-help',
          'Use Search, the page box at the bottom, or simply scroll to find your place.',
        ),
      );
      body.append(empty);
      return;
    }

    const list = el('nav', 'toc-list');
    list.setAttribute('aria-label', 'Document contents');
    for (const item of this.book.outline) {
      const button = el('button', 'toc-item');
      button.type = 'button';
      button.style.setProperty('--toc-depth', String(Math.min(item.depth, 5)));
      const title = el('span', 'toc-title', item.title);
      const page = el(
        'span',
        'toc-page',
        Number.isFinite(item.page) ? String(item.page) : '—',
      );
      button.append(title, page);
      if (item.bold) title.style.fontWeight = '650';
      if (item.italic) title.style.fontStyle = 'italic';
      if (Number.isFinite(item.page)) {
        button.addEventListener('click', () => {
          this.ui.closeDrawers();
          this.goToPage(item.page);
        });
      } else {
        button.disabled = true;
      }
      list.append(button);
    }
    body.append(list);
  }

  /* ------------------------------------------------------------------ */
  /* navigation                                                         */
  /* ------------------------------------------------------------------ */

  async goToPage(pageNumber, { behavior = 'smooth', offset = 0, screen = null } = {}) {
    const page = clamp(Math.round(Number(pageNumber) || 1), 1, this.numPages);
    this.currentPage = page;
    this.updateChrome();

    if (this.mode === 'paged') {
      await this.renderPaged({ preserveScreen: false, targetScreen: screen });
      this.schedulePositionSave();
      return;
    }

    await this.requestPage(page, { priority: true });
    this.renderPageSection(page);
    this.scrollToPage(page, offset, behavior);
    this.startAnchorHold(page, behavior === 'smooth' ? 700 : 0, offset);
    this.schedulePositionSave();
  }

  /** Keep a jumped-to page steady while earlier lazy pages grow above it. */
  startAnchorHold(page, delay = 0, offset = 0) {
    this.cancelAnchorHold();
    if (this.mode !== 'scroll') return;
    this.anchorPage = page;
    this.anchorGuard = performance.now() + delay + 450;

    const begin = () => {
      if (this.stopped || this.anchorPage !== page) return;
      const element = this.pageEls.get(page);
      if (!element) return;

      // A smooth scroll finishes here. Earlier placeholder pages may have
      // grown in the meantime, so put the target back on the intended line.
      const topbar = this.ui.refs.topbar.getBoundingClientRect().height || 56;
      const desired = topbar + 20 - offset;
      const current = element.getBoundingClientRect().top;
      if (Math.abs(current - desired) >= 1) {
        window.scrollBy({ top: current - desired, behavior: 'auto' });
        this.anchorGuard = performance.now() + 450;
      }

      let lastTop = element.getBoundingClientRect().top;
      const until = performance.now() + 2500;

      const tick = () => {
        if (this.stopped || this.anchorPage !== page) return;
        const top = element.getBoundingClientRect().top;
        const shift = top - lastTop;
        if (Math.abs(shift) >= 1) {
          window.scrollBy({ top: shift, behavior: 'auto' });
          // Scrolling by `shift` moves the element back to its previous
          // viewport position; keep the reference in step with that.
          lastTop = top - shift;
          this.anchorGuard = performance.now() + 450;
        }
        if (performance.now() < until) {
          this.anchorRaf = requestAnimationFrame(tick);
        } else {
          this.anchorPage = null;
          this.anchorRaf = 0;
        }
      };
      this.anchorRaf = requestAnimationFrame(tick);
    };

    if (delay > 0) this.anchorTimer = window.setTimeout(begin, delay);
    else begin();
  }

  cancelAnchorHold() {
    window.clearTimeout(this.anchorTimer);
    this.anchorTimer = 0;
    if (this.anchorRaf) cancelAnimationFrame(this.anchorRaf);
    this.anchorRaf = 0;
    this.anchorPage = null;
  }

  scrollToPage(page, offset = 0, behavior = 'smooth') {
    const section = this.pageEls.get(page);
    if (!section) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({
      block: 'start',
      behavior: reduce ? 'auto' : behavior,
    });
    if (offset) {
      requestAnimationFrame(() => window.scrollBy({ top: offset, behavior: 'auto' }));
    }
  }

  nextScreen() {
    if (this.mode === 'paged') {
      if (this.navigating) return;
      if (this.paged.original || this.paged.screen >= this.paged.screens - 1) {
        if (this.currentPage < this.numPages) {
          this.navigating = true;
          this.goToPage(this.currentPage + 1, { behavior: 'auto', screen: 0 }).finally(() => {
            this.navigating = false;
          });
        }
        return;
      }
      this.setPagedScreen(this.paged.screen + 1);
      return;
    }
    window.scrollBy({
      top: window.innerHeight * 0.85,
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  }

  prevScreen() {
    if (this.mode === 'paged') {
      if (this.navigating) return;
      if (this.paged.original || this.paged.screen <= 0) {
        if (this.currentPage > 1) {
          this.navigating = true;
          this.goToPage(this.currentPage - 1, { behavior: 'auto', screen: 'last' }).finally(() => {
            this.navigating = false;
          });
        }
        return;
      }
      this.setPagedScreen(this.paged.screen - 1);
      return;
    }
    window.scrollBy({
      top: -window.innerHeight * 0.85,
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  }

  /* ------------------------------------------------------------------ */
  /* paginated mode                                                     */
  /* ------------------------------------------------------------------ */

  applyModeDom() {
    const paged = this.mode === 'paged';
    this.scrollView.hidden = paged;
    this.pagedView.hidden = !paged;
    this.ui.refs.btnPaged?.setAttribute('aria-pressed', String(paged));
    this.ui.refs.btnPaged?.classList.toggle('is-active', paged);
    document.body.classList.toggle('is-paginated', paged);
  }

  async renderPaged({ preserveScreen = true, targetScreen = null } = {}) {
    const token = ++this.pagedToken;
    const page = this.currentPage;
    await this.requestPage(page, { priority: true });

    if (token !== this.pagedToken || this.stopped || this.mode !== 'paged') return;
    const data = this.data.get(page);
    if (!data) {
      this.paged.flow.replaceChildren(el('p', 'page-placeholder', 'Loading text…'));
      return;
    }

    const previousFraction =
      preserveScreen && this.paged.screens > 1
        ? this.paged.screen / (this.paged.screens - 1)
        : 0;
    const original = this.isOriginalPage(page);
    const hasBlocks = data.blocks.length > 0;

    this.paged.original = original;
    this.paged.flow.replaceChildren();
    this.paged.flow.classList.toggle('is-original', original);
    this.paged.viewport.classList.toggle('is-original', original);
    this.paged.viewport.scrollLeft = 0;
    if (original) this.paged.viewport.style.width = '100%';

    this.paged.metaLabel.textContent = `Page ${page} of ${this.numPages}`;
    this.paged.quality.textContent = data.quality.scanned
      ? 'Image-only page'
      : data.quality.lowQuality
        ? 'Reflow may be imperfect'
        : '';
    this.paged.toggle.dataset.pageToggle = String(page);
    this.paged.toggle.hidden = !hasBlocks;
    this.paged.toggle.textContent = original ? 'Reflowed text' : 'Original page';
    this.paged.toggle.setAttribute('aria-pressed', String(original));

    if (data.quality.lowQuality && !data.quality.scanned && !original) {
      const warning = el('div', 'page-warning paged-warning');
      warning.append(
        el(
          'span',
          '',
          data.quality.reasons.join(' ') || 'Reflow confidence is low on this page.',
        ),
      );
      const button = el('button', 'text-button', 'View original page');
      button.type = 'button';
      button.dataset.viewOriginal = String(page);
      warning.append(button);
      this.paged.flow.append(warning);
    }

    if (original || !hasBlocks) {
      this.renderPagedOriginal(page, data);
      this.paged.screens = 1;
      this.paged.screen = 0;
      this.updatePagedLabels();
      this.updateChrome();
      return;
    }

    const stageWidth = this.paged.stage.clientWidth || window.innerWidth - 48;
    const width = Math.max(260, Math.min(this.settings.textWidth, stageWidth - 24));
    const gap = width >= 600 ? 52 : 34;
    this.paged.width = width;
    this.paged.gap = gap;
    this.paged.viewport.style.width = `${width}px`;
    this.paged.flow.style.width = `${width}px`;
    this.paged.flow.style.columnWidth = `${width}px`;
    this.paged.flow.style.columnGap = `${gap}px`;
    const stageHeight = this.paged.stage.clientHeight;
    if (stageHeight > 0) {
      this.paged.flow.style.height = `${stageHeight}px`;
      this.paged.flow.style.setProperty(
        '--paged-figure-max-height',
        `${Math.max(180, stageHeight - 56)}px`,
      );
    }

    this.renderBlocks(page, this.paged.flow, data);
    this.hydrateImages(page, this.paged.flow);

    if (this.search.matches.length && this.search.query.length >= 2) {
      const active =
        this.search.current >= 0 && this.search.matches[this.search.current]?.page === page
          ? this.search.matches[this.search.current].ordinal
          : -1;
      this.markText(this.paged.flow, this.search.query, active);
    }

    await nextFrame();
    await nextFrame();
    if (token !== this.pagedToken) return;

    const step = width + gap;
    const measured = this.paged.flow.scrollWidth;
    this.paged.screens = Math.max(1, Math.round((measured + gap) / step));

    let screen = 0;
    if (targetScreen === 'last') screen = this.paged.screens - 1;
    else if (Number.isFinite(targetScreen)) screen = targetScreen;
    else if (preserveScreen) screen = Math.round(previousFraction * (this.paged.screens - 1));

    this.paged.screen = clamp(screen, 0, this.paged.screens - 1);
    this.paged.viewport.scrollTo({
      left: this.paged.screen * step,
      behavior: 'auto',
    });
    this.updatePagedLabels();
    this.updateChrome();

    if (this.search.current >= 0) {
      const match = this.search.matches[this.search.current];
      if (match?.page === page) this.scrollPagedToHighlight(match.ordinal);
    }
  }

  renderPagedOriginal(page, data) {
    const wrap = el('div', 'paged-original-page');
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    wrap.append(canvas);

    if (data.quality.scanned) {
      const notice = el('div', 'scan-notice');
      notice.append(el('strong', '', 'No text layer on this page.'));
      notice.append(
        el(
          'span',
          '',
          'This scanned page is shown as an image. Reflowed text is not available.',
        ),
      );
      wrap.append(notice);
    } else {
      wrap.append(el('p', 'original-caption', 'Original page from the PDF.'));
    }

    this.paged.flow.append(wrap);

    const width = Math.max(240, Math.min(this.paged.stage.clientWidth - 32, 900));
    const height = Math.max(240, this.paged.stage.clientHeight - 96);
    this.book
      .renderPage(page, canvas, { width, height })
      .then(() => canvas.classList.add('is-ready'))
      .catch((error) => {
        if (error?.name !== 'RenderingCancelledException') {
          this.ui.toast('The original page could not be rendered.', { error: true });
        }
      });
  }

  setPagedScreen(screen, { smooth = true } = {}) {
    if (this.mode !== 'paged') return;
    const next = clamp(screen, 0, Math.max(0, this.paged.screens - 1));
    this.paged.screen = next;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.paged.viewport.scrollTo({
      left: next * (this.paged.width + this.paged.gap),
      behavior: smooth && !reduce ? 'smooth' : 'auto',
    });
    this.updatePagedLabels();
    this.updateChrome();
    this.schedulePositionSave();
  }

  updatePagedLabels() {
    if (!this.paged.screenCount) return;
    const total = this.paged.screens;
    const current = Math.min(this.paged.screen + 1, total);
    this.paged.screenCount.textContent = this.paged.original
      ? 'Original page'
      : `Screen ${current} of ${total}`;
  }

  scrollPagedToHighlight(ordinal) {
    const marks = [...this.paged.flow.querySelectorAll('mark.search-hit')];
    const mark = marks[ordinal] || marks[0];
    if (!mark) return;
    requestAnimationFrame(() => {
      const viewportRect = this.paged.viewport.getBoundingClientRect();
      const rect = mark.getBoundingClientRect();
      let x = rect.left - viewportRect.left + this.paged.viewport.scrollLeft;
      x = Math.max(0, x - 24);
      const screen = Math.round(x / (this.paged.width + this.paged.gap));
      this.setPagedScreen(screen, { smooth: false });
      const targetY = rect.top - viewportRect.top;
      if (targetY < 0 || targetY > viewportRect.height - 40) {
        this.paged.viewport.scrollTop = 0;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* scroll tracking, progress and keyboard                             */
  /* ------------------------------------------------------------------ */

  handleScroll() {
    if (this.mode !== 'scroll' || this.stopped) return;
    // Ignore the scroll event produced by our own height compensation.
    if (this.anchorGuard && performance.now() < this.anchorGuard) return;
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      if (this.stopped || this.mode !== 'scroll') return;
      const page = this.pageAtScrollPosition();
      if (page !== this.currentPage) {
        this.currentPage = page;
        this.updateChrome();
      }
      this.schedulePositionSave();
    });
  }

  pageAtScrollPosition() {
    const sections = this.sectionList;
    if (!sections?.length) return 1;
    const topbar = this.ui.refs.topbar.getBoundingClientRect().height || 56;
    const probe = window.scrollY + topbar + window.innerHeight * 0.28;
    let low = 0;
    let high = sections.length - 1;
    let candidate = 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (sections[mid].offsetTop <= probe) {
        candidate = mid + 1;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return candidate;
  }

  updateChrome() {
    const page = this.currentPage;
    let detail = '';
    if (this.mode === 'paged') {
      const total = Math.max(1, this.paged.screens);
      const current = Math.min(this.paged.screen + 1, total);
      detail = this.paged.original ? ' · original' : ` · screen ${current}/${total}`;
    }
    this.ui.setPageReadout(`Page ${page} of ${this.numPages}${detail}`);
    this.ui.setProgress(page / Math.max(1, this.numPages));
    const input = this.ui.refs.gotoPage;
    input.max = String(this.numPages);
    input.placeholder = `1–${this.numPages}`;
  }

  handleKeydown(event) {
    const refs = this.ui.refs;
    if (refs.passwordDialog.open || refs.originalDialog.open) return;
    if (document.body.classList.contains('drawer-open')) return;
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.closest('input, textarea, select, [contenteditable="true"]') ||
        target.isContentEditable)
    ) {
      return;
    }

    this.cancelAnchorHold();

    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      if (event.key === ' ' && event.shiftKey) {
        event.preventDefault();
        this.prevScreen();
      } else {
        event.preventDefault();
        this.nextScreen();
      }
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      this.prevScreen();
    } else if (this.mode === 'paged' && event.key === 'ArrowDown') {
      event.preventDefault();
      this.nextScreen();
    } else if (this.mode === 'paged' && event.key === 'ArrowUp') {
      event.preventDefault();
      this.prevScreen();
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.goToPage(1, { behavior: 'auto' });
      if (this.mode === 'scroll') window.scrollTo({ top: 0, behavior: 'auto' });
    } else if (event.key === 'End') {
      event.preventDefault();
      this.goToPage(this.numPages, { behavior: 'auto' });
    }
  }

  handlePagedWheel(event) {
    if (this.mode !== 'paged') return;
    if (event.ctrlKey) return;
    const now = Date.now();
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(delta) < 6) return;
    event.preventDefault();

    this.wheelAccum = (this.wheelAccum || 0) + delta;
    if (now - this.lastWheel < 480) return;
    if (Math.abs(this.wheelAccum) < 34) return;

    this.lastWheel = now;
    const direction = this.wheelAccum > 0 ? 1 : -1;
    this.wheelAccum = 0;
    if (direction > 0) this.nextScreen();
    else this.prevScreen();
  }

  handleResize() {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (this.stopped) return;
      if (this.mode === 'paged') {
        this.renderPaged({ preserveScreen: true });
      } else {
        // Reflow changes how tall the current page is. Keep the reader on the
        // same page and approximately the same line after a rotation/resize.
        const section = this.pageEls.get(this.currentPage);
        if (section) {
          const top = section.getBoundingClientRect().top + window.scrollY;
          const offset = Math.max(0, Math.round(window.scrollY - top));
          this.startAnchorHold(this.currentPage, 120, offset);
        }
      }
      if (this.ui.refs.originalDialog.open) this.renderOriginalOverlay();
    }, 180);
  }

  schedulePositionSave() {
    window.clearTimeout(this.positionTimer);
    this.positionTimer = window.setTimeout(() => this.emitPosition(), 450);
  }

  emitPosition() {
    if (this.stopped) return;
    let offset = 0;
    if (this.mode === 'scroll') {
      const section = this.pageEls.get(this.currentPage);
      if (section) {
        const top = section.getBoundingClientRect().top + window.scrollY;
        offset = Math.max(0, Math.round(window.scrollY - top));
      }
    }
    this.onPositionChange?.({
      page: this.currentPage,
      offset,
      screen: this.mode === 'paged' ? this.paged.screen : 0,
      total: this.numPages,
      mode: this.mode,
    });
  }

  handleBeforeUnload() {
    window.clearTimeout(this.positionTimer);
    this.emitPosition();
  }

  /* ------------------------------------------------------------------ */
  /* original page comparison dialog                                    */
  /* ------------------------------------------------------------------ */

  openOriginalOverlay(page = this.currentPage) {
    this.overlay = {
      page: clamp(page, 1, this.numPages),
      zoomIndex: 0,
    };
    this.ui.openOriginalDialog();
    this.renderOriginalOverlay();
  }

  shiftOriginalOverlay(direction) {
    if (!this.overlay) return;
    this.overlay.page = clamp(this.overlay.page + direction, 1, this.numPages);
    this.renderOriginalOverlay();
  }

  zoomOriginalOverlay(direction) {
    if (!this.overlay) return;
    const levels = [1, 1.25, 1.5, 2, 3];
    this.overlay.zoomIndex = clamp(this.overlay.zoomIndex + direction, 0, levels.length - 1);
    this.renderOriginalOverlay();
  }

  async renderOriginalOverlay() {
    if (!this.overlay) return;
    const refs = this.ui.refs;
    const { page } = this.overlay;
    const levels = [1, 1.25, 1.5, 2, 3];
    const zoom = levels[this.overlay.zoomIndex];

    refs.originalPageLabel.textContent = `Page ${page} of ${this.numPages}`;
    refs.originalZoomLabel.textContent =
      this.overlay.zoomIndex === 0 ? 'Fit' : `${Math.round(zoom * 100)}%`;
    refs.originalLoading.hidden = false;
    refs.originalLoading.textContent = 'Rendering page…';
    refs.originalPrev.disabled = page <= 1;
    refs.originalNext.disabled = page >= this.numPages;

    const wrap = refs.originalCanvasWrap;
    const availableWidth = Math.max(260, wrap.clientWidth - 48);
    const availableHeight = Math.max(260, wrap.clientHeight - 48);

    try {
      await this.book.renderPage(page, refs.originalCanvas, {
        width: availableWidth * zoom,
        height: availableHeight * zoom,
      });
      refs.originalLoading.hidden = true;
      wrap.scrollTop = 0;
      wrap.scrollLeft = 0;
    } catch (error) {
      if (error?.name === 'RenderingCancelledException') return;
      refs.originalLoading.hidden = false;
      refs.originalLoading.textContent = 'Could not render this page.';
    }
  }

  /* ------------------------------------------------------------------ */
  /* settings changes                                                   */
  /* ------------------------------------------------------------------ */

  reflowAllCached() {
    for (const [page, data] of this.data) {
      if (!data.lines) continue;
      const result = reflowLines({
        lines: data.lines,
        pageNumber: page,
        pageWidth: data.pageWidth,
        pageHeight: data.pageHeight,
        marginalSignatures: this.repeated,
        options: { removeHeaderFooter: this.settings.removeHeaderFooter },
      });
      Object.assign(data, result, {
        lines: data.lines,
        pageWidth: data.pageWidth,
        pageHeight: data.pageHeight,
      });
    }

    this.renderEpoch += 1;
  }

  updateSettings(next) {
    const previous = this.settings;
    this.settings = { ...next };

    const structural = previous.removeHeaderFooter !== next.removeHeaderFooter;
    if (structural) {
      this.reflowAllCached();
      for (const page of this.renderedPages) {
        this.renderPageSection(page, { force: true });
      }
    }

    if (previous.ocrEnabled !== next.ocrEnabled) {
      for (const page of this.renderedPages) {
        if (this.isOriginalPage(page)) this.renderPageSection(page, { force: true });
      }
    }

    if (previous.paginated !== next.paginated) {
      this.mode = next.paginated ? 'paged' : 'scroll';
      this.applyModeDom();
      if (this.mode === 'paged') {
        this.renderPaged({ preserveScreen: false });
      } else {
        requestAnimationFrame(() => {
          this.goToPage(this.currentPage, { behavior: 'auto' });
        });
      }
    } else if (this.mode === 'paged') {
      window.clearTimeout(this.pagedRebuildTimer);
      this.pagedRebuildTimer = window.setTimeout(() => {
        if (!this.stopped) this.renderPaged({ preserveScreen: true });
      }, 80);
    }
  }

  /* ------------------------------------------------------------------ */
  /* in-book search                                                     */
  /* ------------------------------------------------------------------ */

  bindSearch() {
    const refs = this.ui.refs;

    const onInput = () => {
      const query = refs.searchInput.value.trim();
      window.clearTimeout(this.searchDebounce);
      if (query.length < 2) {
        this.performSearch(query);
        return;
      }
      this.ui.refs.searchStatus.textContent = 'Searching…';
      this.searchDebounce = window.setTimeout(() => this.performSearch(query), 260);
    };

    const onKeydown = (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (!this.search.matches.length) {
        this.performSearch(refs.searchInput.value.trim());
        return;
      }
      const direction = event.shiftKey ? -1 : 1;
      const start = this.search.current < 0 ? (direction > 0 ? -1 : 0) : this.search.current;
      const next = (start + direction + this.search.matches.length) % this.search.matches.length;
      this.jumpToMatch(next);
    };

    const onPrev = () => {
      if (!this.search.matches.length) return;
      const start = this.search.current < 0 ? 0 : this.search.current;
      this.jumpToMatch(
        (start - 1 + this.search.matches.length) % this.search.matches.length,
      );
    };
    const onNext = () => {
      if (!this.search.matches.length) return;
      const start = this.search.current < 0 ? -1 : this.search.current;
      this.jumpToMatch((start + 1) % this.search.matches.length);
    };

    refs.searchInput.addEventListener('input', onInput);
    refs.searchInput.addEventListener('keydown', onKeydown);
    refs.searchPrev.addEventListener('click', onPrev);
    refs.searchNext.addEventListener('click', onNext);
    this.cleanup.push(() => {
      window.clearTimeout(this.searchDebounce);
      refs.searchInput.removeEventListener('input', onInput);
      refs.searchInput.removeEventListener('keydown', onKeydown);
      refs.searchPrev.removeEventListener('click', onPrev);
      refs.searchNext.removeEventListener('click', onNext);
    });
  }

  async performSearch(query) {
    const token = ++this.search.token;
    this.search.query = query;
    this.search.matches = [];
    this.search.current = -1;
    this.search.running = query.length >= 2;
    this.search.scannedPage = 0;

    this.clearAllHighlights();
    this.renderSearchResults();
    this.updateSearchUi();

    if (query.length < 2) {
      this.ui.refs.searchStatus.textContent = 'Type at least two characters.';
      return;
    }

    const needle = query.toLocaleLowerCase();
    const matches = [];
    let matchedPages = new Set();
    let stoppedEarly = false;

    for (let page = 1; page <= this.numPages; page += 1) {
      if (token !== this.search.token) return;
      this.search.scannedPage = page;

      let raw;
      try {
        raw = await this.loadRawLines(page);
      } catch {
        raw = null;
      }
      if (token !== this.search.token) return;

      if (raw?.lines?.length) {
        const text = raw.lines.map((line) => line.text).join(' ');
        const haystack = text.toLocaleLowerCase();
        let from = 0;
        let ordinal = 0;
        let index = haystack.indexOf(needle, from);
        while (index >= 0) {
          if (matches.length >= SEARCH_LIMIT) {
            stoppedEarly = true;
            break;
          }
          const start = Math.max(0, index - 64);
          const end = Math.min(text.length, index + query.length + 64);
          const snippet =
            `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${
              end < text.length ? '…' : ''
            }`;
          matches.push({ page, ordinal, index, snippet });
          matchedPages.add(page);
          ordinal += 1;
          from = index + Math.max(1, query.length);
          index = haystack.indexOf(needle, from);
        }
      }

      if (stoppedEarly) break;

      if (page % 8 === 0) {
        this.search.matches = matches;
        this.renderSearchResults();
        this.updateSearchUi();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    if (token !== this.search.token) return;

    this.search.matches = matches;
    this.search.running = false;
    this.renderSearchResults();
    this.updateSearchUi();
    this.applySearchHighlights();

    if (!matches.length) {
      this.ui.refs.searchStatus.textContent = `No matches for “${query}”.`;
    } else {
      const pages = matchedPages.size;
      this.ui.refs.searchStatus.textContent = `${matches.length}${
        stoppedEarly ? '+' : ''
      } matches on ${pages} page${pages === 1 ? '' : 's'}.`;
    }
  }

  updateSearchUi() {
    const refs = this.ui.refs;
    const count = this.search.matches.length;
    refs.searchPrev.disabled = count === 0;
    refs.searchNext.disabled = count === 0;

    if (this.search.running) {
      const pages = this.search.matches.length ? new Set(this.search.matches.map((m) => m.page)).size : 0;
      refs.searchStatus.textContent =
        `Searching… ${this.search.matches.length} found · page ${this.search.scannedPage} of ${this.numPages}` +
        (pages ? ` · ${pages} page${pages === 1 ? '' : 's'}` : '');
    } else if (this.search.current >= 0 && count) {
      refs.searchStatus.textContent = `Match ${this.search.current + 1} of ${count}`;
    }
  }

  renderSearchResults() {
    const refs = this.ui.refs;
    const results = refs.searchResults;
    results.replaceChildren();

    if (this.search.query.length < 2) {
      results.append(
        el(
          'p',
          'search-empty',
          'Search runs across the whole document in the background. Matches are highlighted on the page.',
        ),
      );
      return;
    }

    if (!this.search.matches.length) {
      if (this.search.running) {
        results.append(el('p', 'search-empty', 'Searching the document…'));
      } else {
        results.append(el('p', 'search-empty', 'No matches found.'));
      }
      return;
    }

    const shown = Math.min(200, this.search.matches.length);
    for (let i = 0; i < shown; i += 1) {
      const match = this.search.matches[i];
      const button = el('button', 'search-result');
      button.type = 'button';
      button.dataset.matchIndex = String(i);
      if (i === this.search.current) button.classList.add('is-active');

      const page = el('span', 'search-result-page', `Page ${match.page}`);
      const snippet = el('span', 'search-result-snippet');

      const lower = match.snippet.toLocaleLowerCase();
      const index = lower.indexOf(this.search.query.toLocaleLowerCase());
      if (index >= 0) {
        snippet.append(document.createTextNode(match.snippet.slice(0, index)));
        const mark = document.createElement('mark');
        mark.textContent = match.snippet.slice(index, index + this.search.query.length);
        snippet.append(mark);
        snippet.append(document.createTextNode(match.snippet.slice(index + this.search.query.length)));
      } else {
        snippet.textContent = match.snippet;
      }

      button.append(page, snippet);
      button.addEventListener('click', () => this.jumpToMatch(i));
      results.append(button);
    }

    if (this.search.matches.length > shown) {
      results.append(
        el(
          'p',
          'search-empty',
          `Showing the first ${shown} matches. Refine the search to narrow the list.`,
        ),
      );
    }
  }

  async jumpToMatch(index) {
    if (!this.search.matches.length) return;
    const normalized =
      ((index % this.search.matches.length) + this.search.matches.length) %
      this.search.matches.length;
    this.search.current = normalized;
    const match = this.search.matches[normalized];

    for (const button of this.ui.refs.searchResults.querySelectorAll('.search-result')) {
      button.classList.toggle(
        'is-active',
        Number(button.dataset.matchIndex) === normalized,
      );
    }
    const active = this.ui.refs.searchResults.querySelector('.search-result.is-active');
    active?.scrollIntoView({ block: 'nearest' });
    this.updateSearchUi();

    await this.goToPage(match.page, { behavior: 'auto' });
    this.applySearchHighlights();

    if (this.mode === 'paged') {
      this.scrollPagedToHighlight(match.ordinal);
      return;
    }

    await nextFrame();
    const body = this.pageEls.get(match.page)?.querySelector('.page-body');
    if (!body) return;
    const marks = body.querySelectorAll('mark.search-hit');
    const mark = marks[match.ordinal] || marks[0];
    if (mark) {
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  applySearchHighlights() {
    const { query, current, matches } = this.search;
    if (!matches.length || query.length < 2) return;
    for (const page of this.renderedPages) {
      if (this.isOriginalPage(page)) continue;
      const body = this.pageEls.get(page)?.querySelector('.page-body');
      if (!body) continue;
      const active =
        current >= 0 && matches[current]?.page === page ? matches[current].ordinal : -1;
      this.markText(body, query, active);
    }
  }

  clearHighlights(root) {
    if (!root) return;
    const marks = [...root.querySelectorAll('mark.search-hit')];
    const parents = new Set();
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      mark.replaceWith(document.createTextNode(mark.textContent || ''));
      parents.add(parent);
    }
    for (const parent of parents) parent.normalize();
  }

  clearAllHighlights() {
    this.clearHighlights(this.scrollView);
    this.clearHighlights(this.paged.flow);
  }

  markText(root, query, activeOrdinal = -1) {
    if (!root || !query || query.length < 2) return 0;
    this.clearHighlights(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (
          parent.closest(
            'button, mark, .page-warning, .scan-notice, .original-caption, .ocr-output, .original-loading',
          )
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const needle = query.toLocaleLowerCase();
    let ordinal = 0;

    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLocaleLowerCase();
      let index = lower.indexOf(needle);
      if (index < 0) continue;

      const fragment = document.createDocumentFragment();
      let last = 0;
      while (index >= 0) {
        fragment.append(document.createTextNode(text.slice(last, index)));
        const mark = document.createElement('mark');
        mark.className = 'search-hit';
        if (ordinal === activeOrdinal) mark.classList.add('is-active');
        mark.textContent = text.slice(index, index + query.length);
        fragment.append(mark);
        last = index + query.length;
        ordinal += 1;
        index = lower.indexOf(needle, last);
      }
      fragment.append(document.createTextNode(text.slice(last)));
      node.replaceWith(fragment);
    }

    return ordinal;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  destroy() {
    if (this.stopped) return;
    this.cancelAnchorHold();
    this.emitPosition();
    this.stopped = true;
    window.clearTimeout(this.positionTimer);
    window.clearTimeout(this.searchDebounce);
    window.clearTimeout(this.resizeTimer);
    window.clearTimeout(this.extractionHideTimer);
    window.clearTimeout(this.pagedRebuildTimer);
    this.search.token += 1;

    this.observer?.disconnect();
    for (const cleanup of this.cleanup) {
      try {
        cleanup();
      } catch {
        /* already gone */
      }
    }
    this.cleanup = [];

    for (const waiters of this.pageWaiters.values()) {
      for (const resolve of waiters) resolve(null);
    }
    this.pageWaiters.clear();

    this.ui.closeOriginalDialog();
    this.ui.finishExtraction();
    document.body.classList.remove('is-paginated');
    this.mount.replaceChildren();
    this.book.destroy().catch(() => {});
  }
}
