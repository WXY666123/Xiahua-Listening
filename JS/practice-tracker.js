(function () {
  const STORAGE_KEY = 'ielts_listening_tracker_v1';
  const LIBRARY_ROOT_ALIASES = {
    '普通': '普通',
    'VIP': 'VIP',
    'IELTS Listening 虾滑': '普通',
    'IELTS Listening 虾滑VIP': 'VIP'
  };
  const MAX_ATTEMPTS_PER_TEST = 3;
  let cachedStore = null;
  let cachedStoreRaw = null;
  let cachedStoreLookups = null;
  let cachedStoreLookupsRaw = null;

  function getEmptyStore() {
    return { version: 2, tests: {}, ignoredVocabKeys: [] };
  }

  function clearStoreCache() {
    cachedStore = null;
    cachedStoreRaw = null;
    cachedStoreLookups = null;
    cachedStoreLookupsRaw = null;
  }

  function setStoreCache(raw, store) {
    cachedStoreRaw = raw;
    cachedStore = store;
    cachedStoreLookups = null;
    cachedStoreLookupsRaw = null;
    return cachedStore;
  }

  function readStorage(key) {
    try {
      return window.localStorage?.getItem(key) || null;
    } catch (error) {
      console.error('Failed to read localStorage:', error);
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage?.setItem(key, value);
      return true;
    } catch (error) {
      console.error('Failed to write localStorage:', error);
      return false;
    }
  }

  function removeStorage(key) {
    try {
      window.localStorage?.removeItem(key);
    } catch (error) {
      console.error('Failed to remove localStorage item:', error);
    }
  }

	  const StorageBackup = (() => {
    const DB_NAME = 'ielts_listening_persistent_backup_v1';
    const STORE_NAME = 'entries';
    let dbPromise = null;

    function isSupported() {
      return typeof indexedDB !== 'undefined';
    }

    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (!isSupported()) {
          dbPromise = null;
          reject(new Error('IndexedDB is not available.'));
          return;
        }

        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          dbPromise = null;
          reject(request.error || new Error('Failed to open persistent backup DB.'));
        };
        request.onblocked = () => {
          dbPromise = null;
          reject(new Error('Persistent backup DB open request was blocked.'));
        };
      });
      return dbPromise;
    }

    async function withStore(mode, callback) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = callback(store);
        transaction.onerror = () => reject(transaction.error || new Error('Persistent backup transaction failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('Persistent backup transaction aborted.'));
        if (!request) {
          transaction.oncomplete = () => resolve(true);
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Persistent backup request failed.'));
      });
    }

    async function get(key) {
      if (!isSupported() || !key) return null;
      try {
        const entry = await withStore('readonly', (store) => store.get(key));
        return typeof entry?.value === 'string' ? entry.value : null;
      } catch (error) {
        console.error('Failed to read persistent backup:', error);
        return null;
      }
    }

    async function set(key, value) {
      if (!isSupported() || !key || typeof value !== 'string') return false;
      try {
        await withStore('readwrite', (store) => store.put({
          value,
          updatedAt: new Date().toISOString()
        }, key));
        return true;
      } catch (error) {
        console.error('Failed to write persistent backup:', error);
        return false;
      }
    }

    async function remove(key) {
      if (!isSupported() || !key) return false;
      try {
        await withStore('readwrite', (store) => store.delete(key));
        return true;
      } catch (error) {
        console.error('Failed to remove persistent backup:', error);
        return false;
      }
    }

    async function requestPersistence() {
      try {
        if (!navigator.storage?.persist) return false;
        if (await navigator.storage.persisted?.()) return true;
        return await navigator.storage.persist();
      } catch (error) {
        console.error('Failed to request persistent storage:', error);
        return false;
      }
    }

    async function estimate() {
      try {
        return await navigator.storage?.estimate?.() || null;
      } catch (error) {
        console.error('Failed to estimate browser storage:', error);
        return null;
      }
    }

	    return { get, set, remove, requestPersistence, estimate };
	  })();

	  function backupAnswerRecord(key, value) {
	    try {
	      return !!window.NativeDiskStorage?.backupAnswerRecord?.(key, value);
	    } catch (error) {
	      console.error('Failed to write answer record backup:', error);
	      return false;
	    }
	  }

	  function readAnswerRecordBackup(key) {
	    try {
	      return window.NativeDiskStorage?.readAnswerRecordBackup?.(key) || null;
	    } catch (error) {
	      console.error('Failed to read answer record backup:', error);
	      return null;
	    }
	  }

	  function removeAnswerRecordBackup(key) {
	    try {
	      return !!window.NativeDiskStorage?.removeAnswerRecordBackup?.(key);
	    } catch (error) {
	      console.error('Failed to remove answer record backup:', error);
	      return false;
	    }
	  }

	  function getStore() {
    try {
      const raw = readStorage(STORAGE_KEY);
      if (raw === cachedStoreRaw && cachedStore) return cachedStore;
      if (!raw && cachedStore) return cachedStore;
      if (!raw) return setStoreCache(raw, getEmptyStore());
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return setStoreCache(raw, getEmptyStore());
      return setStoreCache(raw, sanitizeStore(parsed));
    } catch (error) {
      console.error('Failed to load practice tracker store:', error);
      return setStoreCache(null, getEmptyStore());
    }
  }

  function saveStore(store) {
    const sanitized = sanitizeStore(store);
	    const serialized = JSON.stringify(sanitized);
	    if (serialized === cachedStoreRaw) {
	      setStoreCache(serialized, sanitized);
	      return sanitized;
	    }
	    const localSaved = writeStorage(STORAGE_KEY, serialized);
	    StorageBackup.set(STORAGE_KEY, serialized);
	    backupAnswerRecord(STORAGE_KEY, serialized);
	    setStoreCache(localSaved ? serialized : null, sanitized);
	    return sanitized;
	  }

  function decodePath(value) {
    try {
      return decodeURI(String(value || ''));
    } catch (error) {
      return String(value || '');
    }
  }

  function normalizePath(path) {
    return decodePath(path)
      .normalize('NFC')
      .replace(/^file:\/\/(?:localhost\/)?/i, '')
      .replace(/^[A-Za-z]+:\/\/[^/]+/i, '')
      .replace(/[?#].*$/, '')
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/([A-Za-z]:\/)/, '$1')
      .replace(/\/+/g, '/')
      .trim();
  }

  function splitPath(path) {
    return normalizePath(path).split('/').filter(Boolean);
  }

  function getQuestionParts(path) {
    const fromCache = window.LibraryCache?.getQuestionParts?.(path);
    if (fromCache) return fromCache;

    const parts = splitPath(path);
    const start = parts.findIndex((part) => Object.prototype.hasOwnProperty.call(LIBRARY_ROOT_ALIASES, part));
    if (start === -1 || parts.length < start + 5) return null;

    const questionParts = parts.slice(start);
    questionParts[0] = LIBRARY_ROOT_ALIASES[questionParts[0]] || questionParts[0];
    return {
      section: questionParts[0],
      part: questionParts[1] || '',
      frequency: questionParts[2] || '',
      title: questionParts[3] || '',
      fileName: questionParts[4] || '',
      relativePath: normalizePath(questionParts.join('/'))
    };
  }

  function slugQuestionIdPart(value) {
    return String(value || '')
      .normalize('NFC')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function normalizeQuestionIdSection(section) {
    const value = String(section || '').trim();
    if (/^vip$/i.test(value)) return 'vip';
    if (value === '普通') return 'normal';
    return slugQuestionIdPart(value);
  }

  function getQuestionNumberFromTitle(title) {
    const match = String(title || '').match(/^\s*(\d+)\s*\./);
    return match ? match[1] : '';
  }

  function buildQuestionId(section, part, title, fallbackPath = '') {
    const cleanTitle = String(title || '')
      .replace(/^\s*\d+\s*\.\s*/, '')
      .replace(/^P\d+\s+/i, '')
      .replace(/\s*\((?:VIP)\)\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const sectionToken = normalizeQuestionIdSection(section);
    const partToken = String(part || '').trim().toLowerCase();
    const number = getQuestionNumberFromTitle(title) || getQuestionNumberFromTitle((fallbackPath || '').split('/').slice(-2, -1)[0] || '');
    const titleToken = slugQuestionIdPart(cleanTitle);
    return [sectionToken, partToken, number, titleToken].filter(Boolean).join('-');
  }

  function normalizeQuestionTitle(title) {
    return String(title || '')
      .normalize('NFC')
      .replace(/^\d+\s*\.\s*/u, '')
      .replace(/\s*\((?:VIP)\)\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function buildQuestionKey(section, part, title) {
    const cleanSection = String(section || '').trim();
    const cleanPart = String(part || '').trim().toUpperCase();
    const cleanTitle = normalizeQuestionTitle(title);
    if (!cleanSection || !cleanPart || !cleanTitle) return '';
    return [cleanSection, cleanPart, cleanTitle].join('::');
  }

  function buildLooseQuestionKey(section, title) {
    const cleanSection = String(section || '').trim();
    const cleanTitle = normalizeQuestionTitle(title);
    if (!cleanSection || !cleanTitle) return '';
    return [cleanSection, cleanTitle].join('::');
  }

  function getContextFromPath(path) {
    const question = getQuestionParts(path);
    if (!question) return null;

    const { section, part, frequency, title, fileName, relativePath } = question;

    const questionKey = buildQuestionKey(section, part, title);
    const questionId = buildQuestionId(section, part, title, relativePath);


    return {
      id: questionId || questionKey || relativePath,
      questionId,
      questionKey,
      section,
      part,
      frequency,
      title,
      fileName,
      relativePath
    };
  }

  function getPageContext() {
    return getContextFromPath(window.location.pathname || window.location.href);
  }

  function buildStoreLookups(store) {
    const tests = store?.tests && typeof store.tests === 'object' ? store.tests : {};
    const entryByPath = new Map();
    const entryByQuestionId = new Map();
    const entryByQuestionKey = new Map();
    const entryByLooseKey = new Map();
    const latestAttempts = [];

    Object.values(tests).forEach((entry) => {
      const questionId = String(entry?.questionId || entry?.latestAttempt?.questionId || buildQuestionId(entry?.section, entry?.part, entry?.title, entry?.relativePath || entry?.id || '') || '');
      const questionKey = String(entry?.questionKey || buildQuestionKey(entry?.section, entry?.part, entry?.title) || '');
      const normalizedPath = normalizePath(entry?.relativePath || entry?.id || '');
      const looseKey = buildLooseQuestionKey(entry?.section, entry?.title);

      if (questionId) {
        entryByQuestionId.set(questionId, entry);
      }
      if (questionKey) {
        entryByQuestionKey.set(questionKey, entry);
      }
      if (normalizedPath) {
        entryByPath.set(normalizedPath, entry);
      }
      if (looseKey) {
        const list = entryByLooseKey.get(looseKey) || [];
        list.push(entry);
        entryByLooseKey.set(looseKey, list);
      }
      if (entry?.latestAttempt) {
        latestAttempts.push(entry.latestAttempt);
      }
    });

    return { entryByPath, entryByQuestionId, entryByQuestionKey, entryByLooseKey, latestAttempts };
  }

  function getStoreLookups(store = getStore()) {
    if (cachedStoreLookups && cachedStoreLookupsRaw === cachedStoreRaw) {
      return cachedStoreLookups;
    }
    cachedStoreLookups = buildStoreLookups(store);
    cachedStoreLookupsRaw = cachedStoreRaw;
    return cachedStoreLookups;
  }

  function getText(node) {
    return String(node?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function cleanAnswer(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    if (/^(?:No Answer|未作答|[-—–]+)$/i.test(value)) return '';
    return value;
  }

  function hasAnsweredDetails(details) {
    return (Array.isArray(details) ? details : []).some((detail) => cleanAnswer(detail?.userAnswer));
  }

  function shouldRejectBlankOverwrite(existingEntry, incomingAttempt) {
    const existingLatest = existingEntry?.latestAttempt || (existingEntry?.attempts || []).slice(-1)[0] || null;
    if (!existingLatest || !incomingAttempt) return false;
    if (Number(existingLatest.total || 0) !== Number(incomingAttempt.total || 0)) return false;
    return hasAnsweredDetails(existingLatest.details) && !hasAnsweredDetails(incomingAttempt.details);
  }

  function getAnswerCellValue(cell) {
    if (!cell) return '';
    const answerElement =
      cell.querySelector?.('[data-answer]')
      || cell.querySelector?.('.answer-value');
    const dataAnswer = answerElement?.dataset?.answer || cell.dataset?.answer || '';
    const visibleAnswer = getText(answerElement || cell);
    return cleanAnswer(dataAnswer || visibleAnswer);
  }

  function normalizeAnswerForCompare(text) {
    return cleanAnswer(text).toLowerCase();
  }

  function parseTableRows(doc, selector, options = {}) {
    const rows = [...doc.querySelectorAll(selector)];
    const validRows = rows.filter((row) => row.querySelectorAll('td').length >= 4);
    if (!validRows.length) return [];

    return validRows.map((row) => {
      const cells = row.querySelectorAll('td');
      const question = getText(cells[0]);
      const userAnswer = cleanAnswer(getText(cells[1]));
      const correctAnswer = getAnswerCellValue(cells[2]);
      const resultCell = cells[3];
      const resultText = getText(resultCell);
      const resultClass = String(resultCell?.className || '');
      const sameAnswer = !!userAnswer && normalizeAnswerForCompare(userAnswer) === normalizeAnswerForCompare(correctAnswer);
      const isCorrect = sameAnswer || (options.checker
        ? options.checker(resultText, resultClass, resultCell)
        : /correct|right/i.test(resultText) && !/incorrect|wrong/i.test(resultText));
      return { question, userAnswer, correctAnswer, isCorrect };
    });
  }

  function parseResultsFromDocument(doc) {
    const resultsRows = parseTableRows(doc, '.results-table tbody tr, .results-table tr', {
      checker(resultText) {
        return /correct/i.test(resultText) && !/incorrect/i.test(resultText);
      }
    });
    if (resultsRows.length) return resultsRows;

    const legacyResultRows = parseTableRows(doc, '.result-table tr', {
      checker(resultText, resultClass) {
        return (
          (/correct|right/i.test(resultText) && !/incorrect|wrong/i.test(resultText)) ||
          /res-correct|ans-correct|correct/i.test(resultClass) ||
          /^(?:✓|✔|\u2713|\u2714)$/u.test(resultText)
        );
      }
    });
    if (legacyResultRows.length) return legacyResultRows;

    const generatedReviewRows = parseTableRows(doc, '.group.review table tr, section.review table tr', {
      checker(resultText, resultClass) {
        return (
          (/correct|right|✓|✔|\u2713|\u2714/i.test(resultText) && !/incorrect|wrong/i.test(resultText)) ||
          /correct/i.test(resultClass)
        );
      }
    });
    if (generatedReviewRows.length) return generatedReviewRows;

    const reviewRows = parseTableRows(doc, '.review-table tr');
    if (reviewRows.length) return reviewRows;

    const answerRows = parseTableRows(doc, '.ans-table tbody tr, .ans-table tr');
    if (answerRows.length) return answerRows;

    const gradeRows = parseTableRows(doc, '.feedback .grade-report tr', {
      checker(resultText, resultClass, resultCell) {
        const styleColor = String(resultCell?.style?.color || '').trim().toLowerCase();
        return (
          /correct|right|✓|✔|\u2713|\u2714/i.test(resultText) ||
          /correct/i.test(resultClass) ||
          styleColor === 'green' ||
          styleColor === 'rgb(0, 128, 0)' ||
          resultCell?.matches?.('[style*="green" i]')
        ) && !/incorrect|wrong/i.test(resultText);
      }
    });
    if (gradeRows.length) return gradeRows;

    const reviewItems = [...doc.querySelectorAll('#reviewList .rvItem')];
    if (reviewItems.length) {
      return reviewItems.map((item) => {
        const question = getText(item.querySelector('.rvQ'));
        const rows = item.querySelectorAll('.rvRow');
        const userBadge = rows[0]?.querySelector('span:last-child');
        const correctBadge = rows[1]?.querySelector('span:last-child');
        const userAnswer = cleanAnswer(getText(userBadge));
        const correctAnswer = cleanAnswer(getText(correctBadge));
        const isCorrect = !!userBadge && userBadge.classList.contains('badge') && !userBadge.classList.contains('bad');
        return { question, userAnswer, correctAnswer, isCorrect };
      });
    }

    return [];
  }

  function formatAttemptTime(date) {
    return new Date(date).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  function parseStoredTime(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    const direct = new Date(text);
    if (!Number.isNaN(direct.getTime())) {
      return direct.toISOString();
    }

    const match = text.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})\D+(\d{1,2})\D(\d{1,2})\D(\d{1,2})/);
    if (!match) return '';

    const [, year, month, day, hour, minute, second] = match;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );

    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }

  function resolveAttemptTimestamp(rawAttempt, fallback = {}) {
    return (
      parseStoredTime(rawAttempt?.timestamp)
      || parseStoredTime(rawAttempt?.formattedTime)
      || parseStoredTime(fallback?.timestamp)
      || parseStoredTime(fallback?.formattedTime)
      || '1970-01-01T00:00:00.000Z'
    );
  }

  function buildAttempt(context, details) {
    const total = details.length;
    const correct = details.filter((item) => item.isCorrect).length;
    const percent = total ? Math.round((correct / total) * 100) : 0;
    const timestamp = new Date().toISOString();
    const signature = JSON.stringify(details);
    return {
      id: context.questionKey || context.id,
      questionKey: context.questionKey || '',
      title: context.title,
      section: context.section,
      part: context.part,
      frequency: context.frequency,
      relativePath: context.relativePath,
      total,
      correct,
      wrong: Math.max(total - correct, 0),
      percent,
      timestamp,
      formattedTime: formatAttemptTime(timestamp),
      signature,
      details
    };
  }

  function sanitizeAttempt(rawAttempt, fallback = {}) {
    const details = Array.isArray(rawAttempt?.details) ? rawAttempt.details.map((detail) => ({
      question: String(detail?.question || ''),
      userAnswer: String(detail?.userAnswer || ''),
      correctAnswer: String(detail?.correctAnswer || ''),
      isCorrect: !!detail?.isCorrect
    })) : [];

    const timestamp = resolveAttemptTimestamp(rawAttempt, fallback);
    const total = Number.isFinite(rawAttempt?.total) ? rawAttempt.total : details.length;
    const correct = Number.isFinite(rawAttempt?.correct)
      ? rawAttempt.correct
      : details.filter((item) => item.isCorrect).length;
    const relativePath = normalizePath(rawAttempt?.relativePath || fallback.relativePath || rawAttempt?.id || '');
    const section = String(rawAttempt?.section || fallback.section || '');
    const part = String(rawAttempt?.part || fallback.part || '');
    const title = String(rawAttempt?.title || fallback.title || '');
    const questionId = String(
      rawAttempt?.questionId
      || fallback.questionId
      || buildQuestionId(section, part, title, relativePath)
      || ''
    );
    const questionKey = String(
      rawAttempt?.questionKey
      || fallback.questionKey
      || buildQuestionKey(section, part, title)
      || ''
    );
    const highlightHtml = String(rawAttempt?.highlightHtml || fallback.highlightHtml || '');
    const highlightTexts = Array.isArray(rawAttempt?.highlightTexts)
      ? rawAttempt.highlightTexts.map((item) => ({
        text: String(item?.text || '').trim(),
        className: String(item?.className || 'hl-brown').trim() || 'hl-brown'
      })).filter((item) => item.text)
      : (Array.isArray(fallback.highlightTexts) ? fallback.highlightTexts.map((item) => ({
        text: String(item?.text || '').trim(),
        className: String(item?.className || 'hl-brown').trim() || 'hl-brown'
      })).filter((item) => item.text) : []);
    const highlightsSource = Array.isArray(rawAttempt?.highlights) ? rawAttempt.highlights : fallback.highlights;
    const highlights = Array.isArray(highlightsSource)
      ? highlightsSource.map((item) => ({
        path: Array.isArray(item?.path) ? item.path.map((value) => Number(value)).filter((value) => Number.isFinite(value)) : [],
        start: Math.max(0, Number(item?.start || 0)),
        end: Math.max(0, Number(item?.end || 0)),
        text: String(item?.text || '').trim(),
        className: String(item?.className || 'hl-brown').trim() || 'hl-brown'
      })).filter((item) => item.path.length && item.end > item.start)
      : [];

    return {
      id: questionId || questionKey || relativePath,
      questionId,
      questionKey,
      title,
      section,
      part,
      frequency: String(rawAttempt?.frequency || fallback.frequency || ''),
      relativePath,
      total,
      correct,
      wrong: Math.max(total - correct, 0),
      percent: total ? Math.round((correct / total) * 100) : 0,
      timestamp,
      formattedTime: rawAttempt?.formattedTime || formatAttemptTime(timestamp),
      signature: rawAttempt?.signature || JSON.stringify(details),
      details,
      highlights,
      highlightHtml,
      highlightTexts
    };
  }

  function getEntryLookupKey(entry) {
    return String(
      entry?.questionId
      || buildQuestionId(entry?.section, entry?.part, entry?.title, entry?.relativePath || entry?.id || '')
      || entry?.questionKey
      || buildQuestionKey(entry?.section, entry?.part, entry?.title)
      || normalizePath(entry?.relativePath || entry?.id || '')
    );
  }

  function ensureEntryShape(entry) {
    return {
      id: getEntryLookupKey(entry),
      questionId: String(entry?.questionId || buildQuestionId(entry?.section, entry?.part, entry?.title, entry?.relativePath || entry?.id || '') || ''),
      questionKey: String(entry?.questionKey || buildQuestionKey(entry?.section, entry?.part, entry?.title) || ''),
      title: String(entry?.title || ''),
      section: String(entry?.section || ''),
      part: String(entry?.part || ''),
      frequency: String(entry?.frequency || ''),
      relativePath: normalizePath(entry?.relativePath || entry?.id || ''),
      attempts: Array.isArray(entry?.attempts) ? entry.attempts : [],
      latestAttempt: entry?.latestAttempt || null
    };
  }

  function mergeAttempts(existingAttempts, incomingAttempts) {
    const merged = new Map();
    const attempts = [...(existingAttempts || []), ...(incomingAttempts || [])]
      .map((attempt) => sanitizeAttempt(attempt))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    attempts.forEach((attempt) => {
      const target = attempt.questionId || attempt.questionKey || attempt.relativePath;
      const signature = attempt.signature || '';
      const minuteBucket = Math.floor(new Date(attempt.timestamp).getTime() / (60 * 1000));
      const dedupeKey = [target, signature, minuteBucket].join('::');
      const existing = merged.get(dedupeKey);
      if (!existing || new Date(attempt.timestamp) >= new Date(existing.timestamp)) {
        merged.set(dedupeKey, attempt);
      }
    });

    return [...merged.values()].slice(-MAX_ATTEMPTS_PER_TEST);
  }

  function getAttemptTimestampMs(attempt) {
    const parsed = new Date(attempt?.timestamp || attempt?.formattedTime || '').getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function appendAttemptHistory(existingAttempts, incomingAttempt) {
    const normalizedIncoming = sanitizeAttempt(incomingAttempt);
    const attempts = [...(existingAttempts || []).map((attempt) => sanitizeAttempt(attempt)), normalizedIncoming]
      .sort((a, b) => getAttemptTimestampMs(a) - getAttemptTimestampMs(b));
    const deduped = [];
    attempts.forEach((attempt) => {
      const previous = deduped[deduped.length - 1];
      const isSameImmediateAttempt = previous
        && previous.signature
        && attempt.signature
        && previous.signature === attempt.signature
        && Math.abs(getAttemptTimestampMs(attempt) - getAttemptTimestampMs(previous)) < 2000;
      if (isSameImmediateAttempt) {
        deduped[deduped.length - 1] = getAttemptTimestampMs(attempt) >= getAttemptTimestampMs(previous) ? attempt : previous;
        return;
      }
      deduped.push(attempt);
    });
    return deduped.slice(-MAX_ATTEMPTS_PER_TEST);
  }

  function findExistingEntryForAttempt(store, attempt) {
    const lookupKey = attempt.questionId || attempt.questionKey || attempt.relativePath;
    if (lookupKey && store.tests?.[lookupKey]) {
      return { key: lookupKey, entry: store.tests[lookupKey] };
    }

    const normalizedPath = normalizePath(attempt.relativePath || '');
    const context = normalizedPath ? getContextFromPath(normalizedPath) : {
      questionKey: attempt.questionKey || '',
      section: attempt.section || '',
      part: attempt.part || '',
      title: attempt.title || ''
    };
    const matchedEntry = findEntryByContext(store, normalizedPath, context);
    if (!matchedEntry) return { key: lookupKey, entry: null };

    return {
      key: getEntryLookupKey(matchedEntry),
      entry: matchedEntry
    };
  }

  function mergeEntries(baseEntry, incomingEntry) {
    const base = ensureEntryShape(baseEntry);
    const incoming = ensureEntryShape(incomingEntry);
    const attempts = mergeAttempts(base.attempts, incoming.attempts);

    let latestAttempt = attempts[attempts.length - 1] || null;
    if (base.latestAttempt) latestAttempt = sanitizeAttempt(base.latestAttempt, latestAttempt || base);
    if (incoming.latestAttempt) {
      const normalizedLatest = sanitizeAttempt(incoming.latestAttempt, latestAttempt || incoming);
      if (!latestAttempt || new Date(normalizedLatest.timestamp) >= new Date(latestAttempt.timestamp)) {
        latestAttempt = normalizedLatest;
      }
    }

    return {
      id: incoming.id || base.id,
      questionId: incoming.questionId || base.questionId || latestAttempt?.questionId || '',
      questionKey: incoming.questionKey || base.questionKey || latestAttempt?.questionKey || '',
      title: incoming.title || base.title || latestAttempt?.title || '',
      section: incoming.section || base.section || latestAttempt?.section || '',
      part: incoming.part || base.part || latestAttempt?.part || '',
      frequency: incoming.frequency || base.frequency || latestAttempt?.frequency || '',
      relativePath: incoming.relativePath || base.relativePath || latestAttempt?.relativePath || '',
      attempts,
      latestAttempt
    };
  }

  function sanitizeStore(store) {
    const sourceTests = store?.tests && typeof store.tests === 'object' ? store.tests : {};
    const tests = {};
    const ignoredVocabKeys = [...new Set(
      (Array.isArray(store?.ignoredVocabKeys) ? store.ignoredVocabKeys : [])
        .map((item) => normalizeVocabKey(item))
        .filter(Boolean)
    )];

    Object.entries(sourceTests).forEach(([rawKey, rawEntry]) => {
      const entry = ensureEntryShape({
        ...rawEntry,
        id: rawEntry?.id || rawKey || '',
        relativePath: rawEntry?.relativePath || rawEntry?.id || rawKey || '',
        questionKey: rawEntry?.questionKey || buildQuestionKey(rawEntry?.section, rawEntry?.part, rawEntry?.title)
      });

      const fallbackMeta = {
        id: entry.id,
        questionId: entry.questionId,
        questionKey: entry.questionKey,
        title: entry.title,
        section: entry.section,
        part: entry.part,
        frequency: entry.frequency,
        relativePath: entry.relativePath
      };

      const normalizedAttempts = (Array.isArray(entry.attempts) ? entry.attempts : [])
        .map((attempt) => sanitizeAttempt(attempt, fallbackMeta));

      const mergedEntry = mergeEntries(
        tests[getEntryLookupKey(entry)] || null,
        {
          ...entry,
          attempts: normalizedAttempts,
          latestAttempt: entry.latestAttempt ? sanitizeAttempt(entry.latestAttempt, fallbackMeta) : null
        }
      );

      const lookupKey = getEntryLookupKey(mergedEntry);
      tests[lookupKey] = {
        ...mergedEntry,
        id: lookupKey
      };
    });

    return { version: 2, tests, ignoredVocabKeys };
  }

  function buildLibraryIndex(libraryData) {
    const byPath = new Map();
    const byQuestionId = new Map();
    const byQuestionKey = new Map();
    const byLooseKey = new Map();

    (Array.isArray(libraryData) ? libraryData : []).forEach((item) => {
      if (!item) return;
      const question = getQuestionParts(item.h || item.relativePath || item.id || '');
      const section = String(question?.section || item.s || item.section || '');
      const part = String(question?.part || item.p || item.part || '');
      const frequency = String(question?.frequency || item.f || item.frequency || '');
      const title = String(question?.title || item.t || item.title || '');
      const relativePath = question?.relativePath || normalizePath(item.h || item.relativePath || item.id || '');
      const questionKey = buildQuestionKey(section, part, title);
      const questionId = buildQuestionId(section, part, title, relativePath);
      const looseKey = buildLooseQuestionKey(section, title);
      const meta = {
        id: questionId || questionKey || relativePath,
        questionId,
        questionKey,
        section,
        part,
        frequency,
        title,
        relativePath
      };

      if (relativePath) byPath.set(relativePath, meta);
      if (questionId) byQuestionId.set(questionId, meta);
      if (questionKey) byQuestionKey.set(questionKey, meta);
      if (looseKey) {
        const list = byLooseKey.get(looseKey) || [];
        list.push(meta);
        byLooseKey.set(looseKey, list);
      }
    });

    return { byPath, byQuestionId, byQuestionKey, byLooseKey };
  }

  function findLibraryMatch(entry, index) {
    const path = normalizePath(entry?.relativePath || entry?.id || '');
    const questionId = String(entry?.questionId || buildQuestionId(entry?.section, entry?.part, entry?.title, entry?.relativePath || entry?.id || '') || '');
    const questionKey = String(entry?.questionKey || buildQuestionKey(entry?.section, entry?.part, entry?.title) || '');
    const looseKey = buildLooseQuestionKey(entry?.section, entry?.title);

    if (questionId && index.byQuestionId?.has(questionId)) return index.byQuestionId.get(questionId);
    if (questionKey && index.byQuestionKey.has(questionKey)) return index.byQuestionKey.get(questionKey);
    if (path && index.byPath.has(path)) return index.byPath.get(path);

    const looseMatches = looseKey ? (index.byLooseKey.get(looseKey) || []) : [];
    if (!looseMatches.length) return null;

    const samePart = looseMatches.find((item) => item.part === entry?.part);
    return samePart || (looseMatches.length === 1 ? looseMatches[0] : null);
  }

  function applyMetaToAttempt(attempt, meta) {
    return sanitizeAttempt({
      ...attempt,
      id: meta.questionId || meta.questionKey || meta.relativePath,
      questionId: meta.questionId || '',
      questionKey: meta.questionKey || '',
      title: meta.title,
      section: meta.section,
      part: meta.part,
      frequency: meta.frequency,
      relativePath: meta.relativePath
    }, meta);
  }

  function reconcileStoreWithLibrary(store, libraryData, options = {}) {
    const sanitized = sanitizeStore(store);
    const index = buildLibraryIndex(libraryData);
    const nextTests = {};
    const pruneMissing = !!options.pruneMissing;

    Object.values(sanitized.tests).forEach((entry) => {
      const match = findLibraryMatch(entry, index);
      if (!match && pruneMissing) return;

      const meta = match || {
        id: entry.id,
        questionId: entry.questionId,
        questionKey: entry.questionKey,
        title: entry.title,
        section: entry.section,
        part: entry.part,
        frequency: entry.frequency,
        relativePath: entry.relativePath
      };

      const updatedAttempts = (entry.attempts || []).map((attempt) => applyMetaToAttempt(attempt, meta));
      const updatedLatest = entry.latestAttempt ? applyMetaToAttempt(entry.latestAttempt, meta) : updatedAttempts[updatedAttempts.length - 1] || null;
      const mergedEntry = mergeEntries(
        nextTests[meta.questionId || meta.questionKey || meta.relativePath] || null,
        {
          ...entry,
          id: meta.questionId || meta.questionKey || meta.relativePath,
          questionId: meta.questionId || '',
          questionKey: meta.questionKey || '',
          title: meta.title,
          section: meta.section,
          part: meta.part,
          frequency: meta.frequency,
          relativePath: meta.relativePath,
          attempts: updatedAttempts,
          latestAttempt: updatedLatest
        }
      );

      nextTests[getEntryLookupKey(mergedEntry)] = {
        ...mergedEntry,
        id: getEntryLookupKey(mergedEntry)
      };
    });

    return sanitizeStore({
      version: 2,
      tests: nextTests,
      ignoredVocabKeys: sanitized.ignoredVocabKeys
    });
  }

  function mergeStores(baseStore, incomingStore) {
    const base = sanitizeStore(baseStore);
    const incoming = sanitizeStore(incomingStore);
    const tests = { ...base.tests };

    Object.entries(incoming.tests).forEach(([key, entry]) => {
      tests[key] = tests[key]
        ? mergeEntries(tests[key], entry)
        : mergeEntries(null, entry);
    });

    return sanitizeStore({
      version: 2,
      tests,
      ignoredVocabKeys: [
        ...(Array.isArray(base.ignoredVocabKeys) ? base.ignoredVocabKeys : []),
        ...(Array.isArray(incoming.ignoredVocabKeys) ? incoming.ignoredVocabKeys : [])
      ]
    });
  }

  function syncStoreWithLibrary(libraryData) {
    const current = getStore();
    const next = reconcileStoreWithLibrary(current, libraryData);
    const currentSerialized = current === cachedStore && cachedStoreRaw != null
      ? cachedStoreRaw
      : JSON.stringify(current);
    const nextSerialized = JSON.stringify(next);
    if (currentSerialized !== nextSerialized) {
      saveStore(next);
      return next;
    }
    return current;
  }

  function recordAttempt(attempt) {
    const store = getStore();
    const normalizedAttempt = sanitizeAttempt(attempt);
    const preferredKey = normalizedAttempt.questionId || normalizedAttempt.questionKey || normalizedAttempt.relativePath;
    if (!preferredKey) return null;
    const match = findExistingEntryForAttempt(store, normalizedAttempt);
    const existing = match.entry || null;
    if (shouldRejectBlankOverwrite(existing, normalizedAttempt)) {
      return existing;
    }
    const base = ensureEntryShape(existing || normalizedAttempt);
    const baseAttempts = base.attempts.length
      ? base.attempts
      : (existing?.latestAttempt ? [existing.latestAttempt] : []);
    const attempts = appendAttemptHistory(baseAttempts, normalizedAttempt);
    const latestAttempt = attempts[attempts.length - 1] || normalizedAttempt;
    const lookupKey = preferredKey || match.key;
    if (match.key && match.key !== lookupKey) {
      delete store.tests[match.key];
    }
    store.tests[lookupKey] = {
      ...base,
      id: lookupKey,
      questionId: normalizedAttempt.questionId || base.questionId,
      questionKey: normalizedAttempt.questionKey || base.questionKey,
      title: normalizedAttempt.title || base.title,
      section: normalizedAttempt.section || base.section,
      part: normalizedAttempt.part || base.part,
      frequency: normalizedAttempt.frequency || base.frequency,
      relativePath: normalizedAttempt.relativePath || base.relativePath,
      attempts,
      latestAttempt
    };
    saveStore(store);
    return store.tests[lookupKey];
  }

  function recordPageAttempt() {
    const context = getPageContext();
    if (!context) return null;

    const details = parseResultsFromDocument(document);
    if (!details.length) return null;

    const attempt = buildAttempt(context, details);
    return recordAttempt(attempt);
  }

  function getCurrentSignature() {
    const details = parseResultsFromDocument(document);
    if (!details.length) return '';
    return JSON.stringify(details);
  }

  function setupAutoTracking() {
    let lastSignature = '';
    let pendingRecordTimer = null;

    const tryRecord = () => {
      const signature = getCurrentSignature();
      if (!signature || signature === lastSignature) return;
      lastSignature = signature;
      recordPageAttempt();
    };

    const scheduleTryRecord = () => {
      if (pendingRecordTimer) return;
      pendingRecordTimer = window.setTimeout(() => {
        pendingRecordTimer = null;
        tryRecord();
      }, 120);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryRecord, { once: true });
    } else {
      tryRecord();
    }

    const observer = new MutationObserver(() => {
      scheduleTryRecord();
    });

    const observeWhenReady = () => {
      if (!document.body) return;
      observer.observe(document.body, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', observeWhenReady, { once: true });
    } else {
      observeWhenReady();
    }
  }

  function findEntryByContext(store, normalizedPath, context) {
    const questionId = context?.questionId || '';
    const questionKey = context?.questionKey || '';
    const lookups = getStoreLookups(store);

    if (questionId && lookups.entryByQuestionId.has(questionId)) {
      return lookups.entryByQuestionId.get(questionId);
    }

    if (questionKey && lookups.entryByQuestionKey.has(questionKey)) {
      return lookups.entryByQuestionKey.get(questionKey);
    }

    const matchedEntry = lookups.entryByPath.get(normalizedPath) || null;
    if (matchedEntry) return matchedEntry;

    if (!context) return null;

    const fallbackKey = buildQuestionKey(context.section, context.part, context.title);
    if (fallbackKey && lookups.entryByQuestionKey.has(fallbackKey)) {
      return lookups.entryByQuestionKey.get(fallbackKey);
    }

    const looseKey = buildLooseQuestionKey(context.section, context.title);
    const looseMatches = looseKey ? (lookups.entryByLooseKey.get(looseKey) || []) : [];
    const samePart = looseMatches.find((entry) => !context.part || entry?.part === context.part);
    return samePart || (looseMatches.length === 1 ? looseMatches[0] : null);
  }

  function getLatestRecordByPath(relativePath) {
    const store = getStore();
    const normalizedPath = normalizePath(relativePath);
    const context = getContextFromPath(normalizedPath);
    return findEntryByContext(store, normalizedPath, context)?.latestAttempt || null;
  }

  function getEntryByPath(relativePath) {
    const store = getStore();
    const normalizedPath = normalizePath(relativePath);
    const context = getContextFromPath(normalizedPath);
    return findEntryByContext(store, normalizedPath, context);
  }

  function getAttemptHistoryByPath(relativePath) {
    const entry = getEntryByPath(relativePath);
    return Array.isArray(entry?.attempts) ? entry.attempts : [];
  }

  function getAllLatestRecords() {
    return getStoreLookups(getStore()).latestAttempts.slice();
  }

  function looksLikeFillBlank(detail) {
    const answer = cleanAnswer(detail?.correctAnswer || '');
    if (!answer) return false;

    if (/^[A-J](\b|[.)\s])/.test(answer)) return false;
    if (/^[A-J](\s*,\s*[A-J])+$/i.test(answer)) return false;
    if (/\d/.test(answer)) return false;
    if (answer.length > 40) return false;

    const words = answer.split(/\s+/).filter(Boolean);
    if (words.length > 5) return false;

    return true;
  }

  function isTextQuestionDetail(attempt, detail) {
    return true;
  }

  function normalizeVocabKey(answer) {
    return String(answer || '').trim().toLowerCase();
  }

  function getWrongFillStats() {
    const store = getStore();
    const stats = new Map();
    const seen = new Set();
    const ignored = new Set(
      (Array.isArray(store?.ignoredVocabKeys) ? store.ignoredVocabKeys : [])
        .map((item) => normalizeVocabKey(item))
        .filter(Boolean)
    );

    Object.values(store.tests).forEach((entry) => {
      const attempts = entry?.attempts || [];
      attempts.forEach((attempt) => {
        const details = attempt?.details || [];
        details.forEach((detail) => {
          if (detail?.isCorrect || !looksLikeFillBlank(detail) || !isTextQuestionDetail(attempt, detail)) return;
          const key = normalizeVocabKey(detail.correctAnswer);
          if (!key || ignored.has(key)) return;

          const uniqueKey = [
            attempt.questionKey || attempt.relativePath,
            attempt.timestamp,
            detail.question,
            key
          ].join('::');
          if (seen.has(uniqueKey)) return;
          seen.add(uniqueKey);

          const existing = stats.get(key) || {
            key,
            answer: String(detail.correctAnswer || '').trim(),
            count: 0,
            items: []
          };

          existing.count += 1;
          const sourceKey = [
            normalizePath(attempt.relativePath || ''),
            String(detail.question || '').trim(),
            key
          ].join('::');
          const existingItem = existing.items.find((item) => item.sourceKey === sourceKey);
          if (existingItem) {
            existingItem.count += 1;
            const currentTime = Date.parse(existingItem.timestamp || '') || 0;
            const nextTime = Date.parse(attempt.timestamp || '') || 0;
            if (nextTime >= currentTime) {
              existingItem.userAnswer = detail.userAnswer;
              existingItem.formattedTime = attempt.formattedTime;
              existingItem.timestamp = attempt.timestamp;
            }
          } else {
            existing.items.push({
              sourceKey,
              title: attempt.title,
              section: attempt.section,
              part: attempt.part,
              frequency: attempt.frequency,
              question: detail.question,
              userAnswer: detail.userAnswer,
              correctAnswer: detail.correctAnswer,
              formattedTime: attempt.formattedTime,
              timestamp: attempt.timestamp,
              relativePath: attempt.relativePath,
              count: 1
            });
          }

          stats.set(key, existing);
        });
      });
    });

    return [...stats.values()]
      .map((stat) => {
        stat.items.sort((a, b) => (Date.parse(a.timestamp || '') || 0) - (Date.parse(b.timestamp || '') || 0));
        return stat;
      })
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.answer.localeCompare(b.answer);
      });
  }

	  function removeTestRecord(relativePath) {
    const normalizedPath = normalizePath(relativePath);
    if (!normalizedPath) return false;

    const store = getStore();
    const context = getContextFromPath(normalizedPath);
    const directKey = context?.questionKey || '';

    if (directKey && store.tests[directKey]) {
      delete store.tests[directKey];
	    saveStore(store);
	    return true;
	  }

	    const matchedEntry = getStoreLookups(store).entryByPath.get(normalizedPath) || null;
	    const matchedKey = matchedEntry ? getEntryLookupKey(matchedEntry) : '';
	    if (!matchedKey) return false;

    delete store.tests[matchedKey];
	    saveStore(store);
	    return true;
	  }

	  function removeAttemptRecord(attempt) {
	    const normalizedPath = normalizePath(attempt?.relativePath || '');
	    const questionKey = String(attempt?.questionKey || buildQuestionKey(attempt?.section, attempt?.part, attempt?.title) || '');
	    const timestamp = String(attempt?.timestamp || '');
	    const signature = String(attempt?.signature || '');
	    if (!normalizedPath && !questionKey) return false;

	    const store = sanitizeStore(getStore());
	    const lookups = getStoreLookups(store);
	    const entry = (questionKey && lookups.entryByQuestionKey.get(questionKey))
	      || (normalizedPath && lookups.entryByPath.get(normalizedPath))
	      || null;
	    if (!entry) return false;

	    const key = getEntryLookupKey(entry);
	    const attempts = (entry.attempts || []).filter((item) => {
	      const sameTimestamp = timestamp && String(item.timestamp || '') === timestamp;
	      const sameSignature = signature && String(item.signature || '') === signature;
	      if (sameTimestamp && sameSignature) return false;
	      if (sameTimestamp && !signature) return false;
	      return true;
	    });

	    if (attempts.length === (entry.attempts || []).length) return false;
	    if (!attempts.length) {
	      delete store.tests[key];
	    } else {
	      const latestAttempt = sanitizeAttempt(attempts[attempts.length - 1], entry);
	      store.tests[key] = {
	        ...entry,
	        attempts,
	        latestAttempt
	      };
	    }
	    saveStore(store);
	    return true;
	  }

  function ignoreWrongFillAnswer(answer) {
    const key = normalizeVocabKey(answer);
    if (!key) return false;

    const store = sanitizeStore(getStore());
    if (store.ignoredVocabKeys.includes(key)) return false;

    store.ignoredVocabKeys.push(key);
    saveStore(store);
    return true;
  }

	  function clearAllRecords() {
	    removeStorage(STORAGE_KEY);
	    StorageBackup.remove(STORAGE_KEY);
	    removeAnswerRecordBackup(STORAGE_KEY);
	    clearStoreCache();
	  }

  const PLAYER_STATE_KEY = 'ielts_player_state_v1';
  let cachedPlayerStateStore = {};
  let cachedPlayerStateRaw = null;

  function invalidatePlayerStateCache() {
    cachedPlayerStateRaw = null;
    cachedPlayerStateStore = {};
  }

  function getPlayerStateStore() {
    try {
      const raw = readStorage(PLAYER_STATE_KEY);
      if (raw === cachedPlayerStateRaw) return cachedPlayerStateStore;
      if (!raw && cachedPlayerStateRaw === null && Object.keys(cachedPlayerStateStore || {}).length) {
        return cachedPlayerStateStore;
      }
      const parsed = raw ? JSON.parse(raw) : null;
      cachedPlayerStateRaw = raw;
      cachedPlayerStateStore = parsed && typeof parsed === 'object'
        ? sanitizePlayerStateStore(parsed)
        : {};
      return cachedPlayerStateStore;
    } catch (error) {
      console.error('Failed to load player state:', error);
      invalidatePlayerStateCache();
      return {};
    }
  }

  function setPlayerStateCache(serialized, store) {
    cachedPlayerStateRaw = serialized;
    cachedPlayerStateStore = store || {};
    return cachedPlayerStateStore;
  }

	  function clearPlayerStateStorage() {
	    removeStorage(PLAYER_STATE_KEY);
	    StorageBackup.remove(PLAYER_STATE_KEY);
	    removeAnswerRecordBackup(PLAYER_STATE_KEY);
	    invalidatePlayerStateCache();
	  }

  function normalizePlayerStatePath(path) {
    const normalized = normalizePath(path);
    return getContextFromPath(normalized)?.relativePath || normalized;
  }

  function normalizePlayerStateEntry(entry) {
    if (!entry || typeof entry !== 'object') {
      return { draft: null, completed: null };
    }

    if ('draft' in entry || 'completed' in entry) {
      const draft = entry.draft && typeof entry.draft === 'object'
        ? { ...entry.draft, finishedLocked: false }
        : null;
      const completed = entry.completed && typeof entry.completed === 'object'
        ? { ...entry.completed, finishedLocked: true }
        : null;
      return { draft, completed };
    }

    const snapshot = { ...entry };
    return snapshot.finishedLocked
      ? { draft: null, completed: { ...snapshot, finishedLocked: true } }
      : { draft: { ...snapshot, finishedLocked: false }, completed: null };
  }

  function compactPlayerStateEntry(entry) {
    const draft = entry?.draft ? { ...entry.draft, finishedLocked: false } : null;
    const completed = entry?.completed ? { ...entry.completed, finishedLocked: true } : null;
    if (!draft && !completed) return null;
    return { draft, completed };
  }

  function sanitizePlayerStateStore(store) {
    if (!store || typeof store !== 'object') return {};
    const sanitized = {};
    Object.entries(store).forEach(([rawPath, entry]) => {
      const normalizedPath = normalizePlayerStatePath(rawPath);
      if (!normalizedPath) return;
      const compact = compactPlayerStateEntry(normalizePlayerStateEntry(entry));
      if (compact) sanitized[normalizedPath] = compact;
    });
    return sanitized;
  }

  function savePlayerStateStore(store) {
    const sanitized = sanitizePlayerStateStore(store);
    if (!Object.keys(sanitized).length) {
      clearPlayerStateStorage();
      return {};
    }

	    const serialized = JSON.stringify(sanitized);
	    if (serialized === cachedPlayerStateRaw) {
	      return setPlayerStateCache(serialized, sanitized);
	    }
	    const localSaved = writeStorage(PLAYER_STATE_KEY, serialized);
	    StorageBackup.set(PLAYER_STATE_KEY, serialized);
	    backupAnswerRecord(PLAYER_STATE_KEY, serialized);
	    return setPlayerStateCache(localSaved ? serialized : null, sanitized);
	  }

  function getCompletedPlayerState(relativePath, store = getPlayerStateStore()) {
    const normalized = normalizePlayerStatePath(relativePath);
    if (!normalized) return null;
    return normalizePlayerStateEntry(store[normalized]).completed;
  }

  function getBackupWeight(key, parsed) {
    if (!parsed || typeof parsed !== 'object') return 0;
    if (key === STORAGE_KEY) {
      const tests = parsed.tests && typeof parsed.tests === 'object' ? parsed.tests : {};
      return Object.values(tests).reduce((sum, entry) => {
        const attempts = Array.isArray(entry?.attempts) ? entry.attempts.length : 0;
        return sum + attempts + (entry?.latestAttempt ? 1 : 0);
      }, 0);
    }
    if (key === PLAYER_STATE_KEY) {
      return Object.values(parsed).reduce((sum, entry) => {
        const normalized = normalizePlayerStateEntry(entry);
        return sum + (normalized.draft ? 1 : 0) + (normalized.completed ? 1 : 0);
      }, 0);
    }
    return Object.keys(parsed).length;
  }

  async function seedOrRestoreBackup(key) {
    const raw = readStorage(key);
    let rawParsed = null;
    let rawValid = false;
	    if (raw) {
	      try {
	        rawParsed = JSON.parse(raw);
          rawValid = true;
	      } catch (error) {
	        console.error('Local storage data is invalid, trying persistent backup:', error);
	      }
    }

	    const backup = readAnswerRecordBackup(key) || await StorageBackup.get(key);
    if (rawValid && !backup) {
      StorageBackup.set(key, raw);
      backupAnswerRecord(key, raw);
      return false;
    }
	    if (!backup) return false;

    const backupParsed = JSON.parse(backup);
    if (rawValid) {
      const rawWeight = getBackupWeight(key, rawParsed);
      const backupWeight = getBackupWeight(key, backupParsed);
      if (backupWeight <= rawWeight) {
        StorageBackup.set(key, raw);
        backupAnswerRecord(key, raw);
        return false;
      }
    }

    writeStorage(key, backup);
    StorageBackup.set(key, backup);
    backupAnswerRecord(key, backup);
    return true;
  }

  async function restorePersistentBackups() {
    let restored = false;

    try {
      await StorageBackup.requestPersistence?.();
      const restoredTracker = await seedOrRestoreBackup(STORAGE_KEY);
      const restoredPlayerState = await seedOrRestoreBackup(PLAYER_STATE_KEY);
      restored = restoredTracker || restoredPlayerState;
    } catch (error) {
      console.error('Failed to restore persistent backups:', error);
    }

    if (restored) {
      clearStoreCache();
      invalidatePlayerStateCache();
    }
    return restored;
  }

  function clearAllPlayerState() {
    clearPlayerStateStorage();
  }

  function getPendingPlayerState(relativePath, store = getPlayerStateStore()) {
    const normalized = normalizePlayerStatePath(relativePath);
    if (!normalized) return null;
    return normalizePlayerStateEntry(store[normalized]).draft;
  }

  function setSavedPlayerState(relativePath, snapshot, store = getPlayerStateStore()) {
    const key = normalizePlayerStatePath(relativePath);
    if (!key) return savePlayerStateStore(store);

    const entry = normalizePlayerStateEntry(store[key]);
    if (snapshot) {
      if (snapshot.finishedLocked) {
        entry.completed = { ...snapshot, finishedLocked: true };
        entry.draft = null;
      } else {
        entry.draft = { ...snapshot, finishedLocked: false };
        if (snapshot.retryPending) {
          entry.completed = null;
        }
      }
      store[key] = compactPlayerStateEntry(entry);
    } else {
      delete store[key];
    }

    return savePlayerStateStore(store);
  }

  function clearSavedDraftState(relativePath, store = getPlayerStateStore()) {
    const key = normalizePlayerStatePath(relativePath);
    if (!key) return savePlayerStateStore(store);

    const entry = normalizePlayerStateEntry(store[key]);
    entry.draft = null;
    const compact = compactPlayerStateEntry(entry);
    if (compact) {
      store[key] = compact;
    } else {
      delete store[key];
    }
    return savePlayerStateStore(store);
  }

  function clearQuestionPlayerState(relativePath, store = getPlayerStateStore()) {
    const key = normalizePlayerStatePath(relativePath);
    if (!key || !store[key]) return false;
    delete store[key];
    savePlayerStateStore(store);
    return true;
  }

  function getPlayerSnapshotTimestamp(snapshot) {
    const value = snapshot?.savedAt;
    if (!value) return 0;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function mergePlayerSnapshot(currentSnapshot, importedSnapshot, finishedLocked) {
    const left = currentSnapshot && typeof currentSnapshot === 'object'
      ? { ...currentSnapshot, finishedLocked }
      : null;
    const right = importedSnapshot && typeof importedSnapshot === 'object'
      ? { ...importedSnapshot, finishedLocked }
      : null;
    if (!left) return right;
    if (!right) return left;
    return getPlayerSnapshotTimestamp(right) >= getPlayerSnapshotTimestamp(left) ? right : left;
  }

  function mergePlayerStateStores(currentStore, importedStore) {
    const current = sanitizePlayerStateStore(currentStore);
    const incoming = sanitizePlayerStateStore(importedStore);
    const merged = {};
    const allPaths = new Set([...Object.keys(current), ...Object.keys(incoming)]);

    allPaths.forEach((path) => {
      const currentEntry = normalizePlayerStateEntry(current[path]);
      const incomingEntry = normalizePlayerStateEntry(incoming[path]);
      const draft = mergePlayerSnapshot(currentEntry.draft, incomingEntry.draft, false);
      const completed = mergePlayerSnapshot(currentEntry.completed, incomingEntry.completed, true);
      const compact = compactPlayerStateEntry({ draft, completed });
      if (compact) merged[path] = compact;
    });

    return sanitizePlayerStateStore(merged);
  }

  function reconcilePlayerStateWithLibrary(store, libraryData) {
    const sanitized = sanitizePlayerStateStore(store);
    const index = buildLibraryIndex(libraryData);
    const reconciled = {};
    Object.entries(sanitized).forEach(([path, snapshot]) => {
      let nextPath = normalizePlayerStatePath(path);
      const context = getContextFromPath(path);
      const directMatch = context?.questionId && index.byQuestionId?.has(context.questionId)
        ? index.byQuestionId.get(context.questionId)
        : null;
      if (directMatch?.relativePath) {
        nextPath = normalizePlayerStatePath(directMatch.relativePath);
      } else if (index.byPath.has(path)) {
        nextPath = path;
      } else {
        const match = context ? findLibraryMatch({ ...context, relativePath: path }, index) : null;
        if (match?.relativePath) nextPath = normalizePlayerStatePath(match.relativePath);
      }
      if (!nextPath) return;
      if (!reconciled[nextPath]) {
        reconciled[nextPath] = snapshot;
        return;
      }
      const current = normalizePlayerStateEntry(reconciled[nextPath]);
      const incoming = normalizePlayerStateEntry(snapshot);
      const draft = mergePlayerSnapshot(current.draft, incoming.draft, false);
      const completed = mergePlayerSnapshot(current.completed, incoming.completed, true);
      const compact = compactPlayerStateEntry({ draft, completed });
      if (compact) reconciled[nextPath] = compact;
    });
    return reconciled;
  }

  window.addEventListener('storage', (event) => {
    if (event.key == null || event.key === STORAGE_KEY) {
      clearStoreCache();
    }
    if (event.key == null || event.key === PLAYER_STATE_KEY) {
      invalidatePlayerStateCache();
    }
  });

  window.PlayerState = {
    STORAGE_KEY: PLAYER_STATE_KEY,
    invalidateCache: invalidatePlayerStateCache,
    getStore: getPlayerStateStore,
    saveStore: savePlayerStateStore,
    sanitizeStore: sanitizePlayerStateStore,
    normalizePath: normalizePlayerStatePath,
    normalizeEntry: normalizePlayerStateEntry,
    compactEntry: compactPlayerStateEntry,
    getPending: getPendingPlayerState,
    getCompleted: getCompletedPlayerState,
    setSaved: setSavedPlayerState,
    clearDraft: clearSavedDraftState,
    clearQuestion: clearQuestionPlayerState,
    clearAll: clearAllPlayerState,
    mergeStores: mergePlayerStateStores,
    reconcileWithLibrary: reconcilePlayerStateWithLibrary
  };

  window.IeltsStorageBackup = StorageBackup;

  window.PracticeTracker = {
    STORAGE_KEY,
    getStore,
    saveStore,
    sanitizeStore,
    normalizePath,
    getQuestionParts,
    normalizeQuestionTitle,
    buildQuestionKey,
    buildQuestionId,
    getContextFromPath,
    getPageContext,
    parseResultsFromDocument,
    recordAttempt,
    recordPageAttempt,
    getLatestRecordByPath,
    getAttemptHistoryByPath,
    getAllLatestRecords,
    getWrongFillStats,
    mergeStores,
    reconcileStoreWithLibrary,
    restorePersistentBackups,
    syncStoreWithLibrary,
	    removeTestRecord,
	    removeAttemptRecord,
	    ignoreWrongFillAnswer,
    clearAllRecords
  };

  setupAutoTracking();
}());
