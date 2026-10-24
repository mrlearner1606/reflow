/**
 * settings.js
 * Reading preferences, their DOM application and the settings panel.
 */

export const FONT_FAMILIES = {
  serif: {
    label: 'Serif',
    stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif",
  },
  sans: {
    label: 'Sans',
    stack:
      "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
  dyslexic: {
    label: 'Dyslexia friendly',
    stack: "'OpenDyslexic', 'Atkinson Hyperlegible', 'Trebuchet MS', Verdana, sans-serif",
  },
};

export const THEMES = {
  light: { label: 'Light' },
  sepia: { label: 'Sepia' },
  dark: { label: 'Dark' },
  contrast: { label: 'High contrast' },
};

export const DEFAULT_SETTINGS = Object.freeze({
  fontFamily: 'serif',
  fontSize: 19,
  lineHeight: 1.65,
  paragraphSpacing: 0.8,
  textWidth: 680,
  justify: false,
  theme: 'light',
  removeHeaderFooter: true,
  paginated: false,
  ocrEnabled: false,
});

const RANGES = {
  fontSize: [14, 32],
  lineHeight: [1.2, 2.2],
  paragraphSpacing: [0, 2],
  textWidth: [420, 1000],
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberSetting(value, fallback, [min, max], step = 0.05) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(clamp(parsed, min, max) / step) * step;
}

/** Accept anything from storage, but return a fully valid settings object. */
export function normalizeSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    fontFamily: Object.hasOwn(FONT_FAMILIES, source.fontFamily)
      ? source.fontFamily
      : DEFAULT_SETTINGS.fontFamily,
    fontSize: Math.round(
      numberSetting(source.fontSize, DEFAULT_SETTINGS.fontSize, RANGES.fontSize, 1),
    ),
    lineHeight: Number(
      numberSetting(source.lineHeight, DEFAULT_SETTINGS.lineHeight, RANGES.lineHeight).toFixed(2),
    ),
    paragraphSpacing: Number(
      numberSetting(
        source.paragraphSpacing,
        DEFAULT_SETTINGS.paragraphSpacing,
        RANGES.paragraphSpacing,
      ).toFixed(2),
    ),
    textWidth: Math.round(
      numberSetting(source.textWidth, DEFAULT_SETTINGS.textWidth, RANGES.textWidth, 10),
    ),
    justify: Boolean(source.justify),
    theme: Object.hasOwn(THEMES, source.theme) ? source.theme : DEFAULT_SETTINGS.theme,
    removeHeaderFooter:
      source.removeHeaderFooter === undefined
        ? DEFAULT_SETTINGS.removeHeaderFooter
        : Boolean(source.removeHeaderFooter),
    paginated:
      source.paginated === undefined ? DEFAULT_SETTINGS.paginated : Boolean(source.paginated),
    ocrEnabled:
      source.ocrEnabled === undefined ? DEFAULT_SETTINGS.ocrEnabled : Boolean(source.ocrEnabled),
  };
}

/** Push typography and theme into CSS custom properties. */
export function applySettings(root, settings) {
  const value = normalizeSettings(settings);
  root.dataset.theme = value.theme;
  root.dataset.font = value.fontFamily;
  root.dataset.justify = value.justify ? 'true' : 'false';
  root.style.setProperty('--reader-font-size', `${value.fontSize}px`);
  root.style.setProperty('--reader-line-height', String(value.lineHeight));
  root.style.setProperty('--reader-paragraph-gap', `${value.paragraphSpacing}em`);
  root.style.setProperty('--reader-width', `${value.textWidth}px`);
  return value;
}

/* ------------------------------------------------------------------ */
/* settings panel                                                     */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rangeControl(name, label, min, max, step, suffix = '') {
  return `
    <label class="setting-row">
      <span class="setting-label">${escapeHtml(label)} <output data-output="${name}"></output></span>
      <input type="range" data-setting="${name}" min="${min}" max="${max}" step="${step}" />
    </label>`;
}

/**
 * Builds the drawer contents. `onChange` receives the complete next settings
 * object. The panel owns its DOM state and exposes refresh() for external
 * changes (for example the toolbar's paginated toggle).
 */
export function mountSettingsPanel(container, { settings, onChange, onReset }) {
  container.innerHTML = `
    <div class="panel-section">
      <h3 class="panel-heading">Type &amp; spacing</h3>
      <label class="setting-row">
        <span class="setting-label">Typeface</span>
        <select data-setting="fontFamily" class="select">
          ${Object.entries(FONT_FAMILIES)
            .map(([key, font]) => `<option value="${key}">${escapeHtml(font.label)}</option>`)
            .join('')}
        </select>
      </label>
      ${rangeControl('fontSize', 'Text size', 14, 32, 1, 'px')}
      ${rangeControl('lineHeight', 'Line height', 1.2, 2.2, 0.05)}
      ${rangeControl('paragraphSpacing', 'Paragraph space', 0, 2, 0.1)}
      ${rangeControl('textWidth', 'Text width', 420, 1000, 20, 'px')}
      <label class="setting-toggle">
        <input type="checkbox" data-setting="justify" />
        <span>Justify text</span>
      </label>
    </div>

    <div class="panel-section">
      <h3 class="panel-heading">Theme</h3>
      <div class="theme-grid" role="group" aria-label="Reading theme">
        ${Object.entries(THEMES)
          .map(
            ([key, theme]) => `
          <button type="button" class="theme-swatch" data-theme-value="${key}" title="${escapeHtml(theme.label)}">
            <span class="swatch-preview swatch-${key}" aria-hidden="true"><i></i><i></i><i></i></span>
            <span>${escapeHtml(theme.label)}</span>
          </button>`,
          )
          .join('')}
      </div>
    </div>

    <div class="panel-section">
      <h3 class="panel-heading">Structure</h3>
      <label class="setting-toggle">
        <input type="checkbox" data-setting="paginated" />
        <span>Paginated mode</span>
      </label>
      <p class="setting-help">Pages flow into columns; use the arrows to turn screens.</p>
      <label class="setting-toggle">
        <input type="checkbox" data-setting="removeHeaderFooter" />
        <span>Remove headers, footers and page numbers</span>
      </label>
      <p class="setting-help">Detected from repeated lines in page margins and from page-number-only lines.</p>
      <label class="setting-toggle">
        <input type="checkbox" data-setting="ocrEnabled" />
        <span>Enable OCR hook for scanned pages</span>
      </label>
      <p class="setting-help">No OCR engine is bundled. See README for registering a local one.</p>
    </div>

    <div class="panel-actions">
      <button type="button" class="text-button" data-reset>Reset reading settings</button>
    </div>
  `;

  let current = normalizeSettings(settings);

  const controls = [...container.querySelectorAll('[data-setting]')];
  const outputs = new Map(
    [...container.querySelectorAll('[data-output]')].map((node) => [node.dataset.output, node]),
  );
  const themeButtons = [...container.querySelectorAll('[data-theme-value]')];

  function paint() {
    for (const control of controls) {
      const key = control.dataset.setting;
      if (control.type === 'checkbox') {
        control.checked = Boolean(current[key]);
      } else {
        control.value = current[key];
      }
    }
    for (const [key, output] of outputs) {
      const suffix = key === 'fontSize' || key === 'textWidth' ? 'px' : '';
      output.textContent = `${current[key]}${suffix}`;
    }
    for (const button of themeButtons) {
      const active = button.dataset.themeValue === current.theme;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  function commit(patch) {
    current = normalizeSettings({ ...current, ...patch });
    paint();
    onChange(current);
  }

  container.addEventListener('input', (event) => {
    const control = event.target.closest('[data-setting]');
    if (!control) return;
    const key = control.dataset.setting;
    if (control.type === 'checkbox') return;
    commit({
      [key]: control.tagName === 'SELECT' ? control.value : Number(control.value),
    });
  });

  container.addEventListener('change', (event) => {
    const control = event.target.closest('[data-setting]');
    if (!control || control.type !== 'checkbox') return;
    commit({ [control.dataset.setting]: control.checked });
  });

  container.addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-theme-value]');
    if (swatch) {
      commit({ theme: swatch.dataset.themeValue });
      return;
    }
    if (event.target.closest('[data-reset]')) {
      current = { ...DEFAULT_SETTINGS };
      paint();
      onReset?.(current);
      onChange(current);
    }
  });

  paint();

  return {
    refresh(next) {
      current = normalizeSettings(next);
      paint();
    },
    get settings() {
      return { ...current };
    },
  };
}
