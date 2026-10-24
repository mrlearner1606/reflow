/**
 * storage.js
 * All persistence is local: localStorage for small records and IndexedDB for
 * extracted page geometry. Nothing here talks to the network.
 */

const SETTINGS_KEY = 'pdfreader:settings:v1';
const DOC_PREFIX = 'pdfreader:doc:v1:';
const DB_NAME = 'pdfreader-cache';
const DB_VERSION = 1;
const PAGE_STORE = 'pages';

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota or a privacy mode that disables storage: reading still works.
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                           */
/* ------------------------------------------------------------------ */

export function getStoredSettings() {
  return readJson(SETTINGS_KEY);
}

export function saveStoredSettings(settings) {
  return writeJson(SETTINGS_KEY, settings);
}

/* ------------------------------------------------------------------ */
/* per-document state                                                 */
/* ------------------------------------------------------------------ */

export function getDocState(docKey) {
  const value = readJson(`${DOC_PREFIX}${docKey}`);
  return value && typeof value === 'object' ? value : null;
}

export function saveDocState(docKey, patch) {
  if (!docKey) return false;
  const previous = getDocState(docKey) || {};
  const next = {
    ...previous,
    ...patch,
    updatedAt: Date.now(),
  };
  return writeJson(`${DOC_PREFIX}${docKey}`, next);
}

/* ------------------------------------------------------------------ */
/* file identity                                                      */
/* ------------------------------------------------------------------ */

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Stable document key. Full-file SHA-256 for normal PDFs; for very large
 * files, hash the size plus the first and last 2 MB so opening stays snappy.
 */
export async function hashFile(file) {
  const fallback = `${file.name}:${file.size}:${file.lastModified}`;
  if (!globalThis.crypto?.subtle || typeof file.arrayBuffer !== 'function') {
    return fallback;
  }

  const SAMPLE = 2 * 1024 * 1024;
  const MAX_FULL = 64 * 1024 * 1024;

  try {
    let bytes;
    if (file.size <= MAX_FULL) {
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const head = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer());
      const tail = new Uint8Array(
        await file.slice(Math.max(0, file.size - SAMPLE)).arrayBuffer(),
      );
      const sizeBytes = new TextEncoder().encode(String(file.size));
      bytes = new Uint8Array(head.length + tail.length + sizeBytes.length);
      bytes.set(head, 0);
      bytes.set(tail, head.length);
      bytes.set(sizeBytes, head.length + tail.length);
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return toHex(new Uint8Array(digest));
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB page cache                                               */
/* ------------------------------------------------------------------ */

let dbPromise = null;

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAGE_STORE)) {
        db.createObjectStore(PAGE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function pageKey(docKey, pageNumber) {
  return `${docKey}:${pageNumber}`;
}

export async function getCachedPage(docKey, pageNumber) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db
        .transaction(PAGE_STORE, 'readonly')
        .objectStore(PAGE_STORE)
        .get(pageKey(docKey, pageNumber));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedPage(docKey, pageNumber, value) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PAGE_STORE, 'readwrite');
      tx.objectStore(PAGE_STORE).put(value, pageKey(docKey, pageNumber));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function clearCachedDocument(docKey) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PAGE_STORE, 'readwrite');
      const store = tx.objectStore(PAGE_STORE);
      const range = IDBKeyRange.bound(`${docKey}:`, `${docKey}:\uffff`);
      store.delete(range);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
