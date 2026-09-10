(function () {
  const LIBRARY_STORAGE_KEY = "ielts_listening_library_v1";
  const LIBRARY_FINGERPRINT_KEY = "ielts_listening_library_fingerprint_v1";
  const RECORD_EXPORT_VERSION = 3;
  const SUITE_DRAFT_STORAGE_PREFIX = "ielts_suite_outer_draft_";
  const SUITE_FREQUENCY_FILTER_KEY = "ielts_suite_frequency_filter_v1";
  const SUITE_LIBRARY_SCOPE_KEY = "ielts_suite_library_scope_v1";
  const RECORD_SUMMARY_STORAGE_KEY = "ielts_record_summary_v1";
  const REVIEW_PREFERENCES_KEY = "ielts_review_preferences_v1";
  const DIRECTORY_HANDLE_DB = "ielts_listening_directory_handle_v1";
  const DIRECTORY_HANDLE_STORE = "handles";
  const DIRECTORY_HANDLE_KEY = "library-root";
  const sections = ["普通", "VIP"];
  const LIBRARY_ROOT_ALIASES = {
    "普通": "普通",
    "VIP": "VIP",
    "IELTS Listening 虾滑": "普通",
    "IELTS Listening 虾滑VIP": "VIP"
  };
  const parts = ["P1", "P2", "P3", "P4"];
  const freqOrder = ["高频", "次高频", "非高频"];
  const freqClass = { "高频": "high", "次高频": "mid", "非高频": "low" };
  const statusOrder = ["completed", "pending", "unstarted"];
  const QUESTION_OPEN_WARMUP_TIMEOUT_MS = 250;
  const WRONGBOOK_RENDER_DEBOUNCE_MS = 180;
  const WRONGBOOK_PAGE_SIZE = 20;
  const SUITE_HISTORY_PAGE_SIZE = 10;
  const legendButtonIds = {
    frequency: {
      "高频": "legend-high-btn",
      "次高频": "legend-mid-btn",
      "非高频": "legend-low-btn"
    },
    status: {
      completed: "legend-completed-btn",
      pending: "legend-pending-btn",
      unstarted: "legend-unstarted-btn"
    }
  };
  const trackers = window.PracticeTracker;
  const playerStates = window.PlayerState;
  const suitePractice = window.SuitePractice;
  const authClient = window.AuthClient;
  if (!trackers || !playerStates) {
    alert("核心脚本加载失败，请确认 JS/practice-tracker.js 已正确加载。");
    return;
  }
  const PLAYER_STATE_KEY = playerStates?.STORAGE_KEY || "ielts_player_state_v1";
  let currentSearch = "";
	  let currentLibraryData = [];
		  let activeSectionFilters = new Set();
		  let activeFrequencyFilters = new Set();
		  let activeStatusFilters = new Set();
		  let activePartFilters = new Set();
	  const typeOrder = ["single", "multi", "match", "map", "text"];
	  const typeLabels = { single: "单选", multi: "多选", match: "匹配", map: "地图", text: "填空" };
		  let activeTypeFilters = new Set();
	  let questionViewMode = "gallery";
  let activeSuiteFrequencyFilter = readLocalStorage(SUITE_FREQUENCY_FILTER_KEY) || "all";
  if (!["all", ...freqOrder].includes(activeSuiteFrequencyFilter)) activeSuiteFrequencyFilter = "all";
  let activeSuiteLibraryScope = readLocalStorage(SUITE_LIBRARY_SCOPE_KEY) || "all";
  if (!["all", "普通", "VIP"].includes(activeSuiteLibraryScope)) activeSuiteLibraryScope = "all";
  let cachedLibraryData = [];
  let cachedLibraryDataRaw = null;
  const questionStorageKeysCache = new Map();
  let searchCollections = {
    normal: [],
    vip: []
  };
  let renderScheduled = false;
  let searchFrameId = null;
  let directoryHandleDbPromise = null;
  let selectedWrongAttemptKey = "";
  let selectedWrongAttemptIndex = 0;
  let selectedSuiteGroupKey = "";
  let selectedSuiteAttemptIndex = 0;
  let suiteHistoryPage = 0;
  let wrongbookSearch = "";
  let activeWrongbookFrequencyFilters = new Set(freqOrder);
  let wrongbookFilters = { scope: "all", type: "all", section: "all", part: "all", freq: "all", query: "" };
  let wrongbookRenderTimer = null;
  let wrongbookVisibleCount = WRONGBOOK_PAGE_SIZE;
  let questionTypeIndexCache = null;
  let backgroundCacheWarmPromise = null;
  let isUpdatingLibrary = false;
  let isImportingRecords = false;

  function isAuthorized() {
    return !!authClient?.isAuthorized?.();
  }

  function requireAuthorization(featureName) {
    if (isAuthorized()) return true;
    notify(`${featureName}需要授权后使用；也可以忽略授权，仅使用普通题。`);
    return false;
  }

  function getVisibleLibraryData(data) {
    return isAuthorized() ? (data || []) : (data || []).filter((item) => item?.s === "普通");
  }

  function readLocalStorage(key) {
    try {
      return window.localStorage?.getItem(key) || null;
    } catch (error) {
      console.error("Failed to read localStorage:", error);
      return null;
    }
  }

  function writeLocalStorage(key, value) {
    try {
      window.localStorage?.setItem(key, value);
      return true;
    } catch (error) {
      console.error("Failed to write localStorage:", error);
      return false;
    }
  }

  function removeLocalStorage(key) {
    try {
      window.localStorage?.removeItem(key);
      return true;
    } catch (error) {
      console.error("Failed to remove localStorage item:", error);
      return false;
    }
  }

  function getReviewPreferences() {
    const defaults = { analysisPlayback: "seek", analysisTarget: "evidence", answerVisibility: "hidden" };
    try {
      const saved = JSON.parse(readLocalStorage(REVIEW_PREFERENCES_KEY) || "{}");
      return {
        analysisPlayback: ["seek", "play"].includes(saved.analysisPlayback) ? saved.analysisPlayback : defaults.analysisPlayback,
        analysisTarget: ["evidence", "analysis"].includes(saved.analysisTarget) ? saved.analysisTarget : defaults.analysisTarget,
        answerVisibility: ["hidden", "shown"].includes(saved.answerVisibility) ? saved.answerVisibility : defaults.answerVisibility
      };
    } catch (error) {
      return defaults;
    }
  }

  function syncSettingsForm() {
    const preferences = getReviewPreferences();
    const values = {
      "analysis-playback": preferences.analysisPlayback,
      "analysis-target": preferences.analysisTarget,
      "answer-visibility": preferences.answerVisibility
    };
    Object.entries(values).forEach(([name, value]) => {
      const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
      if (input) input.checked = true;
    });
  }

  function saveSettingsForm() {
    const value = (name, fallback) => document.querySelector(`input[name="${name}"]:checked`)?.value || fallback;
    writeLocalStorage(REVIEW_PREFERENCES_KEY, JSON.stringify({
      analysisPlayback: value("analysis-playback", "seek"),
      analysisTarget: value("analysis-target", "evidence"),
      answerVisibility: value("answer-visibility", "hidden")
    }));
  }

  function openSettingsModal() {
    syncSettingsForm();
    const modal = byId("settings-modal");
    if (modal) modal.hidden = false;
  }

  function closeSettingsModal() {
    const modal = byId("settings-modal");
    if (modal) modal.hidden = true;
  }

  function getLocalStorageKeys() {
    try {
      const storage = window.localStorage;
      if (!storage) return [];
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key) keys.push(key);
      }
      return keys;
    } catch (error) {
      console.error("Failed to enumerate localStorage keys:", error);
      return [];
    }
  }

  function parseJsonObject(value) {
    if (!value) return null;
    if (typeof value === "object") return value;
    try {
      const parsed = JSON.parse(String(value));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  const getNumber = (title) => {
    const match = String(title).match(/^(\d+)/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };

  const getPartNumber = (part) => {
    const match = String(part).match(/^P(\d+)/i);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };

  const getQuestionNumber = (value) => {
    const match = String(value || "").match(/\d+/);
    return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
  };

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const escapeAttrValue = (value) => String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

  function cleanDisplayTitle(title) {
    const value = String(title || "").normalize("NFC").trim();
    const num = value.match(/^\s*(\d+)\s*\.\s*/u)?.[1];
    const body = value
      .replace(/^\s*\d+\s*\.\s*/u, "")
      .replace(/\bP[1-4]\b\s*/gi, "")
      .replace(/\s*\((?:VIP)\)\s*/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return num ? `${num}. ${body}` : body;
  }

  function getTitleKey(title) {
    return cleanDisplayTitle(title).toLowerCase();
  }

  function getPathTitleKey(sourcePath) {
    return getTitleKey(getQuestionParts(sourcePath)?.title || sourcePath);
  }

  function normalizeQuestionType(type) {
    const value = String(type || "").trim();
    if (value === "mcq") return "single";
    if (value === "matching") return "match";
    return typeOrder.includes(value) ? value : "";
  }

  function formatLocalDateTime(value) {
    return new Date(value).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }

  function invalidateLibraryCache() {
    cachedLibraryDataRaw = null;
    cachedLibraryData = [];
    questionTypeIndexCache = null;
  }

  function invalidatePlayerStateCache() {
    playerStates?.invalidateCache?.();
  }

  function createEmptyGrouped() {
    const grouped = {};
    for (const section of sections) {
      grouped[section] = {};
      for (const part of parts) {
        grouped[section][part] = {};
        for (const freq of freqOrder) grouped[section][part][freq] = [];
      }
    }
    return grouped;
  }

  function slugQuestionIdPart(value) {
    return String(value || "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function normalizeQuestionIdSection(section) {
    const value = String(section || "").trim();
    if (/^vip$/i.test(value)) return "vip";
    if (value === "普通") return "normal";
    return slugQuestionIdPart(value);
  }

  function getQuestionNumberFromTitle(title) {
    const match = String(title || "").match(/^\s*(\d+)\s*\./);
    return match ? match[1] : "";
  }

  function buildQuestionId(section, part, title, fallbackPath = "") {
    const cleanTitle = String(title || "")
      .replace(/^\s*\d+\s*\.\s*/, "")
      .replace(/^P\d+\s+/i, "")
      .replace(/\s*\((?:VIP)\)\s*/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const sectionToken = normalizeQuestionIdSection(section);
    const partToken = String(part || "").trim().toLowerCase();
    const number = getQuestionNumberFromTitle(title) || getQuestionNumberFromTitle((fallbackPath || "").split("/").slice(-2, -1)[0] || "");
    const titleToken = slugQuestionIdPart(cleanTitle);
    return [sectionToken, partToken, number, titleToken].filter(Boolean).join("-");
  }

  function getQuestionParts(sourcePath) {
    const fromCache = window.LibraryCache?.getQuestionParts?.(sourcePath);
    if (fromCache) return fromCache;

    const relativePath = normalizeRelativePath(sourcePath);
    const parts = relativePath.split("/").filter(Boolean);
    const start = parts.findIndex((part) => Object.prototype.hasOwnProperty.call(LIBRARY_ROOT_ALIASES, part));
    if (start < 0 || parts.length < start + 5) return null;

    const questionParts = parts.slice(start);
    questionParts[0] = LIBRARY_ROOT_ALIASES[questionParts[0]] || questionParts[0];
    return {
      section: questionParts[0],
      part: questionParts[1],
      frequency: questionParts[2],
      title: questionParts[3],
      fileName: questionParts[4],
      relativePath: questionParts.join("/")
    };
  }

  function toLibraryItem(question) {
    if (!question) return null;
    const item = {
      s: String(question.section || "").normalize("NFC").trim(),
      p: String(question.part || "").normalize("NFC").trim(),
      f: String(question.frequency || "").normalize("NFC").trim(),
      t: String(question.title || "").normalize("NFC").trim(),
      h: normalizeRelativePath(question.relativePath || ""),
      types: Array.isArray(question.types) ? question.types.map(normalizeQuestionType).filter(Boolean) : [],
      q: Number(question.totalQuestions || question.q || 0) || 0,
      qid: String(question.questionId || question.qid || buildQuestionId(question.section, question.part, question.title, question.relativePath) || "")
    };

    if (!(
      sections.includes(item.s)
      && /^P\d+$/i.test(item.p)
      && freqOrder.includes(item.f)
      && item.t
      && item.h
    )) return null;

    item.types = [...new Set(item.types)];
    if (!item.types.length) delete item.types;
    if (!item.q) delete item.q;
    return item;
  }

  function normalizeLibraryData(data) {
    const seen = new Set();
    return (data || []).map((item) => {
      let entry = item;
      if (Array.isArray(item)) {
        const [s, p, f, t, h] = item;
        entry = { s, p, f, t, h };
      }
      if (!entry || typeof entry !== "object") return null;

      const pathQuestion = getQuestionParts(entry.h || entry.relativePath || entry.id || "");
      if (pathQuestion) {
        return toLibraryItem({
          ...pathQuestion,
          types: entry.types,
          totalQuestions: entry.q || entry.totalQuestions,
          questionId: entry.questionId || entry.qid
        });
      }

      return toLibraryItem({
        section: entry.s,
        part: entry.p,
        frequency: entry.f,
        title: entry.t,
        relativePath: entry.h || entry.relativePath || entry.id || "",
        types: entry.types,
        totalQuestions: entry.q || entry.totalQuestions,
        questionId: entry.questionId || entry.qid
      });
    }).filter((item) => {
      if (!item) return false;
      const key = normalizeRelativePath(item.h).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function extractJsonScript(html, id) {
    const pattern = new RegExp(`<script\\b[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i");
    const match = String(html || "").match(pattern);
    if (!match) return null;

    const textarea = document.createElement("textarea");
    textarea.innerHTML = match[1] || "";
    try {
      return JSON.parse(textarea.value);
    } catch (error) {
      console.error("Failed to parse generator test data:", error);
      return null;
    }
  }

  function getQuestionTypesFromTestData(testData) {
    const types = new Set();
    (testData?.groups || []).forEach((group) => {
      const type = String(group?.type || "");
      if (type === "fill") types.add("text");
      else if (type === "matching") types.add("match");
      else types.add(normalizeQuestionType(type));
    });
    const answerKey = testData?.answerKey || {};
    if (Object.keys(answerKey.text || {}).length) types.add("text");
    if (Object.keys(answerKey.single || {}).length) types.add("single");
    if (Object.keys(answerKey.multiple || {}).length || Object.keys(answerKey.multipleMap || {}).length) types.add("multi");
    if (Object.keys(answerKey.matching || {}).length) types.add("match");
    if (Object.keys(answerKey.map || {}).length) types.add("map");
    return [...types].map(normalizeQuestionType).filter(Boolean);
  }

  function createLibraryItemFromFile(file, testData = null) {
    const question = getQuestionParts(file.webkitRelativePath || file.name);
    if (!question || !/\.html?$/i.test(question.relativePath)) return null;

    return toLibraryItem({
      section: question.section,
      part: question.part,
      frequency: question.frequency,
      title: testData?.title || question.title,
      relativePath: question.relativePath,
      types: testData ? getQuestionTypesFromTestData(testData) : [],
      totalQuestions: Array.isArray(testData?.questionIds) ? testData.questionIds.length : 0
    });
  }

  function loadLibraryData() {
    try {
      const raw = readLocalStorage(LIBRARY_STORAGE_KEY);
      if (raw === cachedLibraryDataRaw) return cachedLibraryData;
      if (!raw) {
        invalidateLibraryCache();
        return cachedLibraryData;
      }
      const parsed = JSON.parse(raw);
      cachedLibraryDataRaw = raw;
      cachedLibraryData = normalizeLibraryData(parsed);
      return cachedLibraryData;
    } catch (error) {
      invalidateLibraryCache();
      return [];
    }
  }

  function saveLibraryData(data) {
    const normalized = normalizeLibraryData(data);
    const serialized = JSON.stringify(normalized);
    writeLocalStorage(LIBRARY_STORAGE_KEY, serialized);
    window.IeltsStorageBackup?.set?.(LIBRARY_STORAGE_KEY, serialized);
    cachedLibraryDataRaw = serialized;
    cachedLibraryData = normalized;
  }

  async function restoreLibraryDataBackup() {
    const raw = readLocalStorage(LIBRARY_STORAGE_KEY);
    if (raw) {
      try {
        if (normalizeLibraryData(JSON.parse(raw)).length) {
          window.IeltsStorageBackup?.set?.(LIBRARY_STORAGE_KEY, raw);
          return false;
        }
      } catch (error) {
        console.error("Local library data is invalid, trying backup:", error);
      }
    }

    try {
      const backup = await window.IeltsStorageBackup?.get?.(LIBRARY_STORAGE_KEY);
      if (!backup) return false;

      const normalized = normalizeLibraryData(JSON.parse(backup));
      if (!normalized.length) return false;

      writeLocalStorage(LIBRARY_STORAGE_KEY, backup);
      cachedLibraryDataRaw = backup;
      cachedLibraryData = normalized;
      return true;
    } catch (error) {
      console.error("Failed to restore library data backup:", error);
      return false;
    }
  }

  function buildGrouped(data) {
    const grouped = createEmptyGrouped();
    for (const item of data) {
      if (grouped[item.s]?.[item.p]?.[item.f]) {
        grouped[item.s][item.p][item.f].push(item);
      }
    }

    for (const section of sections) {
      for (const part of parts) {
        for (const freq of freqOrder) {
          grouped[section][part][freq].sort((a, b) => {
            const diff = getNumber(a.t) - getNumber(b.t);
            return diff !== 0 ? diff : a.t.localeCompare(b.t);
          });
        }
      }
    }
    return grouped;
  }

  function normalizeRelativePath(path) {
    if (window.LibraryCache?.normalizeRelativePath) {
      return window.LibraryCache.normalizeRelativePath(path);
    }

    let cleanPath = String(path || "");
    try {
      cleanPath = decodeURI(cleanPath);
    } catch (error) {
      cleanPath = String(path || "");
    }

    cleanPath = cleanPath
      .normalize("NFC")
      .replace(/^file:\/\/(?:localhost\/)?/i, "")
      .replace(/^[A-Za-z]+:\/\/[^/]+/i, "")
      .replace(/[?#].*$/, "")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^\/([A-Za-z]:\/)/, "$1")
      .replace(/\/+/g, "/")
      .trim();

    const parts = cleanPath.split("/").filter(Boolean);
    const start = parts.findIndex((part) => Object.prototype.hasOwnProperty.call(LIBRARY_ROOT_ALIASES, part));
    if (start < 0) return cleanPath;
    const questionParts = parts.slice(start);
    questionParts[0] = LIBRARY_ROOT_ALIASES[questionParts[0]] || questionParts[0];
    return questionParts.join("/");
  }

  function resolveQuestionSourceUrl(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    return window.LibraryCache?.resolveQuestionUrl?.(normalized, window.location.href)
      || new URL(
        normalized
          .split("/")
          .filter(Boolean)
          .map((part) => encodeURIComponent(part))
          .join("/"),
        window.location.href
      ).href;
  }

  function extractQuestionStorageKeys(htmlText) {
    const source = String(htmlText || "");
    const keys = new Set();
    const patterns = [
      /localStorageKey\s*:\s*['"`]([^'"`]+)['"`]/gi,
      /localStorage\.(?:setItem|getItem|removeItem)\(\s*['"`]([^'"`]+)['"`]/gi,
      /\bdb\s*:\s*['"`]([^'"`]+)['"`]/gi,
      /\bkey\s*:\s*['"`]([^'"`]+)['"`]/gi
    ];

    patterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(source))) {
        const key = String(match[1] || "").trim();
        if (/^(ielts|IELTS)/.test(key)) keys.add(key);
      }
    });

    return [...keys];
  }

  async function loadQuestionStorageKeysWith(loader, errorMessage) {
    try {
      const htmlText = await loader();
      const keys = extractQuestionStorageKeys(htmlText);
      return keys.length ? keys : null;
    } catch (error) {
      console.error(errorMessage, error);
      return null;
    }
  }

  async function getQuestionStorageKeys(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return [];
    if (questionStorageKeysCache.has(normalized)) {
      return questionStorageKeysCache.get(normalized);
    }

    const cachedKeys = await loadQuestionStorageKeysWith(
      () => window.LibraryCache?.getQuestionHtml?.(normalized) || Promise.resolve(""),
      "Failed to load cached question HTML for storage cleanup:"
    );
    if (cachedKeys) {
      questionStorageKeysCache.set(normalized, cachedKeys);
      return cachedKeys;
    }

    const directKeys = await loadQuestionStorageKeysWith(
      async () => {
        const response = await fetch(resolveQuestionSourceUrl(normalized));
        if (!response.ok && response.status !== 0) {
          throw new Error(`Unexpected response: ${response.status}`);
        }
        return response.text();
      },
      "Failed to load question HTML directly for storage cleanup:"
    );
    if (directKeys) {
      questionStorageKeysCache.set(normalized, directKeys);
      return directKeys;
    }
    return [];
  }

  const PLAYER_VERSION = "20260824a";

  function buildQuestionHref(relativePath) {
    return buildQuestionHrefWithOptions(relativePath);
  }

  function buildQuestionHrefWithOptions(relativePath, options = {}) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return "#";
    const params = new URLSearchParams({
      v: PLAYER_VERSION,
      src: normalized
    });
    if (options.review) params.set("review", "1");
    if (options.redo) params.set("redo", "1");
    if (options.attemptTimestamp) params.set("attemptTs", String(options.attemptTimestamp));
    if (options.attemptSignature) params.set("attemptSig", String(options.attemptSignature));
    if (Number.isFinite(Number(options.attemptIndex))) params.set("attemptIndex", String(Number(options.attemptIndex)));
    return `./JS/player.html?${params.toString()}`;
  }

  function getPlayerStateStore() {
    return playerStates?.getStore?.() || {};
  }

  function getPendingPlayerState(relativePath, playerStateStore = getPlayerStateStore()) {
    return playerStates?.getPending?.(relativePath, playerStateStore) || null;
  }

  function getCompletedPlayerState(relativePath, playerStateStore = getPlayerStateStore()) {
    return playerStates?.getCompleted?.(relativePath, playerStateStore) || null;
  }

  function buildTrackerLookup(store) {
    const tests = store?.tests && typeof store.tests === "object" ? store.tests : {};
    const recordByPath = new Map();
    const recordByQuestionId = new Map();
    const recordByQuestionKey = new Map();
    const recordsByTitle = new Map();
    const latestAttempts = [];

    Object.values(tests).forEach((entry) => {
      const record = entry?.latestAttempt;
      if (!record) return;

      latestAttempts.push(record);

      const normalizedPath = normalizeRelativePath(record.relativePath || entry?.relativePath || entry?.id || "");
      if (normalizedPath) {
        recordByPath.set(normalizedPath, record);
      }
      const questionId = String(record.questionId || entry?.questionId || "").trim();
      const questionKey = String(record.questionKey || entry?.questionKey || "").trim();
      const titleKey = String(record.title || entry?.title || "").trim().toLowerCase();
      if (questionId) recordByQuestionId.set(questionId, record);
      if (questionKey) recordByQuestionKey.set(questionKey, record);
      if (titleKey) {
        const list = recordsByTitle.get(titleKey) || [];
        list.push(record);
        recordsByTitle.set(titleKey, list);
      }
    });

    return { recordByPath, recordByQuestionId, recordByQuestionKey, recordsByTitle, latestAttempts };
  }

  function getTrackerRecordForLibraryItem(item, trackerLookup) {
    const path = normalizeRelativePath(item?.h || item?.relativePath || "");
    const direct = path ? trackerLookup?.recordByPath?.get(path) : null;
    if (direct) return direct;
    const context = trackers.getContextFromPath?.(path) || {};
    const questionIds = [item?.qid, context.questionId].map((value) => String(value || "").trim()).filter(Boolean);
    for (const questionId of questionIds) {
      const record = trackerLookup?.recordByQuestionId?.get(questionId);
      if (record) return record;
    }
    const questionKey = String(context.questionKey || "").trim();
    if (questionKey) {
      const record = trackerLookup?.recordByQuestionKey?.get(questionKey);
      if (record) return record;
    }
    const titleKey = String(item?.t || context.title || "").trim().toLowerCase();
    const titleMatches = titleKey ? (trackerLookup?.recordsByTitle?.get(titleKey) || []) : [];
    if (titleMatches.length === 1) return titleMatches[0];
    return titleMatches.find((record) => (
      (!item?.s || String(record?.section || "") === String(item.s))
      && (!item?.p || String(record?.part || "") === String(item.p))
    )) || null;
  }

  function readRecordSummaryStore() {
    const parsed = parseJsonObject(readLocalStorage(RECORD_SUMMARY_STORAGE_KEY));
    return parsed && parsed.version === 1 && parsed.items && typeof parsed.items === "object"
      ? parsed
      : { version: 1, items: {}, updatedAt: "" };
  }

  function writeRecordSummaryStore(store) {
    const next = store && typeof store === "object" ? store : { version: 1, items: {} };
    next.version = 1;
    next.updatedAt = new Date().toISOString();
    writeLocalStorage(RECORD_SUMMARY_STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function clearRecordSummaryStore() {
    removeLocalStorage(RECORD_SUMMARY_STORAGE_KEY);
  }

  function getQuestionFieldKey(field) {
    const raw = String(field?.dataQ || field?.name || field?.id || "").trim();
    if (!raw) return "";
    if (/^(?:q)?\d+(?:[-_]\d+)?$/i.test(raw)) return raw.replace(/^q/i, "").replace(/_/g, "-");
    return "";
  }

  function getDraftAnsweredCount(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return 0;
    const answered = new Set();
    (Array.isArray(snapshot.fields) ? snapshot.fields : []).forEach((field) => {
      const key = getQuestionFieldKey(field);
      if (!key || !isAnsweredValue(field?.value)) return;
      answered.add(key);
    });
    (Array.isArray(snapshot.choices) ? snapshot.choices : []).forEach((choice) => {
      const key = String(choice?.name || "").replace(/^q/i, "").replace(/_/g, "-");
      if (!key || !isAnsweredValue(choice?.value)) return;
      if (/^\d+-\d+$/.test(key)) {
        const [start, end] = key.split("-").map(Number);
        const offset = [...(snapshot.choices || [])].filter((item) => String(item?.name || "") === String(choice.name)).indexOf(choice);
        const qid = Number.isFinite(start) && Number.isFinite(end) ? Math.min(end, start + Math.max(0, offset)) : start;
        answered.add(String(qid));
        return;
      }
      answered.add(key);
    });
    (Array.isArray(snapshot.matchingSlots) ? snapshot.matchingSlots : []).forEach((slot) => {
      const key = String(slot?.question || slot?.qid || slot?.dataQ || "").replace(/^q/i, "");
      if (!key || !isAnsweredValue(slot?.value ?? slot?.userAnswer)) return;
      answered.add(key);
    });
    return answered.size;
  }

  function getDraftTotal(item, record) {
    const itemTotal = Number(item?.q || 0);
    if (Number.isFinite(itemTotal) && itemTotal > 0) return itemTotal;
    const recordTotal = Number(record?.total || 0);
    return Number.isFinite(recordTotal) && recordTotal > 0 ? recordTotal : 0;
  }

  function hasDraftContent(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return false;
    if (snapshot.retryPending) return true;
    if (getDraftAnsweredCount(snapshot) > 0) return true;
    if (Array.isArray(snapshot.highlights) && snapshot.highlights.length > 0) return true;
    if (String(snapshot.playerNotes?.text || "").trim()) return true;
    return false;
  }

  function getEffectivePendingState(pendingState, record, completedState = null) {
    if (!pendingState) return null;
    if ((record || completedState) && !hasDraftContent(pendingState)) return null;
    return pendingState;
  }

  function formatPendingProgress(pendingState, total = 0) {
    const answered = Number(pendingState?.answered);
    const safeTotal = Number(total || pendingState?.total || 0);
    if (Number.isFinite(answered) && answered > 0 && safeTotal > 0) return `待完成 · 已答 ${Math.min(answered, safeTotal)}/${safeTotal}`;
    if (Number.isFinite(answered) && answered > 0) return `待完成 · 已答 ${answered}`;
    return "待完成 · 已保存进度";
  }

  function attemptToSummaryRecord(attempt) {
    if (!attempt) return null;
    const details = Array.isArray(attempt.details) ? attempt.details : [];
    const answered = Number.isFinite(Number(attempt.answered))
      ? Number(attempt.answered)
      : getAnsweredCount(attempt);
    return {
      questionId: attempt.questionId || "",
      questionKey: attempt.questionKey || "",
      title: attempt.title || "",
      section: attempt.section || "",
      part: attempt.part || "",
      frequency: attempt.frequency || "",
      relativePath: normalizeRelativePath(attempt.relativePath || ""),
      total: Number(attempt.total || 0),
      correct: Number(attempt.correct || 0),
      wrong: Number(attempt.wrong || 0),
      percent: Number(attempt.percent || 0),
      answered: Math.max(0, Math.min(answered, Number(attempt.total || 0) || answered || 0)),
      hasDetails: details.length > 0,
      timestamp: attempt.timestamp || "",
      formattedTime: attempt.formattedTime || ""
    };
  }

  function buildRecordSummaryStore(libraryData, trackerStore = trackers.getStore(), playerStateStore = getPlayerStateStore()) {
    const trackerLookup = buildTrackerLookup(trackerStore);
    const items = {};
    (libraryData || []).forEach((item) => {
      const path = normalizeRelativePath(item?.h || "");
      if (!path) return;
      const record = getTrackerRecordForLibraryItem(item, trackerLookup);
      const rawPendingState = getPendingPlayerState(path, playerStateStore);
      const completedState = getCompletedPlayerState(path, playerStateStore);
      const pendingState = getEffectivePendingState(rawPendingState, record, completedState);
      const draftAnswered = getDraftAnsweredCount(pendingState);
      const draftTotal = getDraftTotal(item, record);
      if (!record && !pendingState && !completedState) return;
      items[path] = {
        questionId: item?.qid || record?.questionId || "",
        title: item?.t || record?.title || "",
        section: item?.s || record?.section || "",
        part: item?.p || record?.part || "",
        frequency: item?.f || record?.frequency || "",
        relativePath: path,
        status: record || completedState ? (pendingState ? "pending" : "completed") : "pending",
        hasRecord: !!record,
        hasDraft: !!pendingState,
        hasCompleted: !!completedState,
        draftSavedAt: pendingState?.savedAt || "",
        completedSavedAt: completedState?.savedAt || "",
        draftAnswered,
        draftTotal,
        record: attemptToSummaryRecord(record),
        updatedAt: new Date().toISOString()
      };
    });
    return { version: 1, items, updatedAt: new Date().toISOString() };
  }

  function buildSyncedRecordSummaryStore(libraryData) {
    const trackerStore = trackers.syncStoreWithLibrary(libraryData);
    const reconciledPlayerState = reconcilePlayerStateWithLibrary(getPlayerStateStore(), libraryData);
    savePendingPlayerStateStore(reconciledPlayerState);
    return buildRecordSummaryStore(libraryData, trackerStore, reconciledPlayerState);
  }

  function summaryNeedsRebuild(summaryStore, trackerStore) {
    const items = summaryStore?.items && typeof summaryStore.items === "object" ? summaryStore.items : {};
    const tests = trackerStore?.tests && typeof trackerStore.tests === "object" ? trackerStore.tests : {};
    const attempts = Object.values(tests)
      .map((entry) => ({
        entry,
        record: entry?.latestAttempt,
        path: normalizeRelativePath(entry?.latestAttempt?.relativePath || entry?.relativePath || entry?.id || "")
      }))
      .filter((item) => item.record);
    const hasTrackerRecords = attempts.length > 0;
    const hasSummaryRecords = Object.values(items).some((item) => item?.hasRecord || item?.record);
    if (hasSummaryRecords && !hasTrackerRecords) return true;
    if (!hasTrackerRecords) return false;

    const invalidSummaryRecord = (record) => !record
      || !Number.isFinite(Number(record.answered))
      || !Number.isFinite(Number(record.correct))
      || !Number.isFinite(Number(record.total))
      || !Number.isFinite(Number(record.percent));

    if (Object.values(items).some((item) => item?.record && invalidSummaryRecord(item.record))) return true;

    return attempts.some(({ record, path }) => {
      const item = path ? items[path] : null;
      if (!item || !item.record) return true;
      return invalidSummaryRecord(item.record)
        || Number(item.record.correct || 0) !== Number(record.correct || 0)
        || Number(item.record.total || 0) !== Number(record.total || 0)
        || String(item.record.timestamp || "") !== String(record.timestamp || "");
    });
  }

  function summaryNeedsLibraryRebuild(summaryStore, libraryData, trackerStore, playerStateStore) {
    const items = summaryStore?.items && typeof summaryStore.items === "object" ? summaryStore.items : {};
    const trackerLookup = buildTrackerLookup(trackerStore);
    return (libraryData || []).some((item) => {
      const path = normalizeRelativePath(item?.h || "");
      if (!path) return false;
      const record = getTrackerRecordForLibraryItem(item, trackerLookup);
      const rawPendingState = getPendingPlayerState(path, playerStateStore);
      const completedState = getCompletedPlayerState(path, playerStateStore);
      const pendingState = getEffectivePendingState(rawPendingState, record, completedState);
      if (!record && !pendingState && !completedState) return false;
      const summary = items[path] || null;
      if (!summary) return true;
      if (!!summary.hasRecord !== !!record) return true;
      if (!!summary.hasDraft !== !!pendingState) return true;
      if (!!summary.hasCompleted !== !!completedState) return true;
      if ((record || completedState) && rawPendingState && !pendingState && !!summary.hasDraft) return true;
      if (record && (
        Number(summary.record?.correct || 0) !== Number(record.correct || 0)
        || Number(summary.record?.total || 0) !== Number(record.total || 0)
        || String(summary.record?.timestamp || "") !== String(record.timestamp || "")
      )) return true;
      if (pendingState) {
        const draftAnswered = getDraftAnsweredCount(pendingState);
        const draftTotal = getDraftTotal(item, record);
        if (Number(summary.draftAnswered || 0) !== draftAnswered) return true;
        if (Number(summary.draftTotal || 0) !== draftTotal) return true;
      }
      return false;
    });
  }

  function getOrBuildRecordSummaryStore(libraryData) {
    const existing = readRecordSummaryStore();
    const syncedTrackerStore = trackers.syncStoreWithLibrary(libraryData);
    const reconciledPlayerState = reconcilePlayerStateWithLibrary(getPlayerStateStore(), libraryData);
    savePendingPlayerStateStore(reconciledPlayerState);
    const hasExistingItems = Object.keys(existing.items || {}).length > 0;
    if (!hasExistingItems
      || summaryNeedsRebuild(existing, syncedTrackerStore)
      || summaryNeedsLibraryRebuild(existing, libraryData, syncedTrackerStore, reconciledPlayerState)) {
      return writeRecordSummaryStore(buildRecordSummaryStore(libraryData, syncedTrackerStore, reconciledPlayerState));
    }
    return existing;
  }

  function rebuildAndSaveRecordSummary(libraryData = currentLibraryData.length ? currentLibraryData : loadLibraryData()) {
    return writeRecordSummaryStore(buildSyncedRecordSummaryStore(libraryData));
  }

  function getSummaryStateData(relativePath, summaryStore) {
    const normalized = normalizeRelativePath(relativePath);
    const item = normalized ? summaryStore?.items?.[normalized] : null;
    if (!item) return { record: null, pendingState: null, completedState: null, status: "unstarted" };
    const record = item.record ? { ...item.record } : null;
    const pendingState = item.hasDraft ? {
      savedAt: item.draftSavedAt || item.updatedAt || "",
      answered: Number(item.draftAnswered || 0),
      total: Number(item.draftTotal || 0)
    } : null;
    const completedState = item.hasCompleted ? { savedAt: item.completedSavedAt || item.updatedAt || "" } : null;
    const status = item.status || (record || completedState ? (pendingState ? "pending" : "completed") : (pendingState ? "pending" : "unstarted"));
    return { record, pendingState, completedState, status };
  }

  function buildSummaryTrackerLookup(summaryStore) {
    const recordByPath = new Map();
    const latestAttempts = [];
    Object.values(summaryStore?.items || {}).forEach((item) => {
      if (!item?.record) return;
      const record = { ...item.record };
      latestAttempts.push(record);
      const path = normalizeRelativePath(item.relativePath || record.relativePath || "");
      if (path) recordByPath.set(path, record);
    });
    return { recordByPath, latestAttempts };
  }

  function buildSummaryStateLookup(libraryData, summaryStore) {
    const lookup = new Map();
    (libraryData || []).forEach((item) => {
      if (item?.h) lookup.set(item.h, getSummaryStateData(item.h, summaryStore));
    });
    return lookup;
  }

  function getQuestionStateData(relativePath, playerStateStore = getPlayerStateStore(), trackerLookup = null) {
    const normalized = normalizeRelativePath(relativePath);
    const exactRecord = normalized && trackerLookup?.recordByPath
      ? trackerLookup.recordByPath.get(normalized) || null
      : null;
    const record = exactRecord || trackers.getLatestRecordByPath(relativePath);
    const rawPendingState = getPendingPlayerState(relativePath, playerStateStore);
    const completedState = getCompletedPlayerState(relativePath, playerStateStore);
    const effectivePendingState = getEffectivePendingState(rawPendingState, record, completedState);
    const pendingState = effectivePendingState ? {
      ...effectivePendingState,
      answered: getDraftAnsweredCount(effectivePendingState),
      total: Number(record?.total || 0)
    } : null;
    const status = record || completedState
      ? (pendingState ? "pending" : "completed")
      : (pendingState ? "pending" : "unstarted");
    return { record, pendingState, completedState, status };
  }

  function buildQuestionStateLookup(libraryData, playerStateStore, trackerLookup) {
    const lookup = new Map();
    (libraryData || []).forEach((item) => {
      if (item?.h) lookup.set(item.h, getQuestionStateData(item.h, playerStateStore, trackerLookup));
    });
    return lookup;
  }

  function getQuestionState(item, stateLookup, playerStateStore, trackerLookup) {
    return stateLookup?.get(item.h) || getQuestionStateData(item.h, playerStateStore, trackerLookup);
  }

  function clearAllPlayerState() {
    playerStates?.clearAll?.();
  }

  function clearQuestionPlayerState(relativePath) {
    return !!playerStates?.clearQuestion?.(relativePath);
  }

  async function clearQuestionLocalState(relativePath) {
    const keys = await getQuestionStorageKeys(relativePath);
    keys.forEach((key) => {
      if (key) removeLocalStorage(key);
      try {
        if (key) window.NativeDiskStorage?.removeAnswerRecordBackup?.(key);
      } catch (error) {
        console.error("Failed to remove question answer backup:", error);
      }
    });
    return keys;
  }

  async function clearQuestionData(relativePath) {
    if (!relativePath) return false;
    const removedRecord = !!trackers.removeTestRecord(relativePath);
    const removedPlayerState = clearQuestionPlayerState(relativePath);
    const localKeys = await clearQuestionLocalState(relativePath);
    return removedRecord || removedPlayerState || localKeys.length > 0;
  }

  async function resetQuestionForRedo(relativePath) {
    if (!relativePath) return false;
    const removedPlayerState = clearQuestionPlayerState(relativePath);
    const localKeys = await clearQuestionLocalState(relativePath);
    return removedPlayerState || localKeys.length > 0;
  }

  function isProtectedRecordStorageKey(key) {
    return key === LIBRARY_STORAGE_KEY || key === REVIEW_PREFERENCES_KEY || key === "xiahua_auth_state_v2";
  }

  function isAnswerStateStorageKey(key) {
    return /^(ielts|ieltsListening)/i.test(String(key || ""));
  }

  function getResidualAnswerStateKeys() {
    return getLocalStorageKeys().filter((key) => (
      !isProtectedRecordStorageKey(key) && isAnswerStateStorageKey(key)
    ));
  }

  async function clearAllQuestionLocalState() {
    const clearLocal = () => {
      getResidualAnswerStateKeys().forEach((key) => removeLocalStorage(key));
    };
    clearLocal();
    try {
      await window.NativeDiskStorage?.clearAnswerRecordBackups?.({
        prefixes: ["ielts", "IELTS", "ieltsListening"],
        exclude: [LIBRARY_STORAGE_KEY, REVIEW_PREFERENCES_KEY, "xiahua_auth_state_v2"]
      });
      window.NativeDiskStorage?.flush?.();
    } catch (error) {
      console.error("Failed to clear answer-record backups:", error);
    }
    clearLocal();
    questionStorageKeysCache.clear();
  }

  async function getResidualAnswerBackupKeys() {
    try {
      const records = await window.NativeDiskStorage?.readAnswerRecordBackups?.();
      const entries = records?.entries && typeof records.entries === "object" ? records.entries : {};
      return Object.keys(entries).filter((key) => (
        !isProtectedRecordStorageKey(key) && isAnswerStateStorageKey(key)
      ));
    } catch (error) {
      console.error("Failed to inspect answer-record backups:", error);
      return [];
    }
  }

  async function cleanupResidualAnswerState() {
    const localBefore = getResidualAnswerStateKeys();
    localBefore.forEach((key) => removeLocalStorage(key));
    let backupBefore = [];
    try {
      backupBefore = await getResidualAnswerBackupKeys();
      if (backupBefore.length) {
        await window.NativeDiskStorage?.clearAnswerRecordBackups?.({
          prefixes: ["ielts", "IELTS", "ieltsListening"],
          exclude: [LIBRARY_STORAGE_KEY, REVIEW_PREFERENCES_KEY, "xiahua_auth_state_v2"]
        });
        window.NativeDiskStorage?.flush?.();
      }
    } catch (error) {
      console.error("Failed to cleanup residual answer state:", error);
    }
    const localAfter = getResidualAnswerStateKeys();
    const backupAfter = await getResidualAnswerBackupKeys();
    if (localAfter.length || backupAfter.length) {
      console.warn("Residual answer state keys after clear:", { localAfter, backupAfter });
    }
    return {
      removedLocal: localBefore.length,
      removedBackup: backupBefore.length,
      remainingLocal: localAfter.length,
      remainingBackup: backupAfter.length
    };
  }

  function sanitizePlayerStateStore(store) {
    return playerStates?.sanitizeStore?.(store) || {};
  }

  function mergePlayerStateStores(currentStore, importedStore) {
    return playerStates?.mergeStores?.(currentStore, importedStore) || {};
  }

  function savePendingPlayerStateStore(store) {
    playerStates?.saveStore?.(store);
  }

  function reconcilePlayerStateWithLibrary(store, libraryData) {
    return playerStates?.reconcileWithLibrary?.(store, libraryData) || {};
  }

  function preserveRecordsAcrossLibraryUpdate(libraryData) {
    trackers.saveStore(trackers.reconcileStoreWithLibrary(trackers.getStore(), libraryData));
    savePendingPlayerStateStore(reconcilePlayerStateWithLibrary(getPlayerStateStore(), libraryData));
  }

  function applyQuestionLinkAttributes(link) {
    if (window.NativeDiskStorage?.isWebLibrary) {
      link.target = "_self";
    } else {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    return link;
  }

  async function fetchAndCacheQuestionHtml(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return false;

    const response = await fetch(resolveQuestionSourceUrl(normalized));
    if (!response.ok && response.status !== 0) {
      throw new Error(`Unexpected response: ${response.status}`);
    }
    const htmlText = await response.text();
    return !!htmlText && await (window.LibraryCache?.putQuestionHtml?.(normalized, htmlText) || Promise.resolve(false));
  }

  async function warmQuestionBeforeOpen(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return;

    try {
      const cachedHtml = await (window.LibraryCache?.ensureQuestionHtml?.(
        normalized,
        async () => {
          const response = await fetch(resolveQuestionSourceUrl(normalized));
          if (!response.ok && response.status !== 0) {
            throw new Error(`Unexpected response: ${response.status}`);
          }
          return response.text();
        },
        { silent: true }
      ) || Promise.resolve(""));
      if (cachedHtml) return;
    } catch (error) {
      console.error("Failed to warm question HTML before opening:", error);
    }
  }

  function attachQuestionOpenWarmup(link, relativePath) {
    if (!link || !relativePath) return link;
    if (window.NativeDiskStorage?.isWebLibrary) return link;
    link.addEventListener("click", async (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      await Promise.race([
        warmQuestionBeforeOpen(relativePath),
        new Promise((resolve) => window.setTimeout(resolve, QUESTION_OPEN_WARMUP_TIMEOUT_MS))
      ]);
      window.open(link.href, link.target || "_blank", "noopener,noreferrer");
    });
    return link;
  }

  function createEmptyMessage(message) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = message;
    return empty;
  }

  function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function notify(message) {
    alert(message);
  }

  function ensureStartupProgress() {
    let overlay = byId("startup-progress-overlay");
    if (overlay) return overlay;
    const style = document.createElement("style");
    style.textContent = `
      .startup-progress-overlay{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(248,250,252,.86);backdrop-filter:blur(10px)}
      .startup-progress-overlay[hidden]{display:none!important}
      .startup-progress-card{width:min(520px,calc(100vw - 36px));padding:22px;border-radius:18px;background:#fff;box-shadow:0 18px 48px rgba(15,23,42,.16);border:1px solid rgba(148,163,184,.28)}
      .startup-progress-title{font-weight:800;font-size:18px;color:#0f172a;margin-bottom:8px}
      .startup-progress-text{font-size:14px;color:#475569;min-height:22px;margin-bottom:14px}
      .startup-progress-track{height:10px;border-radius:999px;background:#e2e8f0;overflow:hidden}
      .startup-progress-bar{height:100%;width:8%;border-radius:inherit;background:linear-gradient(90deg,#2563eb,#60a5fa);transition:width .18s ease}
    `;
    document.head.appendChild(style);
    overlay = document.createElement("div");
    overlay.id = "startup-progress-overlay";
    overlay.className = "startup-progress-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="startup-progress-card">
        <div class="startup-progress-title">正在检测题库</div>
        <div id="startup-progress-text" class="startup-progress-text">正在检测本地题库...</div>
        <div class="startup-progress-track"><div id="startup-progress-bar" class="startup-progress-bar"></div></div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function setStartupProgress(progress = {}) {
    const overlay = ensureStartupProgress();
    const text = byId("startup-progress-text");
    const bar = byId("startup-progress-bar");
    overlay.hidden = false;
    if (text) text.textContent = progress.message || "正在检测本地题库...";
    if (bar) {
      const current = Number(progress.current || 0);
      const total = Number(progress.total || 0);
      const percent = total > 0
        ? Math.max(8, Math.min(98, Math.round((current / total) * 100)))
        : Math.min(92, 8 + (current % 80));
      bar.style.width = `${progress.phase === "done" ? 100 : percent}%`;
    }
  }

  function hideStartupProgress() {
    const overlay = byId("startup-progress-overlay");
    if (overlay) overlay.hidden = true;
  }

  function askConfirm(message) {
    return confirm(message);
  }

  function createActionButton(label, options = {}) {
    const button = document.createElement("button");
    button.className = `action-btn${options.variant ? ` ${options.variant}` : ""}${options.className ? ` ${options.className}` : ""}`;
    button.type = "button";
    button.textContent = label;
    if (typeof options.onClick === "function") {
      button.addEventListener("click", options.onClick);
    }
    return button;
  }

  function createActionLink(label, href, options = {}) {
    const link = applyQuestionLinkAttributes(document.createElement("a"));
    link.className = `action-btn${options.variant ? ` ${options.variant}` : ""}${options.className ? ` ${options.className}` : ""}`;
    link.href = href;
    link.textContent = label;
    if (options.relativePath) attachQuestionOpenWarmup(link, options.relativePath);
    return link;
  }

  function createQuestionLink(label, relativePath, className = "", options = {}) {
    const link = applyQuestionLinkAttributes(document.createElement("a"));
    link.href = options.href || buildQuestionHref(relativePath);
    link.textContent = label;
    if (className) link.className = className;
    return attachQuestionOpenWarmup(link, relativePath);
  }

  function getSavedTimeValue(value) {
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function buildHomeQuestionHref(relativePath, stateData = {}) {
    const record = stateData.record || null;
    const pendingState = stateData.pendingState || null;
    if (!record) return buildQuestionHref(relativePath);

    const recordTime = getSavedTimeValue(record.timestamp || record.formattedTime);
    const draftTime = getSavedTimeValue(pendingState?.savedAt);
    if (pendingState && (!draftTime || draftTime >= recordTime)) {
      return buildQuestionHref(relativePath);
    }

    return buildQuestionHrefWithOptions(relativePath, {
      review: true,
      attemptTimestamp: record.timestamp || ""
    });
  }

  function isAnsweredValue(value) {
    const text = String(value || "").trim();
    return !!text && !/^No Answer$/i.test(text) && text !== "未作答";
  }

  function getAnsweredCount(attempt) {
    const details = Array.isArray(attempt?.details) ? attempt.details : [];
    if (!details.length) {
      const answered = Number(attempt?.answered);
      return Number.isFinite(answered) ? Math.max(0, answered) : 0;
    }
    return details.filter((detail) => isAnsweredValue(detail?.userAnswer)).length;
  }

  function formatAttemptScore(attempt, options = {}) {
    const total = Number(attempt?.total || 0);
    const correct = Number(attempt?.correct || 0);
    const percent = Number(attempt?.percent || 0);
    const answered = Math.min(getAnsweredCount(attempt), total || getAnsweredCount(attempt));
    const compact = !!options.compact;
    if (compact) return `已答 ${answered}/${total} · 正确 ${correct}/${total}`;
    return `已答 ${answered}/${total} · 正确 ${correct}/${total} · ${percent}%`;
  }

  function isLayerOpen(id) {
    const element = byId(id);
    return !!element && !element.hidden;
  }

  function setLayerOpen(id, open) {
    const element = byId(id);
    if (element) element.hidden = !open;
  }

  function finalizeRecordMutation(options = {}) {
    const { closeDetail = true, closeWrongbook = false } = options;
    if (closeDetail) closeModal();
    if (closeWrongbook) closeWrongbookModal();
    rebuildAndSaveRecordSummary();
    renderAll();
  }

		  function getLibraryFilterSet(filterName) {
		    if (filterName === "section") return activeSectionFilters;
		    if (filterName === "frequency") return activeFrequencyFilters;
		    if (filterName === "status") return activeStatusFilters;
		    if (filterName === "type") return activeTypeFilters;
		    return new Set();
		  }

		  function setLibraryFilterSet(filterName, next) {
		    if (filterName === "section") {
		      activeSectionFilters = next;
		      return;
		    }
		    if (filterName === "frequency") {
		      activeFrequencyFilters = next;
		      return;
		    }
		    if (filterName === "status") {
		      activeStatusFilters = next;
		      return;
		    }
		    if (filterName === "type") {
		      activeTypeFilters = next;
		    }
		  }

		  function hasActiveLibraryFilter() {
		    return activeSectionFilters.size > 0
		      || activeFrequencyFilters.size > 0
		      || activeStatusFilters.size > 0
		      || activePartFilters.size > 0
		      || activeTypeFilters.size > 0;
		  }

		  function matchesLibraryFilter(activeSet, value) {
		    return activeSet.size === 0 || activeSet.has(value);
		  }

  function isAllFilterSelected(activeSet, allValues) {
    return activeSet.size === 0 || (Array.isArray(allValues) && allValues.every((value) => activeSet.has(value)));
  }

			  function toggleFilter(setRefName, value) {
			    const current = getLibraryFilterSet(setRefName);
			    const next = new Set(current);
			    if (next.has(value)) {
			      next.delete(value);
			    } else {
			      next.add(value);
			    }
			    setLibraryFilterSet(setRefName, next);
			  }

		  function togglePartFilter(part) {
			    if (activePartFilters.has(part)) {
			      activePartFilters.delete(part);
			      return;
			    }
		    activePartFilters.add(part);
		  }

	  function setQuestionViewMode(mode) {
	    questionViewMode = mode === "list" ? "list" : "gallery";
	    [byId("normal-grid"), byId("vip-grid")].forEach((root) => {
	      if (!root) return;
	      root.classList.toggle("question-view-list", questionViewMode === "list");
	      root.classList.toggle("question-view-gallery", questionViewMode !== "list");
	    });
	    document.querySelectorAll("[data-view-mode]").forEach((button) => {
	      button.classList.toggle("is-off", button.dataset.viewMode !== questionViewMode);
	    });
	  }

  async function buildLibraryDataFromFiles(files) {
    const map = new Map();

    for (const file of [...files]) {
      const sourcePath = file.webkitRelativePath || file.name;
      if (!/\.html?$/i.test(sourcePath)) continue;

      let testData = file._testData || null;
      try {
        if (!testData && typeof file.text === "function") {
          testData = extractJsonScript(await file.text(), "test-data");
        }
      } catch (error) {
        console.error("Failed to read question HTML metadata:", error);
      }

      const item = createLibraryItemFromFile(file, testData);
      if (!item) continue;

      const { s, p, f, t, h } = item;
      const key = normalizeRelativePath(h).toLowerCase();
      if (!map.has(key)) {
        map.set(key, { s, p, f, t, h, types: item.types || [], q: item.q || 0 });
      }
    }

    return [...map.values()].sort((a, b) => {
      if (a.s !== b.s) return sections.indexOf(a.s) - sections.indexOf(b.s);
      const partDiff = getPartNumber(a.p) - getPartNumber(b.p);
      if (partDiff !== 0) return partDiff;
      const freqDiff = freqOrder.indexOf(a.f) - freqOrder.indexOf(b.f);
      if (freqDiff !== 0) return freqDiff;
      const titleDiff = getNumber(a.t) - getNumber(b.t);
      if (titleDiff !== 0) return titleDiff;
      return a.t.localeCompare(b.t);
    });
  }

  function buildLibraryFingerprintFromFiles(files) {
    const entries = [...files]
      .map((file) => {
        const item = createLibraryItemFromFile(file);
        if (!item) return null;
        return [
          normalizeRelativePath(item.h),
          Number(file.size || 0),
          Math.round(Number(file.lastModified || 0)),
          String(file._sourceSignature || "")
        ].join("|");
      })
      .filter(Boolean)
      .sort();
    return JSON.stringify(entries);
  }

  const LibraryDirectory = (() => {
    function getNativeDiskStorage() {
      return window.NativeDiskStorage || null;
    }

    function isSupported() {
      return !!getNativeDiskStorage()?.readLibraryFiles
        || (typeof window.showDirectoryPicker === "function" && typeof indexedDB !== "undefined");
    }

    function openDb() {
      if (directoryHandleDbPromise) return directoryHandleDbPromise;
      directoryHandleDbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          directoryHandleDbPromise = null;
          reject(new Error("IndexedDB is not available."));
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
          reject(request.error || new Error("Failed to open directory handle DB."));
        };
        request.onblocked = () => {
          directoryHandleDbPromise = null;
          reject(new Error("Directory handle DB open request was blocked."));
        };
      });
      return directoryHandleDbPromise;
    }

    async function withStore(mode, callback) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(DIRECTORY_HANDLE_STORE, mode);
        const store = transaction.objectStore(DIRECTORY_HANDLE_STORE);
        const request = callback(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Directory handle request failed."));
      });
    }

    async function getSavedHandle() {
      if (!isSupported()) return null;
      return (await withStore("readonly", (store) => store.get(DIRECTORY_HANDLE_KEY))) || null;
    }

    async function saveHandle(handle) {
      if (!isSupported() || !handle) return;
      await withStore("readwrite", (store) => store.put(handle, DIRECTORY_HANDLE_KEY));
    }

    async function clearHandle() {
      if (!isSupported()) return;
      await withStore("readwrite", (store) => store.delete(DIRECTORY_HANDLE_KEY));
    }

    async function ensurePermission(handle, options = {}) {
      if (!handle) return false;
      const permissionOptions = { mode: "read" };
      if ((await handle.queryPermission?.(permissionOptions)) === "granted") return true;
      if (options.silent) return false;
      return (await handle.requestPermission?.(permissionOptions)) === "granted";
    }

    async function pickHandle() {
      try {
        const handle = await window.showDirectoryPicker({ mode: "read" });
        await saveHandle(handle);
        return handle;
      } catch (error) {
        if (error?.name !== "AbortError") {
          console.error("Failed to pick library directory:", error);
        }
        return null;
      }
    }

    async function getHandle(options = {}) {
      if (!isSupported()) return null;

      if (!options.forcePick) {
        try {
          const savedHandle = await getSavedHandle();
          if (savedHandle && await ensurePermission(savedHandle, { silent: !!options.silent })) {
            return savedHandle;
          }
        } catch (error) {
          console.error("Failed to reuse saved library directory:", error);
        }
        if (options.silent) return null;
      }

      return pickHandle();
    }

    async function collectLibraryFiles(rootHandle) {
      const files = [];
      const cacheableFilePattern = /\.(?:html?|mp3|m4a|wav|ogg|png|jpe?g|gif|webp|svg)$/i;
      const skipped = [];

      async function walk(directoryHandle, relativeParts = []) {
        try {
          for await (const [name, handle] of directoryHandle.entries()) {
            if (handle.kind === "directory") {
              await walk(handle, [...relativeParts, name]);
              continue;
            }
            if (handle.kind !== "file" || !cacheableFilePattern.test(name)) continue;

            try {
              const file = await handle.getFile();
              const relativePath = [...relativeParts, name].join("/");
              files.push({
                name: file.name,
                size: file.size,
                type: file.type,
                lastModified: file.lastModified,
                webkitRelativePath: relativePath,
                text: () => file.text()
              });
            } catch (error) {
              skipped.push([...relativeParts, name].join("/"));
              console.error("Failed to read one library file:", error);
            }
          }
        } catch (error) {
          skipped.push(relativeParts.join("/") || ".");
          console.error("Failed to scan one library directory:", error);
        }
      }

      await walk(rootHandle);
      if (skipped.length) {
        console.warn(`Skipped ${skipped.length} unreadable library item(s).`);
      }
      return files;
    }

    async function readFiles(forcePick = false, options = {}) {
      const nativeDiskStorage = getNativeDiskStorage();
      if (nativeDiskStorage?.readLibraryFiles) {
        try {
          if (forcePick && nativeDiskStorage.pickLibraryDirectory) {
            await nativeDiskStorage.pickLibraryDirectory();
          }
          return nativeDiskStorage.readLibraryFiles({ silent: !!options.silent });
        } catch (error) {
          console.error("Failed to read native library directory:", error);
          return null;
        }
      }

      const handle = await getHandle({ forcePick, silent: !!options.silent });
      if (!handle) return false;

      try {
        return { handle, files: await collectLibraryFiles(handle) };
      } catch (error) {
        console.error("Failed to read library directory:", error);
        await clearHandle();
        return null;
      }
    }

    return {
      clearHandle,
      isSupported,
      readFiles
    };
  })();

  function createFreqBlock(freq, items, playerStateStore, trackerLookup, stateLookup) {
    const block = document.createElement("div");
    block.className = `freq-block ${freqClass[freq]}`;

    const title = document.createElement("div");
    title.className = "freq-title";
    title.appendChild(createTextElement("strong", "", freq));
    title.appendChild(createTextElement("span", "freq-count", `${items.length}篇`));
    block.appendChild(title);

    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "暂无题目";
      block.appendChild(empty);
      return block;
    }

    const list = document.createElement("ul");
    list.className = "question-list";
    for (const item of items) {
      const stateData = getQuestionState(item, stateLookup, playerStateStore, trackerLookup);
	      const li = document.createElement("li");
	      li.className = "question-item";
	      li.dataset.search = `${item.t}`.toLowerCase();
      li.dataset.frequency = freq;
      li.dataset.part = item.p || "";
      li.dataset.status = stateData.status;
      li.dataset.types = [...getQuestionTypes(item.h, item)].join(",");

      const a = createQuestionLink(cleanDisplayTitle(item.t), item.h, "", {
        href: buildHomeQuestionHref(item.h, stateData)
      });
      li.appendChild(a);

      const meta = document.createElement("div");
      meta.className = "question-meta";
      if (item.q) {
        const countBadge = document.createElement("span");
        countBadge.className = "stat-badge";
        countBadge.textContent = `${item.q}题`;
        meta.appendChild(countBadge);
      }

      const { record, pendingState } = stateData;
      const badge = document.createElement("span");
      badge.className = "stat-badge";
      if (pendingState) {
        badge.classList.add("pending");
        if (record) badge.classList.add("done");
        badge.textContent = formatPendingProgress(pendingState, pendingState.total || record?.total || item.q || 0);
      } else if (record) {
        badge.classList.add("done");
        if (record.wrong > 0) badge.classList.add("wrong");
        badge.textContent = `${formatAttemptScore(record)} · 已完成`;
      } else {
        badge.textContent = "未完成";
      }
      meta.appendChild(badge);

      const time = document.createElement("span");
      time.className = "last-time";
      if (record) {
        time.textContent = pendingState
          ? `上次成绩：${record.correct}/${record.total} · ${record.formattedTime}`
          : `做题记录：${record.formattedTime}`;
      } else if (pendingState?.savedAt) {
        time.textContent = `草稿保存：${formatLocalDateTime(pendingState.savedAt)}`;
      } else {
        time.textContent = "";
      }
      meta.appendChild(time);

      li.appendChild(meta);
      list.appendChild(li);
    }
    block.appendChild(list);
    return block;
  }

  function createPartHead(part, total) {
    const head = document.createElement("div");
    head.className = "part-head";

    const title = document.createElement("h3");
    title.textContent = part;

    const summary = document.createElement("p");
    summary.className = "part-total";
    summary.textContent = `共 ${total} 篇`;

    head.append(title, summary);
    return head;
  }

  function renderSection(sectionName, rootId, grouped, playerStateStore, trackerLookup, stateLookup) {
    const root = byId(rootId);
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
	      const card = document.createElement("article");
	      card.className = "part-card";
	      card.dataset.part = part;

      const total = freqOrder.reduce((sum, freq) => sum + grouped[sectionName][part][freq].length, 0);
      card.appendChild(createPartHead(part, total));

      const body = document.createElement("div");
      body.className = "part-body";
      for (const freq of freqOrder) {
        body.appendChild(createFreqBlock(freq, grouped[sectionName][part][freq], playerStateStore, trackerLookup, stateLookup));
      }
      card.appendChild(body);
      fragment.appendChild(card);
    }
    root.replaceChildren(fragment);
  }

  function createWrongItem(attempt) {
    const item = document.createElement("article");
    item.className = "wrong-item";
    item.dataset.wrongKey = attempt.relativePath || attempt.questionKey || attempt.title;

    const summary = document.createElement("div");
    summary.setAttribute("role", "button");
    summary.tabIndex = 0;
    summary.className = "wrong-summary";
    summary.classList.add(`freq-${freqClass[attempt.frequency] || "mid"}`);
    summary.classList.toggle("is-selected", item.dataset.wrongKey === selectedWrongAttemptKey);
    const openDetail = () => {
      selectedWrongAttemptKey = item.dataset.wrongKey;
      showAttemptDetail(attempt);
      document.querySelectorAll(".wrong-summary.is-selected").forEach((node) => node.classList.remove("is-selected"));
      summary.classList.add("is-selected");
    };
    summary.addEventListener("click", openDetail);
    summary.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail();
      }
    });

    const main = document.createElement("div");
    main.className = "wrong-summary-main";
    main.append(
      createTextElement("div", "wrong-summary-title", cleanDisplayTitle(attempt.title)),
      createTextElement("div", "wrong-summary-meta", `备注：完成于 ${attempt.formattedTime}`)
    );

    const side = document.createElement("div");
    side.className = "wrong-summary-side";
    const openLink = createActionLink("跳转原题", buildQuestionHrefWithOptions(attempt.relativePath, { review: true }), { relativePath: attempt.relativePath });
    openLink.addEventListener("click", (event) => event.stopPropagation());
    const deleteBtn = createActionButton("删除全部记录", { variant: "danger", onClick: (event) => {
        event.stopPropagation();
        deleteWrongItem(attempt);
      }});
    side.append(
      createTextElement("span", "stat-badge wrong", formatAttemptScore(attempt)),
      openLink,
      deleteBtn
    );

    summary.append(main, side);
    item.appendChild(summary);
    return item;
  }

  function getWrongbookAttemptTypes(attempt) {
    return getQuestionTypes(attempt?.relativePath || "", {
      s: attempt?.section || "",
      p: attempt?.part || "",
      t: attempt?.title || ""
    });
  }

  function normalizeWrongbookFreq(value) {
    if (value === "高频") return "high";
    if (value === "次高频") return "medium";
    if (value === "非高频") return "low";
    return value || "";
  }

  function getWrongbookQueryText(attempt, types = getWrongbookAttemptTypes(attempt)) {
    return [
      attempt?.title,
      cleanDisplayTitle(attempt?.title),
      attempt?.part,
      attempt?.frequency,
      attempt?.section,
      String(attempt?.correct ?? ""),
      String(attempt?.total ?? ""),
      [...types].map((type) => typeLabels[type] || type).join(" "),
      ...(attempt?.details || []).flatMap((detail) => [
        detail?.question,
        detail?.userAnswer,
        detail?.correctAnswer
      ])
    ].join(" ").toLowerCase();
  }

  function getWrongGroupKey(groupOrAttempt) {
    return groupOrAttempt?.key || groupOrAttempt?.relativePath || groupOrAttempt?.questionKey || groupOrAttempt?.title || "";
  }

  function getCurrentLibraryItemForAttempt(entry, attempt) {
    const ids = new Set([
      attempt?.questionId,
      entry?.questionId,
      attempt?.questionKey,
      entry?.questionKey
    ].map((value) => String(value || "").trim()).filter(Boolean));
    const paths = new Set([
      attempt?.relativePath,
      entry?.relativePath
    ].map(normalizeRelativePath).filter(Boolean));
    return currentLibraryData.find((item) => ids.has(String(item?.qid || "")) || paths.has(normalizeRelativePath(item?.h || ""))) || null;
  }

  function applyCurrentLibraryMeta(attempt, item) {
    if (!attempt || !item) return attempt;
    return {
      ...attempt,
      questionId: item.qid || attempt.questionId,
      section: item.s || attempt.section,
      part: item.p || attempt.part,
      frequency: item.f || attempt.frequency,
      title: item.t || attempt.title,
      relativePath: item.h || attempt.relativePath
    };
  }

  function getWrongbookGroups() {
    const tests = trackers.sanitizeStore(trackers.getStore())?.tests || {};
    const groups = new Map();
    Object.values(tests).forEach((entry) => {
      const rawAttempts = (Array.isArray(entry?.attempts) ? entry.attempts : [])
        .filter((attempt) => Number(attempt?.wrong || 0) > 0);
      if (!rawAttempts.length) return;
      const rawLatestAttempt = rawAttempts[rawAttempts.length - 1] || entry.latestAttempt || rawAttempts[0];
      const currentItem = getCurrentLibraryItemForAttempt(entry, rawLatestAttempt);
      const attempts = rawAttempts.map((attempt) => applyCurrentLibraryMeta(attempt, currentItem));
      const latestAttempt = applyCurrentLibraryMeta(rawLatestAttempt, currentItem);
      const key = latestAttempt.questionId || entry.questionId || latestAttempt.questionKey || entry.questionKey || latestAttempt.relativePath || entry.relativePath || latestAttempt.title;
      if (!key) return;
      const existing = groups.get(key);
      if (existing) {
        existing.attempts.push(...attempts);
        existing.attempts.sort((left, right) => (Date.parse(right.timestamp || "") || 0) - (Date.parse(left.timestamp || "") || 0));
        existing.latestAttempt = existing.attempts[0] || existing.latestAttempt;
        return;
      }
      attempts.sort((left, right) => (Date.parse(right.timestamp || "") || 0) - (Date.parse(left.timestamp || "") || 0));
      groups.set(key, {
        key,
        entry,
        attempts: attempts.slice(),
        latestAttempt: attempts[0] || latestAttempt,
        section: currentItem?.s || latestAttempt.section || entry.section || "",
        part: currentItem?.p || latestAttempt.part || entry.part || "",
        frequency: currentItem?.f || latestAttempt.frequency || entry.frequency || "",
        title: currentItem?.t || latestAttempt.title || entry.title || "",
        relativePath: currentItem?.h || latestAttempt.relativePath || entry.relativePath || ""
      });
    });
    return [...groups.values()];
  }

  function groupMatchesWrongbookFilter(group) {
    if (!group) return false;
    if (!isAuthorized() && group.section === "VIP") return false;
    if (wrongbookFilters.section !== "all" && group.section !== wrongbookFilters.section) return false;
    if (wrongbookFilters.part !== "all" && group.part !== wrongbookFilters.part) return false;
    if (wrongbookFilters.freq !== "all" && normalizeWrongbookFreq(group.frequency) !== wrongbookFilters.freq) return false;

    const types = getWrongbookAttemptTypes(group.latestAttempt);
    if (wrongbookFilters.type !== "all") {
      if (wrongbookFilters.type === "single") {
        if (!types.has("single") && !types.has("mcq")) return false;
      } else if (wrongbookFilters.type === "match") {
        if (!types.has("match") && !types.has("matching")) return false;
      } else if (!types.has(wrongbookFilters.type)) return false;
    }

    const query = String(wrongbookFilters.query || wrongbookSearch || "").trim().toLowerCase();
    if (!query) return true;
    return group.attempts.some((attempt) => getWrongbookQueryText(attempt, types).includes(query));
  }

  function sortWrongbookGroups(left, right) {
    const rightTime = Date.parse(right.latestAttempt?.timestamp || right.latestAttempt?.formattedTime || "") || 0;
    const leftTime = Date.parse(left.latestAttempt?.timestamp || left.latestAttempt?.formattedTime || "") || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    const sectionDiff = sections.indexOf(left.section) - sections.indexOf(right.section);
    if (sectionDiff !== 0) return sectionDiff;
    const partDiff = getPartNumber(left.part) - getPartNumber(right.part);
    if (partDiff !== 0) return partDiff;
    const titleDiff = getNumber(left.title) - getNumber(right.title);
    if (titleDiff !== 0) return titleDiff;
    return String(left.title).localeCompare(String(right.title));
  }

  function getFilteredWrongbookGroups() {
    return getWrongbookGroups()
      .filter(groupMatchesWrongbookFilter)
      .sort(sortWrongbookGroups);
  }

  function createWrongbookQuestionItem(group) {
    const attempt = group.latestAttempt;
	    const item = document.createElement("li");
	    item.className = "question-item wrongbook-question-item";
	    item.dataset.wrongKey = getWrongGroupKey(group);
	    item.tabIndex = 0;
	    item.setAttribute("role", "button");
	
		    const openDetail = () => {
		      const groupKey = getWrongGroupKey(group);
		      const detail = getWrongbookDetailRoot();
		      if (selectedWrongAttemptKey === groupKey && detail && !detail.hidden) {
		        closeWrongbookDetail();
		        return;
		      }
		      selectedWrongAttemptKey = groupKey;
		      selectedWrongAttemptIndex = 0;
		      renderWrongbookDetail(group);
		      document.querySelectorAll(".wrongbook-question-item.is-selected").forEach((node) => node.classList.remove("is-selected"));
		      item.classList.add("is-selected");
		    };
    item.addEventListener("click", openDetail);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail();
      }
    });

    const questions = (attempt.details || []).map((detail) => getQuestionNumber(detail.question)).filter(Number.isFinite);
    const qStart = questions.length ? Math.min(...questions) : 1;
    const qEnd = questions.length ? Math.max(...questions) : attempt.total || qStart;

    const link = createQuestionLink(cleanDisplayTitle(attempt.title), attempt.relativePath);
    link.href = buildQuestionHrefWithOptions(attempt.relativePath, {
      review: true,
      attemptTimestamp: attempt.timestamp,
      attemptSignature: attempt.signature
    });
    link.addEventListener("click", (event) => event.stopPropagation());

	    const meta = document.createElement("div");
	    meta.className = "question-meta";
    const scoreBadge = document.createElement("span");
    scoreBadge.className = "stat-badge wrong";
    scoreBadge.textContent = `${formatAttemptScore(attempt)} · ${group.attempts.length} 条记录`;
    const rangeBadge = document.createElement("span");
    rangeBadge.className = "stat-badge";
    rangeBadge.textContent = `Q${qStart}-Q${qEnd}`;
    const time = document.createElement("span");
    time.className = "last-time";
    time.textContent = `做题记录：${attempt.formattedTime || formatLocalDateTime(attempt.timestamp)}`;
	    meta.append(scoreBadge, rangeBadge, time);

    item.append(link, meta);
    return item;
  }

  function buildWrongbookGrouped(groups) {
    const grouped = {};
    parts.forEach((part) => {
      grouped[part] = {};
      freqOrder.forEach((freq) => { grouped[part][freq] = []; });
    });
    groups.forEach((group) => {
      const part = parts.includes(group.part) ? group.part : "P1";
      const freq = freqOrder.includes(group.frequency) ? group.frequency : "次高频";
      grouped[part][freq].push(group);
    });
    return grouped;
  }

  function createWrongbookFreqBlock(freq, groups) {
    const block = document.createElement("div");
    block.className = `freq-block ${freqClass[freq]}`;
    const title = document.createElement("div");
    title.className = "freq-title";
    title.appendChild(createTextElement("strong", "", freq));
    block.appendChild(title);
    const list = document.createElement("ul");
    list.className = "question-list";
    groups.forEach((group) => list.appendChild(createWrongbookQuestionItem(group)));
    block.appendChild(list);
    return block;
  }

  function refreshWrongbookFilterButtons() {
    document.querySelectorAll("[data-wrongbook-filter]").forEach((button) => {
      const filterName = button.dataset.wrongbookFilter;
      button.classList.toggle("on", wrongbookFilters[filterName] === button.dataset.value);
    });
  }

  function renderWrongbookPage(trackerLookup = buildTrackerLookup(trackers.getStore())) {
	    const root = byId("wrongbook-list");
	    if (!root) return;
	    const groups = getFilteredWrongbookGroups();
	    const summary = byId("wrongbook-summary");
	    if (summary) {
	      const total = getAllWrongGroups().length;
	      summary.textContent = `${groups.length}/${total} 篇`;
	    }
	    refreshWrongbookFilterButtons();
	
	    if (!groups.length) {
	      root.replaceChildren(createEmptyMessage("当前筛选条件下没有错题记录。"));
	      closeWrongbookDetail();
	      return;
	    }
	
	    if (selectedWrongAttemptKey && !groups.some((group) => getWrongGroupKey(group) === selectedWrongAttemptKey) && !byId("wrongbook-detail")?.hidden) {
	      closeWrongbookDetail();
	    }
	    const fragment = document.createDocumentFragment();
	    const visibleGroups = groups.slice(0, Math.max(WRONGBOOK_PAGE_SIZE, wrongbookVisibleCount));
	    const grouped = buildWrongbookGrouped(visibleGroups);
	    parts.forEach((part) => {
	      const total = freqOrder.reduce((sum, freq) => sum + grouped[part][freq].length, 0);
	      if (!total) return;
	      const card = document.createElement("article");
	      card.className = "part-card wrongbook-part-card";
	      card.dataset.part = part;
	      card.appendChild(createPartHead(part, total));
	      const body = document.createElement("div");
	      body.className = "part-body";
	      freqOrder.forEach((freq) => {
	        if (grouped[part][freq].length) {
	          body.appendChild(createWrongbookFreqBlock(freq, grouped[part][freq]));
	        }
	      });
	      card.appendChild(body);
	      fragment.appendChild(card);
	    });
	    if (visibleGroups.length < groups.length) {
	      const moreButton = createActionButton(`再显示 ${Math.min(WRONGBOOK_PAGE_SIZE, groups.length - visibleGroups.length)} 篇`, {
	        className: "wrong-passage-open",
	        onClick: () => {
	          wrongbookVisibleCount += WRONGBOOK_PAGE_SIZE;
	          renderWrongbookPage(trackerLookup);
	        }
	      });
	      const moreWrap = document.createElement("div");
	      moreWrap.className = "wrongbook-load-more";
	      moreWrap.appendChild(moreButton);
	      fragment.appendChild(moreWrap);
	    }
	    root.replaceChildren(fragment);
	  }

  function renderWrongbookPageSoon(options = {}) {
    wrongbookVisibleCount = options.keepVisible ? Math.max(WRONGBOOK_PAGE_SIZE, wrongbookVisibleCount) : WRONGBOOK_PAGE_SIZE;
    if (wrongbookRenderTimer) window.clearTimeout(wrongbookRenderTimer);
    wrongbookRenderTimer = window.setTimeout(() => {
      wrongbookRenderTimer = null;
      renderWrongbookPage(buildTrackerLookup(trackers.getStore()));
    }, Number(options.delay ?? WRONGBOOK_RENDER_DEBOUNCE_MS));
  }

	  function getWrongbookDetailRoot() {
	    let detail = byId("wrongbook-detail");
	    if (detail) return detail;
	    detail = document.createElement("aside");
	    detail.id = "wrongbook-detail";
	    detail.className = "wrongbook-detail-pane";
	    detail.hidden = true;
	    byId("wrongbook-list")?.after(detail);
	    return detail;
	  }

	  function setWrongbookDetailMode(isOpen) {
	    const detail = getWrongbookDetailRoot();
	    if (detail) detail.hidden = !isOpen;
	  }

	  function placeWrongbookDetailAfterSelectedCard() {
	    const detail = getWrongbookDetailRoot();
	    const selectedCard = selectedWrongAttemptKey
	      ? document.querySelector(`.wrongbook-question-item[data-wrong-key="${CSS.escape(selectedWrongAttemptKey)}"]`)
	      : null;
	    if (detail && selectedCard) selectedCard.after(detail);
	  }

	  function closeWrongbookDetail() {
	    selectedWrongAttemptKey = "";
	    selectedWrongAttemptIndex = 0;
	    setWrongbookDetailMode(false);
	    getWrongbookDetailRoot()?.replaceChildren();
	    document.querySelectorAll(".wrongbook-question-item.is-selected").forEach((node) => node.classList.remove("is-selected"));
	    document.querySelectorAll(".wrong-item .wrong-summary.is-selected").forEach((node) => node.classList.remove("is-selected"));
	  }
	
	  function createAttemptHistorySlide(group, attempt, index, totalCount) {
	    const card = document.createElement("div");
	    card.className = "suite-record-detail wrongbook-single-record-detail";
	    const actions = document.createElement("div");
	    actions.className = "suite-record-actions";
	    const prevButton = createActionButton("上一条", {
      className: "compact",
	      onClick: () => {
	        selectedWrongAttemptIndex = Math.max(0, index - 1);
	        renderWrongbookDetail(group);
	      }
	    });
	    const nextButton = createActionButton("下一条", {
      className: "compact",
	      onClick: () => {
	        selectedWrongAttemptIndex = Math.min(totalCount - 1, index + 1);
	        renderWrongbookDetail(group);
	      }
	    });
	    prevButton.disabled = index <= 0;
	    nextButton.disabled = index >= totalCount - 1;
	    actions.append(
	      createTextElement("strong", "", `记录 ${index + 1} / ${totalCount}`),
	      createTextElement("span", "", `${formatSuiteTime(attempt.timestamp)} · 已完成 · ${attempt.correct}/${attempt.total}`),
	      prevButton,
	      nextButton
	    );
	    card.appendChild(actions);

	    const partRow = document.createElement("div");
	    partRow.className = "suite-record-part";
	    partRow.append(
	      createTextElement("span", "", `${attempt.part || ""} ${cleanDisplayTitle(attempt.title)}`.trim()),
	      createTextElement("span", "", `${attempt.correct}/${attempt.total}`)
	    );
	    card.appendChild(partRow);

	    const recordActions = document.createElement("div");
	    recordActions.className = "suite-record-actions";
	    const reviewLink = createActionLink("回看这次", buildQuestionHrefWithOptions(attempt.relativePath, {
	        review: true,
	        attemptTimestamp: attempt.timestamp,
	        attemptSignature: attempt.signature,
	        attemptIndex: index
	      }), { relativePath: attempt.relativePath, variant: "primary" });
	    const redoButton = createActionButton("重做这篇", {
	      onClick: async () => {
	        await resetQuestionForRedo(attempt.relativePath);
	        window.open(buildQuestionHrefWithOptions(attempt.relativePath, { redo: true }), "_blank", "noopener,noreferrer");
	      }
	    });
	    recordActions.append(
	      reviewLink,
	      redoButton,
	      createActionButton("删除这次", { variant: "danger", onClick: () => deleteWrongAttempt(attempt) }),
	      createActionButton("删除全部记录", { variant: "danger", onClick: () => deleteWrongItem(attempt) })
	    );
	    card.appendChild(recordActions);
	    return card;
	  }

	  function renderWrongbookDetail(group) {
	    const root = getWrongbookDetailRoot();
	    if (!root) return;
	    root.classList.add("wrongbook-detail-pane");
	    if (!group?.latestAttempt) {
	      closeWrongbookDetail();
	      return;
	    }
	    setWrongbookDetailMode(true);
	    placeWrongbookDetailAfterSelectedCard();

	    const attempt = group.latestAttempt;
	    const detailList = document.createElement("div");
	    detailList.className = "wrongbook-detail-table";
	    selectedWrongAttemptIndex = Math.max(0, Math.min(selectedWrongAttemptIndex, group.attempts.length - 1));
	    const historyAttempt = group.attempts[selectedWrongAttemptIndex] || group.latestAttempt;
	    detailList.appendChild(createAttemptHistorySlide(group, historyAttempt, selectedWrongAttemptIndex, group.attempts.length));
    root.replaceChildren(detailList);
	  }

	  async function deleteWrongItem(attempt) {
	    if (!attempt?.relativePath) return;
	    const confirmed = askConfirm(`确定删除《${attempt.title}》的全部答题记录吗？删除后这道题会从错题本和正确率统计中移除，并恢复为未完成。`);
	    if (!confirmed) return;

    const removed = await clearQuestionData(attempt.relativePath);
    if (!removed) {
      notify("没有找到这道题的记录。");
      return;
    }

	    selectedWrongAttemptKey = "";
	    closeWrongbookDetail();
	    finalizeRecordMutation();
		    notify("这道题的全部答题记录已删除。");
	  }

	  async function deleteWrongAttempt(attempt) {
	    if (!attempt) return;
	    const confirmed = askConfirm(`确定删除《${attempt.title}》在 ${attempt.formattedTime || "这一次"} 的答题记录吗？`);
	    if (!confirmed) return;
	    const removed = trackers.removeAttemptRecord?.(attempt);
	    if (!removed) {
	      notify("没有找到这一次做题记录。");
	      return;
	    }
	    const remaining = trackers.getAttemptHistoryByPath?.(attempt.relativePath) || [];
	    const remainingWrong = remaining.filter((item) => Number(item?.wrong || 0) > 0);
	    if (!remaining.length) {
	      clearQuestionPlayerState(attempt.relativePath);
	      await clearQuestionLocalState(attempt.relativePath);
	    }
	    finalizeRecordMutation({ closeDetail: false });
	    if (remainingWrong.length) {
	      selectedWrongAttemptIndex = Math.max(0, Math.min(selectedWrongAttemptIndex, remainingWrong.length - 1));
	      syncWrongbookDetail();
	    } else {
	      closeWrongbookDetail();
	    }
	    notify(remaining.length ? "这一次答题记录已删除。" : "这道题已恢复为未完成。");
	  }

  function getWrongbookList(sectionName, trackerLookup) {
    if (!isAuthorized() && sectionName === "VIP") return [];
    const query = wrongbookSearch.trim().toLowerCase();
    return (trackerLookup?.latestAttempts || [])
      .map((attempt) => applyCurrentLibraryMeta(attempt, getCurrentLibraryItemForAttempt(null, attempt)))
      .filter((attempt) => attempt.section === sectionName && attempt.wrong > 0)
      .filter((attempt) => activeWrongbookFrequencyFilters.has(attempt.frequency))
      .filter((attempt) => {
        if (!query) return true;
        return [
          attempt.title,
          cleanDisplayTitle(attempt.title),
          attempt.part,
          attempt.frequency,
          attempt.section,
          String(attempt.correct),
          String(attempt.total)
        ].join(" ").toLowerCase().includes(query);
      })
      .sort((a, b) => {
        const partDiff = getPartNumber(a.part) - getPartNumber(b.part);
        if (partDiff !== 0) return partDiff;

        const titleDiff = getNumber(a.title) - getNumber(b.title);
        if (titleDiff !== 0) return titleDiff;

        return String(a.title).localeCompare(String(b.title));
      });
  }

  function renderWrongbook(sectionName, rootId, trackerLookup) {
    const root = byId(rootId);
    const list = getWrongbookList(sectionName, trackerLookup);

    const byPart = {};
    for (const part of parts) byPart[part] = [];
    list.forEach((attempt) => {
      const key = parts.includes(attempt.part) ? attempt.part : "P1";
      byPart[key].push(attempt);
    });

    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      const block = document.createElement("section");
      block.className = "wrongbook-part-block";
      block.appendChild(createTextElement("h4", "wrongbook-part-title", part));

      const partList = document.createElement("div");
      partList.className = "wrong-list";
      if (byPart[part].length) {
        byPart[part].forEach((attempt) => partList.appendChild(createWrongItem(attempt)));
      } else {
        partList.appendChild(createEmptyMessage(`当前${sectionName} ${part} 还没有错题记录。`));
      }

      block.appendChild(partList);
      fragment.appendChild(block);
    }

    root.replaceChildren(fragment);
  }

  function getAllWrongGroups() {
    return getWrongbookGroups()
      .filter((group) => isAuthorized() || group.section !== "VIP")
      .sort(sortWrongbookGroups);
  }

  function getAllWrongAttempts(trackerLookup = buildTrackerLookup(trackers.getStore())) {
    return getAllWrongGroups().map((group) => group.latestAttempt);
  }

  function syncWrongbookDetail(trackerLookup) {
    const groups = getAllWrongGroups();
	    if (!groups.length) {
	      selectedWrongAttemptKey = "";
	      selectedWrongAttemptIndex = 0;
	      renderWrongbookDetail(null);
	      return;
	    }
	    const selected = groups.find((group) => getWrongGroupKey(group) === selectedWrongAttemptKey) || groups[0];
	    selectedWrongAttemptKey = getWrongGroupKey(selected);
	    selectedWrongAttemptIndex = Math.max(0, Math.min(selectedWrongAttemptIndex, selected.attempts.length - 1));
	    renderWrongbookDetail(selected);
	    document.querySelectorAll(".wrong-item").forEach((item) => {
	      item.querySelector(".wrong-summary")?.classList.toggle("is-selected", item.dataset.wrongKey === selectedWrongAttemptKey);
	    });
	    document.querySelectorAll(".wrongbook-question-item").forEach((item) => {
	      item.classList.toggle("is-selected", item.dataset.wrongKey === selectedWrongAttemptKey);
	    });
  }

  function refreshWrongbookFilters() {
    document.querySelectorAll("[data-wrong-frequency]").forEach((button) => {
      button.classList.toggle("is-off", !activeWrongbookFrequencyFilters.has(button.dataset.wrongFrequency));
    });
  }

  function renderOverallStats(trackerLookup) {
    const attempts = trackerLookup?.latestAttempts || [];
    const totalCorrect = attempts.reduce((sum, item) => sum + item.correct, 0);
    const totalQuestions = attempts.reduce((sum, item) => sum + item.total, 0);
    const percent = totalQuestions ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
    const overallRate = byId("overall-rate");
    if (overallRate) {
      overallRate.textContent = totalQuestions ? `${totalCorrect}/${totalQuestions} · ${percent}%` : "未开始";
    }

    const partStats = {};
    for (const part of parts) {
      partStats[part] = { correct: 0, total: 0 };
    }

    for (const attempt of attempts) {
      if (!partStats[attempt.part]) partStats[attempt.part] = { correct: 0, total: 0 };
      partStats[attempt.part].correct += attempt.correct;
      partStats[attempt.part].total += attempt.total;
    }

    const tipList = byId("overall-tip-list");
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      const stat = partStats[part];
      const partRate = byId(`part-rate-${part.toLowerCase()}`);
      if (partRate) {
        if (stat.total) {
          const pct = Math.round((stat.correct / stat.total) * 100);
          partRate.classList.remove("is-empty");
          partRate.innerHTML = `${pct}%<small>${stat.correct}/${stat.total}</small>`;
        } else {
          partRate.classList.add("is-empty");
          partRate.textContent = "未开始";
        }
      }

      const item = document.createElement("div");
      item.className = "overall-tip-item";
      const rate = stat.total ? `${stat.correct}/${stat.total} · ${Math.round((stat.correct / stat.total) * 100)}%` : "未开始";
      item.append(
        createTextElement("span", "", part),
        createTextElement("strong", "", rate)
      );
      fragment.appendChild(item);
    }
    if (tipList) tipList.replaceChildren(fragment);
  }

	  function renderLegendStats(playerStateStore, trackerLookup, stateLookup) {
		    const counts = {
		      "高频": 0,
		      "次高频": 0,
		      "非高频": 0
		    };
		    const sectionCounts = Object.fromEntries(sections.map((section) => [section, 0]));
		    const statusCounts = { completed: 0, pending: 0, unstarted: 0 };
	    const partCounts = Object.fromEntries(parts.map((part) => [part, 0]));
	    const typeCounts = Object.fromEntries(typeOrder.map((type) => [type, 0]));
	
		    for (const item of currentLibraryData) {
		      if (sectionCounts[item.s] !== undefined) {
		        sectionCounts[item.s] += 1;
		      }
		      if (counts[item.f] !== undefined) {
	        counts[item.f] += 1;
	      }
	      if (partCounts[item.p] !== undefined) {
	        partCounts[item.p] += 1;
	      }
	      getQuestionTypes(item.h, item).forEach((type) => {
	        if (typeCounts[type] !== undefined) typeCounts[type] += 1;
	      });
      const state = getQuestionState(item, stateLookup, playerStateStore, trackerLookup).status;
      if (statusCounts[state] !== undefined) {
        statusCounts[state] += 1;
      }
    }

		    const legendText = {
		      "legend-section-normal-count": `普通 / ${sectionCounts["普通"]}篇`,
		      "legend-section-vip-count": `VIP / ${sectionCounts.VIP}篇`,
	      "legend-high-count": `高频 / ${counts["高频"]}篇`,
      "legend-mid-count": `次高频 / ${counts["次高频"]}篇`,
      "legend-low-count": `非高频 / ${counts["非高频"]}篇`,
		      "legend-completed-count": `已完成 / ${statusCounts.completed}篇`,
		      "legend-pending-count": `待完成 / ${statusCounts.pending}篇`,
		      "legend-unstarted-count": `未完成 / ${statusCounts.unstarted}篇`,
		      "legend-part-p1-count": `P1 / ${partCounts.P1}篇`,
		      "legend-part-p2-count": `P2 / ${partCounts.P2}篇`,
		      "legend-part-p3-count": `P3 / ${partCounts.P3}篇`,
		      "legend-part-p4-count": `P4 / ${partCounts.P4}篇`,
		      "legend-single-count": `单选 / ${typeCounts.single}篇`,
	      "legend-multi-count": `多选 / ${typeCounts.multi}篇`,
	      "legend-match-count": `匹配 / ${typeCounts.match}篇`,
	      "legend-map-count": `地图 / ${typeCounts.map}篇`,
	      "legend-text-count": `填空 / ${typeCounts.text}篇`
    };
	    Object.entries(legendText).forEach(([id, text]) => {
	      const element = byId(id);
	      if (element) element.textContent = text;
	    });

		    sections.forEach((section) => {
		      const buttonId = section === "普通" ? "legend-section-normal-btn" : "legend-section-vip-btn";
		      byId(buttonId)?.classList.toggle("is-off", !activeSectionFilters.has(section));
		    });

	    freqOrder.forEach((freq) => {
      const buttonId = legendButtonIds.frequency[freq];
      byId(buttonId)?.classList.toggle("is-off", !activeFrequencyFilters.has(freq));
    });

	    statusOrder.forEach((statusKey) => {
	      const buttonId = legendButtonIds.status[statusKey];
	      byId(buttonId)?.classList.toggle("is-off", !activeStatusFilters.has(statusKey));
	    });
	
	    parts.forEach((part) => {
	      const button = byId(`legend-part-${part.toLowerCase()}-btn`);
	      if (button) button.classList.toggle("is-off", !activePartFilters.has(part));
	    });

	    typeOrder.forEach((type) => {
	      const button = byId(`legend-type-${type}-btn`);
	      if (button) button.classList.toggle("is-off", !activeTypeFilters.has(type));
	    });

	    document.querySelectorAll("[data-view-mode]").forEach((button) => {
	      button.classList.toggle("is-off", button.dataset.viewMode !== questionViewMode);
	    });
	  }

  function buildSearchCollection(gridId) {
    return [...(byId(gridId)?.querySelectorAll(".part-card") || [])].map((card) => ({
      card,
      blocks: [...card.querySelectorAll(".freq-block")].map((block) => ({
        block,
        items: [...block.querySelectorAll(".question-item")]
      }))
    }));
  }

  function createTableCell(text, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = text;
    return cell;
  }

  function buildAttemptDetailTable(attempt, label) {
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "18px";

    const meta = document.createElement("div");
    meta.className = "modal-meta";
    meta.style.marginBottom = "10px";
    meta.append(
      createTextElement("strong", "", label),
      document.createTextNode(`：${attempt.formattedTime} · 正确率 ${attempt.correct}/${attempt.total} (${attempt.percent}%)`)
    );

    const table = document.createElement("table");
    table.className = "detail-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["题号", "你的答案", "正确答案", "结果"].forEach((text) => {
      const th = document.createElement("th");
      th.textContent = text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    attempt.details.forEach((detail) => {
      const row = document.createElement("tr");
      row.append(
        createTableCell(detail.question),
        createTableCell(detail.userAnswer || "未作答"),
        createTableCell(detail.correctAnswer || "无"),
        createTableCell(detail.isCorrect ? "正确" : "错误", detail.isCorrect ? "result-ok" : "result-bad")
      );
      tbody.appendChild(row);
    });

    table.append(thead, tbody);
    wrap.append(meta, table);
    return wrap;
  }

  function showAttemptDetail(attempt) {
    setLayerOpen("detail-modal", true);
    const detailTitle = byId("detail-title");
    const detailMeta = byId("detail-meta");
    if (detailTitle) detailTitle.textContent = cleanDisplayTitle(attempt.title);
    if (detailMeta) detailMeta.textContent = `${attempt.section} · ${attempt.part} · ${attempt.frequency}`;

    const history = trackers.getAttemptHistoryByPath(attempt.relativePath);
    const firstAttempt = history[0] || attempt;
    const latestAttempt = history[history.length - 1] || attempt;
    const sections = [buildAttemptDetailTable(firstAttempt, "第一次做题记录")];

    if ((latestAttempt.timestamp || latestAttempt.formattedTime || "") !== (firstAttempt.timestamp || firstAttempt.formattedTime || "")) {
      sections.push(buildAttemptDetailTable(latestAttempt, "最新一次做题记录"));
    }

    byId("detail-body")?.replaceChildren(...sections);
  }

  function getQuestionTypeIndex() {
    if (questionTypeIndexCache) return questionTypeIndexCache;
    const byPath = new Map();
    const byTitle = new Map();
    const byPassageKey = new Map();
    const addTypes = (map, key, rawTypes) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, new Set());
      const target = map.get(key);
      rawTypes.forEach((rawType) => {
        const type = normalizeQuestionType(rawType);
        if (type) target.add(type);
      });
    };

    loadLibraryData().forEach((item) => {
      addTypes(byPath, normalizeRelativePath(item.h || ""), item.types || []);
      addTypes(byTitle, getTitleKey(item.t || ""), item.types || []);
      addTypes(byPassageKey, `${item.s || ""}|${item.p || ""}|${getNumber(item.t || "") || ""}`, item.types || []);
    });

    questionTypeIndexCache = { byPath, byTitle, byPassageKey };
    return questionTypeIndexCache;
  }

  function getQuestionTypes(relativePath, item = null) {
    const normalized = normalizeRelativePath(relativePath);
    const index = getQuestionTypeIndex();
    const direct = index.byPath.get(normalized);
    if (direct?.size) return direct;

    const titleKey = getTitleKey(item?.t || getQuestionParts(normalized)?.title || normalized);
    const byTitle = index.byTitle.get(titleKey);
    if (byTitle?.size) return byTitle;

    const passageKey = `${item?.s || ""}|${item?.p || ""}|${getNumber(item?.t || "") || ""}`;
    const byPassage = index.byPassageKey.get(passageKey);
    return byPassage?.size ? byPassage : new Set();
  }

  function formatSuiteTime(value) {
    if (!value) return "";
    try {
      return new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });
    } catch (error) {
      return String(value);
    }
  }

  function getSuiteTimeValue(suite) {
    const parsed = Date.parse(suite?.updatedAt || suite?.createdAt || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeSuiteFrequencyFilter(value) {
    const next = String(value || "all").trim();
    if (next === "all" || freqOrder.includes(next)) return next;
    return "all";
  }

  function saveSuiteFrequencyFilter(value) {
    activeSuiteFrequencyFilter = normalizeSuiteFrequencyFilter(value);
    writeLocalStorage(SUITE_FREQUENCY_FILTER_KEY, activeSuiteFrequencyFilter);
    return activeSuiteFrequencyFilter;
  }

  function saveSuiteLibraryScope(value) {
    const next = ["all", "普通", "VIP"].includes(value) ? value : "all";
    activeSuiteLibraryScope = isAuthorized() ? next : "普通";
    writeLocalStorage(SUITE_LIBRARY_SCOPE_KEY, activeSuiteLibraryScope);
    return activeSuiteLibraryScope;
  }

  function getSuiteLibraryData(data) {
    const visible = getVisibleLibraryData(data);
    if (!isAuthorized()) return visible.filter((item) => item?.s === "普通");
    if (activeSuiteLibraryScope === "普通" || activeSuiteLibraryScope === "VIP") {
      return visible.filter((item) => item?.s === activeSuiteLibraryScope);
    }
    return visible;
  }

  function createSuitePartCard(item) {
    const card = document.createElement("div");
    card.className = "suite-part-card";
    card.append(
      createTextElement("div", "suite-part-label", `${item.part} · ${item.section} · ${item.frequency}`),
      createTextElement("div", "suite-part-title", cleanDisplayTitle(item.title))
    );
    return card;
  }

  let suiteLibraryRefreshPromise = null;

  async function getVerifiedSuiteLibraryData() {
    if (suiteLibraryRefreshPromise) return suiteLibraryRefreshPromise;

    suiteLibraryRefreshPromise = (async () => {
      const storedLibraryData = loadLibraryData();
      if (!window.NativeDiskStorage?.readLibraryFilesWithProgress) {
        return storedLibraryData.length ? storedLibraryData : currentLibraryData;
      }

      try {
        const result = await readLibraryDirectoryFilesWithProgress({ silent: true });
        const files = result?.files || [];
        if (!files.length) return storedLibraryData.length ? storedLibraryData : currentLibraryData;

        const fingerprint = buildLibraryFingerprintFromFiles(files);
        const previousFingerprint = readLocalStorage(LIBRARY_FINGERPRINT_KEY) || "";
        const indexedQuestionCount = (() => {
          try {
            return JSON.parse(fingerprint).length;
          } catch (error) {
            return 0;
          }
        })();
        const cacheLooksComplete = storedLibraryData.length > 0
          && indexedQuestionCount > 0
          && storedLibraryData.length === indexedQuestionCount;

        if (fingerprint === previousFingerprint && cacheLooksComplete) {
          return storedLibraryData;
        }

        setStartupProgress({
          phase: "update",
          current: 65,
          total: 100,
          message: "检测到题库索引变化，正在更新完整套题候选池..."
        });
        const rebuiltLibraryData = await buildLibraryDataFromFiles(files);
        if (!rebuiltLibraryData.length) return storedLibraryData.length ? storedLibraryData : currentLibraryData;

        const summary = getLibraryChangeSummary(rebuiltLibraryData, storedLibraryData);
        saveLibraryData(rebuiltLibraryData);
        writeLocalStorage(LIBRARY_FINGERPRINT_KEY, fingerprint);
        preserveRecordsAcrossLibraryUpdate(rebuiltLibraryData);
        suitePractice?.reconcileStoreWithLibrary?.(rebuiltLibraryData);
        currentLibraryData = getVisibleLibraryData(rebuiltLibraryData);
        setStartupProgress({
          phase: "done",
          current: 100,
          total: 100,
          message: summary.changed
            ? `完整题库已更新：新增 ${summary.added} 篇，移除/移动 ${summary.removed} 篇。`
            : `完整题库索引已校准，共 ${rebuiltLibraryData.length} 篇。`
        });
        return rebuiltLibraryData;
      } catch (error) {
        console.error("Failed to verify the full suite library:", error);
        return storedLibraryData.length ? storedLibraryData : currentLibraryData;
      } finally {
        window.setTimeout(hideStartupProgress, 450);
      }
    })();

    try {
      return await suiteLibraryRefreshPromise;
    } finally {
      suiteLibraryRefreshPromise = null;
    }
  }

  async function startSuitePractice() {
    if (!suitePractice) {
      notify("套题模块加载失败，请重新打开软件。");
      return;
    }
    const libraryData = await getVerifiedSuiteLibraryData();
    const suiteLibraryData = getSuiteLibraryData(libraryData);
    const syncedTrackerStore = trackers.syncStoreWithLibrary(suiteLibraryData);
    const excludedIdentityKeys = new Set();
    let suite = null;
    setStartupProgress({ phase: "update", current: 80, total: 100, message: "正在验证套题 P1-P4..." });
    for (let round = 0; round < 12; round += 1) {
      const candidate = suitePractice.createSuite(suiteLibraryData, syncedTrackerStore, getPlayerStateStore(), {
        preferredFrequency: activeSuiteFrequencyFilter === "all" ? "" : activeSuiteFrequencyFilter,
        excludedIdentityKeys: [...excludedIdentityKeys],
        persist: false
      });
      if (!candidate) break;
      const checks = await Promise.all((candidate.items || []).map(async (item) => {
        try {
          let html = window.NativeDiskStorage?.readQuestionHtml?.(item.path) || "";
          if (!html) {
            html = await (window.LibraryCache?.ensureQuestionHtml?.(item.path, null, { silent: true, force: true }) || Promise.resolve(""));
          }
          const match = String(html || "").match(/<script\s+id=["']test-data["']\s+type=["']application\/json["']>([\s\S]*?)<\/script>/i);
          if (!match) return false;
          const parsed = JSON.parse(match[1]);
          return !!parsed && typeof parsed === "object";
        } catch (error) {
          return false;
        }
      }));
      const failedItems = candidate.items.filter((_, index) => !checks[index]);
      if (!failedItems.length) {
        suite = suitePractice.persistSuite?.(candidate) || null;
        break;
      }
      failedItems.forEach((item) => {
        suitePractice.getItemIdentityKeys?.(item)?.forEach?.((key) => excludedIdentityKeys.add(key));
      });
    }
    window.setTimeout(hideStartupProgress, 250);
    if (!suite) {
      notify("当前题库范围内没有找到四篇均可读取的 P1-P4，请更新题库后重试。");
      return;
    }
    renderSuitePanel(suite);
    openSuitePlayer(suitePractice.getSuiteUrl(suite.id, 0));
  }

  function openSuitePlayer(url) {
    if (!url) return;
    if (window.NativeDiskStorage?.isWebLibrary) {
      window.location.href = url;
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function continueSuitePractice(suite) {
    if (!suitePractice || !suite?.id) return;
    const index = suitePractice.getResumeIndex?.(suite) || 0;
    openSuitePlayer(suitePractice.getSuiteUrl(suite.id, index));
  }

  function reviewSuitePractice(suite, index = 0) {
    if (!suitePractice || !suite?.id) return;
    const safeIndex = Math.max(0, Math.min(Number(index || 0), (suite.items || []).length - 1));
    openSuitePlayer(suitePractice.getSuiteUrl(suite.id, safeIndex, { review: true }));
  }

	  async function redoSuitePractice(suite) {
	    if (!suitePractice || !suite?.items?.length) return;
    await Promise.all((suite.items || []).map(async (item) => {
      const relativePath = item?.path || item?.h || "";
      clearQuestionPlayerState(relativePath);
      await clearQuestionLocalState(relativePath);
    }));
    const nextSuite = suitePractice.createSuiteFromItems?.(suite.items);
    if (!nextSuite) {
      notify("重做套题失败，请重新随机生成套题。");
      return;
    }
    renderSuitePanel(nextSuite);
	    openSuitePlayer(suitePractice.getSuiteUrl(nextSuite.id, 0));
	  }

	  function deleteSuiteRecord(suite) {
	    if (!suitePractice?.deleteSuite || !suite?.id) return;
	    const confirmed = askConfirm("确定删除这一次套题记录吗？删除后单篇答题记录会保留，可在错题本里单独删除。");
	    if (!confirmed) return;
	    const removed = suitePractice.deleteSuite(suite.id);
	    if (!removed) {
	      notify("没有找到这套套题记录。");
	      return;
	    }
	    selectedSuiteAttemptIndex = 0;
	    suiteHistoryPage = Math.max(0, suiteHistoryPage);
	    renderSuitePanel();
	    renderAll();
	    notify("这一次套题记录已删除，单篇答题记录已保留。");
	  }

	  function getSuiteGroupKey(suite) {
	    const keys = (suite?.items || []).map((item) => String(item.questionId || item.qid || normalizeRelativePath(item.path || item.h || "")).trim()).filter(Boolean);
	    return keys.length ? keys.join("|") : String(suite?.id || "");
	  }

	  function getSuiteScoreText(suite) {
	    const finished = !!suite?.completedAt;
	    if (!finished) return "进行中";
	    return Number(suite.totalQuestions || 0) > 0
	      ? `${suite.totalCorrect}/${suite.totalQuestions} · 预计 ${suite.estimatedBand || "-"}`
	      : "已完成";
	  }

  function groupSuiteRecords(suites) {
    const groups = new Map();
    (suites || [])
      .filter((suite) => isAuthorized() || !(suite?.items || []).some((item) => item.section === "VIP" || /^VIP\//i.test(item.path || "")))
      .forEach((suite) => {
	      const key = getSuiteGroupKey(suite);
	      if (!groups.has(key)) groups.set(key, { key, suites: [] });
	      groups.get(key).suites.push(suite);
      });
	    return [...groups.values()]
	      .map((group) => {
	        group.suites.sort((left, right) => getSuiteTimeValue(right) - getSuiteTimeValue(left));
	        group.latestSuite = group.suites[0] || null;
	        return group;
	      })
	      .sort((left, right) => getSuiteTimeValue(right.latestSuite) - getSuiteTimeValue(left.latestSuite));
	  }

	  function deleteSuiteGroup(group) {
	    const count = group?.suites?.length || 0;
	    if (!count || !suitePractice?.deleteSuite) return;
	    const confirmed = askConfirm(`确定删除这套套题的全部 ${count} 次记录吗？删除后单篇答题记录会保留，可在错题本里单独删除。`);
	    if (!confirmed) return;
	    group.suites.forEach((suite) => suitePractice.deleteSuite(suite.id));
	    selectedSuiteGroupKey = "";
	    selectedSuiteAttemptIndex = 0;
	    suiteHistoryPage = Math.max(0, suiteHistoryPage);
	    renderSuitePanel();
	    renderAll();
	    notify("这套套题的全部记录已删除，单篇答题记录已保留。");
	  }

	  function createSuiteAttemptSlide(group, suite, index, totalCount) {
	    const detail = document.createElement("div");
	    detail.className = "suite-record-detail";
	    const actions = document.createElement("div");
	    actions.className = "suite-record-actions";
	    const prevButton = createActionButton("上一条", {
      className: "compact",
	      onClick: () => {
	        selectedSuiteAttemptIndex = Math.max(0, index - 1);
	        renderSuitePanel();
	      }
	    });
	    const nextButton = createActionButton("下一条", {
      className: "compact",
	      onClick: () => {
	        selectedSuiteAttemptIndex = Math.min(totalCount - 1, index + 1);
	        renderSuitePanel();
	      }
	    });
	    prevButton.disabled = index <= 0;
	    nextButton.disabled = index >= totalCount - 1;
	    actions.append(
	      createTextElement("strong", "", `记录 ${index + 1} / ${totalCount}`),
	      createTextElement("span", "", `${formatSuiteTime(suite.createdAt)} · ${suite.completedAt ? "已完成" : "进行中"} · ${getSuiteScoreText(suite)}`),
	      prevButton,
	      nextButton
	    );
	    detail.appendChild(actions);

	    (suite.items || []).forEach((item, partIndex) => {
	      const partRow = document.createElement("div");
	      partRow.className = "suite-record-part";
	      const result = suite.results?.[String(partIndex)];
	      const stateText = result
	        ? `${result.correct}/${result.total}`
	        : (partIndex === suitePractice.getResumeIndex?.(suite) ? "待继续" : "未完成");
	      partRow.append(
	        createTextElement("span", "", `${item.part} ${cleanDisplayTitle(item.title)}`),
	        createTextElement("span", "", stateText)
	      );
	      detail.appendChild(partRow);
	    });

	    const recordActions = document.createElement("div");
	    recordActions.className = "suite-record-actions";
	    if (suite.completedAt) {
	      const reviewButton = createActionButton("回看这次", {
	        variant: "primary",
	        onClick: () => reviewSuitePractice(suite, 0)
	      });
	      const redoButton = createActionButton("重做这套", {
	        onClick: () => redoSuitePractice(suite)
	      });
	      recordActions.append(reviewButton, redoButton);
	    } else {
	      recordActions.appendChild(createActionButton("继续这次", {
	        variant: "primary",
	        onClick: () => continueSuitePractice(suite)
	      }));
	    }
	    recordActions.append(
	      createActionButton("删除这次", { variant: "danger", onClick: () => deleteSuiteRecord(suite) }),
	      createActionButton("删除全部记录", { variant: "danger", onClick: () => deleteSuiteGroup(group) })
	    );
	    detail.appendChild(recordActions);
	    return detail;
	  }

  function createSuiteHistoryPager(totalGroups) {
    const totalPages = Math.max(1, Math.ceil(Number(totalGroups || 0) / SUITE_HISTORY_PAGE_SIZE));
    suiteHistoryPage = Math.max(0, Math.min(suiteHistoryPage, totalPages - 1));
    if (totalPages <= 1) return null;

    const pager = document.createElement("div");
    pager.className = "suite-history-pager";
    const prevButton = createActionButton("上一页", {
      className: "compact",
      onClick: () => {
        suiteHistoryPage = Math.max(0, suiteHistoryPage - 1);
        selectedSuiteGroupKey = "";
        selectedSuiteAttemptIndex = 0;
        renderSuitePanel();
      }
    });
    const nextButton = createActionButton("下一页", {
      className: "compact",
      onClick: () => {
        suiteHistoryPage = Math.min(totalPages - 1, suiteHistoryPage + 1);
        selectedSuiteGroupKey = "";
        selectedSuiteAttemptIndex = 0;
        renderSuitePanel();
      }
    });
    prevButton.disabled = suiteHistoryPage <= 0;
    nextButton.disabled = suiteHistoryPage >= totalPages - 1;
    pager.append(
      prevButton,
      createTextElement("span", "suite-history-page", `第 ${suiteHistoryPage + 1} / ${totalPages} 页 · 共 ${totalGroups} 条`),
      nextButton
    );
    return pager;
  }

  function renderSuitePanel(activeSuite = null) {
    const root = byId("suite-panel");
    if (!root) return;
    suitePractice?.reconcileStoreWithLibrary?.(loadLibraryData());
    const latestSuites = (suitePractice?.listSuites?.() || [])
      .filter((item) => isAuthorized() || !(item?.items || []).some((part) => part.section === "VIP" || /^VIP\//i.test(part.path || "")));
    const suite = activeSuite || latestSuites[0] || null;
    const fragment = document.createDocumentFragment();
    const head = document.createElement("div");
    head.className = "suite-head";
    const copy = document.createElement("div");
    const freqRow = document.createElement("div");
    freqRow.style.display = "flex";
    freqRow.style.flexWrap = "wrap";
    freqRow.style.alignItems = "center";
    freqRow.style.gap = "8px";
    freqRow.style.marginTop = "12px";
    const freqLabel = createTextElement("span", "suite-desc", "抽题偏好");
    freqLabel.style.minWidth = "64px";
    const freqButtons = ["all", ...freqOrder].map((freq) => {
      const label = freq === "all" ? "全部随机" : `${freq}优先`;
      const button = createActionButton(label, {
        variant: activeSuiteFrequencyFilter === freq ? "primary" : ""
      });
      button.addEventListener("click", () => {
        saveSuiteFrequencyFilter(freq);
        renderSuitePanel(suite);
      });
      return button;
    });
    freqRow.append(freqLabel, ...freqButtons);
    const scopeRow = document.createElement("div");
    scopeRow.style.display = "flex";
    scopeRow.style.flexWrap = "wrap";
    scopeRow.style.alignItems = "center";
    scopeRow.style.gap = "8px";
    scopeRow.style.marginTop = "8px";
    const scopeLabel = createTextElement("span", "suite-desc", "题库范围");
    scopeLabel.style.minWidth = "64px";
    const scopeOptions = isAuthorized()
      ? [["all", "全部题库"], ["普通", "仅普通"], ["VIP", "仅 VIP"]]
      : [["普通", "仅普通"]];
    if (!isAuthorized()) activeSuiteLibraryScope = "普通";
    const scopeButtons = scopeOptions.map(([scope, label]) => {
      const button = createActionButton(label, {
        variant: activeSuiteLibraryScope === scope ? "primary" : ""
      });
      button.addEventListener("click", () => {
        saveSuiteLibraryScope(scope);
        renderSuitePanel(suite);
      });
      return button;
    });
    scopeRow.append(scopeLabel, ...scopeButtons);
    copy.append(
      createTextElement("div", "suite-title", "套题匹配"),
      createTextElement("div", "suite-desc", "随机组成 P1-P4 一套题。首选频率没有新题时，会从另外两种频率的新题中随机；全部新题用完后才回抽历史题。"),
      freqRow,
      scopeRow
    );
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "10px";
    actions.style.flexWrap = "wrap";
    if (suite && !suite.completedAt) {
      actions.appendChild(createActionButton("继续当前套题", { variant: "primary", onClick: () => continueSuitePractice(suite) }));
    }
    actions.appendChild(createActionButton("随机生成套题", { variant: suite && !suite.completedAt ? "" : "primary", onClick: startSuitePractice }));
    head.append(copy, actions);
    fragment.appendChild(head);

    const history = document.createElement("div");
    history.className = "suite-history";
    const suiteGroups = groupSuiteRecords(latestSuites);
    const totalSuitePages = Math.max(1, Math.ceil(suiteGroups.length / SUITE_HISTORY_PAGE_SIZE));
    suiteHistoryPage = Math.max(0, Math.min(suiteHistoryPage, totalSuitePages - 1));
    const pageStart = suiteHistoryPage * SUITE_HISTORY_PAGE_SIZE;
    const pageGroups = suiteGroups.slice(pageStart, pageStart + SUITE_HISTORY_PAGE_SIZE);
    pageGroups.forEach((group) => {
      const record = group.latestSuite;
      if (!record) return;
      const row = document.createElement("div");
      row.className = "suite-record";
      row.dataset.suiteGroupKey = group.key;
      const finished = !!record.completedAt;
      const headButton = document.createElement("button");
      headButton.type = "button";
      headButton.className = "suite-record-head";
      headButton.append(
        createTextElement("span", "", `${formatSuiteTime(record.createdAt)} · ${finished ? "已完成" : "进行中"} · ${group.suites.length} 条记录`),
        createTextElement("span", "", getSuiteScoreText(record))
      );
      headButton.addEventListener("click", () => {
        const isOpen = selectedSuiteGroupKey === group.key;
        selectedSuiteGroupKey = isOpen ? "" : group.key;
        selectedSuiteAttemptIndex = 0;
        renderSuitePanel();
      });

      const isSelected = selectedSuiteGroupKey === group.key;
      row.classList.toggle("open", isSelected);
      selectedSuiteAttemptIndex = isSelected
        ? Math.max(0, Math.min(selectedSuiteAttemptIndex, group.suites.length - 1))
        : selectedSuiteAttemptIndex;
      const detailSuite = group.suites[selectedSuiteAttemptIndex] || record;
      const detail = createSuiteAttemptSlide(group, detailSuite, isSelected ? selectedSuiteAttemptIndex : 0, group.suites.length);
      row.append(headButton, detail);
      history.appendChild(row);
    });
    if (suiteGroups.length) {
      fragment.appendChild(history);
      const pager = createSuiteHistoryPager(suiteGroups.length);
      if (pager) fragment.appendChild(pager);
    }
    root.replaceChildren(fragment);
  }

	  function closeModal() {
	    setLayerOpen("detail-modal", false);
	  }

	  function openIntroModal() {
	    setLayerOpen("intro-modal", true);
	  }

	  function closeIntroModal() {
	    setLayerOpen("intro-modal", false);
	  }

  function setActiveSideNav(activeId) {
    document.querySelectorAll(".side-nav-item").forEach((item) => item.classList.remove("on"));
    if (activeId) byId(activeId)?.classList.add("on");
  }

  function setLibraryNavActive(targetSelector) {
    document.querySelectorAll(".side-nav-item").forEach((item) => item.classList.remove("on"));
    const homeSummary = document.querySelector(".side-nav-group summary.side-nav-item");
    if (homeSummary) homeSummary.classList.add("on");
    const targetButton = document.querySelector(`[data-jump="${escapeAttrValue(targetSelector)}"]`);
    if (targetButton) targetButton.classList.add("on");
  }

  function setMainPage(page) {
    const pages = {
      "library-page": "library",
      "wrongbook-page": "wrongbook",
      "suite-page": "suite",
      "help-page": "help"
    };
    Object.entries(pages).forEach(([id, value]) => {
      const element = byId(id);
      if (element) element.hidden = page !== value;
    });
    setLayerOpen("wrongbook-modal", false);
    const top = byId("top");
    if (top) top.scrollTop = 0;
  }

  function openLibraryPage(targetSelector = "#top") {
    if (!isAuthorized() && targetSelector === "#vip-section") {
      notify("VIP 题需要授权后使用；未授权可继续使用普通题。");
      targetSelector = "#normal-section";
    }
    setMainPage("library");
    setLibraryNavActive(targetSelector);
    const target = document.querySelector(targetSelector);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openWrongbook() {
    setMainPage("wrongbook");
    setActiveSideNav("open-wrongbook-btn");
    const page = byId("wrongbook-page");
    if (page) page.hidden = false;
    wrongbookVisibleCount = WRONGBOOK_PAGE_SIZE;
    const libraryData = currentLibraryData.length ? currentLibraryData : loadLibraryData();
    const trackerLookup = buildTrackerLookup(trackers.syncStoreWithLibrary(libraryData));
    renderWrongbook("普通", "wrongbook-normal", trackerLookup);
    renderWrongbook("VIP", "wrongbook-vip", trackerLookup);
    renderWrongbookPage(trackerLookup);
    refreshWrongbookFilters();
  }

  function closeWrongbookModal() {
    if (isLayerOpen("wrongbook-page")) openLibraryPage();
    setLayerOpen("wrongbook-modal", false);
  }

  function openSuite() {
    setMainPage("suite");
    setActiveSideNav("open-suite-btn");
    suiteHistoryPage = 0;
    renderSuitePanel();
  }

  function openHelpPage() {
    setMainPage("help");
    setActiveSideNav("open-help-btn");
  }

  function toggleToolsMenu() {
    const menu = byId("tools-menu");
    if (menu) menu.hidden = !menu.hidden;
  }

  function closeToolsMenu() {
    const menu = byId("tools-menu");
    if (menu) menu.hidden = true;
  }

  function renderAll() {
    const allLibraryData = loadLibraryData();
    currentLibraryData = getVisibleLibraryData(allLibraryData);
    const summaryStore = getOrBuildRecordSummaryStore(allLibraryData);
    const trackerLookup = buildSummaryTrackerLookup(summaryStore);
    const grouped = buildGrouped(currentLibraryData);
    const playerStateStore = null;
    const stateLookup = buildSummaryStateLookup(currentLibraryData, summaryStore);
    renderLegendStats(playerStateStore, trackerLookup, stateLookup);
	    renderOverallStats(trackerLookup);
	    renderSection("普通", "normal-grid", grouped, playerStateStore, trackerLookup, stateLookup);
	    renderSection("VIP", "vip-grid", grouped, playerStateStore, trackerLookup, stateLookup);
	    setQuestionViewMode(questionViewMode);
	    searchCollections.normal = buildSearchCollection("normal-grid");
    searchCollections.vip = buildSearchCollection("vip-grid");
    if (isLayerOpen("wrongbook-modal") || isLayerOpen("wrongbook-page")) {
      const fullTrackerLookup = buildTrackerLookup(trackers.getStore());
      renderWrongbook("普通", "wrongbook-normal", fullTrackerLookup);
      renderWrongbook("VIP", "wrongbook-vip", fullTrackerLookup);
      wrongbookVisibleCount = WRONGBOOK_PAGE_SIZE;
      renderWrongbookPage(fullTrackerLookup);
      refreshWrongbookFilters();
    }
    if (isLayerOpen("suite-page")) renderSuitePanel();
    refreshAuthorizationUi();
    applySearch(currentSearch);
  }

  function refreshLegendAndFilters() {
    const playerStateStore = getPlayerStateStore();
    const trackerLookup = buildTrackerLookup(trackers.getStore());
    const libraryData = currentLibraryData.length ? currentLibraryData : loadLibraryData();
    const stateLookup = buildQuestionStateLookup(libraryData, playerStateStore, trackerLookup);
    renderLegendStats(playerStateStore, trackerLookup, stateLookup);
    applySearch(currentSearch);
  }

	  function refreshAuthorizationUi() {
	    const authorized = isAuthorized();
	    const state = authClient?.getState?.() || {};
    const status = byId("auth-status");
    const loginButton = byId("auth-login-btn");
    const vipSection = byId("vip-section");
    const suiteButton = byId("open-suite-btn");
	    const vipWrongbook = byId("wrongbook-vip")?.closest(".wrongbook-card");
	    const expiresAt = state.expiresAt || state.licenseExpiresAt || state.licenseNotAfter || "";
	    const expiresText = expiresAt
	      ? new Date(expiresAt).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
	      : "";
	
	    if (status) {
	      status.innerHTML = authorized
	        ? `VIP已解锁：<strong>${escapeHtml(state.username || "本机")}</strong>${expiresText ? ` · 至 ${escapeHtml(expiresText)}` : ""}`
	        : "未解锁：仅显示普通题；VIP记录会保留";
	    }
    if (loginButton) loginButton.hidden = authorized;
    if (vipSection) vipSection.hidden = !authorized;
    if (suiteButton) suiteButton.hidden = false;
    if (vipWrongbook) vipWrongbook.hidden = !authorized;
  }

  function buildLibraryUpdateMessage(nextCount) {
    return `网页版题库已更新，共 ${nextCount} 篇题目。记录、状态和待完成草稿会保存在当前浏览器。`;
  }

  async function updateLibraryFromSelection(files, parsedData = null) {
    const data = parsedData || await buildLibraryDataFromFiles(files);
    if (!data.length) {
      notify("网页版题库暂时没有加载成功，请刷新页面后重试。");
      return;
    }
    questionStorageKeysCache.clear();
    const fingerprint = buildLibraryFingerprintFromFiles(files || []);
    saveLibraryData(data);
    writeLocalStorage(LIBRARY_FINGERPRINT_KEY, fingerprint);
    preserveRecordsAcrossLibraryUpdate(data);
    renderAll();
    notify(buildLibraryUpdateMessage(data.length));
  }

  async function warmLibraryCacheInBackground() {
    if (window.NativeDiskStorage) return Promise.resolve(false);
    if (backgroundCacheWarmPromise) return backgroundCacheWarmPromise;

    backgroundCacheWarmPromise = (async () => {
      try {
        const libraryData = currentLibraryData.length ? currentLibraryData : loadLibraryData();
        if (!libraryData.length) return false;

        if (LibraryDirectory.isSupported()) {
          try {
            const result = await readLibraryDirectoryFiles(false, { silent: true });
            const files = result?.files || [];
            if (files.length) {
              await (window.LibraryCache?.cacheQuestionFiles?.(files) || Promise.resolve(0));
              questionStorageKeysCache.clear();
              return true;
            }
          } catch (error) {
            console.error("Failed to warm cache from saved directory:", error);
          }
        }

        let warmedCount = 0;
        const paths = libraryData.map((item) => item?.h || "").filter(Boolean);
        for (let index = 0; index < paths.length; index += 4) {
          const batch = paths.slice(index, index + 4);
          const results = await Promise.all(batch.map(async (path) => {
            try {
              const hasCached = await (window.LibraryCache?.hasQuestionHtml?.(path) || Promise.resolve(false));
              return hasCached || await fetchAndCacheQuestionHtml(path);
            } catch (error) {
              console.error("Failed to warm one question HTML:", error);
              return false;
            }
          }));
          warmedCount += results.filter(Boolean).length;
        }

        return warmedCount > 0;
      } catch (error) {
        console.error("Failed to warm library cache in background:", error);
        return false;
      } finally {
        backgroundCacheWarmPromise = null;
      }
    })();

    return backgroundCacheWarmPromise;
  }

  async function readLibraryDirectoryFiles(forcePick = false, options = {}) {
    return LibraryDirectory.readFiles(forcePick, options);
  }

  async function readLibraryDirectoryFilesWithProgress(options = {}, onProgress = null) {
    if (window.NativeDiskStorage?.readLibraryFilesWithProgress) {
      return window.NativeDiskStorage.readLibraryFilesWithProgress(options, onProgress);
    }
    return readLibraryDirectoryFiles(false, options);
  }

  function getLibraryChangeSummary(nextData, currentData) {
    const nextPaths = new Set((nextData || []).map((item) => item?.h || "").filter(Boolean));
    const currentPaths = new Set((currentData || []).map((item) => item?.h || "").filter(Boolean));
    let added = 0;
    let removed = 0;
    nextPaths.forEach((path) => { if (!currentPaths.has(path)) added += 1; });
    currentPaths.forEach((path) => { if (!nextPaths.has(path)) removed += 1; });
    return { added, removed, changed: added > 0 || removed > 0 || nextPaths.size !== currentPaths.size };
  }

  function getFrequencySummary(data) {
    const counts = Object.fromEntries(freqOrder.map((freq) => [freq, 0]));
    (data || []).forEach((item) => {
      if (counts[item?.f] !== undefined) counts[item.f] += 1;
    });
    return freqOrder.map((freq) => `${freq}${counts[freq]}篇`).join("，");
  }

  async function autoRefreshLibraryFromDisk() {
    if (!window.NativeDiskStorage) return false;
    try {
      const result = await readLibraryDirectoryFilesWithProgress({ silent: true }, setStartupProgress);
      const files = result?.files || [];
      if (!files.length) return false;
      const data = await buildLibraryDataFromFiles(files);
      if (!data.length) return false;
      const fingerprint = buildLibraryFingerprintFromFiles(files);
      const previousFingerprint = readLocalStorage(LIBRARY_FINGERPRINT_KEY) || "";
      const currentData = currentLibraryData.length ? currentLibraryData : loadLibraryData();
      const summary = getLibraryChangeSummary(data, currentData);
      const dataChanged = JSON.stringify(data) !== JSON.stringify(currentData);
      const filesChanged = fingerprint !== previousFingerprint;
      const shouldShowUpdateProgress = dataChanged || filesChanged;
      if (shouldShowUpdateProgress) {
        setStartupProgress({
          phase: "update",
          current: 95,
          message: summary.changed
            ? `检测到题库变化：新增 ${summary.added} 篇，移除/移动 ${summary.removed} 篇，正在更新数字...`
            : "检测到题库文件修改，正在重新统计数字..."
        });
      }
      if (dataChanged || filesChanged) {
        questionStorageKeysCache.clear();
        saveLibraryData(data);
        writeLocalStorage(LIBRARY_FINGERPRINT_KEY, fingerprint);
      }
      if (dataChanged || filesChanged) {
        preserveRecordsAcrossLibraryUpdate(data);
      }
      if (shouldShowUpdateProgress) {
        setStartupProgress({
          phase: "done",
          current: 100,
          total: 100,
          message: `题库、章节、Part 和频率分类已更新完成：${getFrequencySummary(data)}。`
        });
      }
      return true;
    } catch (error) {
      console.error("Failed to auto refresh library from disk:", error);
      return false;
    }
  }

  async function updateLibraryFromSavedDirectory() {
    try {
      const result = await readLibraryDirectoryFiles(true);
      if (!result) return false;

      const data = await buildLibraryDataFromFiles(result.files || []);
      if (!data.length) {
        notify("网页版题库暂时没有加载成功，请刷新页面后重试。");
        return true;
      }

      await updateLibraryFromSelection(result.files, data);
      return true;
    } catch (error) {
      console.error("Failed to update library from saved directory:", error);
      return false;
    }
  }

  function getActionButtonLabel(button) {
    return button?.querySelector?.(".side-nav-label") || button;
  }

  function setActionButtonText(button, text) {
    const label = getActionButtonLabel(button);
    if (label) label.textContent = text;
  }

  function getActionButtonText(button) {
    const label = getActionButtonLabel(button);
    return label?.textContent || "";
  }

  function applySearch(keyword) {
    currentSearch = String(keyword || "").trim().toLowerCase();

		    const allSearchItems = [
		      ...searchCollections.normal.flatMap(({ blocks }) => blocks.flatMap(({ items }) => items.map((item) => ({ item, section: "普通" })))),
		      ...searchCollections.vip.flatMap(({ blocks }) => blocks.flatMap(({ items }) => items.map((item) => ({ item, section: "VIP" }))))
		    ];
		    const countFacet = (dimension, candidate) => allSearchItems.reduce((count, { item, section }) => {
		      const itemTypes = String(item.dataset.types || "").split(",").filter(Boolean);
		      const textMatched = !currentSearch || String(item.dataset.search || "").includes(currentSearch);
		      const sectionMatched = dimension === "section"
		        ? section === candidate
		        : matchesLibraryFilter(activeSectionFilters, section);
		      const frequencyMatched = dimension === "frequency"
		        ? item.dataset.frequency === candidate
		        : matchesLibraryFilter(activeFrequencyFilters, item.dataset.frequency || "");
		      const partMatched = dimension === "part"
		        ? item.dataset.part === candidate
		        : matchesLibraryFilter(activePartFilters, item.dataset.part || "");
		      const statusMatched = dimension === "status"
		        ? item.dataset.status === candidate
		        : matchesLibraryFilter(activeStatusFilters, item.dataset.status || "");
		      const typeMatched = dimension === "type"
		        ? itemTypes.includes(candidate)
		        : (isAllFilterSelected(activeTypeFilters, typeOrder)
		          ? true
		          : (itemTypes.length ? itemTypes.some((type) => activeTypeFilters.has(type)) : false));
		      return count + (textMatched && sectionMatched && frequencyMatched && partMatched && statusMatched && typeMatched ? 1 : 0);
		    }, 0);
		    const dynamicLegendText = {
		      "legend-section-normal-count": `普通 / ${countFacet("section", "普通")}篇`,
		      "legend-section-vip-count": `VIP / ${countFacet("section", "VIP")}篇`,
		      "legend-high-count": `高频 / ${countFacet("frequency", "高频")}篇`,
		      "legend-mid-count": `次高频 / ${countFacet("frequency", "次高频")}篇`,
		      "legend-low-count": `非高频 / ${countFacet("frequency", "非高频")}篇`,
		      "legend-completed-count": `已完成 / ${countFacet("status", "completed")}篇`,
		      "legend-pending-count": `待完成 / ${countFacet("status", "pending")}篇`,
		      "legend-unstarted-count": `未完成 / ${countFacet("status", "unstarted")}篇`,
		      "legend-part-p1-count": `P1 / ${countFacet("part", "P1")}篇`,
		      "legend-part-p2-count": `P2 / ${countFacet("part", "P2")}篇`,
		      "legend-part-p3-count": `P3 / ${countFacet("part", "P3")}篇`,
		      "legend-part-p4-count": `P4 / ${countFacet("part", "P4")}篇`,
		      "legend-single-count": `单选 / ${countFacet("type", "single")}篇`,
		      "legend-multi-count": `多选 / ${countFacet("type", "multi")}篇`,
		      "legend-match-count": `匹配 / ${countFacet("type", "match")}篇`,
		      "legend-map-count": `地图 / ${countFacet("type", "map")}篇`,
		      "legend-text-count": `填空 / ${countFacet("type", "text")}篇`
		    };
		    Object.entries(dynamicLegendText).forEach(([id, text]) => {
		      const element = byId(id);
		      if (element) element.textContent = text;
		    });

		    const hasFilter = hasActiveLibraryFilter();
		    const updateGrid = (collection, emptyId, sectionName, sectionId) => {
		      const sectionElement = byId(sectionId);
		      const sectionMatched = matchesLibraryFilter(activeSectionFilters, sectionName);
		      let visibleCards = 0;
		
		      collection.forEach(({ card, blocks }) => {
		        const partMatched = matchesLibraryFilter(activePartFilters, card.dataset.part || "");
		        let visibleBlocks = 0;
		        let visibleItemCount = 0;
		        const totalItemCount = blocks.reduce((sum, entry) => sum + entry.items.length, 0);
		
		        blocks.forEach(({ block, items }) => {
		          let visibleItems = 0;
		
		          items.forEach((item) => {
		            const textMatched = !currentSearch || String(item.dataset.search || "").includes(currentSearch);
		            const freqMatched = matchesLibraryFilter(activeFrequencyFilters, item.dataset.frequency || "");
		            const statusMatched = matchesLibraryFilter(activeStatusFilters, item.dataset.status || "");
		            const itemTypes = String(item.dataset.types || "").split(",").filter(Boolean);
		            const typeMatched = isAllFilterSelected(activeTypeFilters, typeOrder)
		              ? true
		              : (itemTypes.length ? itemTypes.some((type) => activeTypeFilters.has(type)) : false);
		            const matched = hasFilter && sectionMatched && partMatched && textMatched && freqMatched && statusMatched && typeMatched;
		            item.style.display = matched ? "" : "none";
		            if (matched) visibleItems += 1;
		          });

		          block.style.display = visibleItems > 0 ? "" : "none";
		          const frequencyCount = block.querySelector(".freq-count");
		          if (frequencyCount) frequencyCount.textContent = `${visibleItems}篇`;
		          visibleItemCount += visibleItems;
		          if (visibleItems > 0) visibleBlocks += 1;
		        });

		        const partTotal = card.querySelector(".part-total");
		        if (partTotal) {
		          partTotal.textContent = visibleItemCount === totalItemCount
		            ? `共 ${totalItemCount} 篇`
		            : `显示 ${visibleItemCount} / 共 ${totalItemCount} 篇`;
		        }

		        card.style.display = hasFilter && sectionMatched && partMatched && visibleBlocks > 0 ? "" : "none";
		        if (visibleBlocks > 0) visibleCards += 1;
		      });
	
	      const empty = byId(emptyId);
		      if (sectionElement) sectionElement.hidden = !hasFilter || !sectionMatched || visibleCards === 0;
	      if (empty) {
		        empty.textContent = hasFilter
		          ? `当前筛选条件下没有匹配到${sectionName}题。`
		          : "请选择上方任意标签后显示题目。";
		        empty.style.display = hasFilter && sectionMatched && visibleCards === 0 ? "block" : "none";
		      }
	    };
	
	    updateGrid(searchCollections.normal, "normal-search-empty", "普通", "normal-section");
	    updateGrid(searchCollections.vip, "vip-search-empty", "VIP", "vip-section");
	  }

  function scheduleSearch(keyword) {
    currentSearch = String(keyword || "").trim().toLowerCase();
    if (searchFrameId != null) {
      window.cancelAnimationFrame(searchFrameId);
    }
    searchFrameId = window.requestAnimationFrame(() => {
      searchFrameId = null;
      applySearch(currentSearch);
    });
  }

  function scheduleRenderAll() {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(() => {
      renderScheduled = false;
      renderAll();
    });
  }

  function getSuiteDraftStorageKeys() {
    return getLocalStorageKeys().filter((key) => String(key || "").startsWith(SUITE_DRAFT_STORAGE_PREFIX));
  }

  function collectSuiteDraftExportData() {
    const drafts = {};
    getSuiteDraftStorageKeys().forEach((key) => {
      const parsed = parseJsonObject(readLocalStorage(key));
      if (parsed) drafts[key] = parsed;
    });
    return drafts;
  }

  function normalizeImportedSuiteDrafts(data) {
    const source = data?.suiteDrafts && typeof data.suiteDrafts === "object"
      ? data.suiteDrafts
      : data?.records?.suiteDrafts && typeof data.records.suiteDrafts === "object"
        ? data.records.suiteDrafts
        : {};
    const drafts = {};
    Object.entries(source).forEach(([key, value]) => {
      if (!String(key || "").startsWith(SUITE_DRAFT_STORAGE_PREFIX)) return;
      const parsed = parseJsonObject(value);
      if (parsed) drafts[key] = parsed;
    });
    return drafts;
  }

  function importSuiteDrafts(suiteDrafts) {
    const drafts = suiteDrafts && typeof suiteDrafts === "object" ? suiteDrafts : {};
    let importedCount = 0;
    Object.entries(drafts).forEach(([key, draft]) => {
      if (!String(key || "").startsWith(SUITE_DRAFT_STORAGE_PREFIX)) return;
      if (!draft || typeof draft !== "object") return;
      if (writeLocalStorage(key, JSON.stringify(draft))) importedCount += 1;
    });
    return importedCount;
  }

  function createRecordExportData() {
    const records = trackers.sanitizeStore(trackers.getStore());
    const playerState = sanitizePlayerStateStore(getPlayerStateStore());
    const suiteRecords = suitePractice?.getStore?.() || { version: 1, suites: {} };
    const suiteDrafts = collectSuiteDraftExportData();
    const recordSummary = readRecordSummaryStore();
    return {
      app: "ielts-listening-practice",
      exportedAt: new Date().toISOString(),
      exportVersion: RECORD_EXPORT_VERSION,
      records,
      ...records,
      playerState,
      suiteRecords,
      suiteDrafts,
      recordSummary
    };
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportRecords() {
    const exportData = {
      ...createRecordExportData()
    };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadJson(exportData, `ielts-listening-records-${stamp}.json`);
  }

  function normalizeImportedStore(data) {
    if (!data || typeof data !== "object") return null;
    const source = data.records && typeof data.records === "object" ? data.records : data;
    const tests = source.tests && typeof source.tests === "object" ? source.tests : {};
    const ignoredVocabKeys = Array.isArray(source.ignoredVocabKeys) ? source.ignoredVocabKeys : [];
    const playerState = sanitizePlayerStateStore(data.playerState || source.playerState);
    const suiteRecords = data.suiteRecords && typeof data.suiteRecords === "object"
      ? data.suiteRecords
      : source.suiteRecords && typeof source.suiteRecords === "object"
        ? source.suiteRecords
        : { version: 1, suites: {} };
    return {
      records: trackers.sanitizeStore({ version: 1, tests, ignoredVocabKeys }),
      playerState,
      suiteRecords,
      suiteDrafts: normalizeImportedSuiteDrafts(data)
    };
  }

  function mergeSuiteRecordStores(currentStore, importedStore) {
    const currentSuites = currentStore?.suites && typeof currentStore.suites === "object" ? currentStore.suites : {};
    const importedSuites = importedStore?.suites && typeof importedStore.suites === "object" ? importedStore.suites : {};
    return {
      version: 1,
      suites: {
        ...currentSuites,
        ...importedSuites
      }
    };
  }

  function getStoreSummary(store) {
    const tests = store?.tests && typeof store.tests === "object" ? store.tests : {};
    const testCount = Object.keys(tests).length;
    const attemptCount = Object.values(tests).reduce((sum, entry) => (
      sum + (Array.isArray(entry?.attempts) ? entry.attempts.length : 0)
    ), 0);
    return { testCount, attemptCount };
  }

  function importRecordsFile(file) {
    if (!file || isImportingRecords) return;
    isImportingRecords = true;
    const importButton = byId("import-wrongbook-btn");
    if (importButton) {
      importButton.disabled = true;
      importButton.dataset.originalText = getActionButtonText(importButton);
      setActionButtonText(importButton, "导入中...");
    }

    const finishImport = () => {
      isImportingRecords = false;
      if (importButton) {
        importButton.disabled = false;
        setActionButtonText(importButton, importButton.dataset.originalText || "导入答题记录");
        delete importButton.dataset.originalText;
      }
    };

    const reader = new FileReader();
    reader.onerror = () => {
      notify("导入失败：无法读取文件。");
      finishImport();
    };
    reader.onload = () => {
      try {
        const imported = normalizeImportedStore(JSON.parse(String(reader.result || "")));
        if (!imported?.records) throw new Error("invalid");

        const current = trackers.getStore();
        const currentPlayerState = getPlayerStateStore();
        const currentData = currentLibraryData.length ? currentLibraryData : loadLibraryData();
        const merged = trackers.reconcileStoreWithLibrary(
          trackers.mergeStores(current, imported.records),
          currentData
        );

        const mergedPlayerState = reconcilePlayerStateWithLibrary(
          mergePlayerStateStores(currentPlayerState, imported.playerState),
          currentData
        );

        trackers.saveStore(merged);
        savePendingPlayerStateStore(mergedPlayerState);
        if (suitePractice?.saveStore) {
          suitePractice.saveStore(mergeSuiteRecordStores(suitePractice.getStore?.(), imported.suiteRecords));
        }
        rebuildAndSaveRecordSummary(currentData);
        const suiteDraftCount = importSuiteDrafts(imported.suiteDrafts);
        window.NativeDiskStorage?.flush?.();
        finalizeRecordMutation({ closeWrongbook: true });
        const summary = getStoreSummary(imported.records);
        const suiteDraftText = suiteDraftCount ? `，套题待完成草稿 ${suiteDraftCount} 套` : "";
        notify(`答题记录导入成功：已读取 ${summary.testCount} 道题、${summary.attemptCount} 次记录${suiteDraftText}，正式记录和待完成草稿都已按当前题库自动匹配并迁移。`);
      } catch (error) {
        notify("导入失败：文件格式不正确。");
      } finally {
        finishImport();
      }
    };
    try {
      reader.readAsText(file, "utf-8");
    } catch (error) {
      notify("导入失败：无法读取文件。");
      finishImport();
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function onClick(id, handler) {
    byId(id)?.addEventListener("click", handler);
  }

  function triggerFileInput(id) {
    byId(id)?.click();
  }

  function bindModalBackdrop(id, closeHandler) {
    byId(id)?.addEventListener("click", (event) => {
      if (event.target.id === id) closeHandler();
    });
  }

	  function closeTransientUi() {
	    closeModal();
	    closeWrongbookModal();
	    closeAuthDialog();
	    closeIntroModal();
	    closeToolsMenu();
	  }

  function ensureAuthDialog() {
    let modal = byId("auth-code-modal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "auth-code-modal";
    modal.className = "modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="modal-panel" style="max-width:420px">
        <div class="modal-head">
          <div>
            <h3>解锁 VIP</h3>
            <div class="modal-meta">输入授权码后会联网校验时间，激活成功后本机解锁 VIP 7 天；到期只隐藏 VIP 内容，不删除历史记录。</div>
          </div>
        </div>
        <div style="display:grid;gap:12px">
          <input id="auth-code-input" class="filter-search" type="text" autocomplete="off" placeholder="请输入授权码">
          <div style="display:flex;justify-content:flex-end;gap:10px">
            <button id="auth-code-cancel" class="action-btn" type="button">取消</button>
            <button id="auth-code-submit" class="action-btn primary" type="button">解锁</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = () => closeAuthDialog();
    byId("auth-code-cancel")?.addEventListener("click", close);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    byId("auth-code-input")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitAuthDialog();
      if (event.key === "Escape") close();
    });
    byId("auth-code-submit")?.addEventListener("click", submitAuthDialog);
    return modal;
  }

  function closeAuthDialog() {
    const modal = byId("auth-code-modal");
    if (modal) modal.hidden = true;
  }

  function openAuthDialog() {
    const modal = ensureAuthDialog();
    const input = byId("auth-code-input");
    if (input) input.value = "";
    modal.hidden = false;
    window.setTimeout(() => input?.focus?.(), 30);
  }

  async function submitAuthDialog() {
    if (!authClient) {
      notify("授权模块加载失败。");
      return;
    }
    const input = byId("auth-code-input");
    const code = String(input?.value || "").trim();
    if (!code) {
      notify("请输入授权码。");
      input?.focus?.();
      return;
    }
    try {
      await authClient.login(code);
      closeAuthDialog();
      notify("VIP 解锁成功，本机 7 天内可用。");
      renderAll();
    } catch (error) {
      notify(error?.message || "授权失败。");
      input?.focus?.();
    }
  }

  async function clearAllRecords() {
    if (!askConfirm("确定要清空全部做题记录吗？这不会删除题目文件，但会清掉正确率、错题本、套题匹配记录和待完成草稿。")) return;
    trackers.clearAllRecords();
    clearAllPlayerState();
    clearRecordSummaryStore();
    if (suitePractice?.clearAll) {
      suitePractice.clearAll();
    } else {
      suitePractice?.saveStore?.({ version: 1, suites: {} });
      removeLocalStorage(suitePractice?.ACTIVE_KEY || "ielts_listening_active_suite_v1");
    }
    await clearAllQuestionLocalState();
    const residual = await cleanupResidualAnswerState();
    closeTransientUi();
    invalidateLibraryCache();
    questionStorageKeysCache.clear();
    renderAll();
    const remaining = Number(residual.remainingLocal || 0) + Number(residual.remainingBackup || 0);
    notify(remaining ? "已清空大部分记录，但仍发现少量残留，请重启后再清一次。" : "全部做题记录和本地作答痕迹已清空。");
  }

  async function handleAuthLogin() {
    if (!authClient) {
      notify("授权模块加载失败。");
      return;
    }
    openAuthDialog();
  }

  async function refreshAuthorizationFromServer() {
    if (!authClient?.getState?.().authorized || !authClient?.refresh) return;
    await authClient.refresh();
  }

  function handleStorageChange(event) {
    const trackerStorageKey = trackers?.STORAGE_KEY || "ielts_listening_tracker_v1";
    const suiteStorageKey = suitePractice?.STORAGE_KEY || "ielts_listening_suite_records_v1";
    if (event.key == null) {
      invalidateLibraryCache();
      invalidatePlayerStateCache();
      questionStorageKeysCache.clear();
      scheduleRenderAll();
      return;
    }

    if (event.key !== LIBRARY_STORAGE_KEY && event.key !== PLAYER_STATE_KEY && event.key !== RECORD_SUMMARY_STORAGE_KEY && event.key !== trackerStorageKey && event.key !== suiteStorageKey) {
      return;
    }

    if (event.key === LIBRARY_STORAGE_KEY) {
      invalidateLibraryCache();
      questionStorageKeysCache.clear();
    }
    if (event.key === PLAYER_STATE_KEY) {
      invalidatePlayerStateCache();
    }
    if (event.key === suiteStorageKey && isLayerOpen("suite-page")) {
      renderSuitePanel();
    }
    scheduleRenderAll();
  }

  function bindFilterButtons(selector, filterName, allValues) {
    document.querySelectorAll(selector).forEach((button) => {
      button.addEventListener("click", () => {
        const value = button.dataset[filterName];
        if (!value) return;
        toggleFilter(filterName, value, allValues);
        refreshLegendAndFilters();
      });
    });
  }

  function bindLibraryJumpNav() {
    document.querySelectorAll("[data-jump]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        openLibraryPage(button.dataset.jump || "#top");
      });
    });
  }

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("#auth-login-btn");
    if (!button) return;
    event.preventDefault();
    handleAuthLogin();
  }, true);

  byId("search-input")?.addEventListener("input", (event) => {
    scheduleSearch(event.target.value);
  });
  byId("wrongbook-search")?.addEventListener("input", (event) => {
    wrongbookSearch = event.target.value;
    wrongbookFilters.query = event.target.value;
    renderWrongbookPageSoon();
  });
  document.querySelectorAll("[data-wrongbook-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const filterName = button.dataset.wrongbookFilter;
      if (!filterName) return;
      wrongbookFilters[filterName] = button.dataset.value || "all";
      renderWrongbookPageSoon({ delay: 0 });
    });
  });
  document.querySelectorAll("[data-wrong-frequency]").forEach((button) => {
    button.addEventListener("click", () => {
      const freq = button.dataset.wrongFrequency;
      if (!freq) return;
      if (activeWrongbookFrequencyFilters.has(freq) && activeWrongbookFrequencyFilters.size > 1) {
        activeWrongbookFrequencyFilters.delete(freq);
      } else {
        activeWrongbookFrequencyFilters.add(freq);
      }
      renderAll();
    });
  });
		  bindFilterButtons(".legend button[data-section]", "section", sections);
	  bindFilterButtons(".legend button[data-frequency]", "frequency", freqOrder);
	  bindFilterButtons(".legend button[data-status]", "status", statusOrder);
	  document.querySelectorAll(".legend button[data-part]").forEach((button) => {
	    button.addEventListener("click", () => {
	      const part = button.dataset.part;
	      if (!part) return;
	      togglePartFilter(part);
	      refreshLegendAndFilters();
	    });
	  });
	  bindFilterButtons(".legend button[data-type]", "type", typeOrder);
	  document.querySelectorAll("[data-view-mode]").forEach((button) => {
	    button.addEventListener("click", () => {
	      setQuestionViewMode(button.dataset.viewMode);
	    });
	  });
	  bindLibraryJumpNav();

  onClick("open-wrongbook-btn", openWrongbook);
  onClick("open-suite-btn", openSuite);
  onClick("open-help-btn", openHelpPage);
  onClick("open-settings-btn", openSettingsModal);
  onClick("settings-close", closeSettingsModal);
  onClick("settings-done", closeSettingsModal);
  document.querySelectorAll("#settings-modal input[type='radio']").forEach((input) => input.addEventListener("change", saveSettingsForm));
  onClick("tools-toggle-btn", toggleToolsMenu);

  onClick("export-wrongbook-btn", () => {
    closeToolsMenu();
    exportRecords();
  });
  onClick("import-wrongbook-btn", () => {
    closeToolsMenu();
    triggerFileInput("import-wrongbook-file");
  });

  byId("import-wrongbook-file")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    importRecordsFile(file);
    event.target.value = "";
  });

	  onClick("wrongbook-close", closeWrongbookModal);
	  onClick("detail-close", closeModal);
	  onClick("intro-close", closeIntroModal);
  onClick("intro-help-btn", () => {
    closeIntroModal();
    openHelpPage();
  });
	  bindModalBackdrop("wrongbook-modal", closeWrongbookModal);
	  bindModalBackdrop("detail-modal", closeModal);
	  bindModalBackdrop("intro-modal", closeIntroModal);
    bindModalBackdrop("settings-modal", closeSettingsModal);

  window.addEventListener("click", (event) => {
    if (!event.target.closest(".tools-wrap")) closeToolsMenu();
  });
  onClick("clear-records-btn", clearAllRecords);
  window.addEventListener("focus", () => {
    refreshAuthorizationFromServer().finally(scheduleRenderAll);
  });
  window.addEventListener("storage", handleStorageChange);
  window.addEventListener("xiahua-auth-change", scheduleRenderAll);

  (async () => {
    await trackers.restorePersistentBackups?.();
    window.LibraryCache?.requestPersistentStorage?.();
    window.LibraryCache?.pruneLegacyAssetCache?.();
    await restoreLibraryDataBackup();
    try {
      await refreshAuthorizationFromServer();
      await autoRefreshLibraryFromDisk();
    } finally {
      hideStartupProgress();
	    }
	    renderAll();
	    openIntroModal();
	    warmLibraryCacheInBackground();
	  })();
}());
