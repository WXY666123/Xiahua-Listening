(function () {
  const STORAGE_KEY = "ielts_listening_suite_records_v1";
  const ACTIVE_KEY = "ielts_listening_active_suite_v1";
  const MAX_SUITE_RECORDS = 50;
  const parts = ["P1", "P2", "P3", "P4"];

  function readStorage(key) {
    try {
      return window.localStorage?.getItem(key) || null;
    } catch (error) {
      console.error("Failed to read suite storage:", error);
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage?.setItem(key, value);
      window.NativeDiskStorage?.backupAnswerRecord?.(key, value);
      return true;
    } catch (error) {
      console.error("Failed to write suite storage:", error);
      return false;
    }
  }

  function readBackupStorage(key) {
    try {
      return window.NativeDiskStorage?.readAnswerRecordBackup?.(key) || null;
    } catch (error) {
      console.error("Failed to read suite backup storage:", error);
      return null;
    }
  }

  function normalizePath(path) {
    return window.PracticeTracker?.normalizePath?.(path)
      || window.LibraryCache?.normalizeRelativePath?.(path)
      || String(path || "").trim();
  }

  function limitSuiteRecords(suites) {
    const source = suites && typeof suites === "object" ? suites : {};
    const entries = Object.entries(source)
      .filter(([, suite]) => suite && typeof suite === "object")
      .sort(([, left], [, right]) => getSuiteTimestamp(right) - getSuiteTimestamp(left));
    const activeId = readStorage(ACTIVE_KEY) || "";
    let kept = entries.slice(0, MAX_SUITE_RECORDS);
    if (activeId && source[activeId] && !kept.some(([id]) => id === activeId)) {
      kept = [[activeId, source[activeId]], ...kept].slice(0, MAX_SUITE_RECORDS);
    }
    return Object.fromEntries(kept);
  }

  function normalizeStore(store) {
    return {
      version: 1,
      suites: limitSuiteRecords(store?.suites)
    };
  }

  function getStore() {
    try {
      const localRaw = readStorage(STORAGE_KEY);
      const raw = localRaw || readBackupStorage(STORAGE_KEY) || "{}";
      if (localRaw) window.NativeDiskStorage?.backupAnswerRecord?.(STORAGE_KEY, localRaw);
      if (!localRaw && raw !== "{}") writeStorage(STORAGE_KEY, raw);
      const parsed = JSON.parse(raw);
      return normalizeStore(parsed);
    } catch (error) {
      return { version: 1, suites: {} };
    }
  }

  function saveStore(store) {
    const next = normalizeStore(store);
    const serialized = JSON.stringify(next);
    if (serialized === readStorage(STORAGE_KEY)) return next;
    writeStorage(STORAGE_KEY, serialized);
    window.NativeDiskStorage?.flush?.();
    return next;
  }

  function getItemQuestionId(item) {
    return String(item?.questionId || item?.qid || item?.id || '');
  }

  function getItemQuestionKey(item) {
    return String(item?.questionKey || item?.key || '');
  }

  function normalizeIdentityToken(value) {
    return String(value || '')
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getItemIdentityKeys(item) {
    const keys = new Set();
    const questionId = getItemQuestionId(item);
    if (questionId) keys.add('qid:' + questionId);

    const questionKey = getItemQuestionKey(item);
    if (questionKey) keys.add('qkey:' + questionKey);

    const normalized = normalizePath(item?.h || item?.path || item?.relativePath || '');
    if (normalized) keys.add('path:' + normalized);

    const title = normalizeIdentityToken(item?.t || item?.title || '');
    const cleanTitle = normalizeIdentityToken(title.replace(/^\d+\s*\.\s*/, '').replace(/^p\d+\s+/, ''));
    const numberMatch = title.match(/^\s*(\d+)\s*\./);
    const section = normalizeIdentityToken(item?.s || item?.section || '');
    const part = normalizeIdentityToken(item?.p || item?.part || '');
    if (section && part && cleanTitle) keys.add('title-part:' + section + '|' + part + '|' + cleanTitle);
    if (section && numberMatch?.[1] && cleanTitle) keys.add('title-number:' + section + '|' + numberMatch[1] + '|' + cleanTitle);
    if (section && cleanTitle) keys.add('title:' + section + '|' + cleanTitle);
    if (cleanTitle) keys.add('title-any:' + cleanTitle);
    return keys;
  }

  function hasUsedIdentity(item, usedIdentities) {
    if (!(usedIdentities instanceof Set)) return false;
    return [...getItemIdentityKeys(item)].some((key) => usedIdentities.has(key));
  }

  function addUsedIdentity(item, usedIdentities) {
    if (!(usedIdentities instanceof Set)) return;
    getItemIdentityKeys(item).forEach((key) => usedIdentities.add(key));
  }

  function hasDuplicateSuiteItems(items) {
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const keys = getItemIdentityKeys(item);
      if ([...keys].some((key) => seen.has(key))) return true;
      keys.forEach((key) => seen.add(key));
    }
    return false;
  }

  function getSuiteTimeValue(suite) {
    const parsed = Date.parse(suite?.updatedAt || suite?.createdAt || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getRecentSuiteIdentitiesByPart(store) {
    const byPart = Object.fromEntries(parts.map((part) => [part, new Set()]));
    Object.values(store?.suites || {})
      .filter((suite) => suite && typeof suite === 'object')
      .sort((left, right) => getSuiteTimeValue(right) - getSuiteTimeValue(left))
      .forEach((suite) => {
        (suite.items || []).forEach((item) => {
          const part = String(item?.part || item?.p || '').toUpperCase();
          if (!byPart[part]) return;
          getItemIdentityKeys(item).forEach((key) => byPart[part].add(key));
        });
      });
    return byPart;
  }

  function chooseCandidatePool(candidates, preferredFrequency = '') {
    const fresh = candidates.filter((candidate) => !candidate.done && !candidate.inWrongbook);
    const freshNotRecent = fresh.filter((candidate) => !candidate.recentSuitePick);
    const preferredFreshNotRecent = preferredFrequency
      ? freshNotRecent.filter((candidate) => candidate.frequency === preferredFrequency)
      : [];
    if (preferredFreshNotRecent.length) return { pool: preferredFreshNotRecent, hasFresh: true };
    if (freshNotRecent.length) {
      const fallbackFresh = preferredFrequency
        ? freshNotRecent.filter((candidate) => candidate.frequency !== preferredFrequency)
        : freshNotRecent;
      if (fallbackFresh.length) return { pool: fallbackFresh, hasFresh: true };
    }

    const preferredFresh = preferredFrequency
      ? fresh.filter((candidate) => candidate.frequency === preferredFrequency)
      : [];
    if (preferredFresh.length) return { pool: preferredFresh, hasFresh: true };
    if (fresh.length) {
      const fallbackFresh = preferredFrequency
        ? fresh.filter((candidate) => candidate.frequency !== preferredFrequency)
        : fresh;
      if (fallbackFresh.length) return { pool: fallbackFresh, hasFresh: true };
    }

    const notRecent = candidates.filter((candidate) => !candidate.recentSuitePick);
    if (notRecent.length) return { pool: notRecent, hasFresh: false };
    return { pool: candidates, hasFresh: false };
  }

  function getEntryAttempts(entry) {
    const attempts = Array.isArray(entry?.attempts) ? entry.attempts.filter(Boolean) : [];
    if (entry?.latestAttempt && !attempts.some((attempt) => (
      String(attempt?.timestamp || '') === String(entry.latestAttempt?.timestamp || '')
      && String(attempt?.signature || '') === String(entry.latestAttempt?.signature || '')
    ))) {
      attempts.push(entry.latestAttempt);
    }
    return attempts;
  }

  function getAttemptTime(attempt) {
    const parsed = Date.parse(attempt?.timestamp || attempt?.formattedTime || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getLatestAttemptFromEntry(entry) {
    return getEntryAttempts(entry).sort((left, right) => getAttemptTime(right) - getAttemptTime(left))[0] || null;
  }

  function attemptMatchesQuestionId(attempt, questionId) {
    return !!questionId && String(attempt?.questionId || '') === questionId;
  }

  function entryMatchesQuestionId(entry, questionId) {
    if (!questionId) return false;
    if (String(entry?.questionId || entry?.latestAttempt?.questionId || '') === questionId) return true;
    return getEntryAttempts(entry).some((attempt) => attemptMatchesQuestionId(attempt, questionId));
  }

  function entryMatchesPath(entry, normalizedPath) {
    if (!normalizedPath) return false;
    if (normalizePath(entry?.relativePath || entry?.latestAttempt?.relativePath || '') === normalizedPath) return true;
    return getEntryAttempts(entry).some((attempt) => normalizePath(attempt?.relativePath || '') === normalizedPath);
  }

  function getEntryByItem(item, trackerStore) {
    const questionId = getItemQuestionId(item);
    const normalized = normalizePath(item?.h || item?.path || '');
    const tests = Object.values(trackerStore?.tests || {});
    return (questionId ? tests.find((entry) => entryMatchesQuestionId(entry, questionId)) : null)
      || tests.find((entry) => entryMatchesPath(entry, normalized))
      || tests.find((entry) => {
        const itemKeys = getItemIdentityKeys(item);
        const entryKeys = getItemIdentityKeys(entry);
        itemKeys.delete('title-any:' + normalizeIdentityToken(item?.t || item?.title || '').replace(/^\d+\s*\.\s*/, '').replace(/^p\d+\s+/, ''));
        return [...itemKeys].some((key) => entryKeys.has(key));
      })
      || null;
  }

  function getLatestRecordByItem(item, trackerStore) {
    return getLatestAttemptFromEntry(getEntryByItem(item, trackerStore));
  }

  function getLatestRecordByPath(path, trackerStore) {
    const normalized = normalizePath(path);
    const tests = Object.values(trackerStore?.tests || {});
    return getLatestAttemptFromEntry(tests.find((entry) => entryMatchesPath(entry, normalized)));
  }

  function getPlayerEntryCompleted(path, playerStore) {
    const normalized = normalizePath(path);
    const entry = playerStore?.[normalized];
    return !!(entry?.completed || (!entry?.draft && entry?.finishedLocked));
  }

  function getCandidateStats(item, trackerStore) {
    const entry = getEntryByItem(item, trackerStore);
    const attempts = getEntryAttempts(entry);
    const latest = getLatestAttemptFromEntry(entry);
    const wrongAttempts = attempts
      .filter((attempt) => Number(attempt?.wrong || 0) > 0)
      .sort((left, right) => getAttemptTime(right) - getAttemptTime(left));
    const latestWrong = wrongAttempts[0] || null;
    return {
      latest,
      attempts,
      latestWrong,
      inWrongbook: wrongAttempts.length > 0,
      wrong: Number(latestWrong?.wrong || 0)
    };
  }

  function scoreCandidate(item, trackerStore, playerStore) {
    const stats = getCandidateStats(item, trackerStore);
    const done = stats.attempts.length > 0 || getPlayerEntryCompleted(item?.h || item?.path || '', playerStore);
    return {
      item,
      done,
      inWrongbook: stats.inWrongbook,
      wrong: stats.wrong,
      wrongTime: getAttemptTime(stats.latestWrong),
      attempts: stats.attempts.length,
      random: Math.random()
    };
  }

  function pickForPart(libraryData, part, trackerStore, playerStore, preferredFrequency = '', usedIdentities = null, recentSuiteIdentities = null) {
    const preferred = String(preferredFrequency || '').trim();
    const recentSet = recentSuiteIdentities instanceof Set ? recentSuiteIdentities : new Set();
    const candidates = (libraryData || [])
      .filter((item) => String(item?.p || "").toUpperCase() === part)
      .filter((item) => !hasUsedIdentity(item, usedIdentities))
      .map((item) => ({
        ...scoreCandidate(item, trackerStore, playerStore),
        frequency: String(item?.f || '').trim(),
        recentSuitePick: hasUsedIdentity(item, recentSet)
      }));
    if (!candidates.length) return null;

    const choice = chooseCandidatePool(candidates, preferred);
    const pool = choice.pool;
    pool.sort((a, b) => {
      if (!choice.hasFresh && b.wrong !== a.wrong) return b.wrong - a.wrong;
      if (!choice.hasFresh && b.wrongTime !== a.wrongTime) return b.wrongTime - a.wrongTime;
      if (!choice.hasFresh && a.attempts !== b.attempts) return a.attempts - b.attempts;
      return a.random - b.random;
    });
    return pool[0].item;
  }

  function createSuite(libraryData, trackerStore, playerStore, options = {}) {
    const preferredFrequency = String(options.preferredFrequency || '').trim();
    const store = getStore();
    const recentIdentitiesByPart = getRecentSuiteIdentitiesByPart(store);
    const usedIdentities = new Set(Array.isArray(options.excludedIdentityKeys) ? options.excludedIdentityKeys : []);
    const items = parts.map((part) => {
      const item = pickForPart(
        libraryData,
        part,
        trackerStore,
        playerStore,
        preferredFrequency,
        usedIdentities,
        recentIdentitiesByPart[part]
      );
      addUsedIdentity(item, usedIdentities);
      return item;
    });
    if (items.some((item) => !item) || hasDuplicateSuiteItems(items)) return null;
    const id = `suite-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const suite = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: items.map((item, index) => ({
        index,
        part: parts[index],
        section: item.s,
        frequency: item.f,
        title: item.t,
        path: item.h,
        questionId: getItemQuestionId(item)
      })),
      results: {},
      currentIndex: 0,
      durationSeconds: 0,
      startedAt: "",
      deadlineAt: "",
      completedAt: "",
      totalCorrect: 0,
      totalQuestions: 0,
      estimatedBand: null
    };
    if (options.persist !== false) persistSuite(suite);
    return suite;
  }

  function persistSuite(suite) {
    if (!suite?.id || !Array.isArray(suite.items) || suite.items.some((item) => !item?.path)) return null;
    const store = getStore();
    store.suites[suite.id] = suite;
    saveStore(store);
    writeStorage(ACTIVE_KEY, suite.id);
    return suite;
  }

  function reconcileStoreWithLibrary(libraryData) {
    const library = Array.isArray(libraryData) ? libraryData : [];
    if (!library.length) return getStore();
    const store = getStore();
    let changed = false;
    const findMatch = (item) => {
      const path = normalizePath(item?.path || item?.h || item?.relativePath || '');
      const questionId = getItemQuestionId(item);
      const keys = [...getItemIdentityKeys(item)].filter((key) => !key.startsWith('title-any:'));
      return library.find((candidate) => normalizePath(candidate?.h || candidate?.path || '') === path)
        || (questionId ? library.find((candidate) => getItemQuestionId(candidate) === questionId) : null)
        || library.find((candidate) => {
          const candidateKeys = getItemIdentityKeys(candidate);
          return keys.some((key) => candidateKeys.has(key));
        })
        || null;
    };
    Object.values(store.suites || {}).forEach((suite) => {
      (suite.items || []).forEach((item, index) => {
        const match = findMatch(item);
        if (!match) return;
        const meta = {
          section: match.s || match.section || item.section || '',
          part: match.p || match.part || item.part || '',
          frequency: match.f || match.frequency || item.frequency || '',
          title: match.t || match.title || item.title || '',
          path: match.h || match.path || item.path || '',
          questionId: getItemQuestionId(match) || item.questionId || ''
        };
        Object.entries(meta).forEach(([key, value]) => {
          if (String(item[key] || '') !== String(value || '')) {
            item[key] = value;
            changed = true;
          }
        });
        const result = suite.results?.[String(index)];
        if (result) {
          const resultBefore = JSON.stringify(result);
          result.part = meta.part;
          result.path = meta.path;
          result.questionId = meta.questionId;
          result.title = meta.title;
          if (result.attempt) {
            result.attempt = { ...result.attempt, ...meta, relativePath: meta.path };
          }
          if (JSON.stringify(result) !== resultBefore) changed = true;
        }
      });
    });
    return changed ? saveStore(store) : store;
  }

  function createSuiteFromItems(items) {
    const sourceItems = Array.isArray(items) ? items : [];
    if (sourceItems.length !== parts.length) return null;
    const id = `suite-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const suite = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: sourceItems.map((item, index) => ({
        index,
        part: parts[index],
        section: item.section || item.s || "",
        frequency: item.frequency || item.f || "",
        title: item.title || item.t || "",
        path: item.path || item.h || "",
        questionId: getItemQuestionId(item)
      })),
      results: {},
      currentIndex: 0,
      durationSeconds: 0,
      startedAt: "",
      deadlineAt: "",
      completedAt: "",
      totalCorrect: 0,
      totalQuestions: 0,
      estimatedBand: null
    };
    if (suite.items.some((item) => !item.path)) return null;
    const store = getStore();
    store.suites[id] = suite;
    saveStore(store);
    writeStorage(ACTIVE_KEY, id);
    return suite;
  }

  function getSuite(id) {
    return getStore().suites?.[id] || null;
  }

  function listSuites() {
    return Object.values(getStore().suites || {})
      .sort((a, b) => getSuiteTimestamp(b) - getSuiteTimestamp(a));
  }

  function getSuiteTimestamp(suite) {
    const parsed = Date.parse(suite?.updatedAt || suite?.createdAt || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function deleteSuite(id) {
    const suiteId = String(id || "");
    if (!suiteId) return false;
    const store = getStore();
    if (!store.suites?.[suiteId]) return false;
    delete store.suites[suiteId];
    saveStore(store);
    if (readStorage(ACTIVE_KEY) === suiteId) {
      writeStorage(ACTIVE_KEY, "");
    }
    return true;
  }

  function clearAll() {
    try {
      window.localStorage?.removeItem?.(STORAGE_KEY);
      window.localStorage?.removeItem?.(ACTIVE_KEY);
      window.NativeDiskStorage?.removeAnswerRecordBackup?.(STORAGE_KEY);
      window.NativeDiskStorage?.removeAnswerRecordBackup?.(ACTIVE_KEY);
      window.NativeDiskStorage?.flush?.();
      return true;
    } catch (error) {
      console.error("Failed to clear suite records:", error);
      saveStore({ version: 1, suites: {} });
      writeStorage(ACTIVE_KEY, "");
      return false;
    }
  }

  function estimateBand(correct) {
    const raw = Number(correct || 0);
    if (raw >= 39) return 9;
    if (raw >= 37) return 8.5;
    if (raw >= 35) return 8;
    if (raw >= 33) return 7.5;
    if (raw >= 30) return 7;
    if (raw >= 27) return 6.5;
    if (raw >= 23) return 6;
    if (raw >= 20) return 5.5;
    if (raw >= 16) return 5;
    if (raw >= 13) return 4.5;
    if (raw >= 10) return 4;
    if (raw >= 6) return 3.5;
    if (raw >= 4) return 3;
    if (raw >= 3) return 2.5;
    if (raw >= 2) return 2;
    if (raw >= 1) return 1;
    return 0;
  }

  function updateSuitePart(id, index, attempt) {
    const store = getStore();
    const suite = store.suites?.[id];
    if (!suite || !attempt) return null;
    const storedAttempt = attempt && typeof attempt === "object"
      ? {
        ...attempt,
        details: Array.isArray(attempt.details) ? attempt.details : []
      }
      : null;
    const previousResult = suite.results?.[String(index)] || null;
    const syncSignature = String(storedAttempt?.wrongbookSyncSignature || storedAttempt?.signature || "");
    const previousSyncKept = previousResult?.wrongbookSyncedAt
      && (!previousResult.wrongbookSyncSignature || previousResult.wrongbookSyncSignature === syncSignature);
    suite.results[String(index)] = {
      part: suite.items?.[index]?.part || attempt.part || "",
      path: attempt.relativePath || suite.items?.[index]?.path || "",
      questionId: attempt.questionId || suite.items?.[index]?.questionId || "",
      title: attempt.title || suite.items?.[index]?.title || "",
      correct: Number(attempt.correct || 0),
      total: Number(attempt.total || 0),
      wrong: Number(attempt.wrong || 0),
      percent: Number(attempt.percent || 0),
      timestamp: attempt.timestamp || new Date().toISOString(),
      attempt: storedAttempt,
      wrongbookSyncedAt: previousSyncKept ? previousResult.wrongbookSyncedAt : "",
      wrongbookSyncSignature: previousSyncKept ? String(previousResult.wrongbookSyncSignature || syncSignature) : ""
    };
    const results = Object.values(suite.results);
    suite.totalCorrect = results.reduce((sum, item) => sum + Number(item.correct || 0), 0);
    suite.totalQuestions = results.reduce((sum, item) => sum + Number(item.total || 0), 0);
    suite.estimatedBand = estimateBand(suite.totalCorrect);
    suite.updatedAt = new Date().toISOString();
    suite.currentIndex = Math.min(Number(index || 0) + 1, (suite.items || []).length - 1);
    if (parts.every((_, partIndex) => suite.results[String(partIndex)])) {
      suite.completedAt = suite.completedAt || new Date().toISOString();
    }
    suite.wrongbookSyncedAt = "";
    store.suites[id] = suite;
    saveStore(store);
    return suite;
  }

  function clearSuitePart(id, index) {
    const store = getStore();
    const suite = store.suites?.[id];
    if (!suite) return null;
    delete suite.results[String(index)];
    const results = Object.values(suite.results || {});
    suite.totalCorrect = results.reduce((sum, item) => sum + Number(item.correct || 0), 0);
    suite.totalQuestions = results.reduce((sum, item) => sum + Number(item.total || 0), 0);
    suite.estimatedBand = estimateBand(suite.totalCorrect);
    suite.completedAt = "";
    suite.wrongbookSyncedAt = "";
    suite.currentIndex = Math.max(0, Math.min(Number(index || 0), (suite.items || []).length - 1));
    suite.updatedAt = new Date().toISOString();
    store.suites[id] = suite;
    saveStore(store);
    writeStorage(ACTIVE_KEY, id);
    return suite;
  }

  function markWrongbookSynced(id) {
    const store = getStore();
    const suite = store.suites?.[String(id || "")];
    if (!suite) return null;
    suite.wrongbookSyncedAt = new Date().toISOString();
    store.suites[suite.id] = suite;
    saveStore(store);
    return suite;
  }

  function markPartWrongbookSynced(id, index, signature = "") {
    const store = getStore();
    const suite = store.suites?.[String(id || "")];
    if (!suite) return null;
    const key = String(index);
    const result = suite.results?.[key];
    if (!result) return suite;
    result.wrongbookSyncedAt = new Date().toISOString();
    result.wrongbookSyncSignature = String(signature || result.attempt?.signature || "");
    suite.results[key] = result;
    suite.updatedAt = new Date().toISOString();
    suite.wrongbookSyncedAt = "";
    store.suites[suite.id] = suite;
    saveStore(store);
    return suite;
  }

  function setCurrentIndex(id, index) {
    const store = getStore();
    const suite = store.suites?.[id];
    if (!suite) return null;
    suite.currentIndex = Math.max(0, Math.min(Number(index || 0), (suite.items || []).length - 1));
    suite.updatedAt = new Date().toISOString();
    store.suites[id] = suite;
    saveStore(store);
    writeStorage(ACTIVE_KEY, id);
    return suite;
  }

  function getResumeIndex(suite) {
    if (!suite) return 0;
    const items = suite.items || [];
    const firstUnfinished = items.findIndex((_, index) => !suite.results?.[String(index)]);
    if (firstUnfinished >= 0) return firstUnfinished;
    return Math.max(0, Math.min(Number(suite.currentIndex || 0), items.length - 1));
  }

  function getSuiteUrl(id, index = 0, options = {}) {
    const review = options === true || !!options?.review;
    const suffix = review ? "&review=1" : "";
    return `./JS/player.html?suite=${encodeURIComponent(id)}&idx=${encodeURIComponent(String(index))}${suffix}`;
  }

  window.SuitePractice = {
    STORAGE_KEY,
    ACTIVE_KEY,
    parts,
    getStore,
    saveStore,
    getItemIdentityKeys,
    createSuite,
    persistSuite,
    reconcileStoreWithLibrary,
    createSuiteFromItems,
    getSuite,
    listSuites,
    deleteSuite,
    clearAll,
    updateSuitePart,
    clearSuitePart,
    markWrongbookSynced,
    markPartWrongbookSynced,
    setCurrentIndex,
    getResumeIndex,
    estimateBand,
    getSuiteUrl
  };
}());
