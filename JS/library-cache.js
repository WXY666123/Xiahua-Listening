(function () {
  const DB_NAME = 'ielts_listening_library_cache_v1';
  const STORE_NAME = 'questions';
  const DIRECTORY_HANDLE_DB = 'ielts_listening_directory_handle_v1';
  const DIRECTORY_HANDLE_STORE = 'handles';
  const DIRECTORY_HANDLE_KEY = 'library-root';
  const LIBRARY_ROOT_ALIASES = {
    '普通': '普通',
    'VIP': 'VIP',
    'IELTS Listening 虾滑': '普通',
    'IELTS Listening 虾滑VIP': 'VIP'
  };
  const LIBRARY_ROOTS = Object.keys(LIBRARY_ROOT_ALIASES);
  const CACHE_BATCH_SIZE = 50;
  let dbPromise = null;
  let directoryHandleDbPromise = null;
  const trackedDbs = new WeakSet();
  const memoryCache = new Map();

  function resetDbPromise() {
    dbPromise = null;
  }

  function isQuotaError(error) {
    return /quota|storage/i.test(String(error?.name || error?.message || ''));
  }

  async function requestPersistentStorage() {
    try {
      if (!navigator.storage?.persist) return false;
      if (await navigator.storage.persisted?.()) return true;
      return await navigator.storage.persist();
    } catch (error) {
      console.error('Failed to request persistent cache storage:', error);
      return false;
    }
  }

  function decodePath(value) {
    try {
      return decodeURI(String(value || ''));
    } catch (error) {
      return String(value || '');
    }
  }

  function normalizeRelativePath(path) {
    const cleanPath = decodePath(path)
      .normalize('NFC')
      .replace(/^file:\/\/(?:localhost\/)?/i, '')
      .replace(/^[A-Za-z]+:\/\/[^/]+/i, '')
      .replace(/[?#].*$/, '')
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/([A-Za-z]:\/)/, '$1')
      .replace(/\/+/g, '/')
      .trim();

    const parts = cleanPath.split('/').filter(Boolean);
    const start = getLibraryRootIndex(parts);
    return start >= 0 ? canonicalizeQuestionParts(parts.slice(start)).join('/') : cleanPath;
  }

  function getLibraryRootIndex(parts) {
    return (parts || []).findIndex((part) => Object.prototype.hasOwnProperty.call(LIBRARY_ROOT_ALIASES, part));
  }

  function canonicalizeQuestionParts(parts) {
    const questionParts = [...(parts || [])];
    if (questionParts.length) questionParts[0] = LIBRARY_ROOT_ALIASES[questionParts[0]] || questionParts[0];
    return questionParts;
  }

  function getQuestionParts(sourcePath) {
    const relativePath = normalizeRelativePath(sourcePath);
    const parts = relativePath.split('/').filter(Boolean);
    const start = getLibraryRootIndex(parts);
    if (start < 0 || parts.length < start + 5) return null;

    const questionParts = canonicalizeQuestionParts(parts.slice(start));
    return {
      section: questionParts[0],
      part: questionParts[1],
      frequency: questionParts[2],
      title: questionParts[3],
      fileName: questionParts[4],
      relativePath: questionParts.join('/')
    };
  }

  function resolveQuestionUrl(relativePath, baseUrl) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return '';
    const nativeDiskStorage = getNativeDiskStorage();
    if (nativeDiskStorage?.resolveQuestionUrl) {
      try {
        const nativeUrl = nativeDiskStorage.resolveQuestionUrl(normalized);
        if (nativeUrl) return nativeUrl;
      } catch (error) {
        console.error('Failed to resolve native question URL:', error);
      }
    }

    const encodedPath = normalized
      .split('/')
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join('/');

    return new URL(encodedPath, baseUrl).href;
  }

  function getCachePath(sourcePath) {
    const question = getQuestionParts(sourcePath);
    if (!question || !/\.html?$/i.test(question.relativePath)) return '';
    return question.relativePath;
  }

  function attachDbLifecycle(db) {
    if (!db || trackedDbs.has(db)) return db;
    trackedDbs.add(db);
    db.onversionchange = () => {
      resetDbPromise();
      try {
        db.close();
      } catch (error) {}
    };
    return db;
  }

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        resetDbPromise();
        reject(new Error('IndexedDB is not available.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, 2);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'path' });
        }
      };

      request.onsuccess = () => resolve(attachDbLifecycle(request.result));
      request.onerror = () => {
        resetDbPromise();
        reject(request.error || new Error('Failed to open IndexedDB.'));
      };
      request.onblocked = () => {
        resetDbPromise();
        reject(new Error('IndexedDB open request was blocked.'));
      };
    });

    return dbPromise;
  }

  function putMemoryEntry(entry) {
    if (!entry?.path) return;
    memoryCache.set(entry.path, entry);
    if (memoryCache.size > 800) {
      const firstKey = memoryCache.keys().next().value;
      if (firstKey) memoryCache.delete(firstKey);
    }
  }

  function getMemoryEntry(path) {
    return memoryCache.get(normalizeRelativePath(path)) || null;
  }

  function getNativeDiskStorage() {
    return window.NativeDiskStorage || null;
  }

  async function readExistingMetadata(paths) {
    const normalizedPaths = [...new Set((paths || []).map(normalizeRelativePath).filter(Boolean))];
    if (!normalizedPaths.length) return new Map();

    const fallback = new Map();
    normalizedPaths.forEach((path) => {
      const entry = getMemoryEntry(path);
      if (entry) fallback.set(path, {
        size: entry.size,
        lastModified: entry.lastModified,
        updatedAt: entry.updatedAt
      });
    });

    const nativeDiskStorage = getNativeDiskStorage();
    if (nativeDiskStorage?.cacheMetadata) {
      try {
        const metadata = nativeDiskStorage.cacheMetadata(normalizedPaths);
        Object.entries(metadata || {}).forEach(([path, entry]) => {
          fallback.set(path, {
            size: entry.size,
            lastModified: entry.lastModified,
            updatedAt: entry.updatedAt
          });
        });
        return fallback;
      } catch (error) {
        console.error('Failed to read disk cache metadata, using browser fallback:', error);
      }
    }

    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const metadata = new Map(fallback);
        let pending = normalizedPaths.length;

        normalizedPaths.forEach((path) => {
          const request = store.get(path);
          request.onsuccess = () => {
            const entry = request.result;
            if (entry) {
              metadata.set(path, {
                size: entry.size,
                lastModified: entry.lastModified,
                updatedAt: entry.updatedAt
              });
            }
            pending -= 1;
            if (pending === 0) resolve(metadata);
          };
          request.onerror = () => reject(request.error || new Error('Failed to read cache metadata.'));
        });
      });
    } catch (error) {
      console.error('Failed to read cache metadata, using memory fallback:', error);
      return fallback;
    }
  }

  function hasSameFileMetadata(existing, file) {
    if (!existing || !file) return false;
    const size = Number(file.size || 0);
    const lastModified = Number(file.lastModified || 0);
    return Number(existing.size || 0) === size
      && Number(existing.lastModified || 0) === lastModified
      && size > 0
      && lastModified > 0;
  }

  function withStore(mode, executor) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);

      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));

      executor(store, resolve, reject);
    })).catch((error) => {
      console.error(isQuotaError(error)
        ? 'Browser storage quota is full, using memory cache for this session:'
        : 'Persistent cache is unavailable, using memory cache for this session:', error);
      return false;
    });
  }

  function openDirectoryHandleDb() {
    if (directoryHandleDbPromise) return directoryHandleDbPromise;

    directoryHandleDbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        directoryHandleDbPromise = null;
        reject(new Error('IndexedDB is not available.'));
        return;
      }
      const request = indexedDB.open(DIRECTORY_HANDLE_DB, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DIRECTORY_HANDLE_STORE)) {
          db.createObjectStore(DIRECTORY_HANDLE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        directoryHandleDbPromise = null;
        reject(request.error || new Error('Failed to open directory handle DB.'));
      };
      request.onblocked = () => {
        directoryHandleDbPromise = null;
        reject(new Error('Directory handle DB open request was blocked.'));
      };
    });

    return directoryHandleDbPromise;
  }

  function getSavedDirectoryHandle() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return openDirectoryHandleDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(DIRECTORY_HANDLE_STORE, 'readonly');
      const store = transaction.objectStore(DIRECTORY_HANDLE_STORE);
      const request = store.get(DIRECTORY_HANDLE_KEY);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Failed to read directory handle.'));
    })).catch((error) => {
      console.error('Failed to read saved library directory:', error);
      return null;
    });
  }

  async function ensureDirectoryPermission(handle, options = {}) {
    if (!handle) return false;
    const permissionOptions = { mode: 'read' };
    try {
      if ((await handle.queryPermission?.(permissionOptions)) === 'granted') return true;
      if (options.silent) return false;
      return (await handle.requestPermission?.(permissionOptions)) === 'granted';
    } catch (error) {
      console.error('Failed to request library directory permission:', error);
      return false;
    }
  }

  async function readQuestionHtmlFromDirectory(relativePath, options = {}) {
    const path = normalizeRelativePath(relativePath);
    if (!path || !/\.html?$/i.test(path)) return '';
    const nativeDiskStorage = getNativeDiskStorage();
    if (nativeDiskStorage?.readQuestionHtml) {
      try {
        const nativeHtml = String(nativeDiskStorage.readQuestionHtml(path) || '');
        if (nativeHtml) return nativeHtml;

        // The hosted library exposes question files over HTTP rather than a
        // synchronous desktop filesystem bridge. Fetch the same resolved URL
        // so suite validation and preloading can use the shared cache API.
        if (nativeDiskStorage.isWebLibrary && nativeDiskStorage.resolveQuestionUrl) {
          const response = await fetch(nativeDiskStorage.resolveQuestionUrl(path));
          if (!response.ok && response.status !== 0) {
            throw new Error(`Unexpected response: ${response.status}`);
          }
          return await response.text();
        }
        return '';
      } catch (error) {
        console.error('Failed to read question HTML from disk library:', error);
        return '';
      }
    }
    const rootHandle = await getSavedDirectoryHandle();
    if (!rootHandle || !(await ensureDirectoryPermission(rootHandle, options))) return '';

    try {
      const parts = path.split('/').filter(Boolean);
      let handle = rootHandle;
      for (let index = 0; index < parts.length - 1; index += 1) {
        handle = await handle.getDirectoryHandle(parts[index]);
      }
      const fileHandle = await handle.getFileHandle(parts[parts.length - 1]);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (error) {
      console.error('Failed to read question HTML from directory:', error);
      return '';
    }
  }

  async function putQuestionHtml(relativePath, htmlText) {
    const path = getCachePath(relativePath);
    const html = String(htmlText || '');
    if (!path || !html) return false;

    if (getNativeDiskStorage()) return false;

    await requestPersistentStorage();
    const entry = { path, html, updatedAt: Date.now() };
    const persisted = await withStore('readwrite', (store) => store.put(entry));
    putMemoryEntry(entry);
    return !!persisted || memoryCache.has(path);
  }

  async function cacheQuestionFiles(files) {
    if (getNativeDiskStorage()) return 0;

    const candidates = Array.from(files || []).map((file) => {
      const path = getCachePath(file.webkitRelativePath || file.name);
      if (path) {
        return {
          file,
          path,
          type: 'html'
        };
      }
      return null;
    }).filter(Boolean);

    if (!candidates.length) return 0;

    await requestPersistentStorage();
    const metadata = await readExistingMetadata(candidates.map((item) => item.path));
    const nextCandidates = candidates.filter((item) => !hasSameFileMetadata(metadata.get(item.path), item.file));
    if (!nextCandidates.length) return 0;

    const updatedAt = Date.now();
    let cachedCount = 0;

    for (let index = 0; index < nextCandidates.length; index += CACHE_BATCH_SIZE) {
      const batch = nextCandidates.slice(index, index + CACHE_BATCH_SIZE);
      const htmlFiles = await Promise.all(batch
        .filter((item) => item.type === 'html')
        .map(async ({ file, path }) => ({
          path,
          html: await file.text(),
          size: Number(file.size || 0),
          lastModified: Number(file.lastModified || 0),
          updatedAt
        })));
      if (htmlFiles.length) {
        await withStore('readwrite', (store) => {
          htmlFiles.forEach((item) => store.put(item));
        });
        htmlFiles.forEach(putMemoryEntry);
        cachedCount += htmlFiles.length;
      }
    }

    return cachedCount;
  }

  function getQuestionHtml(relativePath, options = {}) {
    const path = normalizeRelativePath(relativePath);
    if (!path) return Promise.resolve('');

    if (getNativeDiskStorage()) {
      return readQuestionHtmlFromDirectory(path, options);
    }

    return openDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(path);

      request.onsuccess = () => resolve(String(request.result?.html || ''));
      request.onerror = () => reject(request.error || new Error('Failed to read cached question HTML.'));
    })).catch((error) => {
      console.error('Failed to read cached question HTML from IndexedDB:', error);
      return String(getMemoryEntry(path)?.html || '');
    }).then(async (html) => html || await readQuestionHtmlFromDirectory(path, options));
  }

  function hasQuestionHtml(relativePath) {
    const path = normalizeRelativePath(relativePath);
    if (!path) return Promise.resolve(false);

    if (getNativeDiskStorage()) {
      return readQuestionHtmlFromDirectory(path, { silent: true }).then(Boolean);
    }

    return openDb().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(path);

      request.onsuccess = () => resolve(!!request.result?.html);
      request.onerror = () => reject(request.error || new Error('Failed to check cached question HTML.'));
    })).catch(() => !!getMemoryEntry(path)?.html);
  }

  async function warmQuestionHtml(relativePath, options = {}) {
    const path = getCachePath(relativePath);
    if (!path) return false;
    if (!options.force && await hasQuestionHtml(path)) return true;

    const html = await readQuestionHtmlFromDirectory(path, { silent: !!options.silent });
    if (!html) return false;
    return putQuestionHtml(path, html);
  }

  async function ensureQuestionHtml(relativePath, loader = null, options = {}) {
    const path = getCachePath(relativePath);
    if (!path) return '';

    const cachedHtml = await getQuestionHtml(path, options);
    if (cachedHtml) return cachedHtml;

    if (await warmQuestionHtml(path, options)) {
      return getQuestionHtml(path, options);
    }

    if (typeof loader === 'function') {
      const html = String(await loader(path) || '');
      if (html) {
        await putQuestionHtml(path, html);
        return html;
      }
    }

    return '';
  }

  function clearAllCache() {
    memoryCache.clear();
    return withStore('readwrite', (store) => {
      store.clear();
    }).then(() => 0);
  }

  async function pruneLegacyAssetCache() {
    try {
      const db = await openDb();
      let removed = 0;
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.openCursor();

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const value = cursor.value || {};
          if (!value.html) {
            store.delete(cursor.primaryKey);
            memoryCache.delete(value.path);
            removed += 1;
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('Failed to prune legacy asset cache.'));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Legacy asset prune transaction failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('Legacy asset prune transaction aborted.'));
      });
      return removed;
    } catch (error) {
      console.error('Failed to prune legacy asset cache:', error);
      return 0;
    }
  }

  window.LibraryCache = {
    normalizeRelativePath,
    getQuestionParts,
    resolveQuestionUrl,
    requestPersistentStorage,
    cacheQuestionFiles,
    putQuestionHtml,
    warmQuestionHtml,
    ensureQuestionHtml,
    clearAllCache,
    pruneLegacyAssetCache,
    getQuestionHtml,
    hasQuestionHtml
  };
}());
