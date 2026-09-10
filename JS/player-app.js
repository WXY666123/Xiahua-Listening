(function () {
  const ROOT_URL = new URL("../", window.location.href);
  const params = new URLSearchParams(window.location.search);
  const suiteId = String(params.get("suite") || "").trim();
  let suiteIndex = Math.max(0, Number(params.get("idx") || 0) || 0);
  const explicitSuiteReview = /^(1|true|yes)$/i.test(String(params.get("review") || ""));
  const explicitRedo = /^(1|true|yes)$/i.test(String(params.get("redo") || ""));
  const reviewAttemptTimestamp = String(params.get("attemptTs") || "");
  const reviewAttemptSignature = String(params.get("attemptSig") || "");
  const reviewAttemptIndex = Number(params.get("attemptIndex"));
  const suiteRecord = suiteId ? window.SuitePractice?.getSuite?.(suiteId) || null : null;
  let suiteItem = suiteRecord?.items?.[suiteIndex] || null;
  const isSuiteMode = !!suiteId;
  const rawSrc = String(params.get("src") || "").trim();
  let decodedSrc = suiteItem?.path || rawSrc;
  const byId = (id) => document.getElementById(id);
  const frame = byId("player-frame");
  const title = byId("title");
  const status = byId("status");
  const errorBox = byId("error");
  const playerTimer = byId("player-timer");
  const finishButton = byId("player-finish");
  const clearButton = byId("player-clear");
  const noteButton = byId("player-note");
  const transcriptButton = byId("player-transcript");
  const suiteNextButton = byId("suite-next");
  const playerSelbar = byId("player-selbar");
  const notePanel = byId("player-note-panel");
  const intensivePanel = byId("player-intensive-panel");
  const intensiveBody = byId("player-intensive-body");
  const intensivePlayButton = byId("player-intensive-play");
  const intensiveLoopButton = byId("player-intensive-loop");
  const intensiveSlowButton = byId("player-intensive-slow");
  const intensiveCnButton = byId("player-intensive-cn");
  const intensiveAnalysisButton = byId("player-intensive-analysis");
  const playerStates = window.PlayerState;
  if (!window.PracticeTracker || !playerStates) {
    showError("核心脚本加载失败，请返回题库页后重试。");
    return;
  }
  const PLAYER_STATE_KEY = playerStates?.STORAGE_KEY || "ielts_player_state_v1";
  const RECORD_SUMMARY_STORAGE_KEY = "ielts_record_summary_v1";
  const LIBRARY_STORAGE_KEY = "ielts_listening_library_v1";
  const REVIEW_PREFERENCES_KEY = "ielts_review_preferences_v1";
  const SUITE_REVIEW_GRACE_SECONDS = 2 * 60;
  const frameState = {
    observer: null,
    lastSignature: "",
    latestSubmittedDetails: [],
    activePath: "",
    activeDocument: null,
    context: null,
    playerStateKey: "",
    activeHighlightTarget: null,
    lastSelectionRange: null,
    syncTimer: null,
    restoredKey: "",
    storageKeys: new Set(),
    intervalIds: new Set(),
    finishedLocked: false,
    recordDebounceTimer: null,
    draftDebounceTimer: null,
    selbarUpdateTimer: null,
    maintenanceFrameId: null,
    suppressAutoPersist: false,
    suppressFinishHook: false,
    skipRestoreOnce: false,
    passiveWrongbookReview: !isSuiteMode && explicitSuiteReview,
    latestSuiteAttempt: null,
    suiteAudio: null,
    suiteAudioPartIndex: 0,
    suiteAudioStarted: false,
    suiteAudioStarting: false,
    suitePreloadTimer: null,
    suiteGraceDeadlineAt: 0,
    noteDrag: null,
    intensive: {
      lines: [],
      activeIndex: 0,
      loop: false,
      slow: false,
      showCn: true,
      showAnalysis: true,
      audio: null
    }
  };
  const NATIVE_UI_SELECTORS = "#save";
  const REVIEW_TABLE_SELECTOR = ".results-table td, .result-table td, .review-table td, .ans-table td, .feedback .grade-report td";
  const TRACKABLE_FIELD_SELECTOR = "input, select, textarea";
  const TRACKABLE_CLICK_SELECTOR = ".match-slot, .option, .choice, .tag";
  const SUITE_OUTER_RENDER_VERSION = 3;

  function setStatus(message, level) {
    status.textContent = message;
    status.className = "status" + (level ? " " + level : "");
  }

  function attachAudioRetry(audio, getUrl, options = {}) {
    if (!audio || audio.__xiahuaAudioRetryInstalled) return;
    const maxRetries = Number(options.maxRetries || 3);
    const getShouldPlay = typeof options.shouldPlay === "function"
      ? options.shouldPlay
      : () => !audio.paused;
    const report = typeof options.report === "function" ? options.report : setStatus;

    const reset = () => {
      audio.__xiahuaAudioRetryCount = 0;
    };
    const retry = () => {
      const count = Number(audio.__xiahuaAudioRetryCount || 0);
      if (count >= maxRetries) {
        report("音频加载失败，请重新进入本题或返回题库后重试。", "error");
        return;
      }
      audio.__xiahuaAudioRetryCount = count + 1;
      window.clearTimeout(audio.__xiahuaAudioRetryTimer);
      report("音频加载失败，正在自动重试...", "warn");
      audio.__xiahuaAudioRetryTimer = window.setTimeout(() => {
        const url = String(getUrl?.() || audio.currentSrc || audio.src || "").trim();
        if (!url) return;
        const shouldPlay = !!getShouldPlay();
        try {
          if (audio.src !== url) {
            audio.src = url;
          }
          audio.load?.();
          if (shouldPlay) {
            const promise = audio.play?.();
            if (promise?.catch) promise.catch(() => {});
          }
        } catch (error) {
          console.warn("Audio retry failed:", error);
        }
      }, count ? 900 : 300);
    };

    audio.addEventListener("loadedmetadata", reset);
    audio.addEventListener("canplay", reset);
    audio.addEventListener("error", retry);
    audio.__xiahuaAudioRetryInstalled = true;
  }

  function installFrameAudioRetry(win = getFrameWindow()) {
    const doc = win?.document;
    const audio = doc?.querySelector?.("audio");
    if (!audio) return;
    attachAudioRetry(audio, () => {
      const raw = audio.getAttribute("src") || audio.currentSrc || audio.src || "audio.mp3";
      try {
        return new URL(raw, resolveQuestionSourceUrl(decodedSrc).replace(/[^/]+$/, "")).href;
      } catch (error) {
        return audio.currentSrc || audio.src || raw;
      }
    }, {
      shouldPlay: () => !audio.paused,
      report: (message, level) => setStatus(message, level)
    });
  }

  function getCurrentSuite() {
    return isSuiteMode ? window.SuitePractice?.getSuite?.(suiteId) || suiteRecord : null;
  }

  function isCompletedSuiteReview() {
    return !!(isSuiteMode && getCurrentSuite()?.completedAt);
  }

  function isSuiteReadOnlyReview() {
    return !!(isCompletedSuiteReview() || (isSuiteMode && explicitSuiteReview));
  }

  function isReadOnlyReview() {
    return isSuiteReadOnlyReview();
  }

  function isPassiveWrongbookReview() {
    return !!(!isSuiteMode && explicitSuiteReview && frameState.passiveWrongbookReview);
  }

  function exitPassiveWrongbookReview() {
    frameState.passiveWrongbookReview = false;
  }

  function isLastSuitePart(suite = getCurrentSuite()) {
    const totalParts = Number(suite?.items?.length || 4);
    return suiteIndex >= totalParts - 1;
  }

  function hideFrameForSuiteReview() {
    if (isSuiteReadOnlyReview()) {
      frame.style.visibility = "hidden";
    }
  }

  function revealFrameForSuiteReview() {
    if (frame.style.visibility === "hidden") {
      frame.style.visibility = "";
    }
  }

  function getRemainingSuiteSeconds() {
    const suite = getCurrentSuite();
    if (!suite?.deadlineAt) return 0;
    return Math.max(0, Math.ceil((Date.parse(suite.deadlineAt) - Date.now()) / 1000));
  }

  function formatSuiteRemaining(seconds) {
    const value = Math.max(0, Math.ceil(Number(seconds || 0)));
    const minutes = Math.floor(value / 60);
    const secs = value % 60;
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function showError(message) {
    setStatus(message, "error");
    errorBox.textContent = message;
    errorBox.classList.add("show");
    frame.style.display = "none";
  }

  function isVipQuestionPath(path) {
    const normalized = window.LibraryCache?.normalizeRelativePath?.(path) || String(path || "");
    return /^VIP\//i.test(normalized) || /^IELTS Listening 虾滑VIP\//i.test(String(path || ""));
  }

  if (!window.AuthClient?.isAuthorized?.() && isVipQuestionPath(decodedSrc)) {
    showError("该内容需要授权后使用。请返回首页输入授权码，或继续使用普通题。");
    return;
  }

  function clearErrorState() {
    errorBox.textContent = "";
    errorBox.classList.remove("show");
    frame.style.display = "";
  }

  function normalizePath(path) {
    return window.PracticeTracker?.normalizePath?.(path)
      || window.LibraryCache?.normalizeRelativePath?.(path)
      || String(path || "").trim();
  }

  function getStoredLibraryData() {
    try {
      const raw = window.localStorage?.getItem(LIBRARY_STORAGE_KEY) || "";
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn("Failed to read library data for questionId lookup:", error);
      return [];
    }
  }

  function getLibraryItemQuestionId(item) {
    const direct = String(item?.questionId || item?.qid || "").trim();
    if (direct) return direct;
    return String(window.PracticeTracker?.getContextFromPath?.(item?.h || item?.path || item?.relativePath || "")?.questionId || "").trim();
  }

  function findLatestLibraryItemByQuestionId(questionId) {
    const targetId = String(questionId || "").trim();
    if (!targetId) return null;
    return getStoredLibraryData().find((item) => getLibraryItemQuestionId(item) === targetId) || null;
  }

  function resolveSuiteItemPath(item) {
    const match = findLatestLibraryItemByQuestionId(item?.questionId);
    const latestPath = normalizePath(match?.h || match?.path || match?.relativePath || "");
    return latestPath || normalizePath(item?.path || item?.h || "");
  }

  function refreshSuiteItemPath(item) {
    if (!item || typeof item !== "object") return item;
    const match = findLatestLibraryItemByQuestionId(item?.questionId);
    if (match) {
      item.section = match.s || match.section || item.section || "";
      item.part = match.p || match.part || item.part || "";
      item.frequency = match.f || match.frequency || item.frequency || "";
      item.title = match.t || match.title || item.title || "";
    }
    const latestPath = resolveSuiteItemPath(item);
    if (latestPath && latestPath !== item.path) item.path = latestPath;
    return item;
  }

  function getContextFromSrc(path) {
    return window.PracticeTracker?.getContextFromPath?.(path) || null;
  }

  function resolveQuestionSourceUrl(relativePath) {
    const normalized = normalizePath(relativePath);
    return window.LibraryCache?.resolveQuestionUrl?.(normalized, ROOT_URL)
      || new URL(normalized, ROOT_URL).href;
  }

  function formatAttemptTime(date) {
    return new Date(date).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }

  function invalidatePlayerStateCache() {
    playerStates?.invalidateCache?.();
  }

  function getPlayerStateStore() {
    return playerStates?.getStore?.() || {};
  }

  function normalizePlayerStateEntry(entry) {
    return playerStates?.normalizeEntry?.(entry) || { draft: null, completed: null };
  }

  function getPlayerStateKey() {
    if (!frameState.playerStateKey) {
      frameState.playerStateKey = frameState.context?.relativePath || normalizePath(decodedSrc);
    }
    return frameState.playerStateKey;
  }

  function getSavedPlayerState() {
    if (explicitRedo) return null;
    if (!isSuiteMode && explicitSuiteReview) return null;
    const entry = getSavedPlayerStateEntry();
    if (entry.draft?.retryPending) return entry.draft;
    const recordSnapshot = getLatestSavedRecord();
    if (!isSuiteMode && !explicitSuiteReview) {
      const base = entry.draft || entry.completed || null;
      return mergeSnapshotHighlights(mergeSnapshotHighlights(base, entry.completed), recordSnapshot);
    }
    return mergeSnapshotHighlights(entry.completed || entry.draft || null, recordSnapshot);
  }

  function getSavedPlayerStateEntry() {
    const key = getPlayerStateKey();
    return normalizePlayerStateEntry(getPlayerStateStore()[key]);
  }

  function mergeSnapshotHighlights(snapshot, fallback) {
    if (!snapshot && fallback?.highlights?.length) return { ...fallback };
    if (!snapshot || !fallback?.highlights?.length || snapshot.highlights?.length) return snapshot;
    return { ...snapshot, highlights: fallback.highlights };
  }

  function getPreviousHighlightSnapshot() {
    const entry = getSavedPlayerStateEntry();
    return entry.draft?.highlights?.length ? entry.draft : entry.completed?.highlights?.length ? entry.completed : null;
  }

  function isAnsweredSummaryValue(value) {
    const text = String(value || "").trim();
    return !!text && !/^No Answer$/i.test(text) && text !== "未作答";
  }

  function getQuestionFieldKey(field) {
    const raw = String(field?.dataQ || field?.name || field?.id || "").trim();
    if (!raw) return "";
    if (/^(?:q)?\d+(?:[-_]\d+)?$/i.test(raw)) return raw.replace(/^q/i, "").replace(/_/g, "-");
    return "";
  }

  function getSnapshotAnsweredCount(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return 0;
    const answered = new Set();
    (Array.isArray(snapshot.fields) ? snapshot.fields : []).forEach((field) => {
      const key = getQuestionFieldKey(field);
      if (!key || !isAnsweredSummaryValue(field?.value)) return;
      answered.add(key);
    });
    const choices = Array.isArray(snapshot.choices) ? snapshot.choices : [];
    choices.forEach((choice) => {
      const key = String(choice?.name || "").replace(/^q/i, "").replace(/_/g, "-");
      if (!key || !isAnsweredSummaryValue(choice?.value)) return;
      if (/^\d+-\d+$/.test(key)) {
        const [start, end] = key.split("-").map(Number);
        const groupChoices = choices.filter((item) => String(item?.name || "") === String(choice.name));
        const offset = groupChoices.indexOf(choice);
        const qid = Number.isFinite(start) && Number.isFinite(end) ? Math.min(end, start + Math.max(0, offset)) : start;
        answered.add(String(qid));
        return;
      }
      answered.add(key);
    });
    (Array.isArray(snapshot.matchingSlots) ? snapshot.matchingSlots : []).forEach((slot) => {
      const key = String(slot?.question || slot?.qid || slot?.dataQ || "").replace(/^q/i, "");
      const value = slot?.value ?? slot?.userAnswer;
      if (!key || !isAnsweredSummaryValue(value)) return;
      answered.add(key);
    });
    return answered.size;
  }

  function getSnapshotTotal() {
    const data = getFrameTestData(getFrameWindow());
    const total = Array.isArray(data?.questionIds) ? data.questionIds.length : 0;
    return total || Number(getLatestSavedRecord()?.total || 0) || 0;
  }

  function setSavedPlayerState(snapshot) {
    playerStates?.setSaved?.(getPlayerStateKey(), snapshot);
    if (snapshot) {
      updateRecordSummary({
        hasDraft: !snapshot.finishedLocked,
        hasCompleted: !!snapshot.finishedLocked,
        draftSavedAt: snapshot.savedAt || "",
        completedSavedAt: snapshot.savedAt || "",
        draftAnswered: snapshot.finishedLocked ? 0 : getSnapshotAnsweredCount(snapshot),
        draftTotal: snapshot.finishedLocked ? 0 : getSnapshotTotal()
      });
    }
  }

  function clearSavedDraftState() {
    playerStates?.clearDraft?.(getPlayerStateKey());
    updateRecordSummary({ hasDraft: false });
  }

  function clearSavedPlayerState() {
    playerStates?.clearQuestion?.(getPlayerStateKey());
    updateRecordSummary({ hasDraft: false, hasCompleted: false, hasRecord: !!getLatestSavedRecord() });
  }

  function markRetryPendingState() {
    const entry = getSavedPlayerStateEntry();
    if (!hasCompletedRecord() && !entry.completed) return;
    setSavedPlayerState({
      savedAt: new Date().toISOString(),
      fields: [],
      highlights: [],
      playerNotes: null,
      audio: null,
      transcriptOpen: false,
      reviewMode: false,
      finishedLocked: false,
      retryPending: true
    });
  }

  function clearCompletedSnapshotForRetry() {
    const key = getPlayerStateKey();
    const store = getPlayerStateStore();
    const entry = normalizePlayerStateEntry(store[key]);
    if (!entry.draft?.retryPending || !entry.completed) return;
    store[key] = playerStates?.compactEntry?.({ draft: entry.draft, completed: null }) || { draft: entry.draft, completed: null };
    playerStates?.saveStore?.(store);
  }

  function getLatestSavedRecord() {
    const path = getPlayerStateKey();
    return path ? window.PracticeTracker?.getLatestRecordByPath?.(path) || null : null;
  }

  function readRecordSummaryStore() {
    try {
      const parsed = JSON.parse(window.localStorage?.getItem(RECORD_SUMMARY_STORAGE_KEY) || "{}");
      return parsed && parsed.version === 1 && parsed.items && typeof parsed.items === "object"
        ? parsed
        : { version: 1, items: {}, updatedAt: "" };
    } catch (error) {
      return { version: 1, items: {}, updatedAt: "" };
    }
  }

  function writeRecordSummaryStore(store) {
    try {
      const next = store && typeof store === "object" ? store : { version: 1, items: {} };
      next.version = 1;
      next.updatedAt = new Date().toISOString();
      window.localStorage?.setItem(RECORD_SUMMARY_STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      console.error("Failed to write record summary:", error);
    }
  }

  function notifyRecordSummaryUpdated() {
    try {
      window.opener?.dispatchEvent?.(new StorageEvent("storage", {
        key: RECORD_SUMMARY_STORAGE_KEY,
        storageArea: window.opener.localStorage || null,
        url: window.location.href
      }));
    } catch (error) {}
  }

  function attemptToSummaryRecord(attempt) {
    if (!attempt) return null;
    return {
      questionId: attempt.questionId || "",
      questionKey: attempt.questionKey || "",
      title: attempt.title || "",
      section: attempt.section || "",
      part: attempt.part || "",
      frequency: attempt.frequency || "",
      relativePath: normalizePath(attempt.relativePath || getPlayerStateKey() || ""),
      total: Number(attempt.total || 0),
      correct: Number(attempt.correct || 0),
      wrong: Number(attempt.wrong || 0),
      percent: Number(attempt.percent || 0),
      timestamp: attempt.timestamp || "",
      formattedTime: attempt.formattedTime || ""
    };
  }

  function updateRecordSummary(patch = {}) {
    if (isSuiteMode && !frameState.context?.relativePath) return;
    const path = normalizePath(patch.relativePath || frameState.context?.relativePath || getPlayerStateKey() || "");
    if (!path) return;
    const store = readRecordSummaryStore();
    const current = store.items[path] || {};
    const attemptRecord = patch.record ? attemptToSummaryRecord(patch.record) : current.record || null;
    const hasRecord = patch.hasRecord != null ? !!patch.hasRecord : !!attemptRecord || !!current.hasRecord;
    const hasDraft = patch.hasDraft != null ? !!patch.hasDraft : !!current.hasDraft;
    const hasCompleted = patch.hasCompleted != null ? !!patch.hasCompleted : !!current.hasCompleted;
    if (!hasRecord && !hasDraft && !hasCompleted) {
      delete store.items[path];
      writeRecordSummaryStore(store);
      notifyRecordSummaryUpdated();
      return;
    }
    const now = new Date().toISOString();
    store.items[path] = {
      ...current,
      questionId: patch.questionId || frameState.context?.questionId || attemptRecord?.questionId || current.questionId || "",
      title: patch.title || frameState.context?.title || attemptRecord?.title || current.title || "",
      section: patch.section || frameState.context?.section || attemptRecord?.section || current.section || "",
      part: patch.part || frameState.context?.part || attemptRecord?.part || current.part || "",
      frequency: patch.frequency || frameState.context?.frequency || attemptRecord?.frequency || current.frequency || "",
      relativePath: path,
      status: hasRecord || hasCompleted ? (hasDraft ? "pending" : "completed") : "pending",
      hasRecord,
      hasDraft,
      hasCompleted,
      draftSavedAt: hasDraft ? (patch.draftSavedAt || now) : "",
      completedSavedAt: hasCompleted ? (patch.completedSavedAt || current.completedSavedAt || now) : "",
      draftAnswered: hasDraft ? Number(patch.draftAnswered ?? current.draftAnswered ?? 0) : 0,
      draftTotal: hasDraft ? Number(patch.draftTotal ?? current.draftTotal ?? attemptRecord?.total ?? 0) : 0,
      record: attemptRecord,
      updatedAt: now
    };
    writeRecordSummaryStore(store);
    notifyRecordSummaryUpdated();
  }

  function getReviewSavedRecord() {
    if (isSuiteMode) {
      const suiteAttempt = getCurrentSuite()?.results?.[String(suiteIndex)]?.attempt;
      if (suiteAttempt && Array.isArray(suiteAttempt.details) && suiteAttempt.details.length) {
        return suiteAttempt;
      }
    }
    const path = getPlayerStateKey();
    if (!path) return null;
    const history = window.PracticeTracker?.getAttemptHistoryByPath?.(path) || [];
    if (!Array.isArray(history) || !history.length) return getLatestSavedRecord();
    const newestFirst = history.slice().sort((left, right) => (
      (Date.parse(right?.timestamp || right?.formattedTime || "") || 0)
      - (Date.parse(left?.timestamp || left?.formattedTime || "") || 0)
    ));
    if (reviewAttemptTimestamp || reviewAttemptSignature) {
      const matched = newestFirst.find((attempt) => (
        (!reviewAttemptTimestamp || String(attempt?.timestamp || "") === reviewAttemptTimestamp)
        && (!reviewAttemptSignature || String(attempt?.signature || "") === reviewAttemptSignature)
      ));
      if (matched) return matched;
    }
    if (Number.isInteger(reviewAttemptIndex) && reviewAttemptIndex >= 0 && reviewAttemptIndex < newestFirst.length) {
      return newestFirst[reviewAttemptIndex];
    }
    return getLatestSavedRecord();
  }

  function hasCompletedRecord() {
    const record = getLatestSavedRecord();
    return !!(record && Number(record.total || 0) > 0);
  }

  function shouldResetSuitePartForFreshAttempt(savedState) {
    if (!isSuiteMode || explicitSuiteReview) return false;
    const suite = getCurrentSuite();
    if (!suite || suite.completedAt) return false;
    if (savedState) return false;
    return !suite.results?.[String(suiteIndex)];
  }

  function isActiveSuiteAttempt() {
    if (!isSuiteMode || explicitSuiteReview) return false;
    const suite = getCurrentSuite();
    return !!suite && !suite.completedAt;
  }

  function isUnifiedSuiteAudioEnabled() {
    return isActiveSuiteAttempt();
  }

  function isBlankAnswer(value) {
    return !String(value || "").trim() || /^No Answer$/i.test(String(value || "").trim());
  }

  function isWorseThanExistingRecord(attempt) {
    const existing = getLatestSavedRecord();
    if (!existing || !attempt) return false;
    if (Number(existing.total || 0) !== Number(attempt.total || 0)) return false;
    const existingDetails = Array.isArray(existing.details) ? existing.details : [];
    const nextDetails = Array.isArray(attempt.details) ? attempt.details : [];
    if (!existingDetails.length || existingDetails.length !== nextDetails.length) return false;
    const existingHasAnswers = existingDetails.some((detail) => !isBlankAnswer(detail?.userAnswer));
    const nextHasAnswers = nextDetails.some((detail) => !isBlankAnswer(detail?.userAnswer));
    return existingHasAnswers && !nextHasAnswers;
  }

  function isFinishLocked(win) {
    if (isSuiteMode && !getCurrentSuite()?.completedAt) return false;
    const completedRecord = hasCompletedRecord();
    return (frameState.finishedLocked && completedRecord) || (isReviewMode(win) && completedRecord);
  }

  function getDefaultNotePanelPosition() {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const panelWidth = Math.min(360, Math.max(280, viewportWidth - 24));
    const left = Math.max(12, viewportWidth - panelWidth - 24);
    const top = Math.max(72, Math.min(120, viewportHeight - 260));
    return { left, top };
  }

  function clampNotePanelPosition(position) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const panelWidth = notePanel?.offsetWidth || Math.min(360, Math.max(280, viewportWidth - 24));
    const panelHeight = notePanel?.offsetHeight || 260;
    const left = Math.min(
      Math.max(12, Number(position?.left) || 0),
      Math.max(12, viewportWidth - panelWidth - 12)
    );
    const top = Math.min(
      Math.max(12, Number(position?.top) || 0),
      Math.max(12, viewportHeight - panelHeight - 12)
    );
    return { left, top };
  }

  function setNotePanelPosition(position) {
    if (!notePanel) return;
    const next = clampNotePanelPosition(position || getDefaultNotePanelPosition());
    notePanel.style.left = `${Math.round(next.left)}px`;
    notePanel.style.top = `${Math.round(next.top)}px`;
  }

  function getNotePanelPosition() {
    if (!notePanel) return getDefaultNotePanelPosition();
    const left = Number.parseFloat(notePanel.style.left);
    const top = Number.parseFloat(notePanel.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      return clampNotePanelPosition({ left, top });
    }
    return getDefaultNotePanelPosition();
  }

  function syncNoteButtonState() {
    if (!noteButton) return;
    const open = !!notePanel && !notePanel.hidden;
    noteButton.classList.toggle("active", open);
    noteButton.setAttribute("aria-pressed", open ? "true" : "false");
  }

  function hideNotePanel() {
    if (!notePanel) return;
    notePanel.hidden = true;
    frameState.noteDrag = null;
    syncNoteButtonState();
  }

  function parseCueStartSeconds(value) {
    const first = String(value || "").split("-->")[0].trim().replace(",", ".");
    const parts = first.split(":").map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  function parseCueEndSeconds(value, fallback) {
    const end = String(value || "").split("-->")[1] || "";
    const seconds = parseCueStartSeconds(end);
    return seconds > fallback ? seconds : fallback + 4;
  }

  function formatCueTimeLabel(value) {
    return String(value || "").replace(/,000\b/g, "").replace(/\s*-->\s*/g, " - ");
  }

  function sanitizeInlineHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    template.content.querySelectorAll("*").forEach((element) => {
      const tag = element.tagName.toLowerCase();
      if (!["mark", "span", "strong", "em", "b", "i"].includes(tag)) {
        element.replaceWith(document.createTextNode(element.textContent || ""));
        return;
      }
      const style = tag === "mark" ? String(element.getAttribute("style") || "") : "";
      [...element.attributes].forEach((attribute) => element.removeAttribute(attribute.name));
      const color = style.match(/background-color\s*:\s*(#[0-9a-fA-F]{3,8})/)?.[1];
      if (color) element.setAttribute("style", `background-color: ${color};`);
    });
    return template.innerHTML;
  }

  function getIntensiveLines(win = getFrameWindow()) {
    const rawLines = Array.isArray(win?.DATA?.transcriptLines) ? win.DATA.transcriptLines : [];
    return rawLines
      .map((line, index) => {
        if (!line || typeof line !== "object" || line.html === undefined) return null;
        const start = parseCueStartSeconds(line.time);
        const end = parseCueEndSeconds(line.time, start);
        return {
          index,
          start,
          end,
          time: formatCueTimeLabel(line.time),
          html: sanitizeInlineHtml(line.html),
          cn: String(line.cn || ""),
          analysis: sanitizeInlineHtml(line.analysis || "")
        };
      })
      .filter(Boolean);
  }

  function getIntensiveAudio(win = getFrameWindow()) {
    return win?.document?.querySelector?.("audio") || null;
  }

  function canUseIntensive(win = getFrameWindow()) {
    if (isSuiteMode && !getCurrentSuite()?.completedAt) return false;
    return !!getIntensiveAudio(win) && getIntensiveLines(win).length > 0;
  }

  function syncIntensiveButtonState(win = getFrameWindow()) {
    void win;
  }

  function setIntensiveToggleStates() {
    const state = frameState.intensive;
    intensivePanel?.classList.toggle("hide-cn", !state.showCn);
    intensivePanel?.classList.toggle("hide-analysis", !state.showAnalysis);
    intensiveLoopButton?.classList.toggle("active", !!state.loop);
    intensiveLoopButton?.setAttribute("aria-pressed", state.loop ? "true" : "false");
    intensiveSlowButton?.classList.toggle("active", !!state.slow);
    intensiveSlowButton?.setAttribute("aria-pressed", state.slow ? "true" : "false");
    intensiveCnButton?.classList.toggle("active", !!state.showCn);
    intensiveCnButton?.setAttribute("aria-pressed", state.showCn ? "true" : "false");
    intensiveAnalysisButton?.classList.toggle("active", !!state.showAnalysis);
    intensiveAnalysisButton?.setAttribute("aria-pressed", state.showAnalysis ? "true" : "false");
  }

  function renderIntensivePanel(win = getFrameWindow()) {
    if (!intensiveBody) return false;
    const lines = getIntensiveLines(win);
    frameState.intensive.lines = lines;
    if (!lines.length) {
      intensiveBody.innerHTML = '<div class="player-empty-state">当前题目没有可精听的时间轴原文。</div>';
      return false;
    }
    const state = frameState.intensive;
    intensiveBody.innerHTML = lines.map((line, index) => `
      <button class="player-intensive-line${index === state.activeIndex ? " active" : ""}" type="button" data-index="${index}">
        <span class="player-intensive-time">${escapeText(line.time)}</span>
        <span class="player-intensive-text">
          ${line.html}
          ${line.cn ? `<span class="player-intensive-cn">${escapeText(line.cn)}</span>` : ""}
          ${line.analysis ? `<span class="player-intensive-analysis">${line.analysis}</span>` : ""}
        </span>
      </button>
    `).join("");
    setIntensiveToggleStates();
    return true;
  }

  function setActiveIntensiveLine(index, options = {}) {
    const lines = frameState.intensive.lines;
    if (!lines.length) return;
    const nextIndex = Math.min(Math.max(0, Number(index) || 0), lines.length - 1);
    frameState.intensive.activeIndex = nextIndex;
    intensiveBody?.querySelectorAll?.(".player-intensive-line").forEach((line) => {
      line.classList.toggle("active", Number(line.dataset.index) === nextIndex);
    });
    const active = intensiveBody?.querySelector?.(`.player-intensive-line[data-index="${nextIndex}"]`);
    if (options.scroll !== false) {
      active?.scrollIntoView?.({ block: "nearest" });
    }
  }

  function playIntensiveLine(index = frameState.intensive.activeIndex) {
    const win = getFrameWindow();
    const audio = getIntensiveAudio(win);
    const lines = frameState.intensive.lines.length ? frameState.intensive.lines : getIntensiveLines(win);
    if (!audio || !lines.length) return;
    frameState.intensive.lines = lines;
    const nextIndex = Math.min(Math.max(0, Number(index) || 0), lines.length - 1);
    const line = lines[nextIndex];
    setActiveIntensiveLine(nextIndex);
    audio.currentTime = Math.max(0, line.start);
    audio.playbackRate = frameState.intensive.slow ? 0.8 : Number(audio.playbackRate || 1);
    audio.play?.();
  }

  function syncIntensiveActiveFromAudio() {
    const audio = frameState.intensive.audio;
    const lines = frameState.intensive.lines;
    if (!audio || !lines.length || intensivePanel?.hidden) return;
    const current = Number(audio.currentTime || 0);
    const currentIndex = lines.findIndex((line, index) => (
      current >= line.start && current < (lines[index + 1]?.start ?? line.end)
    ));
    if (currentIndex >= 0 && currentIndex !== frameState.intensive.activeIndex) {
      setActiveIntensiveLine(currentIndex, { scroll: true });
    }
    const active = lines[frameState.intensive.activeIndex];
    if (frameState.intensive.loop && active && current >= active.end - 0.08) {
      audio.currentTime = Math.max(0, active.start);
      audio.play?.();
    }
  }

  function installIntensiveAudioSync(win = getFrameWindow()) {
    const audio = getIntensiveAudio(win);
    if (!audio || audio === frameState.intensive.audio) return;
    if (frameState.intensive.audio && frameState.intensiveAudioHandler) {
      frameState.intensive.audio.removeEventListener("timeupdate", frameState.intensiveAudioHandler);
      frameState.intensive.audio.removeEventListener("pause", frameState.intensivePauseHandler);
      frameState.intensive.audio.removeEventListener("play", frameState.intensivePlayHandler);
    }
    frameState.intensive.audio = audio;
    frameState.intensiveAudioHandler = syncIntensiveActiveFromAudio;
    frameState.intensivePauseHandler = () => {
      if (intensivePlayButton) intensivePlayButton.textContent = "播放";
    };
    frameState.intensivePlayHandler = () => {
      if (intensivePlayButton) intensivePlayButton.textContent = "暂停";
    };
    audio.addEventListener("timeupdate", frameState.intensiveAudioHandler);
    audio.addEventListener("pause", frameState.intensivePauseHandler);
    audio.addEventListener("play", frameState.intensivePlayHandler);
  }

  function showIntensivePanel() {
    const win = getFrameWindow();
    if (!canUseIntensive(win)) {
      setStatus("当前题目没有可精听的时间轴原文。", "warn");
      syncIntensiveButtonState(win);
      return;
    }
    installIntensiveAudioSync(win);
    frameState.intensive.lines = getIntensiveLines(win);
    if (!renderIntensivePanel(win)) return;
    intensivePanel.hidden = false;
    const audio = getIntensiveAudio(win);
    if (audio) {
      const index = frameState.intensive.lines.findIndex((line, lineIndex) => (
        Number(audio.currentTime || 0) >= line.start
        && Number(audio.currentTime || 0) < (frameState.intensive.lines[lineIndex + 1]?.start ?? line.end)
      ));
      setActiveIntensiveLine(index >= 0 ? index : frameState.intensive.activeIndex, { scroll: true });
    }
    syncIntensiveButtonState(win);
    transcriptButton?.classList.add("active");
    transcriptButton?.setAttribute("aria-pressed", "true");
  }

  function hideIntensivePanel() {
    transcriptButton?.classList.remove("active");
    transcriptButton?.setAttribute("aria-pressed", "false");
  }

  function toggleIntensivePanel() {
    performTranscriptToggle(getFrameWindow());
  }

  function showNotePanel(options) {
    void options;
  }

  function toggleNotePanel() {
    if (!notePanel) return;
    if (notePanel.hidden) {
      showNotePanel();
    } else {
      hideNotePanel();
    }
  }

  function clearPlayerNotes() {
  }

  function collectPlayerNotesSnapshot() {
    return null;
  }

  function restorePlayerNotesSnapshot(playerNotes) {
    void playerNotes;
  }

  function escapeAttrValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function escapeSelectorValue(value) {
    const text = String(value || "");
    if (window.CSS?.escape) return window.CSS.escape(text);
    return text.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }

  function buildFieldSelector(field) {
    if (!field || !field.tag) return "";
    const tag = String(field.tag).toLowerCase();

    if (field.id) return `${tag}#${escapeSelectorValue(field.id)}`;
    if (field.name && (field.type === "radio" || field.type === "checkbox")) {
      return `${tag}[name="${escapeAttrValue(field.name)}"][value="${escapeAttrValue(field.value || "")}"]`;
    }
    if (field.name) return `${tag}[name="${escapeAttrValue(field.name)}"]`;
    if (field.dataQ) return `${tag}[data-q="${escapeAttrValue(field.dataQ)}"]`;
    return "";
  }

  function getMatchingSlotQuestion(slot) {
    return String(
      slot?.dataset?.q
      || slot?.dataset?.question
      || slot?.getAttribute?.("data-q")
      || slot?.getAttribute?.("data-question")
      || ""
    ).trim();
  }

  function getMatchingSlotValue(slot) {
    const tag = slot?.querySelector?.(".tag, .drag-option, .draggable-option, .drag-item, [draggable='true']");
    return String(
      tag?.dataset?.value
      || tag?.dataset?.answer
      || tag?.textContent
      || slot?.dataset?.value
      || ""
    ).trim();
  }

  function getMatchingOptionDisplayText(slot, value) {
    const text = String(value || "").trim();
    if (!slot || !text) return text;
    const escaped = escapeAttrValue(text);
    const selector = [
      `.drag[data-value="${escaped}"]`,
      `.drag-option[data-value="${escaped}"]`,
      `.draggable-option[data-value="${escaped}"]`,
      `.drag-item[data-value="${escaped}"]`,
      `.match-choice[data-value="${escaped}"]`
    ].join(",");
    const group = slot.closest?.(".group, .matching-group");
    const option = group?.querySelector?.(selector) || slot.ownerDocument?.querySelector?.(selector);
    return String(option?.textContent || "").replace(/\s+/g, " ").trim() || text;
  }

  function refreshMatchingSlotLabels(win) {
    const doc = win?.document;
    if (!doc) return;
    doc.querySelectorAll(".match-slot, .drop-zone, .dropzone, .droppable, .slot, .suite-slot").forEach((slot) => {
      const value = getMatchingSlotValue(slot);
      if (!value) return;
      const display = getMatchingOptionDisplayText(slot, value);
      const tag = slot.querySelector?.(".tag, .drag-option, .draggable-option, .drag-item, [draggable='true']");
      if (tag) {
        if (String(tag.textContent || "").trim() !== display) tag.textContent = display;
      } else if (slot.classList?.contains("suite-slot") && String(slot.textContent || "").trim() !== display) {
        slot.textContent = display;
      }
    });
  }

  function collectMatchingSlotSnapshots(win) {
    const doc = win?.document;
    if (!doc) return [];
    return [...doc.querySelectorAll(".match-slot, .drop-zone, .dropzone, .droppable, .slot, .suite-slot")]
      .map((slot) => ({
        question: getMatchingSlotQuestion(slot),
        value: getMatchingSlotValue(slot)
      }))
      .filter((slot) => slot.question && slot.value);
  }

  function findMatchingSlot(doc, question) {
    const escaped = escapeAttrValue(question);
    const selectors = [
      `.match-slot[data-q="${escaped}"]`,
      `.match-slot[data-question="${escaped}"]`,
      `.drop-zone[data-q="${escaped}"]`,
      `.drop-zone[data-question="${escaped}"]`,
      `.dropzone[data-q="${escaped}"]`,
      `.dropzone[data-question="${escaped}"]`,
      `.droppable[data-q="${escaped}"]`,
      `.droppable[data-question="${escaped}"]`,
      `.slot[data-q="${escaped}"]`,
      `.slot[data-question="${escaped}"]`,
      `.suite-slot[data-q="${escaped}"]`,
      `.suite-slot[data-question="${escaped}"]`
    ];
    for (const selector of selectors) {
      const slot = doc.querySelector(selector);
      if (slot) return slot;
    }
    return null;
  }

  function setMatchingSlotValue(win, question, value) {
    const doc = win?.document;
    const text = String(value || "").trim();
    if (!doc || !question || !text || isBlankAnswer(text)) return false;
    const slot = findMatchingSlot(doc, String(question));
    if (!slot) return false;

    let tag = slot.querySelector(".tag, .drag-option, .draggable-option, .drag-item, [draggable='true']");
    if (!tag) {
      tag = doc.createElement("span");
      tag.className = "tag";
      slot.appendChild(tag);
    }
    tag.textContent = getMatchingOptionDisplayText(slot, text);
    tag.dataset.value = text;
    tag.setAttribute("draggable", "false");
    slot.dataset.value = text;
    return true;
  }

  function restoreMatchingAnswers(win, detailsOrSlots) {
    if (!Array.isArray(detailsOrSlots) || !detailsOrSlots.length) return false;
    let restored = 0;
    detailsOrSlots.forEach((item) => {
      if (setMatchingSlotValue(win, item.question, item.userAnswer ?? item.value)) restored += 1;
    });
    return restored > 0;
  }

  function clearAnswerUiForRecordReview(win) {
    const doc = win?.document;
    if (!doc) return;
    doc.querySelectorAll("input, textarea, select").forEach((element) => {
      const tag = element.tagName;
      const type = String(element.type || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        element.checked = false;
      } else if (tag === "SELECT") {
        element.selectedIndex = 0;
      } else {
        element.value = "";
      }
      dispatchFieldEvent(element, "input");
      dispatchFieldEvent(element, "change");
    });
    doc.querySelectorAll(".single-choice.selected, .multi-choice.selected, .map-choice.selected")
      .forEach((element) => element.classList.remove("selected"));
    clearMatchingUiState(win);
  }

  function applyAttemptDetailsToFrame(win, details) {
    const doc = win?.document;
    if (!doc || !Array.isArray(details) || !details.length) return false;
    const multiChoiceGroups = new Map();
    const addMultiChoiceGroup = (groupName, ids) => {
      const safeGroupName = String(groupName || "").trim();
      const safeIds = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
      if (!safeGroupName || !safeIds.length) return;
      if (!multiChoiceGroups.has(safeGroupName)) {
        multiChoiceGroups.set(safeGroupName, { ids: safeIds, values: [] });
      }
    };
    doc.querySelectorAll(".multi-choice[data-name][data-group]").forEach((choice) => {
      const group = String(choice.dataset.group || "").trim();
      const name = String(choice.dataset.name || "").trim();
      if (!group || !name) return;
      const ids = getQuestionRangeFromKey(`q${group.replace("-", "_")}`);
      addMultiChoiceGroup(name, ids);
    });
    doc.querySelectorAll(".multi-choice[data-name]").forEach((choice) => {
      const name = String(choice.dataset.name || "").trim();
      if (!name) return;
      const ids = getQuestionRangeFromKey(name);
      if (ids.length > 1) addMultiChoiceGroup(name, ids);
    });
    const testData = getFrameTestData(win);
    (testData?.groups || []).forEach((group) => {
      if (group?.type !== "multiple" || !group.id) return;
      const name = `q${String(group.id).replace("-", "_")}`;
      addMultiChoiceGroup(name, getQuestionRangeFromKey(name));
    });
    let applied = 0;
    details.forEach((detail) => {
      const question = String(detail?.question || "").trim();
      const answerText = String(detail?.userAnswer || "").trim();
      if (!question || isBlankAnswer(answerText)) return;
      const name = `q${question}`;
      const answers = answerText.split(/\s*,\s*/).map((item) => item.trim()).filter(Boolean);
      const textField = doc.querySelector(`input[name="${escapeAttrValue(name)}"]:not([type='radio']):not([type='checkbox']), textarea[name="${escapeAttrValue(name)}"]`);
      if (textField) {
        textField.value = answerText;
        dispatchFieldEvent(textField, "input");
        dispatchFieldEvent(textField, "change");
        applied += 1;
        return;
      }
      answers.forEach((answer) => {
        const choice = doc.querySelector(`input[name="${escapeAttrValue(name)}"][value="${escapeAttrValue(answer)}"]`);
        if (choice) {
          choice.checked = true;
          dispatchFieldEvent(choice, "change");
          applied += 1;
        }
        doc.querySelectorAll(`[data-name="${escapeAttrValue(name)}"][data-value="${escapeAttrValue(answer)}"], [data-q="${escapeAttrValue(question)}"][data-value="${escapeAttrValue(answer)}"]`)
          .forEach((element) => {
            element.classList.add("selected");
            applied += 1;
          });
      });
      multiChoiceGroups.forEach((group) => {
        if (!group.ids.includes(question)) return;
        answers.forEach((answer) => {
          if (answer) group.values.push(answer);
        });
      });
      if (setMatchingSlotValue(win, question, answerText)) applied += 1;
    });
    multiChoiceGroups.forEach((group, groupName) => {
      [...new Set(group.values)].forEach((answer) => {
        const element = doc.querySelector(
          `.multi-choice[data-name="${escapeAttrValue(groupName)}"][data-value="${escapeAttrValue(answer)}"]`
        );
        if (!element) return;
        element.classList.add("selected");
        applied += 1;
      });
    });
    win.updateNav?.();
    return applied > 0;
  }

  function collectChoiceSnapshots(win) {
    const doc = win?.document;
    if (!doc) return [];
    return [...doc.querySelectorAll(".single-choice.selected, .multi-choice.selected, .map-choice.selected")]
      .map((choice) => ({
        kind: choice.classList.contains("multi-choice")
          ? "multi"
          : choice.classList.contains("map-choice") ? "map" : "single",
        name: String(choice.dataset?.name || "").trim(),
        value: String(choice.dataset?.value || "").trim()
      }))
      .filter((choice) => choice.name && choice.value);
  }

  function restoreChoiceSnapshots(win, choices) {
    const doc = win?.document;
    if (!doc || !Array.isArray(choices) || !choices.length) return false;

    const selectorByKind = {
      single: ".single-choice",
      multi: ".multi-choice",
      map: ".map-choice"
    };
    let restored = 0;
    choices.forEach((choice) => {
      const selector = selectorByKind[choice?.kind];
      if (!selector || !choice.name || !choice.value) return;
      if (choice.kind !== "multi") {
        doc.querySelectorAll(`${selector}[data-name="${escapeAttrValue(choice.name)}"]`)
          .forEach((element) => element.classList.remove("selected"));
      }
      const element = doc.querySelector(
        `${selector}[data-name="${escapeAttrValue(choice.name)}"][data-value="${escapeAttrValue(choice.value)}"]`
      );
      if (!element) return;
      element.classList.add("selected");
      restored += 1;
    });
    if (restored) {
      win.updateNav?.();
    }
    return restored > 0;
  }

  function clearMatchingUiState(win) {
    const doc = win?.document;
    if (!doc) return;
    const slotSelector = ".match-slot, .drop-zone, .dropzone, .droppable, .slot, .suite-slot, [data-drop-zone], [data-question][class*='slot']";
    const answerSelector = ".tag, .drag-option, .draggable-option, .drag-item, [draggable='true']";
    doc.querySelectorAll(slotSelector).forEach((slot) => {
      slot.querySelectorAll(answerSelector).forEach((item) => item.remove());
      ["value", "answer", "selected", "choice", "option"].forEach((name) => {
        try { delete slot.dataset[name]; } catch {}
        slot.removeAttribute(`data-${name}`);
      });
      slot.classList.remove("filled", "selected", "answered", "correct", "incorrect", "wrong");
      dispatchFieldEvent(slot, "input");
      dispatchFieldEvent(slot, "change");
    });
    doc.querySelectorAll(".drag-option, .draggable-option, .drag-item, [draggable='true']").forEach((item) => {
      if (item.closest(slotSelector)) return;
      item.setAttribute("draggable", "true");
      item.classList.remove("used", "selected", "disabled", "correct", "incorrect", "wrong");
      item.removeAttribute("aria-disabled");
      item.removeAttribute("disabled");
      item.style.pointerEvents = "";
      item.style.opacity = "";
      item.hidden = false;
    });
  }

  function collectFrameSnapshot(win) {
    const doc = win?.document;
    if (!doc) return null;

    const fields = [...doc.querySelectorAll(TRACKABLE_FIELD_SELECTOR)]
      .filter((element) => !element.closest?.("#notes, #notes-panel, #notes-sidebar"))
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        return {
          tag,
          type: String(element.type || "").toLowerCase(),
          id: element.id || "",
          name: element.name || "",
          value: "value" in element ? String(element.value ?? "") : "",
          checked: !!element.checked,
          dataQ: element.dataset?.q || ""
        };
      })
      .filter((field) => buildFieldSelector(field));

    const audio = doc.querySelector("audio");
    const reviewMode =
      !!doc.querySelector(REVIEW_TABLE_SELECTOR)
      || !!win?.App?.state?.isReviewing
      || !!win?.App?.state?.review
      || !!win?.state?.isReview
      || !!win?.isReviewing;

    return {
      savedAt: new Date().toISOString(),
      fields,
      choices: collectChoiceSnapshots(win),
      matchingSlots: collectMatchingSlotSnapshots(win),
      highlights: collectHighlightSnapshots(win),
      playerNotes: collectPlayerNotesSnapshot(),
      audio: audio ? {
        currentTime: Number(audio.currentTime || 0),
        playbackRate: Number(audio.playbackRate || 1)
      } : null,
      transcriptOpen:
        !!doc.getElementById("main-shell")?.classList?.contains("split-view")
        || !!doc.getElementById("layout")?.classList?.contains("show-t"),
      reviewMode,
      finishedLocked: reviewMode
    };
  }

  function hasMeaningfulSnapshot(snapshot) {
    if (!snapshot) return false;
    if (Number(snapshot.audio?.currentTime || 0) > 0.5) return true;
    if (snapshot.transcriptOpen) return true;
    if (String(snapshot.playerNotes?.text || "").trim() !== "") return true;
    return (snapshot.fields || []).some((field) => {
      if (field.type === "checkbox" || field.type === "radio") {
        return !!field.checked;
      }
      return String(field.value || "").trim() !== "";
    }) || (snapshot.choices || []).some((choice) => String(choice.value || "").trim() !== "")
      || (snapshot.matchingSlots || []).some((slot) => String(slot.value || "").trim() !== "")
      || Array.isArray(snapshot.highlights) && snapshot.highlights.length > 0;
  }

  function persistDraftSnapshot(win) {
    if (isReadOnlyReview() || isPassiveWrongbookReview()) return;
    if (frameState.suppressAutoPersist) return;
    const snapshot = collectFrameSnapshot(win);
    if (!snapshot) return;
    snapshot.finishedLocked = isCompletedSuiteReview() || !!(snapshot.reviewMode || frameState.finishedLocked);
    if (isCompletedSuiteReview()) {
      snapshot.reviewMode = true;
      snapshot.transcriptOpen = !!snapshot.transcriptOpen;
    }
    if (snapshot.finishedLocked || hasMeaningfulSnapshot(snapshot)) {
      setSavedPlayerState(snapshot);
    }
  }

  function debouncedPersistDraft(win) {
    if (!win) return;
    if (frameState.draftDebounceTimer) {
      window.clearTimeout(frameState.draftDebounceTimer);
    }
    frameState.draftDebounceTimer = window.setTimeout(() => {
      frameState.draftDebounceTimer = null;
      persistDraftSnapshot(win);
    }, 650);
  }

  function flushDraftSnapshot(win = getFrameWindow()) {
    if (!win) return;
    if (frameState.draftDebounceTimer) {
      window.clearTimeout(frameState.draftDebounceTimer);
      frameState.draftDebounceTimer = null;
    }
    persistDraftSnapshot(win);
  }

  function dispatchFieldEvent(element, type) {
    try {
      element.dispatchEvent(new Event(type, { bubbles: true }));
    } catch (error) {
      console.error("Failed to dispatch field event:", error);
    }
  }

  function requestSelbarUpdate(win) {
    void win;
  }

  function scheduleFrameMaintenance(win, callback) {
    if (!win) return;
    if (frameState.maintenanceFrameId) return;
    frameState.maintenanceFrameId = window.requestAnimationFrame(() => {
      frameState.maintenanceFrameId = null;
      callback();
    });
  }

  function isReviewMode(win) {
    const doc = win?.document;
    if (!doc) return false;
    return (
      !!doc.querySelector(REVIEW_TABLE_SELECTOR)
      || !!win?.App?.state?.isReviewing
      || !!win?.App?.state?.review
      || !!win?.state?.isReview
      || !!win?.isReviewing
    );
  }

  function performTranscriptToggle(win) {
    const doc = win?.document;
    if (!doc) return;

    const intensiveButton = doc.getElementById("toggleIntensive");
    if (intensiveButton) {
      intensiveButton.click();
      return;
    }

    if (typeof win.toggleIntensive === "function") {
      win.toggleIntensive();
    }
  }

  function performNativeNotesToggle(win) {
    const doc = win?.document;
    if (!doc) return false;

    const notesButton = doc.getElementById("toggleNotes");
    if (notesButton) {
      notesButton.click();
      return true;
    }

    if (typeof win.toggleNotes === "function") {
      win.toggleNotes();
      return true;
    }
    return false;
  }

  function hasEmbeddedIntensivePanel(win) {
    const doc = win?.document;
    if (!doc) return false;
    return !!doc.getElementById("toggleIntensive") || typeof win.toggleIntensive === "function";
  }

  function ensureEmbeddedIntensiveRendered(win) {
    const doc = win?.document;
    if (!doc) return;
    const transcript = doc.getElementById("transcript");
    const main = doc.getElementById("main");
    if (!transcript || transcript.querySelector(".study-cue")) return;
    if (typeof win.buildIntensive === "function") {
      main?.classList?.add("split");
      win.buildIntensive();
    }
  }

  function openEmbeddedIntensivePanel(win) {
    const doc = win?.document;
    if (!doc) return false;
    const main = doc.getElementById("main");
    if (main?.classList?.contains("split")) return true;
    const intensiveButton = doc.getElementById("toggleIntensive");
    if (intensiveButton) {
      intensiveButton.click();
      win.setTimeout?.(() => ensureEmbeddedIntensiveRendered(win), 60);
      return true;
    }
    if (typeof win.toggleIntensive === "function") {
      win.toggleIntensive();
      ensureEmbeddedIntensiveRendered(win);
      win.setTimeout?.(() => ensureEmbeddedIntensiveRendered(win), 60);
      return true;
    }
    return false;
  }

  function closeTranscriptPane(win) {
    const doc = win?.document;
    if (!doc) return;
    const mainShell = doc.getElementById("main-shell");
    const layout = doc.getElementById("layout");
    mainShell?.classList?.remove("split-view");
    layout?.classList?.remove("show-t");
    [...doc.querySelectorAll("[class*='transcript'], [id*='transcript'], [class*='Transcript'], [id*='Transcript']")]
      .forEach((element) => {
        const tag = String(element.tagName || "").toLowerCase();
        if (tag === "button") return;
        element.hidden = true;
      });
  }

  function resetPlaybackRate(win, force = false) {
    const doc = win?.document;
    if (!doc) return;
    const lockSuiteAudio = isActiveSuiteAttempt();
    if (!lockSuiteAudio) {
      if (force || !doc.__playerDefaultPlaybackRateApplied) {
        doc.__playerDefaultPlaybackRateApplied = true;
        doc.querySelectorAll("audio").forEach((audio) => {
          try {
            audio.playbackRate = 1;
            audio.defaultPlaybackRate = 1;
          } catch (_) {}
        });
        doc.querySelectorAll("#speed, select[id*='speed' i], select[name*='speed' i]").forEach((control) => {
          if ("value" in control) control.value = "1";
        });
      }
      doc.querySelectorAll("#speed, select[id*='speed' i], select[name*='speed' i]").forEach((control) => {
        control.disabled = false;
        control.removeAttribute("aria-disabled");
      });
      return;
    }
    if (!force && doc.__playerDefaultPlaybackRateApplied) return;
    doc.__playerDefaultPlaybackRateApplied = true;
    doc.querySelectorAll("audio").forEach((audio) => {
      try {
        audio.playbackRate = 1;
        audio.defaultPlaybackRate = 1;
      } catch (_) {}
    });
    doc.querySelectorAll("#speed, select[id*='speed' i], select[name*='speed' i]").forEach((control) => {
      if ("value" in control) control.value = "1";
    });
  }

  function setSuiteAudioControlsLocked(win, locked) {
    const doc = win?.document;
    if (!doc) return;
    doc.querySelectorAll("#speed, select[id*='speed' i], select[name*='speed' i]").forEach((control) => {
      if (locked && "value" in control) control.value = "1";
      control.disabled = !!locked;
      if (locked) {
        control.setAttribute("aria-disabled", "true");
      } else {
        control.removeAttribute("aria-disabled");
      }
    });
  }

  function getSuitePartAudioUrl(partIndex = suiteIndex) {
    const suite = getCurrentSuite();
    const item = refreshSuiteItemPath(suite?.items?.[partIndex]);
    if (!item?.path) return "";
    const sourceUrl = resolveQuestionSourceUrl(item.path);
    return new URL("audio.mp3", sourceUrl.replace(/[^/]+$/, "")).href;
  }

  function getSuiteAudioStateKey() {
    return suiteId ? `ielts_suite_audio_state_${suiteId}` : "";
  }

  function saveSuiteAudioState() {
    if (!isUnifiedSuiteAudioEnabled() || !frameState.suiteAudioStarted || !frameState.suiteAudio) return;
    const key = getSuiteAudioStateKey();
    if (!key) return;
    try {
      window.localStorage?.setItem?.(key, JSON.stringify({
        started: true,
        partIndex: frameState.suiteAudioPartIndex,
        currentTime: Number(frameState.suiteAudio.currentTime || 0),
        updatedAt: Date.now()
      }));
    } catch (error) {}
  }

  function loadSuiteAudioState() {
    const key = getSuiteAudioStateKey();
    if (!key) return null;
    try {
      const parsed = JSON.parse(window.localStorage?.getItem?.(key) || "null");
      return parsed && parsed.started ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function getUnifiedSuiteAudio() {
    if (!isUnifiedSuiteAudioEnabled()) return null;
    if (!frameState.suiteAudio) {
      const audio = document.createElement("audio");
      audio.preload = "auto";
      audio.style.display = "none";
      attachAudioRetry(audio, () => getSuitePartAudioUrl(frameState.suiteAudioPartIndex), {
        shouldPlay: () => frameState.suiteAudioStarted && !audio.paused,
        report: (message, level) => setStatus(message, level)
      });
      audio.addEventListener("ended", () => {
        const suite = getCurrentSuite();
        const nextIndex = frameState.suiteAudioPartIndex + 1;
        if (nextIndex < (suite?.items?.length || 0)) {
          playUnifiedSuiteAudioPart(nextIndex, { navigate: false });
        }
      });
      document.body?.appendChild(audio);
      frameState.suiteAudio = audio;
    }
    return frameState.suiteAudio;
  }

  function updateNativeAudioMirror(win = getFrameWindow()) {
    const doc = win?.document;
    const mirror = doc?.querySelector?.("audio");
    const suiteAudio = frameState.suiteAudio;
    if (!mirror || !suiteAudio || !isUnifiedSuiteAudioEnabled()) return;
    const samePart = frameState.suiteAudioPartIndex === suiteIndex;
    mirror.__suiteAllowSeekUntil = Date.now() + 300;
    try {
      mirror.currentTime = samePart ? Number(suiteAudio.currentTime || 0) : 0;
      mirror.playbackRate = 1;
      mirror.defaultPlaybackRate = 1;
    } catch (error) {}
  }

  function syncNativeAudioMirror(win = getFrameWindow()) {
    updateNativeAudioMirror(win);
    const doc = win?.document;
    const suiteAudio = frameState.suiteAudio;
    if (!doc || !suiteAudio || !isUnifiedSuiteAudioEnabled()) return;
    const suite = getCurrentSuite();
    const audioItem = suite?.items?.[frameState.suiteAudioPartIndex];
    if (frameState.suiteAudioStarted && audioItem && !suiteAudio.paused) {
      setStatus(`套题音频播放中：${audioItem.part}。可继续提前查看其他部分题目。`, "ok");
    }
    const timeLabel = doc.getElementById("time");
    const fillbar = doc.getElementById("fillbar");
    if (timeLabel) {
      const current = Math.floor(Number(suiteAudio.currentTime || 0));
      const duration = Math.floor(Number(suiteAudio.duration || 0));
      timeLabel.textContent = `${Math.floor(current / 60)}:${String(current % 60).padStart(2, "0")} / ${duration ? Math.floor(duration / 60) : "00"}:${duration ? String(duration % 60).padStart(2, "0") : "00"}`;
    }
    if (fillbar) {
      fillbar.style.width = suiteAudio.duration ? `${(suiteAudio.currentTime / suiteAudio.duration) * 100}%` : "0%";
    }
    const play = doc.getElementById("play");
    if (play) play.textContent = suiteAudio.paused ? "▶" : "⏸";
  }

  function playUnifiedSuiteAudioPart(partIndex = suiteIndex, options = {}) {
    const audio = getUnifiedSuiteAudio();
    const url = getSuitePartAudioUrl(partIndex);
    if (!audio || !url) return false;
    frameState.suiteAudioStarted = true;
    frameState.suiteAudioPartIndex = partIndex;
    if (audio.src !== url) {
      audio.src = url;
      audio.currentTime = 0;
    }
    audio.playbackRate = 1;
    audio.defaultPlaybackRate = 1;
    const promise = audio.play?.();
    if (promise?.catch) promise.catch((error) => console.warn("Unified suite audio play failed:", error));
    saveSuiteAudioState();
    syncNativeAudioMirror();
    if (options.navigate && partIndex !== suiteIndex) {
      navigateSuitePart(partIndex);
    }
    return true;
  }

  function installUnifiedSuiteAudioSync(win = getFrameWindow()) {
    if (!isUnifiedSuiteAudioEnabled()) return;
    const audio = getUnifiedSuiteAudio();
    if (!audio || audio.__suiteSyncInstalled) return;
    ["timeupdate", "loadedmetadata", "play", "pause", "ended"].forEach((eventName) => {
      audio.addEventListener(eventName, () => {
        if (eventName === "timeupdate" || eventName === "play" || eventName === "pause") {
          saveSuiteAudioState();
        }
        syncNativeAudioMirror();
      });
    });
    audio.__suiteSyncInstalled = true;
  }

  function restoreUnifiedSuiteAudioFromState() {
    if (!isUnifiedSuiteAudioEnabled() || frameState.suiteAudioStarted) return;
    const state = loadSuiteAudioState();
    if (!state) return;
    const suite = getCurrentSuite();
    const partIndex = Math.max(0, Math.min(Number(state.partIndex || 0), (suite?.items || []).length - 1));
    const audio = getUnifiedSuiteAudio();
    const url = getSuitePartAudioUrl(partIndex);
    if (!audio || !url) return;
    frameState.suiteAudioStarted = true;
    frameState.suiteAudioPartIndex = partIndex;
    audio.src = url;
    audio.playbackRate = 1;
    audio.defaultPlaybackRate = 1;
    audio.addEventListener("loadedmetadata", () => {
      try {
        audio.currentTime = Math.max(0, Number(state.currentTime || 0));
      } catch (error) {}
      const promise = audio.play?.();
      if (promise?.catch) promise.catch((error) => console.warn("Unified suite audio restore failed:", error));
      syncNativeAudioMirror();
    }, { once: true });
    audio.load?.();
  }

  function preloadAudioUrl(url) {
    if (!url) return;
    try {
      const link = document.createElement("link");
      link.rel = "preload";
      link.as = "audio";
      link.href = url;
      document.head?.appendChild(link);
      const audio = new Audio();
      audio.preload = "auto";
      audio.src = url;
      audio.load?.();
    } catch (error) {
      console.warn("Failed to preload suite audio:", error);
    }
  }

  function preloadSuitePart(partIndex) {
    const suite = getCurrentSuite();
    const item = suite?.items?.[partIndex];
    if (!item?.path) return;
    const sourceUrl = resolveQuestionSourceUrl(item.path);
    window.LibraryCache?.ensureQuestionHtml?.(
      item.path,
      async () => {
        const response = await fetch(sourceUrl);
        if (!response.ok && response.status !== 0) {
          throw new Error(`Unexpected response: ${response.status}`);
        }
        return response.text();
      },
      { silent: true }
    )?.catch?.((error) => console.warn("Failed to preload suite HTML:", error));
    preloadAudioUrl(getSuitePartAudioUrl(partIndex));
  }

  function scheduleSuiteNeighborPreload() {
    if (!isSuiteMode) return;
    if (frameState.suitePreloadTimer) {
      window.clearTimeout(frameState.suitePreloadTimer);
    }
    frameState.suitePreloadTimer = window.setTimeout(() => {
      frameState.suitePreloadTimer = null;
      preloadSuitePart(suiteIndex + 1);
      preloadSuitePart(suiteIndex - 1);
    }, 300);
  }

  function installSuiteAttemptRestrictions(win) {
    const doc = win?.document;
    if (!doc) return;
    if (!isSuiteMode || getCurrentSuite()?.completedAt) {
      doc.documentElement?.classList?.remove("suite-attempt-active");
      setSuiteAudioControlsLocked(win, false);
      return;
    }
    doc.documentElement?.classList?.add("suite-attempt-active");
    resetPlaybackRate(win, true);
    setSuiteAudioControlsLocked(win, true);
    if (doc.__suiteAttemptRestrictionsInstalled) {
      closeTranscriptPane(win);
      return;
    }

    const style = doc.createElement("style");
    style.textContent = [
      "html.suite-attempt-active #bar, html.suite-attempt-active .bar, html.suite-attempt-active .progress-container, html.suite-attempt-active .progress-bar, html.suite-attempt-active .progress, html.suite-attempt-active .seek-bar, html.suite-attempt-active .audio-progress, html.suite-attempt-active input[type='range'], html.suite-attempt-active #speed { cursor: not-allowed !important; }",
      "html.suite-attempt-active .transcript-panel, html.suite-attempt-active .transcript, html.suite-attempt-active #transcript, html.suite-attempt-active #transcript-panel { display: none !important; visibility: hidden !important; }"
    ].join("\n");
    doc.head?.appendChild(style);

    const blockAudioControl = (event) => {
      if (!doc.documentElement?.classList?.contains("suite-attempt-active")) return;
      const target = event.target;
      if (target?.closest?.("#speed, select[id*='speed' i], select[name*='speed' i]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        resetPlaybackRate(win, true);
        return;
      }
      const playButton = target?.closest?.("#play, .play");
      const audio = doc.querySelector("audio");
      if (playButton && isUnifiedSuiteAudioEnabled()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        playUnifiedSuiteAudioPart(frameState.suiteAudioStarted ? frameState.suiteAudioPartIndex : suiteIndex);
        return;
      }
      if (playButton && audio && !audio.paused && !audio.ended) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (target?.closest?.("#bar, .bar, .progress-container, .progress-bar, .progress, .seek-bar, .audio-progress, input[type='range']")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    ["pointerdown", "mousedown", "touchstart", "click", "input", "change"].forEach((eventName) => {
      doc.addEventListener(eventName, blockAudioControl, true);
    });

    const protectAudio = (audio) => {
      if (!audio || audio.__suiteSeekGuardInstalled) return;
      audio.__suiteLastAllowedTime = Number(audio.currentTime || 0);
      audio.playbackRate = 1;
      audio.defaultPlaybackRate = 1;
      if (isUnifiedSuiteAudioEnabled()) {
        audio.pause?.();
        audio.muted = true;
        syncNativeAudioMirror(win);
      }
      audio.addEventListener("timeupdate", () => {
        audio.__suiteLastAllowedTime = Number(audio.currentTime || 0);
      });
      audio.addEventListener("play", () => {
        if (!doc.documentElement?.classList?.contains("suite-attempt-active")) return;
        audio.__suiteHasStarted = true;
        if (audio.playbackRate !== 1) audio.playbackRate = 1;
      });
      audio.addEventListener("pause", () => {
        if (!doc.documentElement?.classList?.contains("suite-attempt-active")) return;
        if (!audio.__suiteHasStarted || audio.ended) return;
        const playPromise = audio.play?.();
        if (playPromise?.catch) playPromise.catch(() => {});
      });
      audio.addEventListener("ratechange", () => {
        if (!doc.documentElement?.classList?.contains("suite-attempt-active")) return;
        if (audio.playbackRate !== 1) {
          audio.playbackRate = 1;
        }
      });
      audio.addEventListener("seeking", () => {
        if (!doc.documentElement?.classList?.contains("suite-attempt-active")) return;
        if (Date.now() < Number(audio.__suiteAllowSeekUntil || 0)) return;
        const current = Number(audio.currentTime || 0);
        const last = Number(audio.__suiteLastAllowedTime || 0);
        if (Math.abs(current - last) > 1.25) {
          audio.__suiteAllowSeekUntil = Date.now() + 300;
          audio.currentTime = last;
        }
      });
      audio.__suiteSeekGuardInstalled = true;
    };
    doc.querySelectorAll("audio").forEach(protectAudio);
    const ObserverCtor = win.MutationObserver || MutationObserver;
    const audioObserver = new ObserverCtor(() => doc.querySelectorAll("audio").forEach(protectAudio));
    if (doc.body) audioObserver.observe(doc.body, { childList: true, subtree: true });
    doc.__suiteAttemptRestrictionsInstalled = true;
    closeTranscriptPane(win);
  }

  function performFinishToggle(win) {
    if (!win) return;
    const originalConfirm = typeof win.confirm === "function" ? win.confirm.bind(win) : null;
    const quietFinish = isReadOnlyReview() || isPassiveWrongbookReview();
    if (originalConfirm) {
      win.confirm = () => true;
    }

    try {
      if (isSuiteReadOnlyReview() && isLastSuitePart()) {
        if (typeof win.App?.finishTest === "function" && !isReviewMode(win)) {
          if (quietFinish) frameState.suppressFinishHook = true;
          win.App.finishTest();
          return;
        }
        if (typeof win.finishTest === "function" && !isReviewMode(win)) {
          if (quietFinish) frameState.suppressFinishHook = true;
          win.finishTest();
          return;
        }
      }
      const finishButton = win.document?.getElementById?.("finish");
      if (finishButton) {
        if (quietFinish) frameState.suppressFinishHook = true;
        finishButton.click();
        return;
      }
      if (typeof win.App?.toggleFinishMode === "function") {
        if (quietFinish) frameState.suppressFinishHook = true;
        win.App.toggleFinishMode();
        return;
      }
      if (typeof win.App?.finishTest === "function" && !isReviewMode(win)) {
        if (quietFinish) frameState.suppressFinishHook = true;
        win.App.finishTest();
        return;
      }
      if (typeof win.App?.toggleFinish === "function" && !isReviewMode(win)) {
        if (quietFinish) frameState.suppressFinishHook = true;
        win.App.toggleFinish();
        return;
      }
      if (typeof win.toggleFinishMode === "function") {
        if (quietFinish) frameState.suppressFinishHook = true;
        win.toggleFinishMode();
        return;
      }
      if (typeof win.finishTest === "function" && !isReviewMode(win)) {
        if (quietFinish) frameState.suppressFinishHook = true;
        win.finishTest();
        return;
      }
      if (typeof win.toggleFinish === "function" && !isReviewMode(win)) {
        if (quietFinish) frameState.suppressFinishHook = true;
        win.toggleFinish();
        return;
      }
    } finally {
      win.setTimeout?.(() => {
        frameState.suppressFinishHook = false;
      }, 0);
      if (originalConfirm) {
        win.confirm = originalConfirm;
      }
    }
  }

  function restoreFrameSnapshot(win, snapshot) {
    const doc = win?.document;
    if (!doc || !snapshot) return;
    const safeSnapshot = isSuiteMode && !getCurrentSuite()?.completedAt
      ? { ...snapshot, transcriptOpen: false, reviewMode: false, finishedLocked: false }
      : snapshot;

    restorePlayerNotesSnapshot(safeSnapshot.playerNotes);

    (safeSnapshot.fields || []).forEach((field) => {
      const selector = buildFieldSelector(field);
      if (!selector) return;
      const element = doc.querySelector(selector);
      if (!element) return;

      if (element.matches?.("#speed, select[id*='speed' i], select[name*='speed' i]")) {
        element.value = "1";
        dispatchFieldEvent(element, "input");
        dispatchFieldEvent(element, "change");
        return;
      }

      if (field.type === "checkbox" || field.type === "radio") {
        element.checked = !!field.checked;
        dispatchFieldEvent(element, "change");
        return;
      }

      element.value = field.value || "";
      dispatchFieldEvent(element, "input");
      dispatchFieldEvent(element, "change");
    });

    restoreChoiceSnapshots(win, safeSnapshot.choices || []);
    restoreMatchingAnswers(win, safeSnapshot.matchingSlots || []);
    refreshMatchingSlotLabels(win);

    const audio = doc.querySelector("audio");
    if (audio) {
      if (safeSnapshot.audio) {
        audio.__suiteAllowSeekUntil = Date.now() + 800;
        audio.currentTime = Number(safeSnapshot.audio.currentTime || 0);
      }
      audio.playbackRate = 1;
      audio.defaultPlaybackRate = 1;
    }
    if (isActiveSuiteAttempt()) resetPlaybackRate(win, true);

    if (safeSnapshot.transcriptOpen) {
      const mainShell = doc.getElementById("main-shell");
      const layout = doc.getElementById("layout");
      const alreadyOpen = !!mainShell?.classList?.contains("split-view") || !!layout?.classList?.contains("show-t");
      if (!alreadyOpen) {
        performTranscriptToggle(win);
      }
    }

    if (Array.isArray(safeSnapshot.highlights) && safeSnapshot.highlights.length) {
      win.setTimeout(() => {
        restoreHighlightSnapshots(win, safeSnapshot.highlights);
      }, 60);
    }

    const shouldRestoreReview = !safeSnapshot.retryPending
      && hasCompletedRecord()
      && (safeSnapshot.reviewMode || safeSnapshot.finishedLocked);
    if (shouldRestoreReview && !isReviewMode(win)) {
      const restoreReview = () => {
        performFinishToggle(win);
        win.setTimeout(() => performFinishToggle(win), 60);
        win.setTimeout(() => renderReviewFromSavedRecord(win), 80);
        win.setTimeout(() => renderReviewFromSavedRecord(win), 120);
        win.setTimeout(() => renderReviewFromSavedRecord(win), 260);
        win.setTimeout(revealFrameForSuiteReview, 160);
      };
      if (isSuiteReadOnlyReview()) {
        restoreReview();
      } else {
        win.setTimeout(restoreReview, 120);
      }
    } else if (shouldRestoreReview) {
      win.setTimeout(() => renderReviewFromSavedRecord(win), 120);
      win.setTimeout(revealFrameForSuiteReview, 180);
    }
  }

  function getAttemptHighlightTextSnapshots(record) {
    if (Array.isArray(record?.highlightTexts) && record.highlightTexts.length) return record.highlightTexts;
    if (Array.isArray(record?.highlights) && record.highlights.length) {
      const fromSnapshots = record.highlights.map((item) => ({
        text: String(item?.text || "").trim(),
        className: String(item?.className || "hl-brown").trim() || "hl-brown"
      })).filter((item) => item.text);
      if (fromSnapshots.length) return fromSnapshots;
    }
    const html = String(record?.highlightHtml || "");
    if (!html) return [];
    try {
      const template = document.createElement("template");
      template.innerHTML = html;
      return [...template.content.querySelectorAll(".hl-brown,.hl-rose,.hl-blue")].map((element) => ({
        text: String(element.textContent || "").trim(),
        className: String(element.className || "hl-brown").trim() || "hl-brown"
      })).filter((item) => item.text);
    } catch (error) {
      return [];
    }
  }

  function restoreAttemptTextHighlights(win, record) {
    const doc = win?.document;
    const body = doc?.body;
    if (!doc || !body) return;
    const items = getAttemptHighlightTextSnapshots(record);
    if (!items.length) return;
    const walk = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let cursor;
    while ((cursor = walk.nextNode())) {
      const parent = cursor.parentElement;
      if (!parent || parent.closest?.(HIGHLIGHT_UNSAFE_SELECTOR) || parent.closest?.(".hl-brown,.hl-rose,.hl-blue")) continue;
      textNodes.push(cursor);
    }
    items.forEach((item) => {
      const value = String(item.text || "").trim();
      if (!value) return;
      const target = textNodes.find((node) => String(node.nodeValue || "").includes(value));
      if (!target) return;
      const start = String(target.nodeValue || "").indexOf(value);
      if (start < 0) return;
      const range = doc.createRange();
      range.setStart(target, start);
      range.setEnd(target, start + value.length);
      wrapRange(doc, range, String(item.className || "hl-brown"));
    });
  }

  function restoreAttemptHighlights(win, record) {
    if (Array.isArray(record?.highlights) && record.highlights.length) {
      restoreHighlightSnapshots(win, record.highlights);
    }
    restoreAttemptTextHighlights(win, record);
  }

  function restoreReadOnlyReviewFromRecord(win) {
    if (!isReadOnlyReview() && !isPassiveWrongbookReview()) return false;
    const record = getReviewSavedRecord();
    if (!Array.isArray(record?.details) || !record.details.length) return false;
    frameState.finishedLocked = true;
    renderReviewFromSavedRecord(win);
    resetPlaybackRate(win, true);
    win.setTimeout(() => {
      renderReviewFromSavedRecord(win);
      resetPlaybackRate(win, true);
    }, 120);
    win.setTimeout(() => restoreAttemptHighlights(win, record), 160);
    win.setTimeout(() => {
      restoreAttemptHighlights(win, record);
      resetPlaybackRate(win, true);
    }, 320);
    setStatus("已打开最近一次历史记录；点击 Clear 可开始新的单篇练习，原记录会保留。", "ok");
    return true;
  }

  function syncPlayerTimer(win) {
    try {
      const doc = win?.document;
      if (!doc) {
        if (playerTimer) playerTimer.textContent = "00:00";
        return;
      }

      const finishLocked = isFinishLocked(win);
      if (frameState.finishedLocked && !finishLocked) {
        frameState.finishedLocked = false;
      }
      if (finishButton) {
        finishButton.textContent = isSuiteMode ? getSuiteFinishButtonText() : "Finish";
        finishButton.disabled = isSuiteMode ? (isSuiteReadOnlyReview() && isLastSuitePart()) : finishLocked;
        finishButton.style.opacity = finishLocked && !isSuiteMode ? "0.55" : "1";
        finishButton.style.cursor = finishLocked && !isSuiteMode ? "not-allowed" : "pointer";
      }

      if (isSuiteMode) {
        if (playerTimer) playerTimer.textContent = formatSuiteRemaining(getRemainingSuiteSeconds());
        return;
      }

      const timerNode =
        doc.getElementById("timer")
        || doc.querySelector(".timer")
        || doc.querySelector(".time-display");
      if (timerNode) {
        const text = String(timerNode.textContent || "").trim();
        if (text) {
          if (playerTimer) playerTimer.textContent = text;
          return;
        }
      }

      const audio = doc.querySelector("audio");
      if (audio) {
        const seconds = Math.floor(Number(audio.currentTime || 0));
        const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
        const remain = String(seconds % 60).padStart(2, "0");
        if (playerTimer) playerTimer.textContent = `${minutes}:${remain}`;
        return;
      }

      if (playerTimer) playerTimer.textContent = "00:00";
    } catch (error) {
      console.error("Failed to sync player timer:", error);
    }
  }

  function startTimerSync(win) {
    if (frameState.syncTimer) {
      window.clearInterval(frameState.syncTimer);
      frameState.syncTimer = null;
    }
    syncPlayerTimer(win);
    frameState.syncTimer = window.setInterval(() => syncPlayerTimer(win), 1000);
  }

  function getInlineStorageKeys(win) {
    const keys = new Set();
    const scripts = [...(win?.document?.scripts || [])].map((script) => script.textContent || "");
    scripts.forEach((text) => {
      const patterns = [
        /\b(?:const|let|var)\s+[A-Z0-9_]*STORAGE_KEY\s*=\s*['"`]([^'"`]+)['"`]/gi,
        /\b(?:db|key|localStorageKey)\s*:\s*['"`]([^'"`]+)['"`]/gi,
        /localStorage\.(?:setItem|getItem|removeItem)\(\s*['"`]([^'"`]+)['"`]/gi
      ];
      patterns.forEach((pattern) => {
        let match;
        while ((match = pattern.exec(text))) {
          const key = String(match[1] || "").trim();
          if (/^(ielts|IELTS)/.test(key)) keys.add(key);
        }
      });
    });
    return keys;
  }

  function clearNativeQuestionStorage(win) {
    try {
      const keys = new Set(frameState.storageKeys);
      const configKey = win?.CONFIG?.key || win?.CONFIG_DATA?.localStorageKey || win?.localStorageKey || "";
      if (configKey) keys.add(String(configKey));
      getInlineStorageKeys(win).forEach((key) => keys.add(key));
      keys.forEach((key) => {
        if (key) win?.localStorage?.removeItem?.(key);
        try {
          if (key) window.NativeDiskStorage?.removeAnswerRecordBackup?.(key);
        } catch (error) {
          console.error("Failed to clear native question backup:", error);
        }
      });
      window.NativeDiskStorage?.flush?.();
    } catch (error) {
      console.error("Failed to clear native question storage:", error);
    }
  }

  function forceClearNativeAnswerDom(win) {
    const doc = win?.document;
    if (!doc) return;
    doc.querySelectorAll("input, textarea, select").forEach((element) => {
      const isSpeedControl = element.matches?.("#speed, select[id*='speed' i], select[name*='speed' i]");
      if (isSpeedControl) {
        element.value = "1";
        element.disabled = false;
        return;
      }
      const type = String(element.type || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        element.checked = false;
        element.defaultChecked = false;
      } else if (element.tagName === "SELECT") {
        element.selectedIndex = 0;
      } else {
        element.value = "";
        element.defaultValue = "";
        element.removeAttribute("value");
      }
      element.disabled = false;
      dispatchFieldEvent(element, "input");
      dispatchFieldEvent(element, "change");
    });
    doc.querySelectorAll("audio").forEach((audio) => {
      audio.playbackRate = 1;
      audio.defaultPlaybackRate = 1;
    });
    doc.querySelectorAll(".single-choice.selected, .multi-choice.selected, .map-choice.selected, .choice.selected")
      .forEach((element) => element.classList.remove("selected"));
    doc.querySelectorAll(".choice.disabled, .single-choice.disabled, .multi-choice.disabled, .map-choice.disabled")
      .forEach((element) => element.classList.remove("disabled"));
    doc.querySelectorAll(".review").forEach((element) => element.remove());
    doc.querySelectorAll("#nav [data-q]").forEach((element) => { element.className = ""; });
    clearMatchingUiState(win);
    if (typeof win.clearAllProgress === "function") {
      try { win.clearAllProgress(); } catch (error) { console.error("Failed to clear template progress:", error); }
    }
    clearNativeQuestionStorage(win);
  }

  function resetNativeQuestionForFreshAttempt(win) {
    const doc = win?.document;
    if (!doc) return;
    frameState.suppressAutoPersist = true;
    clearNativeQuestionStorage(win);
    clearPlayerNotes();
    clearMatchingUiState(win);

    const hadConfirm = typeof win.confirm === "function";
    const originalConfirm = win.confirm;
    try {
      win.confirm = () => true;
      if (typeof win.resetTest === "function") {
        win.resetTest();
      } else if (typeof win.App?.resetTest === "function") {
        win.App.resetTest();
      }
      forceClearNativeAnswerDom(win);
    } catch (error) {
      console.error("Failed to reset native question for fresh attempt:", error);
    } finally {
      if (hadConfirm) {
        win.confirm = originalConfirm;
      } else {
        try { delete win.confirm; } catch {}
      }
      [80, 240, 600].forEach((delay) => {
        win.setTimeout(() => forceClearNativeAnswerDom(win), delay);
      });
      win.setTimeout(() => {
        forceClearNativeAnswerDom(win);
        frameState.suppressAutoPersist = false;
      }, 760);
    }
  }

  function clearTrackedIntervals(win) {
    try {
      frameState.intervalIds.forEach((id) => win?.clearInterval?.(id));
    } catch (error) {
      console.error("Failed to clear tracked intervals:", error);
    }
    frameState.intervalIds.clear();
  }

  function installIntervalTracking(win) {
    try {
      if (!win || win.__playerIntervalTracked) return;
      const originalSetInterval = win.setInterval.bind(win);
      const originalClearInterval = win.clearInterval.bind(win);

      win.setInterval = function (...args) {
        const id = originalSetInterval(...args);
        frameState.intervalIds.add(id);
        return id;
      };

      win.clearInterval = function (id) {
        frameState.intervalIds.delete(id);
        return originalClearInterval(id);
      };

      win.__playerIntervalTracked = true;
    } catch (error) {
      console.error("Failed to install interval tracking:", error);
    }
  }

  function hideNativeUi(win) {
    try {
      const doc = win?.document;
      if (!doc) return;

      let style = doc.getElementById("player-native-hide-style");
      if (!style) {
        style = doc.createElement("style");
        style.id = "player-native-hide-style";
        style.textContent = `${NATIVE_UI_SELECTORS} { display: none !important; visibility: hidden !important; pointer-events: none !important; }`;
        doc.head?.appendChild(style);
      }

      doc.querySelectorAll(NATIVE_UI_SELECTORS).forEach((element) => {
        element.style.display = "none";
        element.hidden = true;
      });
      restoreQuestionContentVisibility(doc);
    } catch (error) {
      console.error("Failed to hide native UI:", error);
    }
  }

  function disableTextAssistance(win) {
    try {
      const doc = win?.document;
      if (!doc) return;
      [doc.documentElement, doc.body].filter(Boolean).forEach((element) => {
        element.spellcheck = false;
        element.setAttribute("spellcheck", "false");
        element.setAttribute("autocorrect", "off");
        element.setAttribute("autocapitalize", "off");
        element.setAttribute("autocomplete", "off");
      });
      doc.querySelectorAll("input, textarea, [contenteditable='true']").forEach((element) => {
        element.spellcheck = false;
        element.setAttribute("spellcheck", "false");
        element.setAttribute("autocorrect", "off");
        element.setAttribute("autocapitalize", "off");
        element.setAttribute("autocomplete", "off");
      });
    } catch (error) {
      console.error("Failed to disable text assistance:", error);
    }
  }

  function buildAttempt(details) {
    const context = frameState.context || getContextFromSrc(decodedSrc);
    if (!context || !details.length) return null;

    const total = details.length;
    const correct = details.filter((item) => item.isCorrect).length;
    const timestamp = new Date().toISOString();

    return {
      id: context.questionId || context.questionKey || context.id,
      questionId: context.questionId || "",
      questionKey: context.questionKey || "",
      title: context.title,
      section: context.section,
      part: context.part,
      frequency: context.frequency,
      relativePath: context.relativePath,
      total,
      correct,
      wrong: Math.max(total - correct, 0),
      percent: total ? Math.round((correct / total) * 100) : 0,
      timestamp,
      formattedTime: formatAttemptTime(timestamp),
      signature: JSON.stringify(details),
      details
    };
  }

  function parseResultsFromHtml(html) {
    if (!html || !window.PracticeTracker?.parseResultsFromDocument) return [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html), "text/html");
    return window.PracticeTracker.parseResultsFromDocument(doc);
  }

  function getFrameTestData(win) {
    const text = win?.document?.getElementById?.("test-data")?.textContent || "";
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      console.error("Failed to parse frame test-data:", error);
      return null;
    }
  }

  function normalizeComparableAnswer(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^No Answer$/i, "")
      .toLowerCase();
  }

  function acceptedAnswerVariants(value) {
    return String(value ?? "")
      .split(/\s*\/\s*/)
      .map(normalizeComparableAnswer)
      .filter(Boolean);
  }

  function answerMatchesAccepted(userAnswer, correctAnswer) {
    const normalizedUser = normalizeComparableAnswer(userAnswer);
    if (!normalizedUser) return false;
    return acceptedAnswerVariants(correctAnswer).includes(normalizedUser);
  }

  function arraysEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  function extractObjectLiteral(source, startIndex) {
    const text = String(source || "");
    const openIndex = text.indexOf("{", startIndex);
    if (openIndex < 0) return "";

    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let i = openIndex; i < text.length; i += 1) {
      const char = text[i];

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = "";
        }
        continue;
      }

      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(openIndex, i + 1);
      }
    }
    return "";
  }

  function parseObjectLiteral(source, startIndex, label) {
    const literal = extractObjectLiteral(source, startIndex);
    if (!literal) return null;
    try {
      return new Function(`return (${literal});`)();
    } catch (error) {
      console.error(`Failed to parse ${label}:`, error);
      return null;
    }
  }

  function getNativeToolbarButtonScore(element) {
    const text = String(element?.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return 0;
    return [
      /\bfinish\b|\breturn to test\b|\bsubmit\b/i,
      /\bclear\b|\breset\b/i,
      /\btranscript\b/i,
      /\bnotes?\b/i,
      /\bsave\b/i
    ].reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
  }

  function hideNativeToolbarContainers(doc) {
    const controls = [...doc.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")]
      .filter((element) => getNativeToolbarButtonScore(element) > 0);

    const containers = new Set();
    controls.forEach((control) => {
      let node = control;
      for (let depth = 0; depth < 4 && node && node !== doc.body; depth += 1) {
        node = node.parentElement;
        if (!node) break;
        const score = [...node.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")]
          .reduce((sum, item) => sum + getNativeToolbarButtonScore(item), 0);
        if (score >= 2) {
          containers.add(node);
          break;
        }
      }
    });

    containers.forEach((container) => {
      if (!canHideNativeToolbarContainer(container)) return;
      container.style.setProperty("display", "none", "important");
      container.style.setProperty("visibility", "hidden", "important");
      container.style.setProperty("pointer-events", "none", "important");
      container.hidden = true;
    });
  }

  function canHideNativeToolbarContainer(container) {
    if (!container || container === container.ownerDocument?.body) return false;
    if (container.matches?.("main, #main, #test-body, #test-pages-container, #main-shell, #layout, .container, .secCard, .secBody")) {
      return false;
    }
    return !container.querySelector?.("main, #main, #test-body, #test-pages-container, #main-shell, #layout, .container, .secCard, .secBody");
  }

  function restoreQuestionContentVisibility(doc) {
    const roots = [
      doc.body,
      doc.querySelector("header"),
      doc.querySelector("main"),
      doc.getElementById("main"),
      doc.getElementById("test-body"),
      doc.getElementById("test-pages-container"),
      doc.getElementById("main-shell"),
      doc.getElementById("layout"),
      doc.querySelector(".container")
    ].filter(Boolean);

    roots.forEach((element) => {
      if (element.hidden) element.hidden = false;
      const display = String(element.style?.display || "").trim().toLowerCase();
      if (display === "none") element.style.removeProperty("display");
      const visibility = String(element.style?.visibility || "").trim().toLowerCase();
      if (visibility === "hidden") element.style.removeProperty("visibility");
    });
  }

  function readInlineAnswerConfig(win) {
    const scripts = [...(win?.document?.scripts || [])].map((script) => script.textContent || "");
    for (const text of scripts) {
      const configMatch = text.match(/\b(?:const|let|var)\s+(?:CONFIG_DATA|CONFIG)\s*=/);
      if (configMatch) {
        const config = parseObjectLiteral(text, configMatch.index + configMatch[0].length, "inline CONFIG");
        if (config?.answerKey || config?.answers) {
          return {
            answerKey: config.answerKey || null,
            answers: config.answers || null,
            questionList: config.questionList || config.questions || config.qs || []
          };
        }
      }

      const answerKeyIndex = text.search(/\banswerKey\s*:/);
      if (answerKeyIndex >= 0) {
        const answerKey = parseObjectLiteral(text, answerKeyIndex, "inline answerKey");
        if (answerKey) return { answerKey, answers: null, questionList: [] };
      }

      const answersIndex = text.search(/\banswers\s*:/);
      if (answersIndex >= 0) {
        const answers = parseObjectLiteral(text, answersIndex, "inline answers");
        if (answers) return { answerKey: null, answers, questionList: [] };
      }
    }
    return null;
  }

  function getAnswerInputValue(doc, question, correctAnswer, sourceKey) {
    const directName = `q${question}`;
    const rawSourceName = String(sourceKey || "");
    const sourceInputs = rawSourceName
      ? [...doc.querySelectorAll(`[name="${escapeAttrValue(rawSourceName)}"]`)]
      : [];
    const directInputs = [...doc.querySelectorAll(`[name="${escapeAttrValue(directName)}"]`)];
    const multipleName = question === "11" || question === "12" ? "q11_12" : "";
    const multipleInputs = multipleName
      ? [...doc.querySelectorAll(`[name="${escapeAttrValue(multipleName)}"]`)]
      : [];
    const inputs = sourceInputs.length ? sourceInputs : (directInputs.length ? directInputs : multipleInputs);
    if (!inputs.length) return "";

    const first = inputs[0];
    if (first.type === "checkbox" || first.type === "radio") {
      const checked = inputs
        .filter((input) => input.checked)
        .map((input) => String(input.value || "").trim())
        .filter(Boolean);
      if (first.type === "checkbox") {
        const correct = String(correctAnswer ?? "").trim();
        return checked.includes(correct) ? correct : checked.join(", ");
      }
      return checked[0] || "";
    }

    return String(first.value || "").trim();
  }

  function getSelectedChoiceValues(doc, name, className = "") {
    if (!doc || !name) return [];
    const classSelector = className ? `.${className}` : ".choice";
    return [...doc.querySelectorAll(`${classSelector}[data-name="${escapeAttrValue(name)}"].selected`)]
      .map((choice) => String(choice?.dataset?.value || choice?.textContent || "").trim())
      .filter(Boolean);
  }

  function getChoiceAnswerValue(doc, name) {
    const values = [
      ...getSelectedChoiceValues(doc, name, "single-choice"),
      ...getSelectedChoiceValues(doc, name, "map-choice"),
      ...getSelectedChoiceValues(doc, name, "choice")
    ];
    return values[0] || "";
  }

  function getQuestionRangeFromKey(key) {
    const text = String(key || "").replace(/^q/i, "").replace(/_/g, "-");
    const match = text.match(/^(\d+)-(\d+)$/);
    if (!match) return [text].filter(Boolean);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [text];
    const values = [];
    for (let value = start; value <= end; value += 1) values.push(String(value));
    return values;
  }

  function getGroupedMultipleValues(doc, key) {
    return [...new Set(getSelectedChoiceValues(doc, String(key || ""), "multi-choice"))].sort();
  }

  function findTestDataMultipleGroup(testData, question) {
    return (testData?.groups || []).find((group) => (
      group?.type === "multiple"
      && getQuestionRangeFromKey(`q${String(group.id || "").replace("-", "_")}`).includes(String(question))
    )) || null;
  }

  function getCorrectAnswerFromTestData(testData, question) {
    const key = `q${question}`;
    const answerKey = testData?.answerKey || {};
    if (answerKey.multipleMap?.[key] != null) return { type: "multiple", answer: answerKey.multipleMap[key] };
    if (answerKey.text?.[key] != null) return { type: "text", answer: answerKey.text[key] };
    if (answerKey.single?.[key] != null) return { type: "single", answer: answerKey.single[key] };
    if (answerKey.matching?.[key] != null) return { type: "matching", answer: answerKey.matching[key] };
    if (answerKey.map?.[key] != null) return { type: "map", answer: answerKey.map[key] };
    return { type: "", answer: "" };
  }

  function getCollectedTemplateAnswers(win) {
    try {
      return typeof win?.collectAnswers === "function" ? win.collectAnswers() : null;
    } catch (error) {
      console.error("Failed to collect template answers:", error);
      return null;
    }
  }

  function getUserAnswerFromTestData(win, testData, question) {
    const doc = win?.document;
    if (!doc) return "";
    const key = `q${question}`;
    const info = getCorrectAnswerFromTestData(testData, question);
    const collected = getCollectedTemplateAnswers(win);
    if (info.type === "multiple") {
      const group = findTestDataMultipleGroup(testData, question);
      const groupName = group ? `q${String(group.id || "").replace("-", "_")}` : "";
      const collectedValues = groupName && Array.isArray(collected?.multiple?.[groupName])
        ? collected.multiple[groupName].map((value) => String(value || "").trim()).filter(Boolean)
        : [];
      const selected = collectedValues.length ? [...new Set(collectedValues)] : (groupName ? getGroupedMultipleValues(doc, groupName) : []);
      const groupIds = groupName ? getQuestionRangeFromKey(groupName) : [];
      const fallbackAnswer = selected[groupIds.indexOf(String(question))] || "";
      const correctAnswers = String(info.answer || "")
        .split(/\s*\/\s*/)
        .map(normalizeComparableAnswer)
        .filter(Boolean);
      const match = selected.find((value) => {
        const normalized = normalizeComparableAnswer(value);
        return normalized && correctAnswers.includes(normalized);
      });
      return match || fallbackAnswer;
    }
    if (info.type === "matching") {
      const fromCollected = collected?.matching?.[key];
      if (fromCollected != null && String(fromCollected).trim()) return String(fromCollected).trim();
      return getMatchingAnswerValue(doc, question, key);
    }
    if (info.type === "single") {
      const fromCollected = collected?.single?.[key];
      if (fromCollected != null && String(fromCollected).trim()) return String(fromCollected).trim();
    }
    if (info.type === "map") {
      const fromCollected = collected?.map?.[key];
      if (fromCollected != null && String(fromCollected).trim()) return String(fromCollected).trim();
    }
    if (info.type === "text") {
      const fromCollected = collected?.text?.[key];
      if (fromCollected != null && String(fromCollected).trim()) return String(fromCollected).trim();
    }
    return getAnswerInputValue(doc, question, info.answer, key)
      || getGeneratedTemplateAnswerValue(doc, question, key);
  }

  function buildDetailsFromTestData(win) {
    const testData = getFrameTestData(win);
    const questionIds = Array.isArray(testData?.questionIds) ? testData.questionIds.map(String) : [];
    if (!questionIds.length) return [];
    return questionIds.map((question) => {
      const info = getCorrectAnswerFromTestData(testData, question);
      const correctAnswer = Array.isArray(info.answer) ? info.answer.join(", ") : String(info.answer ?? "");
      const userAnswer = getUserAnswerFromTestData(win, testData, question);
      return {
        question,
        userAnswer: userAnswer || "No Answer",
        correctAnswer,
        isCorrect: answerMatchesAccepted(userAnswer, correctAnswer)
      };
    });
  }

  function getGeneratedTemplateAnswerValue(doc, question, sourceKey) {
    const directName = `q${question}`;
    const sourceName = String(sourceKey || "");
    const directChoice = getChoiceAnswerValue(doc, directName);
    if (directChoice) return directChoice;
    if (sourceName && sourceName !== directName) {
      const sourceChoice = getChoiceAnswerValue(doc, sourceName);
      if (sourceChoice) return sourceChoice;
    }
    const groupedValues = getGroupedMultipleValues(doc, sourceName);
    if (groupedValues.length) {
      const ids = getQuestionRangeFromKey(sourceName);
      const index = ids.indexOf(String(question));
      return groupedValues[index] || "";
    }
    return "";
  }

  function buildDetailsFromSimpleAnswers(win, answers) {
    const doc = win?.document;
    if (!doc || !answers || typeof answers !== "object") return [];

    return Object.entries(answers)
      .map(([key, rawAnswer]) => {
        const question = String(key || "").replace(/^q/i, "");
        if (!question) return null;
        const correctAnswer = Array.isArray(rawAnswer)
          ? String(rawAnswer[0] ?? "").trim()
          : String(rawAnswer ?? "").trim();
        const userAnswer = getAnswerInputValue(doc, question, correctAnswer, key)
          || getGeneratedTemplateAnswerValue(doc, question, key);
        const allAccepted = Array.isArray(rawAnswer)
          ? rawAnswer.flatMap(acceptedAnswerVariants)
          : acceptedAnswerVariants(rawAnswer);
        const normalizedUserAnswer = normalizeComparableAnswer(userAnswer);
        return {
          question,
          userAnswer,
          correctAnswer,
          isCorrect: !!normalizedUserAnswer && allAccepted.includes(normalizedUserAnswer)
        };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.question) - Number(b.question));
  }

  function flattenAnswerKey(answerKey) {
    if (!answerKey || typeof answerKey !== "object") return [];
    const sections = ["multiple", "text", "single", "matching"];
    const flattened = [];

    sections.forEach((type) => {
      const group = answerKey[type];
      if (!group || typeof group !== "object") return;
      Object.entries(group).forEach(([key, value]) => {
        flattened.push({ type, key, value });
      });
    });

    if (!flattened.length) {
      Object.entries(answerKey).forEach(([key, value]) => {
        if (value && typeof value === "object" && !Array.isArray(value)) return;
        flattened.push({ type: Array.isArray(value) ? "multiple" : "text", key, value });
      });
    }

    return flattened;
  }

  function getMatchingAnswerValue(doc, question, sourceKey) {
    const selectors = [
      `.match-slot[data-q="${escapeAttrValue(question)}"] .tag`,
      `.match-slot[data-q="${escapeAttrValue(sourceKey)}"] .tag`,
      `[data-q="${escapeAttrValue(question)}"] .tag`,
      `[data-q="${escapeAttrValue(sourceKey)}"] .tag`
    ];
    for (const selector of selectors) {
      const slot = doc.querySelector(selector);
      const value = String(slot?.dataset?.value || slot?.textContent || "").trim();
      if (value) return value;
    }
    return "";
  }

  function findMultipleAnswerKey(answerKey, question) {
    const multiple = answerKey?.multiple;
    if (!multiple || typeof multiple !== "object") return "";
    const directKey = `q${question}`;
    if (Array.isArray(multiple[directKey])) return directKey;
    return Object.keys(multiple).find((key) => getQuestionRangeFromKey(key).includes(String(question))) || "";
  }

  function buildDetailsFromAnswerKey(win, answerKey) {
    const doc = win?.document;
    if (!doc) return [];

    return flattenAnswerKey(answerKey)
      .flatMap(({ type, key, value }) => {
        const question = String(key || "").replace(/^q/i, "").replace("_", "-");
        if (!question) return null;
        const acceptedAnswers = Array.isArray(value) ? value : [value];

        if (type === "multiple" && question.includes("-")) {
          const ids = getQuestionRangeFromKey(key);
          const selectedAnswers = getGroupedMultipleValues(doc, key);
          const correctAnswers = acceptedAnswers.map((item) => String(item ?? "").trim()).filter(Boolean).sort();
          return ids.map((id, index) => {
            const correctAnswer = String(answerKey?.multipleMap?.[`q${id}`] || correctAnswers[index] || "").trim();
            const normalizedCorrectAnswers = acceptedAnswerVariants(correctAnswer);
            const userAnswer = selectedAnswers.find((value) => {
              const normalized = normalizeComparableAnswer(value);
              return normalized && normalizedCorrectAnswers.includes(normalized);
            }) || selectedAnswers[index] || "";
            return {
              question: id,
              userAnswer,
              correctAnswer,
              isCorrect: answerMatchesAccepted(userAnswer, correctAnswer)
            };
          });
        }

        const correctAnswer = acceptedAnswers.map((item) => String(item ?? "").trim()).filter(Boolean).join(", ");
        const userAnswer = type === "matching"
          ? getMatchingAnswerValue(doc, question, key)
          : getAnswerInputValue(doc, question, correctAnswer, key)
            || getGeneratedTemplateAnswerValue(doc, question, key);
        const normalizedUserAnswer = normalizeComparableAnswer(userAnswer);
        const normalizedAcceptedAnswers = acceptedAnswers.flatMap(acceptedAnswerVariants);
        const isCorrect = type === "multiple"
          ? arraysEqual(
              String(userAnswer || "").split(",").map(normalizeComparableAnswer).filter(Boolean).sort(),
              normalizedAcceptedAnswers.slice().sort()
            )
          : !!normalizedUserAnswer && normalizedAcceptedAnswers.includes(normalizedUserAnswer);
        return [{ question, userAnswer, correctAnswer, isCorrect }];
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.question) - Number(b.question));
  }

  function buildDetailsFromInlineConfig(win) {
    const config = readInlineAnswerConfig(win);
    if (!config) return [];

    const fromAnswerKey = buildDetailsFromAnswerKey(win, config.answerKey);
    if (fromAnswerKey.length) return fromAnswerKey;
    return buildDetailsFromSimpleAnswers(win, config.answers);
  }

  function getFeedbackGroup(question) {
    const numeric = Number(question);
    if (numeric === 11 || numeric === 12) return "11-12";
    if (numeric >= 14 && numeric <= 16) return "14-16";
    if (numeric >= 17 && numeric <= 20) return "17-20";
    return String(question);
  }

  function createFallbackCell(doc, tagName, text, className) {
    const cell = doc.createElement(tagName);
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function buildFallbackReviewTable(doc, items) {
    const table = doc.createElement("table");
    table.className = "grade-report";

    const header = doc.createElement("tr");
    ["Q", "User", "Correct", "Result"].forEach((label) => {
      header.appendChild(createFallbackCell(doc, "th", label));
    });
    table.appendChild(header);

    items.forEach((item) => {
      const row = doc.createElement("tr");
      const resultText = item.isCorrect ? "√ Correct" : "× Incorrect";
      const resultClass = item.isCorrect ? "result-correct" : "result-incorrect";
      row.append(
        createFallbackCell(doc, "td", item.question),
        createFallbackCell(doc, "td", item.userAnswer || "No Answer"),
        createFallbackCell(doc, "td", item.correctAnswer),
        createFallbackCell(doc, "td", resultText, resultClass),
      );
      table.appendChild(row);
    });

    return table;
  }

  function renderReviewFromSavedRecord(win) {
    const record = getReviewSavedRecord();
    const details = Array.isArray(record?.details) ? record.details : [];
    if (!details.length) return false;
    clearAnswerUiForRecordReview(win);
    applyAttemptDetailsToFrame(win, details);
    restoreMatchingAnswers(win, details);
    const rendered = renderSavedRecordReviewArea(win, details);
    renderSavedReviewVisualFeedback(win, details);
    return rendered;
  }

  function renderSavedRecordReviewArea(win, details) {
    const doc = win?.document;
    const content = doc?.getElementById("content");
    if (!doc || !content || !details.length) return renderFallbackReview(win, details);
    doc.querySelectorAll(".review").forEach((element) => element.remove());

    const review = doc.createElement("section");
    review.id = "player-content-review";
    review.className = "review";
    const head = doc.createElement("div");
    head.className = "review-head";
    const reviewTitle = doc.createElement("strong");
    reviewTitle.textContent = "答案与批改结果";
    head.appendChild(reviewTitle);
    const showAll = doc.createElement("button");
    showAll.type = "button";
    showAll.className = "show-all-answers";
    showAll.textContent = "显示全部正确答案";
    head.appendChild(showAll);

    const table = buildFallbackReviewTable(doc, details);
    const answerShownByDefault = getReviewPreferences().answerVisibility === "shown";
    table.querySelectorAll("tr").forEach((row, index) => {
      if (!index) return;
      const detail = details[index - 1];
      const cells = row.querySelectorAll("td");
      if (!detail || cells.length < 4) return;
      const answerCell = cells[2];
      answerCell.textContent = "";
      answerCell.className = "answer-cell";
      const answerValue = doc.createElement("span");
      answerValue.className = `answer-value${answerShownByDefault ? "" : " is-hidden"}`;
      answerValue.dataset.answer = String(detail.correctAnswer || "");
      answerValue.textContent = answerShownByDefault ? String(detail.correctAnswer || "--") : "已隐藏";
      const answerToggle = doc.createElement("button");
      answerToggle.type = "button";
      answerToggle.className = "answer-toggle";
      answerToggle.dataset.visible = answerShownByDefault ? "1" : "0";
      answerToggle.textContent = answerShownByDefault ? "隐藏答案" : "查看答案";
      answerToggle.addEventListener("click", () => {
        const visible = answerToggle.dataset.visible !== "1";
        answerToggle.dataset.visible = visible ? "1" : "0";
        answerToggle.textContent = visible ? "隐藏答案" : "查看答案";
        answerValue.classList.toggle("is-hidden", !visible);
        answerValue.textContent = visible ? (answerValue.dataset.answer || "--") : "已隐藏";
      });
      answerCell.append(answerValue, answerToggle);

      const resultCell = cells[3];
      const resultText = resultCell.textContent;
      resultCell.textContent = "";
      const resultWrap = doc.createElement("div");
      resultWrap.className = "result-wrap";
      const resultLabel = doc.createElement("span");
      resultLabel.textContent = resultText;
      resultWrap.appendChild(resultLabel);
      const analysis = doc.createElement("button");
      analysis.type = "button";
      analysis.className = "analysis-jump";
      analysis.dataset.q = String(detail.question || "");
      analysis.textContent = "查看解析";
      analysis.addEventListener("click", () => runNativeAnalysisNavigation(win, detail.question));
      resultWrap.appendChild(analysis);
      resultCell.appendChild(resultWrap);
    });
    showAll.addEventListener("click", () => {
      const buttons = [...table.querySelectorAll(".answer-toggle")];
      const shouldShow = buttons.some((button) => button.dataset.visible !== "1");
      buttons.forEach((button) => {
        if ((button.dataset.visible === "1") !== shouldShow) button.click();
      });
      showAll.textContent = shouldShow ? "隐藏全部正确答案" : "显示全部正确答案";
    });
    review.append(head, table);
    content.appendChild(review);
    updateReviewNavigationStates(doc, details);
    disableReviewFields(doc);
    return true;
  }

  function renderSavedReviewVisualFeedback(win, details) {
    const doc = win?.document;
    if (!doc || !Array.isArray(details)) return;
    let style = doc.getElementById("player-saved-review-feedback-style");
    if (!style) {
      style = doc.createElement("style");
      style.id = "player-saved-review-feedback-style";
      style.textContent = [
        ".player-review-correct{border-color:#4ade80!important;outline:1px solid rgba(34,197,94,.2)!important;outline-offset:0!important;background-color:rgba(240,253,244,.7)!important;color:#166534!important;opacity:1!important}",
        ".player-review-incorrect{border-color:#f87171!important;outline:1px solid rgba(239,68,68,.18)!important;outline-offset:0!important;background-color:rgba(254,242,242,.72)!important;color:#991b1b!important;opacity:1!important}",
        ".player-review-correct-label{color:#166534!important}",
        ".player-review-incorrect-label{color:#991b1b!important}",
        ".player-review-row-correct,.player-review-row-incorrect{box-shadow:none!important;background:transparent!important}"
      ].join("");
      (doc.head || doc.documentElement).appendChild(style);
    }
    doc.querySelectorAll(".player-review-correct,.player-review-incorrect,.player-review-correct-label,.player-review-incorrect-label,.player-review-row-correct,.player-review-row-incorrect")
      .forEach((element) => element.classList.remove(
        "player-review-correct", "player-review-incorrect",
        "player-review-correct-label", "player-review-incorrect-label",
        "player-review-row-correct", "player-review-row-incorrect"
      ));

    details.forEach((detail) => {
      const question = String(detail?.question || "").trim();
      if (!question) return;
      const name = `q${question}`;
      const answerValues = String(detail?.userAnswer || "").split(/\s*,\s*/).map((value) => value.trim()).filter(Boolean);
      const stateClass = detail?.isCorrect ? "player-review-correct" : "player-review-incorrect";
      const labelClass = detail?.isCorrect ? "player-review-correct-label" : "player-review-incorrect-label";
      const targets = new Set();
      doc.querySelectorAll(
        `input[name="${escapeAttrValue(name)}"],textarea[name="${escapeAttrValue(name)}"],select[name="${escapeAttrValue(name)}"]`
      ).forEach((field) => {
        if (field.type === "radio" || field.type === "checkbox") {
          if (field.checked) targets.add(field.closest("label") || field);
        } else {
          targets.add(field);
        }
      });
      doc.querySelectorAll(
        `[data-name="${escapeAttrValue(name)}"].selected,[data-q="${escapeAttrValue(question)}"].selected`
      ).forEach((element) => targets.add(element));
      doc.querySelectorAll(".multi-choice.selected").forEach((element) => {
        if (getQuestionRangeFromKey(element.dataset.name || "").includes(question)
          && answerValues.includes(String(element.dataset.value || "").trim())) targets.add(element);
      });
      const slot = findMatchingSlot(doc, question);
      if (slot) targets.add(slot);

      targets.forEach((target) => {
        target.classList.add(stateClass);
        const label = target.closest?.("label,.choice,.question-row,.match-row,.map-row,.flow-step");
        if (label && label !== target) label.classList.add(labelClass);
      });
    });
  }

  function renderContentReviewFallback(doc, details) {
    const content = doc.getElementById("content");
    if (!content) return false;
    let review = doc.getElementById("player-content-review");
    if (!review) {
      review = doc.createElement("section");
      review.id = "player-content-review";
      review.className = "review";
      content.appendChild(review);
    }
    review.replaceChildren(buildFallbackReviewTable(doc, details));
    return true;
  }

  function renderFallbackReview(win, details) {
    const doc = win?.document;
    if (!doc || !details.length) return false;
    doc.getElementById("player-fallback-review")?.remove();

    const hasNativeReviewTable = !!doc.querySelector(
      ".results-table td, .result-table td, .review-table td, .ans-table td"
    );

    if (hasNativeReviewTable) {
      updateReviewNavigationStates(doc, details);
      disableReviewFields(doc);
      return true;
    }

    doc.querySelectorAll(".feedback").forEach((feedback) => {
      feedback.replaceChildren();
    });

    const groups = new Map();
    details.forEach((detail) => {
      const group = getFeedbackGroup(detail.question);
      const list = groups.get(group) || [];
      list.push(detail);
      groups.set(group, list);
    });

    let rendered = 0;
    groups.forEach((items, group) => {
      const feedback = doc.getElementById(`box-${group}`)?.querySelector(".feedback");
      if (!feedback) return;
      feedback.replaceChildren(buildFallbackReviewTable(doc, items));
      rendered += 1;
    });

    if (!rendered && isReviewMode(win)) {
      rendered += renderContentReviewFallback(doc, details) ? 1 : 0;
    }

    updateReviewNavigationStates(doc, details);
    disableReviewFields(doc);

    return rendered > 0;
  }

  function updateReviewNavigationStates(doc, details) {
    details.forEach((detail) => {
      const dot = doc.getElementById(`nav-${detail.question}`);
      if (dot) {
        dot.classList.remove("active");
        dot.classList.add(detail.isCorrect ? "correct" : "incorrect");
      }
    });
  }

  function disableReviewFields(doc) {
    doc.querySelectorAll(TRACKABLE_FIELD_SELECTOR).forEach((input) => {
      input.disabled = true;
    });
  }

  function ensureFallbackReview(win) {
    const doc = win?.document;
    const existing = doc && window.PracticeTracker?.parseResultsFromDocument
      ? window.PracticeTracker.parseResultsFromDocument(doc)
      : [];
    if (existing.length) return existing;
    try {
      const generated = typeof win?.App?.generateResultsTable === "function"
        ? parseResultsFromHtml(win.App.generateResultsTable())
        : [];
      if (generated.length) {
        renderFallbackReview(win, generated);
        return generated;
      }
    } catch (error) {
      console.error("Failed to use generated results table fallback:", error);
    }
    const fromTestData = buildDetailsFromTestData(win);
    if (fromTestData.length) {
      renderFallbackReview(win, fromTestData);
      return fromTestData;
    }
    const details = buildDetailsFromInlineConfig(win);
    if (details.length && renderFallbackReview(win, details)) {
      return details;
    }
    return [];
  }

  function buildDetailsFromAppState(win) {
    const app = win?.App;
    const config = app?.config;
    const answerKey = config?.answerKey;
    const questionList = Array.isArray(config?.questionList) ? config.questionList : [];
    if (!answerKey || !questionList.length) return [];

    const getTextInputValue = (name) => String(win?.document?.querySelector?.(`[name="${name}"]`)?.value ?? "").trim();
    const getCheckedValue = (name) => String(win?.document?.querySelector?.(`[name="${name}"]:checked`)?.value ?? "").trim();

    return questionList.map((rawNum) => {
      const qNum = String(rawNum ?? "").trim();
      if (!qNum) return null;

      const qKey = qNum.includes("-") ? `q${qNum.replace("-", "_")}` : `q${qNum}`;

      const multipleKey = findMultipleAnswerKey(answerKey, qNum);
      if (multipleKey) {
        const selectedAnswers = getGroupedMultipleValues(win.document, multipleKey);
        const userAnswers = Array.isArray(answerKey.multiple?.[qKey])
          ? [...win.document.querySelectorAll(`[name="${qKey}"]:checked`)]
            .map((input) => String(input.value || "").trim())
            .filter(Boolean)
          : selectedAnswers;
        const correctAnswers = (answerKey.multipleMap?.[`q${qNum}`] != null
          ? [answerKey.multipleMap[`q${qNum}`]]
          : [...(answerKey.multiple[multipleKey] || [])])
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        const normalizedCorrectAnswers = correctAnswers.map(normalizeComparableAnswer).filter(Boolean);
        const matchedAnswer = userAnswers.find((value) => {
          const normalized = normalizeComparableAnswer(value);
          return normalized && normalizedCorrectAnswers.includes(normalized);
        }) || userAnswers[getQuestionRangeFromKey(multipleKey).indexOf(qNum)] || "";
        return {
          question: qNum,
          userAnswer: matchedAnswer,
          correctAnswer: correctAnswers.join(", "),
          isCorrect: answerMatchesAccepted(matchedAnswer, correctAnswers.join(" / "))
        };
      }

      if (answerKey.text?.[qKey] != null) {
        const userAnswer = getTextInputValue(qKey);
        const correctAnswer = String(answerKey.text[qKey] ?? "").trim();
        return {
          question: qNum,
          userAnswer,
          correctAnswer,
          isCorrect: answerMatchesAccepted(userAnswer, correctAnswer)
        };
      }

      if (answerKey.single?.[qKey] != null) {
        const userAnswer = getCheckedValue(qKey) || getChoiceAnswerValue(win.document, qKey);
        const correctAnswer = String(answerKey.single[qKey] ?? "").trim();
        return {
          question: qNum,
          userAnswer,
          correctAnswer,
          isCorrect: answerMatchesAccepted(userAnswer, correctAnswer)
        };
      }

      if (answerKey.matching?.[qKey] != null) {
        const slot = win.document.querySelector(`.match-slot[data-q="${qNum}"] .tag`);
        const userAnswer = String(slot?.dataset?.value || slot?.textContent || "").trim();
        const correctAnswer = String(answerKey.matching[qKey] ?? "").trim();
        return {
          question: qNum,
          userAnswer,
          correctAnswer,
          isCorrect: answerMatchesAccepted(userAnswer, correctAnswer)
        };
      }

      return null;
    }).filter(Boolean);
  }

  function extractAttemptDetails(win, options = {}) {
    const allowGenerated = !!options.allowGenerated;
    const doc = win?.document;
    const app = win?.App;
    const isReviewing = !!(app?.state?.isReviewing || app?.state?.review);

    if (doc && window.PracticeTracker?.parseResultsFromDocument) {
      const details = window.PracticeTracker.parseResultsFromDocument(doc);
      if (details.length) return details;
    }

    if ((allowGenerated || isReviewing) && app && typeof app.generateResultsTable === "function") {
      try {
        const details = parseResultsFromHtml(app.generateResultsTable());
        if (details.length) return details;
      } catch (error) {
        console.error("Failed to parse App.generateResultsTable():", error);
      }
    }

    if (allowGenerated || isReviewing) {
      const fromTestData = buildDetailsFromTestData(win);
      if (fromTestData.length) return fromTestData;
    }

    if (isReviewing) {
      const fallback = buildDetailsFromAppState(win);
      if (fallback.length) return fallback;
    }

    if (allowGenerated || isReviewing) {
      const fallback = buildDetailsFromInlineConfig(win);
      if (fallback.length) return fallback;
    }

    return [];
  }

  function saveAttemptDetails(details, win = getFrameWindow()) {
    if (!window.PracticeTracker?.recordAttempt) {
      setStatus("记录器未就绪。", "error");
      return null;
    }

    if (!Array.isArray(details) || !details.length) return null;
    if (isReadOnlyReview()) {
      setStatus("当前为回看模式，不新增错题记录。", "ok");
      return getLatestSavedRecord();
    }

    const signature = JSON.stringify(details);
    if (signature && signature === frameState.lastSignature) return null;
    frameState.lastSignature = signature;

    const attempt = buildAttempt(details);
    if (!attempt) {
      setStatus("题目路径无法识别。", "error");
      return null;
    }
    const snapshotForAttempt = mergeSnapshotHighlights(collectFrameSnapshot(win), getPreviousHighlightSnapshot());
    if (snapshotForAttempt?.highlights?.length) {
      attempt.highlights = snapshotForAttempt.highlights;
    }
    if (!isActiveSuiteAttempt() && isWorseThanExistingRecord(attempt)) {
      setStatus("已保留原答题记录，未用空白复盘覆盖。", "ok");
      return getLatestSavedRecord();
    }

    if (isActiveSuiteAttempt()) {
      frameState.latestSuiteAttempt = attempt;
      setStatus(`本部分已暂存：${formatAttemptStatus(attempt)}`, "ok");
      return { latestAttempt: attempt };
    }

    const saved = window.PracticeTracker.recordAttempt(attempt);
    if (saved?.latestAttempt || saved?.attempts?.length) {
      const snapshot = snapshotForAttempt || collectFrameSnapshot(win);
      if (snapshot) {
        snapshot.finishedLocked = true;
        snapshot.reviewMode = true;
        setSavedPlayerState(snapshot);
      }
      updateRecordSummary({ record: saved.latestAttempt || attempt, hasRecord: true, hasDraft: false, hasCompleted: true });
      setStatus(`已记录：${formatAttemptStatus(attempt)}`, "ok");
    } else {
      setStatus("保存记录失败。", "error");
    }
    return saved;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function saveAttemptFromFrame(win, reason = "auto") {
    if (isReadOnlyReview()) return getLatestSavedRecord();
    const details = extractAttemptDetails(win, {
      allowGenerated: reason === "finish" || reason === "manual"
    });
    return saveAttemptDetails(details, win);
  }

  function getLatestAttemptForCurrentQuestion() {
    const currentKey = getPlayerStateKey();
    if (
      isActiveSuiteAttempt()
      && frameState.latestSuiteAttempt
      && normalizePath(frameState.latestSuiteAttempt.relativePath || "") === normalizePath(currentKey || decodedSrc)
    ) {
      return frameState.latestSuiteAttempt;
    }
    return window.PracticeTracker?.getLatestRecordByPath?.(decodedSrc) || null;
  }

  function saveSuitePartAttempt(details) {
    return saveAttemptDetails(details) || getLatestAttemptForCurrentQuestion();
  }

  function getSuiteSummaryText(suite) {
    if (!suite) return "";
    return `套题完成：${suite.totalCorrect}/${suite.totalQuestions}，预计 IELTS Listening ${suite.estimatedBand}`;
  }

  function getSuiteFinishButtonText(suite = getCurrentSuite()) {
    if (!isSuiteMode) return "Finish";
    if (suite?.completedAt) return "Next";
    return isLastSuitePart(suite) ? "Finish" : "Next";
  }

  function syncNativeSuiteButtons(win = getFrameWindow(), suite = getCurrentSuite()) {
    if (!isSuiteMode || !win?.document) return;
    const nativeFinish = win.document.getElementById("finish");
    const nativeClear = win.document.getElementById("clear");
    const completed = !!suite?.completedAt;
    if (nativeFinish) {
      nativeFinish.textContent = getSuiteFinishButtonText(suite);
      nativeFinish.disabled = completed && isLastSuitePart(suite);
    }
    if (nativeClear) {
      nativeClear.textContent = "Previous";
      nativeClear.disabled = suiteIndex <= 0;
    }
  }

  function syncSuiteButton(suite = window.SuitePractice?.getSuite?.(suiteId)) {
    if (!suiteId || !suite) return;
    const completed = !!suite.completedAt;
    if (transcriptButton) transcriptButton.hidden = !completed;
    if (!completed) hideIntensivePanel();
    if (suiteNextButton) suiteNextButton.hidden = true;
    if (finishButton) finishButton.textContent = getSuiteFinishButtonText(suite);
    if (finishButton) finishButton.disabled = completed && isLastSuitePart(suite);
    if (clearButton) {
      clearButton.textContent = "Previous";
      clearButton.disabled = suiteIndex <= 0;
    }
    syncNativeSuiteButtons(getFrameWindow(), suite);
  }

  function updateSuiteProgress() {
    if (isSuiteReadOnlyReview()) return getCurrentSuite();
    if (!suiteId || !window.SuitePractice?.updateSuitePart) return null;
    const attempt = getLatestAttemptForCurrentQuestion();
    const suite = window.SuitePractice.updateSuitePart(suiteId, suiteIndex, attempt);
    syncSuitePartAttemptToWrongbook(suiteId, suiteIndex, attempt);
    syncSuiteButton(suite);
    return window.SuitePractice?.getSuite?.(suiteId) || suite;
  }

  function notifySuiteEstimate(suite) {
    const text = getSuiteSummaryText(suite);
    if (!text) return;
    setStatus(text, "ok");
    window.alert(text);
  }

  function notifySuitePanelUpdated() {
    try {
      window.opener?.dispatchEvent?.(new StorageEvent("storage", {
        key: window.SuitePractice?.STORAGE_KEY || "ielts_listening_suite_records_v1",
        storageArea: window.opener.localStorage || null,
        url: window.location.href
      }));
    } catch (error) {}
  }

  function isSuiteAttemptSyncable(attempt) {
    return !!attempt
      && Array.isArray(attempt.details)
      && attempt.details.length > 0
      && (attempt.relativePath || attempt.questionId || attempt.questionKey || attempt.title);
  }

  function syncSuiteAttemptToWrongbook(attempt) {
    if (!window.PracticeTracker?.recordAttempt || !isSuiteAttemptSyncable(attempt)) return null;
    try {
      const saved = window.PracticeTracker.recordAttempt(attempt);
      if (saved?.latestAttempt || saved?.attempts?.length) {
        updateRecordSummary({
          record: saved.latestAttempt || attempt,
          hasRecord: true,
          hasDraft: false,
          hasCompleted: true
        });
      }
      return saved || null;
    } catch (error) {
      console.error("Failed to sync suite attempt to wrongbook:", error);
      return null;
    }
  }

  function getSuiteWrongbookSyncSignature(attempt) {
    return String(attempt?.wrongbookSyncSignature || attempt?.signature || "");
  }

  function markSuitePartWrongbookSynced(suiteIdValue, index, attempt) {
    if (!suiteIdValue || !window.SuitePractice?.markPartWrongbookSynced || !isSuiteAttemptSyncable(attempt)) return;
    window.SuitePractice.markPartWrongbookSynced(suiteIdValue, index, getSuiteWrongbookSyncSignature(attempt));
  }

  function isSuitePartWrongbookSynced(suiteIdValue, index, attempt) {
    const suite = window.SuitePractice?.getSuite?.(suiteIdValue);
    const result = suite?.results?.[String(index)];
    const syncSignature = getSuiteWrongbookSyncSignature(attempt);
    return !!result?.wrongbookSyncedAt
      && (!result.wrongbookSyncSignature || result.wrongbookSyncSignature === syncSignature);
  }

  function syncSuitePartAttemptToWrongbook(suiteIdValue, index, attempt) {
    if (!isSuiteAttemptSyncable(attempt)) return null;
    if (isSuitePartWrongbookSynced(suiteIdValue, index, attempt)) return { alreadySynced: true };
    const saved = syncSuiteAttemptToWrongbook(attempt);
    if (saved) markSuitePartWrongbookSynced(suiteIdValue, index, attempt);
    return saved;
  }

  function syncCompletedSuiteAttemptsToWrongbook(suite) {
    if (!suite?.completedAt || !window.PracticeTracker?.recordAttempt) return;
    if (suite.wrongbookSyncedAt) return;
    const results = (suite.items || []).map((_, index) => suite.results?.[String(index)]).filter(Boolean);
    if (!results.length || results.length !== (suite.items || []).length) return;
    let syncedCount = 0;
    results.forEach((result, index) => {
      const attempt = result?.attempt;
      if (!isSuiteAttemptSyncable(attempt)) return;
      if (result.wrongbookSyncedAt && (!result.wrongbookSyncSignature || result.wrongbookSyncSignature === (attempt.signature || ""))) {
        syncedCount += 1;
        return;
      }
      const saved = syncSuitePartAttemptToWrongbook(suite.id, index, attempt);
      if (saved) syncedCount += 1;
    });
    if (syncedCount === results.length) window.SuitePractice?.markWrongbookSynced?.(suite.id);
  }

  function buildEmptySuiteAttempt(item, index) {
    const start = Number(index || 0) * 10 + 1;
    const details = Array.from({ length: 10 }, (_, offset) => ({
      question: String(start + offset),
      userAnswer: "No Answer",
      correctAnswer: "",
      isCorrect: false
    }));
    const timestamp = new Date().toISOString();
    return {
      id: item?.path || item?.title || "",
      questionKey: "",
      title: item?.title || "",
      section: item?.section || "",
      part: item?.part || "",
      frequency: item?.frequency || "",
      relativePath: item?.path || "",
      total: details.length,
      correct: 0,
      wrong: details.length,
      percent: 0,
      timestamp,
      formattedTime: formatAttemptTime(timestamp),
      signature: JSON.stringify(details),
      details
    };
  }

  function isAnsweredValue(value) {
    const text = String(value || "").trim();
    return !!text && !/^No Answer$/i.test(text) && text !== "未作答";
  }

  function getAnsweredCount(details) {
    return (Array.isArray(details) ? details : []).filter((detail) => isAnsweredValue(detail?.userAnswer)).length;
  }

  function formatAttemptStatus(attempt) {
    return `已答 ${getAnsweredCount(attempt?.details)}/${attempt.total} · 正确 ${attempt.correct}/${attempt.total} · ${attempt.percent}%`;
  }

  function enterSuiteReviewMode(win, options = {}) {
    const suite = getCurrentSuite();
    const doc = win?.document;
    if (!isSuiteMode || !suite?.completedAt || !doc) return;
    doc.documentElement?.classList?.remove("suite-attempt-active");
    if (transcriptButton) transcriptButton.hidden = false;
    if (finishButton) {
      finishButton.textContent = "Next";
      finishButton.disabled = isLastSuitePart(suite);
    }
    if (clearButton) {
      clearButton.textContent = "Previous";
      clearButton.disabled = suiteIndex <= 0;
    }
    clearSavedDraftState();
    if (!isReviewMode(win)) {
      performFinishToggle(win);
      window.setTimeout(() => performFinishToggle(win), 60);
    }
    window.setTimeout(() => finalizeFinish(win), 80);
    window.setTimeout(() => renderReviewFromSavedRecord(win), 140);
    window.setTimeout(() => finalizeFinish(win, { lock: true }), 220);
    window.setTimeout(() => renderReviewFromSavedRecord(win), 300);
    window.setTimeout(revealFrameForSuiteReview, 260);
    if (options.alert) {
      window.setTimeout(() => notifySuiteEstimate(window.SuitePractice?.getSuite?.(suiteId) || suite), 260);
    }
  }

  function handleSuiteNextClick(suite = window.SuitePractice?.getSuite?.(suiteId)) {
    if (!suite) return;
    if (isSuiteReadOnlyReview() && isLastSuitePart(suite)) return;
    const nextIndex = suiteIndex + 1;
    if (nextIndex < (suite.items?.length || 0)) {
      if (!isSuiteReadOnlyReview()) {
        window.SuitePractice?.setCurrentIndex?.(suiteId, nextIndex);
        if (isUnifiedSuiteAudioEnabled()) {
          saveSuiteAudioState();
        }
      }
      const reviewSuffix = isSuiteReadOnlyReview() ? "&review=1" : "";
      window.location.href = `./player.html?suite=${encodeURIComponent(suiteId)}&idx=${encodeURIComponent(String(nextIndex))}${reviewSuffix}`;
      return;
    }
    if (!isSuiteReadOnlyReview()) notifySuiteEstimate(suite);
  }

  function handleSuitePreviousClick() {
    if (!isSuiteMode || suiteIndex <= 0) return;
    if (!isSuiteReadOnlyReview()) {
      window.SuitePractice?.setCurrentIndex?.(suiteId, suiteIndex - 1);
      if (isUnifiedSuiteAudioEnabled()) {
        saveSuiteAudioState();
      }
    }
    const reviewSuffix = isSuiteReadOnlyReview() ? "&review=1" : "";
    window.location.href = `./player.html?suite=${encodeURIComponent(suiteId)}&idx=${encodeURIComponent(String(suiteIndex - 1))}${reviewSuffix}`;
  }

  function forceSubmitSuitePart() {
    const win = getFrameWindow();
    if (isSuiteReadOnlyReview()) return;
    if (!win || isFinishLocked(win)) return;
    finishSuitePartWithoutReview(win, { forceComplete: true });
  }

  function lockFrameWithoutReview(win) {
    const doc = win?.document;
    doc?.querySelectorAll?.(TRACKABLE_FIELD_SELECTOR)?.forEach((element) => {
      element.disabled = true;
    });
    doc?.querySelectorAll?.(".tag, .drag-option, [draggable='true']")?.forEach((element) => {
      element.setAttribute("draggable", "false");
    });
  }

  async function finishSuitePartWithoutReview(win, options = {}) {
    if (isSuiteReadOnlyReview()) return null;
    if (frameState.suiteNextPending) return null;
    frameState.suiteNextPending = true;
    closeTranscriptPane(win);
    let details = extractAttemptDetails(win, { allowGenerated: true });
    let saved = saveSuitePartAttempt(details);
    if (!saved) {
      try {
        performFinishToggle(win);
        closeTranscriptPane(win);
        await sleep(180);
        details = extractAttemptDetails(win, { allowGenerated: true });
        saved = saveSuitePartAttempt(details);
      } catch (error) {
        console.error("Failed to use suite hidden finish fallback:", error);
      }
    }
    if (!saved) {
      setStatus("保存本部分失败，请稍等题目加载完成后再点 Next。", "error");
      frameState.suiteNextPending = false;
      return null;
    }
    const snapshot = collectFrameSnapshot(win);
    if (snapshot) {
      snapshot.transcriptOpen = false;
      snapshot.reviewMode = false;
      snapshot.finishedLocked = false;
      if (isActiveSuiteAttempt()) {
        clearSavedDraftState();
      } else {
        setSavedPlayerState(snapshot);
      }
    }
    frameState.finishedLocked = false;
    const suite = updateSuiteProgress();
    if (options.forceComplete && suite && !suite.completedAt) {
      for (let index = 0; index < (suite.items || []).length; index += 1) {
        if (!suite.results?.[String(index)]) {
          window.SuitePractice?.updateSuitePart?.(suiteId, index, buildEmptySuiteAttempt(suite.items[index], index));
        }
      }
    }
    const latestSuite = window.SuitePractice?.getSuite?.(suiteId) || suite;
    setStatus(latestSuite?.completedAt ? getSuiteSummaryText(latestSuite) : "本部分已保存，正在进入下一部分。", "ok");
    syncPlayerTimer(win);
    if (!latestSuite?.completedAt) {
      handleSuiteNextClick(latestSuite);
      frameState.suiteNextPending = false;
      return latestSuite;
    }
    syncCompletedSuiteAttemptsToWrongbook(latestSuite);
    notifySuitePanelUpdated();
    syncSuiteButton(latestSuite);
    enterSuiteReviewMode(win, { alert: true });
    frameState.suiteNextPending = false;
    return latestSuite;
  }

  function updateSuiteTimer() {
    if (!isSuiteMode) return;
    const suite = getCurrentSuite();
    if (suite?.completedAt || isSuiteReadOnlyReview()) {
      frameState.suiteGraceDeadlineAt = 0;
      if (playerTimer) playerTimer.textContent = getSuiteSummaryText(suite) || "已完成";
      return;
    }
    const remaining = getRemainingSuiteSeconds();
    if (remaining > 0) {
      frameState.suiteGraceDeadlineAt = 0;
      if (playerTimer) playerTimer.textContent = formatSuiteRemaining(remaining);
      return;
    }
    if (!frameState.suiteGraceDeadlineAt) {
      frameState.suiteGraceDeadlineAt = Date.now() + SUITE_REVIEW_GRACE_SECONDS * 1000;
      setStatus("套题时间到，进入 2 分钟检查时间；可提前点 Finish 提交。", "warn");
    }
    const graceRemaining = Math.max(0, Math.ceil((frameState.suiteGraceDeadlineAt - Date.now()) / 1000));
    if (playerTimer) playerTimer.textContent = `检查 ${formatSuiteRemaining(graceRemaining)}`;
    if (graceRemaining <= 0) {
      setStatus("检查时间结束，已自动交卷。", "warn");
      forceSubmitSuitePart();
    }
  }

  function finalizeFinish(win, options = {}) {
    if (isSuiteReadOnlyReview()) {
      if (options.lock) {
        frameState.finishedLocked = true;
        syncPlayerTimer(win);
      }
      return;
    }
    if (!options.lock) {
      const details = ensureFallbackReview(win);
      saveAttemptDetails(details) || saveAttemptFromFrame(win, "manual");
      frameState.latestSubmittedDetails = Array.isArray(details) ? details : [];
      renderSavedRecordReviewArea(win, frameState.latestSubmittedDetails);
      renderSavedReviewVisualFeedback(win, frameState.latestSubmittedDetails);
      return;
    }

    const savedDetails = getLatestAttemptForCurrentQuestion()?.details;
    const reviewDetails = Array.isArray(frameState.latestSubmittedDetails) && frameState.latestSubmittedDetails.length
      ? frameState.latestSubmittedDetails
      : (Array.isArray(savedDetails) ? savedDetails : []);
    renderSavedRecordReviewArea(win, reviewDetails);
    renderSavedReviewVisualFeedback(win, reviewDetails);

    const snapshot = mergeSnapshotHighlights(collectFrameSnapshot(win), getPreviousHighlightSnapshot());
    if (snapshot) {
      snapshot.finishedLocked = true;
      setSavedPlayerState(snapshot);
    }
    frameState.finishedLocked = true;
    const suite = updateSuiteProgress();
    setStatus(suite?.completedAt ? getSuiteSummaryText(suite) : "已完成，本题已锁定；如需重做请点击 Clear。", "ok");
    syncPlayerTimer(win);
  }

  function createTrackerBridge(context) {
    if (!context || !window.PracticeTracker) return null;

    return Object.assign({}, window.PracticeTracker, {
      getPageContext() {
        return context;
      },
      recordPageAttempt() {
        return saveAttemptFromFrame(frame.contentWindow);
      },
      getLatestRecordByPath(relativePath) {
        return window.PracticeTracker.getLatestRecordByPath(relativePath || context.relativePath);
      }
    });
  }

  function installTrackerBridge(win) {
    const context = frameState.context || getContextFromSrc(decodedSrc);
    const bridge = createTrackerBridge(context);
    if (win && bridge) {
      win.PracticeTracker = bridge;
    }
  }

  function buildSrcdocHtml(htmlText) {
    const sourceUrl = resolveQuestionSourceUrl(decodedSrc);
    const baseHref = sourceUrl.replace(/[^/]+$/, "");
    const bridgeScript = [
      `<base href="${baseHref}">`,
      "<style>",
      "html.player-clear-selection ::selection, html.player-clear-selection *::selection, body.player-clear-selection ::selection, body.player-clear-selection *::selection { background: transparent !important; color: inherit !important; }",
      "html.player-clear-selection ::-moz-selection, html.player-clear-selection *::-moz-selection, body.player-clear-selection ::-moz-selection, body.player-clear-selection *::-moz-selection { background: transparent !important; color: inherit !important; }",
      ".hl, .hl-brown, html body .hl.hl, html body .hl-brown.hl-brown { background-color: #8b4513 !important; color: #ffffff !important; border-radius: 0 !important; padding: 0 1px !important; box-shadow: none !important; border: none !important; }",
      ".hl-rose, html body .hl-rose.hl-rose { background-color: #c2185b !important; color: #ffffff !important; border-radius: 0 !important; padding: 0 1px !important; box-shadow: none !important; border: none !important; }",
      ".hl-blue, html body .hl-blue.hl-blue { background-color: #2563eb !important; color: #ffffff !important; border-radius: 0 !important; padding: 0 1px !important; box-shadow: none !important; border: none !important; }",
      `${NATIVE_UI_SELECTORS} { display: none !important; visibility: hidden !important; pointer-events: none !important; }`,
      "html, body { padding-bottom: 0 !important; }",
      "</style>",
      "<script>",
      "(function(){",
      "  try {",
      "    const trackStorage = function(key){",
      "      try {",
      "        if (parent && typeof parent.__PLAYER_TRACK_STORAGE_KEY__ === 'function') {",
      "          parent.__PLAYER_TRACK_STORAGE_KEY__(String(key || ''));",
      "        }",
      "      } catch (error) {}",
      "    };",
      "    const storage = window.localStorage;",
      "    if (!window.__playerOriginalSetInterval) {",
      "      window.__playerOriginalSetInterval = window.setInterval.bind(window);",
      "      window.__playerOriginalClearInterval = window.clearInterval.bind(window);",
      "      window.setInterval = function() {",
      "        const id = window.__playerOriginalSetInterval.apply(window, arguments);",
      "        try {",
      "          if (parent && typeof parent.__PLAYER_TRACK_INTERVAL__ === 'function') {",
      "            parent.__PLAYER_TRACK_INTERVAL__(id);",
      "          }",
      "        } catch (error) {}",
      "        return id;",
      "      };",
      "      window.clearInterval = function(id) {",
      "        return window.__playerOriginalClearInterval.call(window, id);",
      "      };",
      "    }",
      "    if (storage && !storage.__playerTracked) {",
      "      const originalSetItem = storage.setItem.bind(storage);",
      "      const originalRemoveItem = storage.removeItem.bind(storage);",
      "      storage.setItem = function(key, value) { trackStorage(key); return originalSetItem(key, value); };",
      "      storage.removeItem = function(key) { trackStorage(key); return originalRemoveItem(key); };",
      "      storage.__playerTracked = true;",
      "    }",
      "    if (parent && typeof parent.__PLAYER_CREATE_TRACKER_BRIDGE__ === 'function') {",
      "      window.PracticeTracker = parent.__PLAYER_CREATE_TRACKER_BRIDGE__(window);",
      "    }",
      "  } catch (error) {",
      "    console.error('Player bridge bootstrap failed:', error);",
      "  }",
      "}());",
      "<\/script>"
    ].join("");

    const source = String(htmlText || "").replace(/<script[^>]*practice-tracker\.js[^>]*><\/script>\s*/gi, "");
    if (/<head([^>]*)>/i.test(source)) {
      return source.replace(/<head([^>]*)>/i, `<head$1>${bridgeScript}`);
    }
    return `${bridgeScript}${source}`;
  }

  function scheduleRecord(win, reason = "auto") {
    if (!win) return;
    saveAttemptFromFrame(win, reason);
    if (reason === "finish") return;
    win.setTimeout(() => saveAttemptFromFrame(win, reason), 120);
    win.setTimeout(() => saveAttemptFromFrame(win, reason), 500);
  }

  function shouldRunRecord(win, reason) {
    if (reason === "click" && isFinishLocked(win)) return false;
    return reason === "finish" || reason === "manual" || reason === "click";
  }

  function suppressSelectionFlash(win, duration = 240) {
    try {
      const doc = win?.document;
      const root = doc?.documentElement;
      const body = doc?.body;
      if (root) {
        root.classList.add("player-clear-selection");
      }
      if (body) {
        body.classList.add("player-clear-selection");
      }
      win.setTimeout(() => {
        root?.classList.remove("player-clear-selection");
        body?.classList.remove("player-clear-selection");
      }, duration);
    } catch (error) {
      console.error("Failed to suppress selection flash:", error);
    }
  }

  function clearSelection(win) {
    try {
      suppressSelectionFlash(win, 300);
      const selection = win?.getSelection?.();
      if (selection && typeof selection.removeAllRanges === "function") {
        selection.removeAllRanges();
      }

      win?.document?.activeElement?.blur?.();
      hidePlayerSelbar();
    } catch (error) {
      console.error("Failed to clear selection:", error);
    }
  }

  function patchMethod(host, key, callback) {
    if (!host || typeof host[key] !== "function" || host[key].__playerWrapped) return;

    const original = host[key];
    const wrapped = function (...args) {
      try {
        return original.apply(this, args);
      } finally {
        callback();
      }
    };
    wrapped.__playerWrapped = true;
    host[key] = wrapped;
  }

  function findClosestHighlightElement(range) {
    let node = range?.commonAncestorContainer || null;
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement;
    }
    return node?.closest?.('[class*="hl"]') || null;
  }

  function isHighlightElement(element) {
    if (!element?.classList) return false;
    return [...element.classList].some((className) => /^hl(?:-|$)/i.test(String(className || "")));
  }

  const HIGHLIGHT_BLOCK_SELECTOR = "p, li, td, th, .choice, .doc-line, .doc-line-content, .flow-text, .map-row-label, .question-block, .cue, .study-cue, .player-intensive-line, h1, h2, h3, h4, h5, h6";
  const HIGHLIGHT_UNSAFE_SELECTOR = "input, textarea, select, button, audio, video, canvas, svg, iframe, .blank-q, .slot, .suite-slot, .pool, .suite-nav, .suite-actions, .suite-bottom, .suite-audio, .player-toolbar, .player-selbar, .player-note-panel, .answer-toggle, .show-all-answers, .analysis-jump, .question-analysis-shortcut";

  function nodeElement(node) {
    return node?.nodeType === Node.TEXT_NODE ? node.parentElement : node?.parentElement || node;
  }

  function isSingleVisualLineRange(range) {
    try {
      const rects = Array.from(range?.getClientRects?.() || [])
        .filter((rect) => rect && rect.width > 1 && rect.height > 1);
      if (rects.length <= 1) return true;
      const first = rects[0];
      return rects.every((rect) => Math.abs(rect.top - first.top) <= 3 && Math.abs(rect.bottom - first.bottom) <= 3);
    } catch (error) {
      return false;
    }
  }

  function getSafeHighlightContainer(range, root) {
    if (!range || range.collapsed || !root) return null;
    if (range.startContainer?.nodeType !== Node.TEXT_NODE || range.endContainer?.nodeType !== Node.TEXT_NODE) return null;
    if (!isSingleVisualLineRange(range)) return null;
    const startElement = nodeElement(range.startContainer);
    const endElement = nodeElement(range.endContainer);
    if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) return null;
    if (startElement.closest?.(HIGHLIGHT_UNSAFE_SELECTOR) || endElement.closest?.(HIGHLIGHT_UNSAFE_SELECTOR)) return null;
    const startContainer = startElement.closest?.(HIGHLIGHT_BLOCK_SELECTOR) || startElement;
    const endContainer = endElement.closest?.(HIGHLIGHT_BLOCK_SELECTOR) || endElement;
    if (!startContainer || startContainer !== endContainer || !root.contains(startContainer)) return null;
    const fragment = range.cloneContents();
    if (fragment.querySelector?.(HIGHLIGHT_UNSAFE_SELECTOR)) return null;
    if (fragment.querySelector?.(HIGHLIGHT_BLOCK_SELECTOR)) return null;
    return startContainer;
  }

  function wrapSafeHighlightRange(doc, range, className, root) {
    const container = getSafeHighlightContainer(range, root);
    if (!container) return null;
    const span = doc.createElement("span");
    span.className = className;
    try {
      range.surroundContents(span);
      return span;
    } catch (error) {
      console.warn("Skipped unsafe highlight range:", error);
      return null;
    }
  }

  function unwrapHighlightElementSafely(element) {
    if (!element || !isHighlightElement(element)) return false;
    const parent = element.parentNode;
    if (!parent) return false;
    try {
      const previous = element.previousSibling;
      const next = element.nextSibling;
      while (element.firstChild) parent.insertBefore(element.firstChild, element);
      parent.removeChild(element);
      if (previous?.nodeType === Node.TEXT_NODE && previous.nextSibling?.nodeType === Node.TEXT_NODE) {
        previous.nodeValue += previous.nextSibling.nodeValue;
        parent.removeChild(previous.nextSibling);
      }
      if (next?.nodeType === Node.TEXT_NODE && next.previousSibling?.nodeType === Node.TEXT_NODE) {
        next.previousSibling.nodeValue += next.nodeValue;
        parent.removeChild(next);
      }
      return true;
    } catch (error) {
      console.error("Safe unwrap failed:", error);
      return false;
    }
  }

  function getElementPath(root, element) {
    const path = [];
    let current = element;
    while (current && current !== root) {
      const parent = current.parentElement;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.children, current);
      if (index < 0) return null;
      path.unshift(index);
      current = parent;
    }
    return current === root ? path : null;
  }

  function resolveElementPath(root, path) {
    let current = root;
    for (const index of path || []) {
      current = current?.children?.[index] || null;
      if (!current) return null;
    }
    return current;
  }

  function createRangeFromOffsets(doc, ancestor, start, end) {
    const walker = doc.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
    let currentOffset = 0;
    let startNode = null;
    let endNode = null;
    let startOffset = 0;
    let endOffset = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = String(node.nodeValue || "");
      const nextOffset = currentOffset + text.length;

      if (!startNode && start >= currentOffset && start <= nextOffset) {
        startNode = node;
        startOffset = Math.max(0, start - currentOffset);
      }

      if (!endNode && end >= currentOffset && end <= nextOffset) {
        endNode = node;
        endOffset = Math.max(0, end - currentOffset);
      }

      currentOffset = nextOffset;
      if (startNode && endNode) break;
    }

    if (!startNode || !endNode) return null;
    const range = doc.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function wrapRange(doc, range, className) {
    if (!range || range.collapsed) return null;
    return wrapSafeHighlightRange(doc, range, className, doc?.body);
  }

  function collectHighlightSnapshots(win) {
    const doc = win?.document;
    const body = doc?.body;
    if (!doc || !body) return [];

    return [...body.querySelectorAll('[class*="hl"]')]
      .filter((element) => isHighlightElement(element))
      .map((element) => {
        const parent = element.parentElement;
        if (!parent || isHighlightElement(parent)) return null;
        const path = getElementPath(body, parent);
        if (!path) return null;

        const range = doc.createRange();
        range.selectNodeContents(element);
        const prefix = doc.createRange();
        prefix.selectNodeContents(parent);
        prefix.setEnd(range.startContainer, range.startOffset);
        const start = prefix.toString().length;
        const text = range.toString();
        return text
          ? {
              path,
              start,
              end: start + text.length,
              text,
              className: String(element.className || "hl").trim() || "hl"
            }
          : null;
      })
      .filter(Boolean);
  }

  function restoreHighlightSnapshots(win, highlights) {
    const doc = win?.document;
    const body = doc?.body;
    if (!doc || !body || !Array.isArray(highlights) || !highlights.length) return;

    [...body.querySelectorAll('[class*="hl"]')]
      .filter((element) => isHighlightElement(element))
      .forEach((element) => unwrapHighlightElement(win, element, null));

    highlights.forEach((item) => {
      const parent = resolveElementPath(body, item.path);
      if (!parent) return;
      const range = createRangeFromOffsets(doc, parent, Number(item.start || 0), Number(item.end || 0));
      if (!range) return;
      wrapRange(doc, range, String(item.className || "hl"));
    });
  }

  function findSelectionHighlightElement(win) {
    const selection = win?.getSelection?.();
    if (!selection || !selection.rangeCount) return null;
    return findClosestHighlightElement(selection.getRangeAt(0));
  }

  function hidePlayerSelbar() {
    if (!playerSelbar) return;
    playerSelbar.hidden = true;
    playerSelbar.style.left = "";
    playerSelbar.style.top = "";
  }

  function rememberSelectionRange(win, range) {
    try {
      if (!win?.document || !range) return;
      frameState.lastSelectionRange = {
        doc: win.document,
        range: range.cloneRange()
      };
    } catch (error) {
      frameState.lastSelectionRange = null;
    }
  }

  function rememberHighlightTarget(win, target) {
    if (!win?.document || !target || !isHighlightElement(target)) {
      frameState.activeHighlightTarget = null;
      return;
    }
    frameState.activeHighlightTarget = {
      doc: win.document,
      element: target
    };
  }

  function getRememberedHighlightTarget(win) {
    const remembered = frameState.activeHighlightTarget;
    const target = remembered?.element;
    if (!remembered || remembered.doc !== win?.document || !target?.isConnected || !isHighlightElement(target)) {
      return null;
    }
    return target;
  }

  function restoreRememberedSelection(win) {
    try {
      const remembered = frameState.lastSelectionRange;
      const selection = win?.getSelection?.();
      if (!remembered || !selection || remembered.doc !== win?.document || !remembered.range) return selection;
      selection.removeAllRanges();
      selection.addRange(remembered.range.cloneRange());
      return selection;
    } catch (error) {
      return win?.getSelection?.() || null;
    }
  }

  function placePlayerSelbar(frameRect, targetRect) {
    if (!playerSelbar || !frameRect?.width || !frameRect?.height || !targetRect || (!targetRect.width && !targetRect.height)) {
      hidePlayerSelbar();
      return false;
    }

    playerSelbar.hidden = false;
    const barWidth = playerSelbar.offsetWidth || 220;
    const barHeight = playerSelbar.offsetHeight || 56;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const leftBase = frameRect.left + targetRect.left + (targetRect.width / 2) - (barWidth / 2);
    const topBase = frameRect.top + targetRect.top - barHeight - 12;
    const left = Math.min(Math.max(12, leftBase), Math.max(12, viewportWidth - barWidth - 12));
    const top = Math.max(12, topBase);
    playerSelbar.style.left = `${Math.round(left)}px`;
    playerSelbar.style.top = `${Math.round(top)}px`;
    return true;
  }

  function positionPlayerSelbar(win) {
    if (!playerSelbar || !win) {
      hidePlayerSelbar();
      return;
    }

    const selection = win.getSelection?.();
    const rememberedHighlight = getRememberedHighlightTarget(win);
    if (rememberedHighlight && (!selection || selection.isCollapsed || !selection.rangeCount)) {
      const rect = rememberedHighlight.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      placePlayerSelbar(frameRect, rect);
      return;
    }

    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      hidePlayerSelbar();
      return;
    }

    const selectedText = String(selection.toString() || "").trim();
    if (!selectedText) {
      hidePlayerSelbar();
      return;
    }

    const range = selection.getRangeAt(0);
    rememberHighlightTarget(win, null);
    rememberSelectionRange(win, range);
    const rect = range.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    placePlayerSelbar(frameRect, rect);
  }

  function updatePlayerSelbar(win) {
    try {
      positionPlayerSelbar(win);
    } catch (error) {
      hidePlayerSelbar();
      console.error("Failed to update player selbar:", error);
    }
  }

  function wrapSelection(win, className) {
    const selection = win.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

    const range = selection.getRangeAt(0);
    return wrapSafeHighlightRange(win.document, range, className, win.document?.body);
  }

  function unwrapHighlightElement(win, element, originalUnwrap) {
    if (!element || !isHighlightElement(element)) return false;

    if (originalUnwrap) {
      try {
        originalUnwrap(element);
        return true;
      } catch (error) {
        console.error("Native unWrap failed, falling back:", error);
      }
    }

    try {
      return unwrapHighlightElementSafely(element);
    } catch (error) {
      console.error("Fallback unwrap failed:", error);
      return false;
    }
  }

  function executeSelbarAction(win, act) {
    const originalAct = act;
    if (act === "note") {
      act = "hl";
    }
    const highlighter = win?.App?.highlighter;
    const originalUnwrap = typeof highlighter?.unWrap === "function"
      ? highlighter.unWrap.bind(highlighter)
      : null;
    const hideSelbar = typeof highlighter?.hideSelbar === "function"
      ? highlighter.hideSelbar.bind(highlighter)
      : () => {};

    if (!act) return;

    if ((act === "hl" || act === "note")) {
      let selection = win.getSelection?.();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        selection = restoreRememberedSelection(win);
      }
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        hideSelbar();
        hidePlayerSelbar();
        return;
      }

      const range = selection.getRangeAt(0);
      const existingHighlight = findClosestHighlightElement(range);

      if (act === "hl" && existingHighlight && isHighlightElement(existingHighlight)) {
        if (existingHighlight.classList.contains("hl-brown")) {
          existingHighlight.className = "hl-rose";
        } else {
          existingHighlight.className = "hl-brown";
        }
        rememberHighlightTarget(win, existingHighlight);
      } else {
        const span = wrapSelection(win, act === "hl" ? "hl-brown" : "hl-blue");
        if (span) {
          rememberHighlightTarget(win, span);
        }
        if (span && originalAct === "note") {
          span.dataset.hid = `h_${Date.now()}`;
          win.App?.notes?.create?.(span);
        }
      }
    } else if (act === "del") {
      const targetHighlight =
        findSelectionHighlightElement(win)
        || getRememberedHighlightTarget(win)
        || null;
      if (targetHighlight && isHighlightElement(targetHighlight)) {
        unwrapHighlightElement(win, targetHighlight, originalUnwrap);
        rememberHighlightTarget(win, null);
      }
    }

    clearSelection(win);
    hideSelbar();
    hidePlayerSelbar();
    debouncedPersistDraft(win);
  }

  function debouncedRunRecord(win, reason = "auto") {
    if (!win || !shouldRunRecord(win, reason)) return;
    if (frameState.recordDebounceTimer) {
      window.clearTimeout(frameState.recordDebounceTimer);
    }
    frameState.recordDebounceTimer = window.setTimeout(() => {
      frameState.recordDebounceTimer = null;
      scheduleRecord(win, reason);
    }, 120);
  }

  function installFinishHooks(win, runRecord) {
    const runFinishRecord = () => {
      if (frameState.suppressFinishHook || isReadOnlyReview() || isPassiveWrongbookReview()) return;
      exitPassiveWrongbookReview();
      const submittedDetails = extractAttemptDetails(win, { allowGenerated: true });
      if (Array.isArray(submittedDetails) && submittedDetails.length) {
        frameState.latestSubmittedDetails = submittedDetails;
      }
      runRecord("finish");
      if (isActiveSuiteAttempt() || !isReviewMode(win)) return;
      win.setTimeout(() => {
        const details = Array.isArray(frameState.latestSubmittedDetails)
          ? frameState.latestSubmittedDetails
          : [];
        if (!details.length) return;
        renderSavedRecordReviewArea(win, details);
        renderSavedReviewVisualFeedback(win, details);
      }, 180);
    };
    patchMethod(win, "finishTest", runFinishRecord);
    patchMethod(win, "toggleFinishMode", runFinishRecord);
    patchMethod(win.App, "finishTest", runFinishRecord);
    patchMethod(win.App, "toggleFinishMode", runFinishRecord);
    patchMethod(win.App, "toggleFinish", runFinishRecord);
    patchMethod(win.App?.highlighter, "handleAction", () => {
      clearSelection(win);
      win.requestAnimationFrame?.(() => clearSelection(win));
      win.setTimeout(() => clearSelection(win), 60);
    });
  }

  function installClickRecordBridge(win, runRecord) {
    const doc = win?.document;
    if (!doc || doc.__playerClickBridgeInstalled) return;

    doc.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const button = target.closest("button, .btn, .button");
      if (!button) return;
      if (event.isTrusted === false) return;
      if (button.matches?.(".analysis-jump[data-q]")) {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        runNativeAnalysisNavigation(win, button.dataset.q);
        return;
      }
      if (isSuiteMode && getCurrentSuite()?.completedAt && button.id === "finish") {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        handleSuiteNextClick();
        return;
      }
      if (isSuiteMode && getCurrentSuite()?.completedAt && button.id === "clear") {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        handleSuitePreviousClick();
        return;
      }
      if (isSuiteMode && !getCurrentSuite()?.completedAt && button.id === "finish") {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        finishSuitePartWithoutReview(win);
        return;
      }
      if (isSuiteMode && !getCurrentSuite()?.completedAt && button.id === "clear") {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        handleSuitePreviousClick();
        return;
      }
      if (!isSuiteMode && button.id === "clear") {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        handleClearClick();
        return;
      }
      const text = String(button.textContent || "").trim().toLowerCase();
      if (/\b(finish|submit)\b/i.test(text)) {
        exitPassiveWrongbookReview();
        runRecord("finish");
        win.setTimeout(() => {
          if (!isReviewMode(win)) return;
          const submittedDetails = extractAttemptDetails(win, { allowGenerated: true });
          if (Array.isArray(submittedDetails) && submittedDetails.length) {
            frameState.latestSubmittedDetails = submittedDetails;
          }
          const details = Array.isArray(frameState.latestSubmittedDetails)
            ? frameState.latestSubmittedDetails
            : [];
          if (!details.length) return;
          renderSavedRecordReviewArea(win, details);
          renderSavedReviewVisualFeedback(win, details);
        }, 180);
      }
    }, true);
    doc.__playerClickBridgeInstalled = true;
  }

  function installDraftBridge(win) {
    const doc = win?.document;
    if (!doc || doc.__playerDraftBridgeInstalled) return;

    const draftListener = (event) => {
      const target = event?.target;
      if (!target || typeof target.closest !== "function") return;
      const selector = event?.type === "click" ? TRACKABLE_CLICK_SELECTOR : TRACKABLE_FIELD_SELECTOR;
      if (!target.closest(selector)) return;
      debouncedPersistDraft(win);
    };
    const immediateDraftListener = () => {
      win.setTimeout(() => flushDraftSnapshot(win), 0);
    };
    doc.addEventListener("input", draftListener, true);
    doc.addEventListener("change", draftListener, true);
    doc.addEventListener("click", draftListener, true);
    doc.addEventListener("drop", immediateDraftListener, true);
    doc.addEventListener("dragend", immediateDraftListener, true);
    doc.addEventListener("pointerup", immediateDraftListener, true);
    doc.addEventListener("touchend", immediateDraftListener, true);
    win.addEventListener("pagehide", () => flushDraftSnapshot(win), true);
    win.addEventListener("beforeunload", () => flushDraftSnapshot(win), true);
    win.document?.addEventListener?.("visibilitychange", () => {
      if (win.document.visibilityState === "hidden") flushDraftSnapshot(win);
    }, true);
    doc.__playerDraftBridgeInstalled = true;
  }

  function installSelectionBridge(win) {
    const doc = win?.document;
    if (!doc || doc.__playerSelectionUiInstalled) return;

    const requestUpdate = (event) => {
      const target = event?.target;
      const selection = win.getSelection?.();
      const highlightTarget = typeof target?.closest === "function"
        ? target.closest('.hl, .hl-brown, .hl-rose, .hl-blue')
        : null;

      if (highlightTarget && (!selection || selection.isCollapsed || !selection.rangeCount)) {
        rememberHighlightTarget(win, highlightTarget);
      } else if (selection && !selection.isCollapsed && selection.rangeCount) {
        rememberHighlightTarget(win, null);
      } else if (!highlightTarget) {
        rememberHighlightTarget(win, null);
      }

      requestSelbarUpdate(win);
    };
    doc.addEventListener("mouseup", requestUpdate, true);
    doc.addEventListener("keyup", requestUpdate, true);
    doc.addEventListener("selectionchange", requestUpdate, true);
    win.addEventListener("scroll", () => requestSelbarUpdate(win), true);
    doc.__playerSelectionUiInstalled = true;
  }

  function getReviewPreferences() {
    const defaults = { analysisPlayback: "seek", analysisTarget: "evidence", answerVisibility: "hidden" };
    try {
      const saved = JSON.parse(window.localStorage?.getItem(REVIEW_PREFERENCES_KEY) || "{}");
      return {
        analysisPlayback: ["seek", "play"].includes(saved.analysisPlayback) ? saved.analysisPlayback : defaults.analysisPlayback,
        analysisTarget: ["evidence", "analysis"].includes(saved.analysisTarget) ? saved.analysisTarget : defaults.analysisTarget,
        answerVisibility: ["hidden", "shown"].includes(saved.answerVisibility) ? saved.answerVisibility : defaults.answerVisibility
      };
    } catch (error) {
      return defaults;
    }
  }

  function reviewAnalysisMatchesQuestion(question, value) {
    const qid = Number(String(question || "").replace(/\D/g, ""));
    const text = String(value || "").replace(/&nbsp;/gi, " ");
    if (!qid || !text) return false;
    if (new RegExp(`(?:问题|Question|Q)\\s*0?${qid}(?!\\d)|第\\s*0?${qid}\\s*题|(^|\\D)0?${qid}\\s*题`, "i").test(text)) return true;
    const ranges = /(?:Questions?|问题|Q)\s*(\d+)\s*(?:-|–|—|至|到|和|and|to|&)\s*(\d+)(?:\s*题)?|第\s*(\d+)\s*(?:-|–|—|至|到|和|&)\s*(\d+)\s*题/gi;
    let match = null;
    while ((match = ranges.exec(text))) {
      const start = Number(match[1] || match[3]);
      const end = Number(match[2] || match[4]);
      if (qid >= Math.min(start, end) && qid <= Math.max(start, end)) return true;
    }
    return false;
  }

  function runNativeAnalysisNavigation(win, question) {
    const qid = String(question || "").trim();
    if (!win || !qid) return;
    const preferences = getReviewPreferences();
    if (typeof win.jumpToAnalysis === "function") win.jumpToAnalysis(qid);
    if (preferences.analysisTarget === "analysis") {
      const cues = [...win.document?.querySelectorAll?.(".study-cue") || []];
      const index = cues.findIndex((cue) => reviewAnalysisMatchesQuestion(qid, cue.querySelector(".cue-analysis")?.textContent));
      if (index >= 0) {
        const timeLabel = String(cues[index].querySelector(".cue-time")?.textContent || "").split(/\s+(?:-->|-)\s+/)[0];
        const start = parseCueStartSeconds(timeLabel);
        const audio = win.document?.querySelector("audio");
        if (audio) audio.currentTime = start;
        const cue = cues[index];
        win.document?.querySelectorAll(".study-cue").forEach((button) => button.classList.toggle("active", button === cue));
        cue?.scrollIntoView?.({ block: "nearest" });
      }
    }
    const audio = win.document?.querySelector("audio");
    if (!audio) return;
    audio.playbackRate = 1;
    if (preferences.analysisPlayback === "play") audio.play().catch(() => {});
    else audio.pause();
  }

  function findNativeQuestionAnalysisAnchor(doc, question) {
    const qid = String(question || "").trim();
    if (!doc || !qid) return null;
    const exactText = (selector) => [...doc.querySelectorAll(selector)].find((node) => (
      !node.closest(".review,#nav,.nav,.question-analysis-shortcuts")
      && String(node.textContent || "").trim().replace(/[.：:]$/, "") === qid
    ));
    const direct = exactText(".blank-q,.flow-num,.map-row-label strong,.match-row strong,p > strong");
    if (direct) {
      if (direct.matches(".match-row strong,.blank-q") && direct.closest(".match-row")) {
        return direct.closest(".match-row").querySelector("span:not(.blank-q)") || direct.closest(".match-row");
      }
      if (direct.matches(".flow-num")) return direct.closest(".flow-step")?.querySelector(".flow-text") || direct.parentElement;
      if (direct.closest(".map-row-label")) return direct.closest(".map-row-label");
      if (direct.matches("p > strong")) return direct.parentElement;
      return direct.closest(".doc-line-content,p,td,li") || direct.parentElement || direct;
    }
    const rangeBlock = [...doc.querySelectorAll(".group[data-id],.question-block[data-q]")].find((node) => {
      const numbers = String(node.dataset.id || node.dataset.q || "").match(/\d+/g) || [];
      if (numbers.length < 2) return false;
      const start = Number(numbers[0]);
      const end = Number(numbers[1]);
      return Number(qid) >= Math.min(start, end) && Number(qid) <= Math.max(start, end);
    });
    const rangeAnchor = rangeBlock?.querySelector("p");
    if (rangeAnchor) return rangeAnchor;
    const escaped = escapeAttrValue(qid);
    const field = doc.querySelector([
      `input[name="q${escaped}"]`,
      `[data-q="${escaped}"]:not(#nav *):not(.analysis-jump):not(.question-analysis-shortcut)`,
      `[data-name="q${escaped}"]:not(.analysis-jump)`
    ].join(","));
    if (!field || field.closest(".review,#nav,.nav")) return null;
    const row = field.closest(".match-row,.flow-step,.map-row,.question-block,p,td,li") || field.parentElement;
    return row?.querySelector?.(".blank-q,.flow-num,.map-row-label strong,.match-row strong,p > strong") || field;
  }

  function syncNativeQuestionAnalysisShortcuts(win) {
    const doc = win?.document;
    if (!doc?.body) return;
    const reviewTargets = [...doc.querySelectorAll(".analysis-jump[data-q]")];
    if (!reviewTargets.length) {
      doc.querySelectorAll(".question-analysis-shortcut,.question-analysis-shortcut-style").forEach((node) => node.remove());
      delete doc.documentElement.dataset.reviewAnswerPreferenceApplied;
      return;
    }
    if (!doc.querySelector(".question-analysis-shortcut-style")) {
      const style = doc.createElement("style");
      style.className = "question-analysis-shortcut-style";
      style.textContent = ".question-analysis-shortcut{display:inline-flex!important;align-items:center;justify-content:center;width:auto!important;min-width:0!important;max-width:none!important;min-height:0!important;flex:0 0 auto;margin-left:7px;padding:1px 6px;border:1px solid #93c5fd;border-radius:999px;background:#eff6ff;color:#1d4ed8;font:600 10px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;vertical-align:middle;cursor:pointer;white-space:nowrap}.question-analysis-shortcut:hover{background:#dbeafe;border-color:#60a5fa}.question-analysis-shortcut:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}";
      doc.head?.appendChild(style);
    }
    reviewTargets.forEach((target) => {
      const qid = String(target.dataset.q || "").trim();
      if (!qid || doc.querySelector(`.question-analysis-shortcut[data-q="${escapeAttrValue(qid)}"]`)) return;
      const anchor = findNativeQuestionAnalysisAnchor(doc, qid);
      if (!anchor || anchor.querySelector?.(".question-analysis-shortcut")) return;
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "question-analysis-shortcut";
      button.dataset.q = qid;
      button.textContent = "解析";
      button.setAttribute("aria-label", `查看第 ${qid} 题解析并播放对应录音`);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        runNativeAnalysisNavigation(win, qid);
      });
      anchor.appendChild(button);
    });
    if (!doc.documentElement.dataset.reviewAnswerPreferenceApplied) {
      doc.documentElement.dataset.reviewAnswerPreferenceApplied = "1";
      if (getReviewPreferences().answerVisibility === "shown") {
        doc.querySelectorAll(".answer-toggle").forEach((button) => {
          if (button.dataset.visible !== "1") button.click();
        });
      }
    }
  }

  function installFrameObserver(win) {
    const doc = win?.document;
    if (!doc) return;

    if (frameState.observer) {
      frameState.observer.disconnect();
      frameState.observer = null;
    }

    installTrackerBridge(win);
    installIntervalTracking(win);
    hideNativeUi(win);
    disableTextAssistance(win);
    resetPlaybackRate(win);
    installUnifiedSuiteAudioSync(win);
    installFrameAudioRetry(win);
    installSuiteAttemptRestrictions(win);
    frameState.suppressAutoPersist = false;
    const savedState = getSavedPlayerState();
    // Single pages should reopen where the learner left them. Clear starts a fresh attempt.
    const shouldStartFreshSuitePart = shouldResetSuitePartForFreshAttempt(savedState);
    if (explicitRedo || shouldStartFreshSuitePart) {
      frameState.finishedLocked = false;
      frameState.restoredKey = getPlayerStateKey();
      resetPlayerUiState();
      resetNativeQuestionForFreshAttempt(win);
      setStatus(explicitRedo ? "已从空白开始重做这篇。" : "套题作答已准备好，当前部分从空白开始。", "ok");
    }

    const runRecord = (reason = "auto") => debouncedRunRecord(win, reason);

    installFinishHooks(win, runRecord);
    installClickRecordBridge(win, runRecord);
    installDraftBridge(win);
    syncNativeQuestionAnalysisShortcuts(win);

    const ObserverCtor = win.MutationObserver || MutationObserver;
    frameState.observer = new ObserverCtor(() => {
      scheduleFrameMaintenance(win, () => {
        hideNativeUi(win);
        disableTextAssistance(win);
        resetPlaybackRate(win);
        installUnifiedSuiteAudioSync(win);
        installFrameAudioRetry(win);
        installSuiteAttemptRestrictions(win);
        refreshMatchingSlotLabels(win);
        syncNativeQuestionAnalysisShortcuts(win);
        syncNativeSuiteButtons(win);
        syncNativeAudioMirror(win);
      });
    });
    if (doc.body) {
      frameState.observer.observe(doc.body, {
        childList: true,
        subtree: true
      });
    }

    if (savedState?.retryPending) {
      frameState.finishedLocked = false;
      clearCompletedSnapshotForRetry();
      resetNativeQuestionForFreshAttempt(win);
      win.setTimeout(() => resetNativeQuestionForFreshAttempt(win), 80);
      win.setTimeout(() => resetNativeQuestionForFreshAttempt(win), 240);
      setStatus("待完成：已清空上次完成态，可重新作答。", "ok");
    } else if (!shouldStartFreshSuitePart) {
      setStatus("已启用自动记录。", "ok");
    }
    syncNativeSuiteButtons(win);
    startTimerSync(win);

    if (frameState.skipRestoreOnce) {
      frameState.skipRestoreOnce = false;
      frameState.finishedLocked = false;
    } else if (!shouldStartFreshSuitePart && savedState && !savedState.retryPending && frameState.restoredKey !== getPlayerStateKey()) {
      frameState.restoredKey = getPlayerStateKey();
      frameState.finishedLocked = isSuiteMode && !getCurrentSuite()?.completedAt
        ? false
        : !!savedState.finishedLocked && hasCompletedRecord();
      win.setTimeout(() => restoreFrameSnapshot(win, savedState), 80);
    } else if (!savedState) {
      frameState.finishedLocked = false;
    }
    if (isPassiveWrongbookReview() && !savedState?.retryPending) {
      win.setTimeout(() => restoreReadOnlyReviewFromRecord(win), savedState ? 160 : 80);
    }
    if (isSuiteMode && getCurrentSuite()?.completedAt) {
      win.setTimeout(() => enterSuiteReviewMode(win), savedState ? 40 : 20);
    }
    if (isUnifiedSuiteAudioEnabled()) {
      restoreUnifiedSuiteAudioFromState();
      win.setTimeout(() => syncNativeAudioMirror(win), 80);
    }
  }

  function bootstrapFrame() {
    try {
      const win = frame.contentWindow;
      const doc = win?.document;
      if (!win || !doc || !doc.documentElement) return false;

      const currentPath = normalizePath(win.location?.href || decodedSrc);
      if (frameState.activePath === currentPath && frameState.activeDocument === doc && frameState.observer) return true;

      frameState.activePath = currentPath;
      frameState.activeDocument = doc;
      frameState.context = getContextFromSrc(currentPath) || getContextFromSrc(decodedSrc);
      frameState.playerStateKey = frameState.context?.relativePath || normalizePath(decodedSrc);
      frameState.lastSignature = "";
      frameState.latestSuiteAttempt = null;
      frameState.intensive.lines = [];
      frameState.intensive.activeIndex = 0;
      hideIntensivePanel();
      frameState.storageKeys = new Set();
      title.textContent = doc.title || decodedSrc;
      document.title = doc.title || decodedSrc;
      installFrameObserver(win);
      return true;
    } catch (error) {
      console.error(error);
      setStatus("自动记录初始化失败。", "error");
      return false;
    }
  }

  function installPlayerRuntimeHooks() {
    window.__PLAYER_CREATE_TRACKER_BRIDGE__ = () => {
      return createTrackerBridge(frameState.context || getContextFromSrc(decodedSrc)) || window.PracticeTracker;
    };
    window.__PLAYER_TRACK_STORAGE_KEY__ = (key) => {
      if (key) frameState.storageKeys.add(String(key));
    };
    window.__PLAYER_TRACK_INTERVAL__ = (id) => {
      if (id != null) frameState.intervalIds.add(id);
    };
  }

  function loadQuestionHtmlIntoFrame(htmlText, statusMessage, statusLevel) {
    if (!isUsableQuestionHtml(htmlText)) return false;
    clearErrorState();
    hideFrameForSuiteReview();
    frame.srcdoc = buildSrcdocHtml(htmlText);
    setStatus(statusMessage, statusLevel);
    scheduleSuiteNeighborPreload();
    return true;
  }

  function isUsableQuestionHtml(htmlText) {
    const html = String(htmlText || "");
    if (!/<html|<!doctype html/i.test(html)) return false;
    if (/id=["']player-frame["']|player-app\.js/i.test(html)) return false;
    return /<body[\s>]/i.test(html) && html.length > 500;
  }

  function resetPlayerUiState() {
    if (finishButton) {
      finishButton.textContent = "Finish";
      finishButton.disabled = false;
      finishButton.style.opacity = "1";
      finishButton.style.cursor = "pointer";
    }
    if (playerTimer) playerTimer.textContent = "00:00";
    clearPlayerNotes();
    hideIntensivePanel();
    syncIntensiveButtonState();
  }

  function startNotePanelDrag(event) {
    if (!notePanel || notePanel.hidden) return;
    const point = "touches" in event ? event.touches?.[0] : event;
    if (!point) return;
    const position = getNotePanelPosition();
    frameState.noteDrag = {
      pointerId: "pointerId" in event ? event.pointerId : null,
      offsetX: Number(point.clientX || 0) - position.left,
      offsetY: Number(point.clientY || 0) - position.top
    };
    event.preventDefault();
  }

  function updateNotePanelDrag(event) {
    if (!frameState.noteDrag || !notePanel || notePanel.hidden) return;
    if ("pointerId" in event && frameState.noteDrag.pointerId != null && event.pointerId !== frameState.noteDrag.pointerId) {
      return;
    }
    const point = "touches" in event ? event.touches?.[0] : event;
    if (!point) return;
    setNotePanelPosition({
      left: Number(point.clientX || 0) - frameState.noteDrag.offsetX,
      top: Number(point.clientY || 0) - frameState.noteDrag.offsetY
    });
  }

  function stopNotePanelDrag() {
    if (!frameState.noteDrag) return;
    frameState.noteDrag = null;
    const win = frame.contentWindow;
    if (win) {
      debouncedPersistDraft(win);
    }
  }

  async function loadQuestion() {
    hidePlayerSelbar();
    hideFrameForSuiteReview();
    installPlayerRuntimeHooks();
    const sourceUrl = resolveQuestionSourceUrl(decodedSrc);
    const isNativeDiskLibrary = !!window.NativeDiskStorage;

    try {
      const cachedHtml = await (window.LibraryCache?.ensureQuestionHtml?.(
        decodedSrc,
        async () => {
          const response = await fetch(sourceUrl);
          if (!response.ok && response.status !== 0) {
            throw new Error(`Unexpected response: ${response.status}`);
          }
          return response.text();
        },
        { silent: true }
      ) || Promise.resolve(""));
      if (loadQuestionHtmlIntoFrame(cachedHtml, "已从题库缓存加载。", "ok")) return;
    } catch (error) {
      console.error("Failed to load cached HTML:", error);
    }

    if (!isNativeDiskLibrary) {
      try {
        const response = await fetch(sourceUrl);
        if (!response.ok && response.status !== 0) {
          throw new Error(`Unexpected response: ${response.status}`);
        }
        const htmlText = await response.text();
        if (loadQuestionHtmlIntoFrame(htmlText, "已从原题加载。", "ok")) return;
      } catch (error) {
        console.error("Failed to load source HTML directly:", error);
      }
    }

    try {
      const directoryHtml = await (window.LibraryCache?.ensureQuestionHtml?.(
        decodedSrc,
        null,
        { silent: false, force: true }
      ) || Promise.resolve(""));
      if (loadQuestionHtmlIntoFrame(directoryHtml, "已重新授权并加载题目。", "ok")) return;
    } catch (error) {
      console.error("Failed to load HTML after permission request:", error);
    }

    showError("无法从本地题库目录读取题目。请返回首页点击“更新题库”，重新选择包含 普通 和 VIP 文件夹的题库根目录。");
  }

  function navigateSuitePart(nextIndex) {
    const suite = getCurrentSuite();
    const safeIndex = Math.max(0, Math.min(Number(nextIndex || 0), (suite?.items || []).length - 1));
    const nextItem = suite?.items?.[safeIndex] || null;
    if (!nextItem?.path) return;
    const currentWin = getFrameWindow();
    flushDraftSnapshot(currentWin);
    clearTrackedIntervals(currentWin);
    suiteIndex = safeIndex;
    suiteItem = nextItem;
    decodedSrc = nextItem.path;
    frameState.activePath = "";
    frameState.activeDocument = null;
    frameState.context = null;
    frameState.playerStateKey = "";
    frameState.restoredKey = "";
    frameState.lastSignature = "";
    frameState.latestSuiteAttempt = null;
    frameState.storageKeys = new Set();
    frameState.intervalIds = new Set();
    frameState.suppressAutoPersist = false;
    frameState.skipRestoreOnce = false;
    hideIntensivePanel();
    hidePlayerSelbar();
    title.textContent = `套题 ${suiteItem.part}：${decodedSrc}`;
    if (clearButton) clearButton.disabled = suiteIndex <= 0;
    if (finishButton) finishButton.textContent = getSuiteFinishButtonText(suite);
    loadQuestion();
    syncNativeSuiteButtons();
    syncSuiteButton(suite);
  }

  function handleFrameLoad() {
    bootstrapFrame();
    hidePlayerSelbar();
  }

  function getFrameWindow() {
    return frame.contentWindow || null;
  }

  function on(element, eventName, handler, options) {
    element?.addEventListener(eventName, handler, options);
  }

  function persistCurrentDraft() {
    const win = getFrameWindow();
    if (win) {
      flushDraftSnapshot(win);
    }
  }

  function handleFinishClick() {
    const win = getFrameWindow();
    if (!win) return;
    exitPassiveWrongbookReview();
    if (isSuiteMode) {
      if (!getCurrentSuite()?.completedAt) {
        finishSuitePartWithoutReview(win);
        return;
      }
    }
    const reviewing = isReviewMode(win);
    if (isFinishLocked(win)) {
      if (isSuiteMode) {
        handleSuiteNextClick();
        return;
      }
      setStatus("当前题已完成，如需重新作答请点击 Clear。", "warn");
      return;
    }

    if (!reviewing) {
      performFinishToggle(win);
    }

    window.setTimeout(() => finalizeFinish(win), 80);
    window.setTimeout(() => finalizeFinish(win, { lock: true }), 220);
  }

  function handleClearClick() {
    const win = getFrameWindow();
    if (!win) return;
    exitPassiveWrongbookReview();
    if (isSuiteMode && !getCurrentSuite()?.completedAt) {
      handleSuitePreviousClick();
      return;
    }
    const reviewing = isReviewMode(win);
    hidePlayerSelbar();
    frameState.suppressAutoPersist = true;
    clearPlayerNotes();
    clearSavedPlayerState();
    clearNativeQuestionStorage(win);
    clearTrackedIntervals(win);
    frameState.lastSignature = "";
    frameState.restoredKey = "";
    frameState.finishedLocked = false;
    frameState.activeDocument = null;
    frameState.skipRestoreOnce = true;
    resetPlayerUiState();
    setStatus(reviewing ? "已退出完成态，正在开始新的单篇练习。" : "已清空当前题进度，正在还原题目。", "warn");
    const redoUrl = new URL(window.location.href);
    redoUrl.searchParams.set("redo", "1");
    redoUrl.searchParams.delete("review");
    redoUrl.searchParams.delete("attemptTs");
    redoUrl.searchParams.delete("attemptSig");
    redoUrl.searchParams.delete("attemptIndex");
    window.location.replace(redoUrl.href);
  }

  function handleNoteToggle() {
    const win = getFrameWindow();
    if (win && !performNativeNotesToggle(win)) {
      showNotePanel();
    }
    persistCurrentDraft();
  }

  function handleTranscriptClick() {
    if (isSuiteMode && !getCurrentSuite()?.completedAt) {
      setStatus("套题未完成 P4 前不显示原文和精听。", "warn");
      return;
    }
    const win = getFrameWindow();
    if (!win) return;
    if (isSuiteMode) {
      win.document?.documentElement?.classList?.remove("suite-attempt-active");
      [...win.document?.querySelectorAll?.("[class*='transcript'], [id*='transcript'], [class*='Transcript'], [id*='Transcript']") || []]
        .forEach((element) => { element.hidden = false; });
    }
    performTranscriptToggle(win);
    window.setTimeout(() => {
      installFrameObserver(win);
      requestSelbarUpdate(win);
    }, 80);
  }

  function handleIntensiveToggle() {
    if (isSuiteMode && !getCurrentSuite()?.completedAt) {
      setStatus("套题未完成 P4 前不显示精听。", "warn");
      return;
    }
    hidePlayerSelbar();
    toggleIntensivePanel();
  }

  function handleIntensiveBodyClick(event) {
    const item = event.target?.closest?.(".player-intensive-line");
    if (!item) return;
    playIntensiveLine(Number(item.dataset.index || 0));
  }

  function handleIntensivePrevClick() {
    playIntensiveLine(frameState.intensive.activeIndex - 1);
  }

  function handleIntensivePlayClick() {
    const audio = getIntensiveAudio();
    if (!audio) return;
    if (audio.paused) {
      playIntensiveLine(frameState.intensive.activeIndex);
    } else {
      audio.pause();
    }
  }

  function handleIntensiveNextClick() {
    playIntensiveLine(frameState.intensive.activeIndex + 1);
  }

  function handleIntensiveLoopClick() {
    frameState.intensive.loop = !frameState.intensive.loop;
    setIntensiveToggleStates();
  }

  function handleIntensiveSlowClick() {
    const audio = getIntensiveAudio();
    frameState.intensive.slow = !frameState.intensive.slow;
    if (audio) audio.playbackRate = frameState.intensive.slow ? 0.8 : 1;
    setIntensiveToggleStates();
  }

  function handleIntensiveCnClick() {
    frameState.intensive.showCn = !frameState.intensive.showCn;
    setIntensiveToggleStates();
  }

  function handleIntensiveAnalysisClick() {
    frameState.intensive.showAnalysis = !frameState.intensive.showAnalysis;
    setIntensiveToggleStates();
  }

  function handleHighlightClick() {
    const win = getFrameWindow();
    if (win) executeSelbarAction(win, "hl");
  }

  function handleHighlightClearClick() {
    const win = getFrameWindow();
    if (win) executeSelbarAction(win, "del");
  }

  function handleNoteCloseClick() {
    hideNotePanel();
    persistCurrentDraft();
  }

  function handleViewportChange() {
    if (notePanel) {
      setNotePanelPosition(getNotePanelPosition());
    }
    requestSelbarUpdate(getFrameWindow());
  }

  function handleBackToLibrary(event) {
    event?.preventDefault?.();
    persistCurrentDraft();
    if (window.NativeDiskStorage?.backToLibrary) {
      window.NativeDiskStorage.backToLibrary();
      return;
    }
    window.location.href = "../index.html";
  }

  function extractSuiteTestData(htmlText) {
    const match = String(htmlText || "").match(/<script\s+id=["']test-data["']\s+type=["']application\/json["']>([\s\S]*?)<\/script>/i);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch (error) {
      console.error("Failed to parse suite test-data:", error);
      return null;
    }
  }

  async function loadSuitePartData(item) {
    refreshSuiteItemPath(item);
    const path = resolveSuiteItemPath(item);
    if (!path) return null;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (attempt) await new Promise((resolve) => window.setTimeout(resolve, attempt * 180));
        const html = await (window.LibraryCache?.ensureQuestionHtml?.(path, async () => {
          const response = await fetch(resolveQuestionSourceUrl(path));
          if (!response.ok && response.status !== 0) throw new Error(`Unexpected response: ${response.status}`);
          return response.text();
        }, { silent: true, force: attempt > 0 }) || Promise.resolve(""));
        const data = extractSuiteTestData(html);
        if (!data) throw new Error(`Missing test-data: ${path}`);
        if (item && typeof item === "object") item.path = path;
        return { item, data, path };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`Unable to load suite item: ${path}`);
  }

  function getSuiteDraftKey() {
    return `ielts_suite_outer_draft_${suiteId}`;
  }

  function readSuiteDraft() {
    try {
      const raw = window.localStorage?.getItem(getSuiteDraftKey());
      const draft = raw ? JSON.parse(raw) : { parts: {}, notes: {}, highlights: {}, study: {} };
      if (draft.renderVersion !== SUITE_OUTER_RENDER_VERSION) {
        Object.values(draft.parts || {}).forEach((part) => {
          if (part && typeof part === "object") part.contentHtml = "";
        });
        draft.renderVersion = SUITE_OUTER_RENDER_VERSION;
      }
      return draft;
    } catch (error) {
      return { renderVersion: SUITE_OUTER_RENDER_VERSION, parts: {}, notes: {}, highlights: {}, study: {} };
    }
  }

  function writeSuiteDraft(draft) {
    try {
      if (draft && typeof draft === "object") draft.renderVersion = SUITE_OUTER_RENDER_VERSION;
      window.localStorage?.setItem(getSuiteDraftKey(), JSON.stringify(draft || {}));
    } catch (error) {
      console.error("Failed to save suite draft:", error);
    }
  }

  function clearSuiteDraft() {
    try {
      window.localStorage?.removeItem(getSuiteDraftKey());
    } catch (error) {}
  }

  function suiteNormalizeAnswer(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.,!?;:'"“”‘’]/g, "");
  }

  function suiteAnswersEqual(userAnswer, correctAnswer, multiple = false) {
    const normalizedUser = suiteNormalizeAnswer(userAnswer);
    if (multiple) {
      return !!normalizedUser && String(correctAnswer || "")
        .split(/\s*\/\s*/)
        .map(suiteNormalizeAnswer)
        .filter(Boolean)
        .some((accepted) => normalizedUser === accepted);
    }
    return !!normalizedUser && String(correctAnswer || "")
      .split(/\s*\/\s*/)
      .map(suiteNormalizeAnswer)
      .filter(Boolean)
      .some((accepted) => normalizedUser === accepted);
  }

  function suiteCorrectAnswerFor(data, qid) {
    const key = `q${qid}`;
    const answerKey = data?.answerKey || {};
    if (answerKey.text?.[key] != null) return { type: "text", answer: answerKey.text[key] };
    if (answerKey.single?.[key] != null) return { type: "single", answer: answerKey.single[key] };
    if (answerKey.matching?.[key] != null) return { type: "matching", answer: answerKey.matching[key] };
    if (answerKey.map?.[key] != null) return { type: "map", answer: answerKey.map[key] };
    if (answerKey.multipleMap?.[key] != null) return { type: "multiple", answer: answerKey.multipleMap[key] };
    return { type: "", answer: "" };
  }

  function suiteQuestionRange(id) {
    const [start, end] = String(id || "").split("-").map((value) => Number(value));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    const out = [];
    for (let n = start; n <= end; n += 1) out.push(String(n));
    return out;
  }

  function suiteMultipleGroupFor(data, qid) {
    return (data?.groups || []).find((group) => (
      group?.type === "multiple" && suiteQuestionRange(group.id).includes(String(qid))
    )) || null;
  }

  function suiteGetUserAnswer(state, data, qid) {
    const key = `q${qid}`;
    const answerInfo = suiteCorrectAnswerFor(data, qid);
    if (answerInfo.type === "multiple") {
      const group = suiteMultipleGroupFor(data, qid);
      const groupKey = group ? `q${String(group.id).replace("-", "_")}` : "";
      const values = groupKey ? [...(state.multiple?.[groupKey] || [])] : [];
      const groupIds = group ? suiteQuestionRange(group.id) : [];
      const fallbackAnswer = values[groupIds.indexOf(String(qid))] || "";
      const correctValues = String(answerInfo.answer || "")
        .split(/\s*\/\s*/)
        .map(suiteNormalizeAnswer)
        .filter(Boolean);
      const match = values.find((value) => {
        const normalized = suiteNormalizeAnswer(value);
        return normalized && correctValues.includes(normalized);
      });
      return match || fallbackAnswer;
    }
    return state.text?.[key] || state.single?.[key] || state.matching?.[key] || state.map?.[key] || "";
  }

  function buildSuiteAttempt(partState, partData, item, index) {
    const data = partData?.data || partData || {};
    const state = partState || {};
    const details = (data.questionIds || []).map((qid) => {
      const info = suiteCorrectAnswerFor(data, qid);
      const correctAnswer = Array.isArray(info.answer) ? info.answer.join(", ") : String(info.answer ?? "");
      const userAnswer = suiteGetUserAnswer(state, data, qid);
      return {
        question: String(qid),
        userAnswer: userAnswer || "No Answer",
        correctAnswer,
        isCorrect: suiteAnswersEqual(userAnswer, correctAnswer, info.type === "multiple")
      };
    });
    const correct = details.filter((detail) => detail.isCorrect).length;
    const timestamp = new Date().toISOString();
    const highlightHtml = String(state.highlightHtml || "");
    const highlightTexts = (() => {
      if (!highlightHtml) return [];
      try {
        const template = document.createElement("template");
        template.innerHTML = highlightHtml;
        return [...template.content.querySelectorAll(".hl-brown,.hl-rose,.hl-blue")].map((element) => ({
          text: String(element.textContent || "").trim(),
          className: String(element.className || "hl-brown").trim() || "hl-brown"
        })).filter((entry) => entry.text);
      } catch (error) {
        return [];
      }
    })();
    return {
      id: item?.questionId || item?.path || item?.title || data.title || "",
      questionId: item?.questionId || "",
      questionKey: "",
      title: item?.title || data.title || "",
      section: item?.section || "",
      part: item?.part || `P${Number(index || 0) + 1}`,
      frequency: item?.frequency || "",
      relativePath: item?.path || "",
      total: details.length,
      correct,
      wrong: Math.max(0, details.length - correct),
      percent: details.length ? Math.round((correct / details.length) * 100) : 0,
      timestamp,
      formattedTime: formatAttemptTime(timestamp),
      signature: JSON.stringify(details),
      wrongbookSyncSignature: JSON.stringify({ details, highlights: Array.isArray(state.highlights) ? state.highlights : [], highlightTexts }),
      details,
      highlightHtml,
      highlights: Array.isArray(state.highlights) ? state.highlights : [],
      highlightTexts
    };
  }

  function escSuite(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderSuiteFillInput(qid, lead = "") {
    const id = escSuite(qid);
    return `<span class="blank-q">${id}</span>${escSuite(lead || "")}<input class="suite-blank" name="q${id}" data-q="${id}" type="text" autocomplete="off" spellcheck="false">`;
  }

  function renderSuiteFillLineContent(meta, body) {
    const level = Math.max(0, Number(meta?.level || 0));
    const bullet = level > 0 ? "◦" : "•";
    return meta?.list ? `<span class="doc-bullet">${bullet}</span><span class="doc-line-content">${body}</span>` : body;
  }

  function renderSuiteFillLine(line, qids = [], used = new Set(), inner = false) {
    const meta = typeof line === "object" && line ? line : {};
    const raw = String(meta.text ?? line ?? "");
    let html = escSuite(raw);
    let hit = false;
    html = html.replace(/(^|[^\d])(\d{1,2})\.?\s*((?:£\s*)?)(?:_{2,}|…{2,}|\.{3,})/g, (match, prefix, qid, lead) => {
      if (qids.length && !qids.includes(String(qid))) return match;
      used.add(String(qid));
      hit = true;
      return `${prefix}${renderSuiteFillInput(qid, lead)}`;
    });
    const numbered = raw.match(/^(\d{1,2})\.?\s+(.+)$/);
    if (!hit && numbered && (!qids.length || qids.includes(String(numbered[1])))) {
      const qid = String(numbered[1]);
      used.add(qid);
      let body = escSuite(numbered[2]);
      const input = renderSuiteFillInput(qid);
      body = /(?:_+|…{2,}|\.{3,})/.test(body)
        ? body.replace(/(?:_+|…{2,}|\.{3,})/, input)
        : `${body} ${input}`;
      return inner ? renderSuiteFillLineContent(meta, body) : body;
    }
    return inner ? renderSuiteFillLineContent(meta, html) : html;
  }

  function renderSuiteFillTable(lines, qids = [], used = new Set()) {
    const rows = [];
    let maxCols = 1;
    (lines || []).forEach((line) => {
      const meta = typeof line === "object" && line ? line : {};
      const row = Number(meta.row || 0);
      const col = Number(meta.col || 0);
      const cols = Number(meta.cols || 1);
      maxCols = Math.max(maxCols, cols, col + 1);
      if (!rows[row]) rows[row] = [];
      if (!rows[row][col]) rows[row][col] = [];
      rows[row][col].push(`<div class="fill-table-line">${renderSuiteFillLine(line, qids, used, true)}</div>`);
    });
    const body = rows.map((cells, rowIndex) => {
      const filled = (cells || [])
        .map((parts, col) => parts ? { col, html: parts.join("") } : null)
        .filter(Boolean);
      return `<tr>${filled.map((cell) => {
        const tag = rowIndex === 0 ? "th" : "td";
        const span = filled.length === 1 && maxCols > 1 ? ` colspan="${maxCols}"` : "";
        return `<${tag}${span}>${cell.html}</${tag}>`;
      }).join("")}</tr>`;
    }).join("");
    return `<div class="fill-table-wrap"><table class="fill-table">${body}</table></div>`;
  }

  function renderSuiteFlowText(raw, qid) {
    const questionId = String(qid || "");
    let html = escSuite(raw || "");
    if (questionId) {
      html = html.replace(new RegExp(`(^|\\D)(${questionId})(?!\\d)`), (_, prefix, id) => `${prefix}<span class="flow-num">${id}</span>`);
    }
    html = html.replace(/(?:_{2,}|…{2,}|\.{4,})/, `<button class="slot suite-slot" type="button" data-q="${escSuite(questionId)}" aria-label="Question ${escSuite(questionId)}">选择</button>`);
    if (!/class="slot suite-slot"/.test(html) && questionId) {
      html += ` <button class="slot suite-slot" type="button" data-q="${escSuite(questionId)}" aria-label="Question ${escSuite(questionId)}">选择</button>`;
    }
    return html;
  }

  function renderSuiteFlowSteps(group) {
    const questionMap = new Map((group.questions || []).map(([qid, label]) => [String(qid), String(label || "")]));
    const used = new Set();
    const lines = Array.isArray(group.bodyLines) ? group.bodyLines : [];
    if (lines.length) {
      const body = lines.map((line) => {
        const raw = String(typeof line === "object" && line ? line.text : line || "");
        const qid = [...questionMap.keys()].find((id) => new RegExp(`(^|\\D)${id}(?!\\d)`).test(raw));
        if (qid) {
          used.add(qid);
          return `<div class="flow-step flow-step-full"><div class="flow-text">${renderSuiteFlowText(raw, qid)}</div></div>`;
        }
        return `<div class="flow-note">${escSuite(raw)}</div>`;
      }).join("");
      const missing = [...questionMap.entries()].filter(([qid]) => !used.has(qid)).map(([qid, label]) => (
        `<div class="flow-step"><span class="flow-num">${escSuite(qid)}</span><span class="flow-text">${escSuite(label)}</span><button class="slot suite-slot" type="button" data-q="${escSuite(qid)}" aria-label="Question ${escSuite(qid)}">选择</button></div>`
      )).join("");
      return body + missing;
    }
    return (group.questions || []).map(([qid, label], index) => (
      `<div class="flow-step"><span class="flow-num">${escSuite(qid)}</span><span class="flow-text">${escSuite(label)}</span><button class="slot suite-slot" type="button" data-q="${escSuite(qid)}" aria-label="Question ${escSuite(qid)}">选择</button></div>${index < (group.questions || []).length - 1 ? '<div class="flow-arrow">↓</div>' : ""}`
    )).join("");
  }

  function suiteFallbackOptions(group) {
    const instruction = String(group?.instruction || "");
    const rangeMatch = instruction.match(/([A-Z])\s*(?:-|–|to)\s*([A-Z])/i);
    if (rangeMatch) {
      const start = rangeMatch[1].toUpperCase().charCodeAt(0);
      const end = rangeMatch[2].toUpperCase().charCodeAt(0);
      if (end >= start && end - start <= 12) {
        const values = [];
        for (let code = start; code <= end; code += 1) values.push([String.fromCharCode(code), ""]);
        return values;
      }
    }
    const listed = [...new Set((instruction.match(/\b[A-Z]\b/g) || []).filter((value) => value >= "A" && value <= "Z"))];
    if (listed.length >= 2 && listed.length <= 12) return listed.map((value) => [value, ""]);
    return [["A", ""], ["B", ""], ["C", ""]];
  }

  function renderSuiteQuestionGroup(group, partData, index) {
    const type = group?.type || "";
    const titleHtml = `<h3>${escSuite(group.title || "")}</h3>`;
    const fillInstructionFromBody = () => {
      const lines = Array.isArray(group.bodyLines) ? group.bodyLines : [];
      return lines.find((line) => String(line?.text || "").trim())?.text || group.instruction || "";
    };
    const instructionText = type === "fill" ? fillInstructionFromBody() : group.instruction;
    const instructionHtml = instructionText ? `<div class="instruction">${escSuite(instructionText)}</div>` : "";
    if (type === "fill") {
      const lines = Array.isArray(group.bodyLines) && group.bodyLines.length
        ? group.bodyLines
        : (group.questions || []).map((q) => ({ text: q.text || "", list: true, level: 0 }));
      const qids = (group.questions || []).map((q) => String(q.id));
      const used = new Set();
      let body = "";
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const tableId = line?.table;
        if (tableId) {
          const chunk = [];
          while (i < lines.length && lines[i]?.table === tableId) {
            chunk.push(lines[i]);
            i += 1;
          }
          i -= 1;
          body += renderSuiteFillTable(chunk, qids, used);
          continue;
        }
        if (String(line?.text || "").trim() === String(instructionText || "").trim()) continue;
        const style = line.level ? ` style="--indent:${Number(line.level || 0) * 18}px"` : "";
        const cls = line.list ? "doc-line is-list" : "doc-line";
        const bullet = line.list ? `<span class="doc-bullet">•</span>` : "";
        body += `<div class="${cls}"${style}>${bullet}<span class="doc-line-content">${renderSuiteFillLine(line, qids, used)}</span></div>`;
      }
      return `<section class="group">${titleHtml}${instructionHtml}${body}</section>`;
    }
    if (type === "single") {
      const body = (group.questions || []).map((q) => {
        const qid = q.id;
        const optionList = (q.options || []).length ? q.options : suiteFallbackOptions(group);
        const options = optionList.map(([value, label]) => {
          const text = label ? `<strong>${escSuite(value)}</strong> ${escSuite(label)}` : `<strong>${escSuite(value)}</strong>`;
          return `<div class="choice single-choice" role="button" tabindex="0" data-name="q${escSuite(qid)}" data-q="${escSuite(qid)}" data-value="${escSuite(value)}">${text}</div>`;
        }).join("");
        return `<div class="question-block"><p><strong>${escSuite(qid)}.</strong> ${escSuite(q.text || "")}</p>${options}</div>`;
      }).join("");
      return `<section class="group">${titleHtml}${instructionHtml}${body}</section>`;
    }
    if (type === "multiple") {
      const groupName = `q${String(group.id || "").replace("-", "_")}`;
      const body = `<div class="question-block" data-q="${escSuite(group.id || "")}" data-limit="${escSuite(group.limit || suiteQuestionRange(group.id).length || 99)}"><p><strong>${escSuite(group.id || "")}</strong> ${escSuite(group.questionText || "")}</p>${(group.options || []).map(([value, label]) => (
        `<div class="choice multi-choice" role="button" tabindex="0" data-name="${escSuite(groupName)}" data-group="${escSuite(group.id || "")}" data-value="${escSuite(value)}"><strong>${escSuite(value)}</strong> ${escSuite(label)}</div>`
      )).join("")}</div>`;
      return `<section class="group">${titleHtml}${instructionHtml}${body}</section>`;
    }
    if (type === "matching") {
      const groupKey = String((group.questions || [])[0]?.[0] || group.title || "matching");
      const allowRepeat = (group.questions || []).length > (group.options || []).length;
      const repeatAttr = allowRepeat ? ' data-repeat="true"' : "";
      const optionPool = `<div class="pool">${group.optionsTitle ? `<strong>${escSuite(group.optionsTitle)}</strong>` : ""}${(group.options || []).map(([value, label]) => (
        `<div class="choice match-choice" role="button" tabindex="0" draggable="true" data-value="${escSuite(value)}"><strong>${escSuite(value)}</strong> ${escSuite(label)}</div>`
      )).join("")}</div>`;
      const rows = group.layout === "flow"
        ? renderSuiteFlowSteps(group)
        : (group.questions || []).map(([qid, label]) => (
          `<div class="match-row"><span class="blank-q">${escSuite(qid)}</span><span>${escSuite(label)}</span><button class="slot suite-slot" type="button" data-q="${escSuite(qid)}" aria-label="Question ${escSuite(qid)}">选择</button></div>`
        )).join("");
      const layoutClass = group.layout === "flow" ? "flow-layout" : "matching";
      const leftClass = group.layout === "flow" ? "flow-steps" : "match-list";
      return `<section class="group matching-group" data-match-group="${escSuite(groupKey)}"${repeatAttr}>${titleHtml}${instructionHtml}<div class="${layoutClass}"><div class="${leftClass}">${rows}</div>${optionPool}</div></section>`;
    }
    if (type === "map") {
      const imageUrl = group.image
        ? new URL(group.image, resolveQuestionSourceUrl(partData.path)).href
        : "";
      const mapOptions = (group.options || []).length ? group.options : ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
      const mapOptionCount = Math.max(1, mapOptions.length);
      const rows = (group.questions || []).map(([qid, label]) => (
        `<div class="map-row" style="--map-options:${mapOptionCount}"><div class="map-row-label"><strong>${escSuite(qid)}.</strong> ${escSuite(label)}</div><div class="map-options">${mapOptions.map((value) => (
          `<div class="choice map-choice" role="button" tabindex="0" data-name="q${escSuite(qid)}" data-q="${escSuite(qid)}" data-value="${escSuite(value)}">${escSuite(value)}</div>`
        )).join("")}</div></div>`
      )).join("");
      return `<section class="group">${titleHtml}${instructionHtml}<div class="map-layout"><div class="map-image">${imageUrl ? `<img src="${escSuite(imageUrl)}" alt="">` : ""}</div><div class="map-grid">${rows}</div></div></section>`;
    }
    return `<section class="group">${titleHtml}${instructionHtml}<p>暂不支持的题型：${escSuite(type)}</p></section>`;
  }

  function suiteCueRange(line) {
    const parts = String(line?.time || "").split(/\s*-->\s*/);
    const start = parseCueStartSeconds(parts[0]);
    const end = parseCueEndSeconds(line?.time, start);
    return { start, end };
  }

  function startSuiteOuterRenderer() {
    const suite = getCurrentSuite();
    if (!suite?.items?.length) {
      showError("套题记录不存在，请返回题库重新开始。");
      return;
    }

    document.body.innerHTML = `
      <div class="suite-outer">
        <header class="suite-head">
          <div>
            <div id="suite-title" class="suite-title">套题加载中...</div>
            <div id="suite-status" class="suite-status">正在读取题目...</div>
          </div>
          <a class="back-link" href="../index.html">返回题库</a>
        </header>
        <main id="suite-main" class="suite-main">
          <section class="suite-left">
            <div class="suite-audio">
              <button id="suite-play" class="suite-play" type="button">▶</button>
              <div id="suite-bar" class="suite-bar"><div id="suite-fillbar" class="suite-fillbar"></div></div>
              <span id="suite-time">00:00 / 00:00</span>
              <span id="suite-speed">1.0x</span>
            </div>
            <div id="suite-content" class="suite-content"></div>
          </section>
          <aside id="suite-transcript" class="suite-transcript" hidden></aside>
        </main>
        <aside id="suite-notes" class="suite-notes" hidden><div class="notes-head"><span>Notes</span><button id="suite-notes-close" type="button">Close</button></div><textarea id="suite-notes-text" spellcheck="false"></textarea></aside>
        <div id="suite-selbar" class="suite-selbar" hidden><button data-act="note" type="button">Note</button><button data-act="hl" type="button">Highlight</button><button data-act="del" type="button">Clear</button></div>
        <footer class="suite-bottom">
          <div id="suite-nav" class="suite-nav"></div>
          <div class="suite-actions">
            <span id="suite-timer" class="timer">40:00</span>
            <button id="suite-prev" type="button">Previous</button>
            <button id="suite-next" type="button">Next</button>
            <button id="suite-clear" type="button">Clear</button>
            <button id="suite-note" type="button">Notes</button>
            <button id="suite-intensive" type="button">原文和精听</button>
          </div>
        </footer>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      html,body{height:100%;margin:0;overflow:hidden;background:#f8fafc;color:#0f172a;font-family:Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;font-size:16px}
      .question-analysis-shortcut{display:inline-flex!important;align-items:center;justify-content:center;width:auto!important;min-width:0!important;max-width:none!important;min-height:0!important;flex:0 0 auto;margin-left:7px;padding:1px 6px;border:1px solid #93c5fd;border-radius:999px;background:#eff6ff;color:#1d4ed8;font:600 10px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;vertical-align:middle;cursor:pointer;white-space:nowrap}.question-analysis-shortcut:hover{background:#dbeafe;border-color:#60a5fa}.question-analysis-shortcut:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}
      *{box-sizing:border-box}.suite-outer{height:100vh;display:flex;flex-direction:column}.suite-head{height:58px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 18px;background:#fff;border-bottom:1px solid #dbe3ef}.suite-title{font-weight:800;font-size:15px}.suite-status{font-size:12px;color:#64748b;margin-top:2px}.suite-status.ok{color:#166534}.suite-status.warn{color:#b45309}.suite-status.error{color:#b91c1c}.suite-main{flex:1;display:flex;min-height:0}.suite-left{flex:1;min-width:0;background:#fff;overflow:auto}.suite-transcript{flex:0 0 42%;overflow:auto;border-left:1px solid #dbe3ef;background:#f8fafc;padding:20px}.suite-main.split .suite-transcript{display:block}.suite-audio{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:14px 24px;background:#fff;border-bottom:1px solid #dbe3ef}.suite-play{width:42px;height:42px;border:0;border-radius:50%;background:#2563eb;color:#fff}.suite-bar{height:7px;border-radius:999px;background:#dbe3ef;flex:1;overflow:hidden}.suite-fillbar{height:100%;width:0;background:#2563eb}.suite-content{padding:20px 28px 96px}.group{border:1px solid #dbe3ef;border-radius:8px;background:#fff;padding:20px 22px;margin:0 0 24px}.group h3{margin:0 0 10px;font-size:18px}.instruction{border-left:4px solid #2563eb;background:#f8fafc;padding:9px 12px;margin:12px 0 18px;color:#64748b}.choice{display:block;margin:8px 0;border:1px solid #dbe3ef;border-radius:8px;background:#f8fafc;color:#0f172a;padding:9px 12px;cursor:pointer;text-align:left}.choice.selected{background:#dbeafe;border-color:#60a5fa;color:#1e40af;font-weight:700}.choice.hidden{display:none}.blank-q{font-weight:800;margin-right:6px}.suite-blank{width:min(170px,48vw);border:0;border-bottom:2px solid #94a3b8;border-radius:0;padding:4px 8px;background:transparent;color:#0f172a;font:inherit;line-height:1.4}.doc-line{line-height:1.75;margin:10px 0}.doc-line.is-list{display:grid;grid-template-columns:16px minmax(0,1fr);column-gap:8px;align-items:baseline;margin:7px 0 7px calc(24px + var(--indent,0px))}.doc-bullet{font-weight:900}.fill-table-wrap{overflow:auto;margin:12px 0 18px}.fill-table{width:100%;border-collapse:collapse;min-width:680px}.fill-table th,.fill-table td{border:1px solid #dbe3ef;padding:10px 12px;vertical-align:top;line-height:1.45}.fill-table th{background:#f8fafc;font-weight:800;text-align:left}.fill-table-line{margin:0 0 7px}.fill-table-line:last-child{margin-bottom:0}.fill-table .doc-line{margin:0}.fill-table .suite-blank{width:min(150px,100%)}.matching{display:grid;grid-template-columns:minmax(300px,1fr) minmax(220px,.45fr);gap:clamp(12px,2.2vw,24px);align-items:start;max-width:1040px}.match-row{display:grid;grid-template-columns:42px minmax(150px,340px) auto;gap:10px;align-items:center;width:min(100%,520px);margin:12px 0}.slot{min-width:86px;max-width:min(260px,42vw);min-height:38px;border:2px dashed #94a3b8;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;justify-self:start;padding:5px 8px;background:#f8fafc;cursor:pointer;overflow-wrap:anywhere}.pool{border:1px solid #dbe3ef;border-radius:8px;background:#f8fafc;padding:14px;display:flex;flex-direction:column;gap:10px}.flow-layout{display:grid;grid-template-columns:minmax(320px,1fr) minmax(220px,.42fr);gap:clamp(12px,2.2vw,24px);align-items:start;max-width:1040px}.flow-steps{display:flex;flex-direction:column;gap:8px}.flow-step{display:grid;grid-template-columns:42px minmax(280px,520px) auto;gap:12px;align-items:center;width:min(100%,740px);border:1px solid #dbe3ef;background:#f8fafc;border-radius:8px;padding:10px}.flow-step-full{grid-template-columns:1fr}.flow-step-full .slot{margin-left:10px;vertical-align:middle}.flow-note{width:min(100%,740px);font-weight:800;color:#0f172a;padding:6px 2px 2px}.flow-num{font-weight:800;color:#2563eb}.flow-text{line-height:1.55;min-width:0}.flow-arrow{width:min(100%,740px);color:#64748b;font-weight:800;text-align:center}.map-layout{display:grid;grid-template-columns:minmax(360px,clamp(420px,58vw,820px)) minmax(330px,1fr);gap:18px;align-items:start}.map-image{min-width:0}.map-image img{display:block;width:100%;height:auto;max-height:min(74vh,820px);object-fit:contain;border:1px solid #dbe3ef;border-radius:8px;background:#f8fafc}.map-grid{min-width:0}.map-answer-list{display:flex;flex-direction:column;gap:10px}.map-row{display:grid;grid-template-columns:minmax(96px,.75fr) minmax(306px,1.25fr);gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #dbe3ef}.map-row-label{font-size:14px}.map-options{display:grid;grid-template-columns:repeat(var(--map-options,9),minmax(30px,1fr));gap:5px;min-width:306px;overflow-x:auto;overscroll-behavior-x:contain;padding-bottom:2px}.map-choice{margin:0;padding:7px 0;text-align:center;font-weight:800;min-width:30px}.suite-bottom{height:70px;position:fixed;left:0;right:0;bottom:0;z-index:30;background:#fff;border-top:1px solid #dbe3ef;display:flex;align-items:center;justify-content:space-between;padding:0 28px}.suite-nav{display:flex;gap:8px;flex-wrap:wrap}.suite-nav button{min-width:36px;height:36px;border:1px solid #dbe3ef;border-radius:8px;background:#f8fafc;font-weight:800}.suite-nav button.answered{background:#dbeafe;color:#1e40af}.suite-nav button.correct{background:#dcfce7;color:#166534}.suite-nav button.incorrect{background:#fee2e2;color:#991b1b}.suite-actions{display:flex;align-items:center;gap:10px}.suite-actions button,.back-link{border:1px solid #dbe3ef;background:#f8fafc;color:#0f172a;border-radius:999px;padding:8px 14px;cursor:pointer;text-decoration:none}.suite-actions button:disabled{opacity:.45;cursor:not-allowed}.timer{font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:800}.review{margin-top:18px;border-top:1px dashed #dbe3ef;padding-top:14px}.review table{width:100%;border-collapse:collapse}.review th,.review td{border:1px solid #dbe3ef;padding:8px;text-align:left}.result-correct{color:#16a34a;font-weight:800}.result-incorrect{color:#dc2626;font-weight:800}.cue{display:block;padding:10px 0;border-bottom:1px solid #dbe3ef}.cue-time{display:block;color:#64748b;font-size:12px;margin-bottom:5px}.cue-cn{margin-top:4px;color:#64748b;font-size:13px}.cue-analysis{margin-top:8px;padding:8px 10px;border-left:3px solid #2563eb;background:#fff;color:#0f172a;font-size:13px;line-height:1.55}mark{padding:2px 4px;border-radius:4px;color:#111827}.study-head{position:sticky;top:0;background:#f8fafc;padding-bottom:12px;border-bottom:1px solid #dbe3ef;margin-bottom:10px}.study-controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.study-controls button{border:1px solid #dbe3ef;background:#fff;border-radius:999px;padding:7px 10px;cursor:pointer}.study-controls button.active{background:#dbeafe;border-color:#60a5fa;color:#1e40af;font-weight:800}.study-cue{display:block;width:100%;text-align:left;border:1px solid #dbe3ef;border-radius:8px;background:#fff;color:#0f172a;padding:10px 12px;margin:6px 0;cursor:pointer}.study-cue.active{border-color:#60a5fa;background:#eff6ff}.hide-cn .cue-cn{display:none}.hide-analysis .cue-analysis{display:none}.suite-notes{position:fixed;right:22px;top:82px;width:min(380px,calc(100vw - 44px));height:420px;z-index:60;background:#fff;border:1px solid #dbe3ef;border-radius:10px;box-shadow:0 18px 48px rgba(15,23,42,.18);display:flex;flex-direction:column}.suite-notes[hidden]{display:none}.notes-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #dbe3ef;font-weight:800}.suite-notes textarea{flex:1;border:0;padding:12px;resize:none;font:inherit}
      .hl-brown{background:#8b4513;color:#fff;border-radius:4px;padding:0 2px}.hl-rose{background:#c2185b;color:#fff;border-radius:4px;padding:0 2px}.hl-blue{background:#2563eb;color:#fff;border-radius:4px;padding:0 2px}.suite-selbar{position:absolute;z-index:80;background:#fff;border:1px solid #dbe3ef;box-shadow:0 10px 24px rgba(15,23,42,.18);border-radius:999px;padding:6px;display:inline-flex;gap:6px}.suite-selbar[hidden]{display:none}.suite-selbar button{border:0;border-radius:999px;background:#f8fafc;color:#0f172a;padding:6px 10px;cursor:pointer}
      .suite-content,.suite-transcript{font-size:1rem}.choice{user-select:text;-webkit-user-select:text;font:inherit}.choice.disabled{pointer-events:none;opacity:.72}.slot{font:inherit}.suite-blank:focus{outline:2px solid rgba(37,99,235,.18);border-bottom-color:#2563eb}.suite-main.split .suite-left{flex-basis:58%}.suite-main.split .suite-transcript{flex-basis:42%}
      .review-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.answer-cell{display:flex;align-items:center;gap:8px;justify-content:space-between}.answer-value.is-hidden{color:#64748b;font-style:italic}.answer-toggle,.show-all-answers,.analysis-jump{border:1px solid #dbe3ef;background:#fff;color:#0f172a;border-radius:999px;padding:5px 9px;cursor:pointer;white-space:nowrap}.answer-toggle:hover,.show-all-answers:hover,.analysis-jump:hover{border-color:#60a5fa;background:#eff6ff}.result-wrap{display:flex;align-items:center;justify-content:space-between;gap:8px}.suite-review-correct{border-color:#4ade80!important;outline:1px solid rgba(34,197,94,.2)!important;outline-offset:0!important;background:rgba(240,253,244,.7)!important;color:#166534!important;opacity:1!important}.suite-review-incorrect{border-color:#f87171!important;outline:1px solid rgba(239,68,68,.18)!important;outline-offset:0!important;background:rgba(254,242,242,.72)!important;color:#991b1b!important;opacity:1!important}.suite-review-row-correct,.suite-review-row-incorrect{box-shadow:none!important;background:transparent!important}
      @media(max-width:980px){.map-layout,.flow-layout{grid-template-columns:1fr}.map-image img{max-height:min(72vh,760px)}.map-row{grid-template-columns:minmax(90px,.55fr) minmax(306px,1fr);align-items:center}.map-grid{overflow-x:auto}.map-options{grid-template-columns:repeat(var(--map-options,9),minmax(30px,1fr))}}@media(max-width:820px){.matching{grid-template-columns:1fr}.map-row{grid-template-columns:1fr}.suite-bottom{height:auto;min-height:82px;align-items:flex-start;gap:10px;flex-direction:column;padding:10px 16px}.suite-content{padding-bottom:130px}.suite-transcript{display:none}}
    `;
    document.head.appendChild(style);

    const refs = {
      title: document.getElementById("suite-title"),
      status: document.getElementById("suite-status"),
      main: document.getElementById("suite-main"),
      content: document.getElementById("suite-content"),
      transcript: document.getElementById("suite-transcript"),
      nav: document.getElementById("suite-nav"),
      timer: document.getElementById("suite-timer"),
      prev: document.getElementById("suite-prev"),
      next: document.getElementById("suite-next"),
      clear: document.getElementById("suite-clear"),
      note: document.getElementById("suite-note"),
      intensive: document.getElementById("suite-intensive"),
      notes: document.getElementById("suite-notes"),
      notesClose: document.getElementById("suite-notes-close"),
      notesText: document.getElementById("suite-notes-text"),
      selbar: document.getElementById("suite-selbar"),
      play: document.getElementById("suite-play"),
      bar: document.getElementById("suite-bar"),
      fillbar: document.getElementById("suite-fillbar"),
      time: document.getElementById("suite-time")
    };

    const state = {
      suite,
      parts: [],
      index: Math.max(0, Math.min(suiteIndex, suite.items.length - 1)),
      draft: readSuiteDraft(),
      audio: new Audio(),
      audioPart: 0,
      audioStarted: false,
      audioDurations: [],
      restoredAudio: false,
      autoFinishPending: false,
      lastAudioPersistAt: 0,
      checking: false,
      checkRemainingSeconds: SUITE_REVIEW_GRACE_SECONDS,
      checkTickAt: 0,
      selectedMatch: "",
      selectedMatchGroup: "",
      dragFromSlot: "",
      intensive: { activeIndex: 0, loop: false, slow: false, showCn: true, showAnalysis: true }
    };
    state.audio.preload = "auto";
    state.audio.setAttribute("playsinline", "");
    state.audio.setAttribute("webkit-playsinline", "");
    state.audio.muted = false;
    state.audio.volume = 1;

    const setSuiteStatus = (message, level = "") => {
      refs.status.textContent = message;
      refs.status.className = `suite-status${level ? ` ${level}` : ""}`;
    };

    const getPartState = (index = state.index) => {
      const key = String(index);
      state.draft.parts ||= {};
      state.draft.parts[key] ||= { text: {}, single: {}, multiple: {}, matching: {}, map: {}, highlights: [], highlightHtml: "", highlightTexts: [], contentHtml: "" };
      state.draft.parts[key].contentHtml = "";
      return state.draft.parts[key];
    };

    const persist = () => {
      const key = String(state.index);
      if (refs.notesText) {
        state.draft.notes ||= {};
        state.draft.notes[key] = refs.notesText.value || "";
      }
      if (!state.suite.completedAt && !explicitSuiteReview) {
        state.draft.audio = {
          started: !!state.audioStarted,
          partIndex: state.audioPart,
          currentTime: Number(state.audio.currentTime || 0),
          durations: state.audioDurations.map((value) => Number(value || 0)),
          paused: true,
          updatedAt: Date.now()
        };
        state.draft.check = {
          active: !!state.checking,
          remainingSeconds: Math.max(0, Number(state.checkRemainingSeconds || 0)),
          updatedAt: Date.now()
        };
      }
      writeSuiteDraft(state.draft);
    };

    const formatTime = (seconds) => {
      const value = Math.max(0, Number(seconds || 0));
      return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
    };

    const getAudioUrl = (index) => {
      const part = state.parts[index];
      const audioName = part?.data?.audio || "audio.mp3";
      return new URL(audioName, resolveQuestionSourceUrl(part?.path || "")).href;
    };

    attachAudioRetry(state.audio, () => getAudioUrl(state.audioPart), {
      shouldPlay: () => state.audioStarted && !state.audio.paused,
      report: (message, level) => setSuiteStatus(message, level)
    });

    const requestAudioPlayback = () => {
      state.audio.muted = false;
      state.audio.volume = 1;
      const requestedSrc = state.audio.src;
      const requestedPart = state.audioPart;
      const promise = state.audio.play?.();
      promise?.catch?.((error) => {
        if (state.audio.src !== requestedSrc || state.audioPart !== requestedPart) return;
        console.error("Suite audio playback failed:", error);
        refs.play.textContent = "▶";
        setSuiteStatus("Safari 未能开始播放，请再点一次播放按钮并检查 iPad 音量。", "warn");
      });
    };

    const loadAudioPart = (index, options = {}) => {
      const safe = Math.max(0, Math.min(index, state.parts.length - 1));
      const src = getAudioUrl(safe);
      if (!src) return;
      const durationKey = String(state.parts[safe]?.path || "").replace(/\\/g, "/");
      const knownDuration = Number(window.XIAHUA_AUDIO_DURATIONS?.[durationKey] || 0);
      if (knownDuration > 0) state.audioDurations[safe] = knownDuration;
      state.audioPart = safe;
      if (state.audio.src !== src) {
        state.audio.pause();
        refs.play.textContent = "▶";
        state.audio.src = src;
        state.audio.currentTime = 0;
        refs.fillbar.style.width = "0%";
        refs.time.textContent = `0:00 / ${knownDuration > 0 ? formatTime(knownDuration) : "00:00"}`;
        state.audio.load?.();
      }
      state.audio.playbackRate = 1;
      if (!options.suppressPlay && (options.play || state.audioStarted)) {
        requestAudioPlayback();
      }
    };

    const ensureAudioReady = () => {
      if (!state.audio.src || state.audioPart !== state.index) {
        loadAudioPart(state.index, { suppressPlay: true });
      }
    };

    const loadAudioDuration = (index) => {
      const durationKey = String(state.parts[index]?.path || "").replace(/\\/g, "/");
      const knownDuration = Number(window.XIAHUA_AUDIO_DURATIONS?.[durationKey] || 0);
      if (knownDuration > 0) return Promise.resolve(knownDuration);
      return new Promise((resolve) => {
      const probe = new Audio();
      probe.preload = "metadata";
      const finish = (value) => {
        probe.removeAttribute("src");
        resolve(Number.isFinite(value) && value > 0 ? value : 0);
      };
      probe.addEventListener("loadedmetadata", () => finish(Number(probe.duration || 0)), { once: true });
      probe.addEventListener("error", () => finish(0), { once: true });
      probe.src = getAudioUrl(index);
      probe.load?.();
      });
    };

    const getAudioRemainingSeconds = () => {
      if (!state.audioStarted) return null;
      if (state.audioDurations.length !== state.parts.length || state.audioDurations.some((value) => !(value > 0))) return null;
      const elapsedBefore = state.audioDurations.slice(0, state.audioPart).reduce((sum, value) => sum + value, 0);
      const total = state.audioDurations.reduce((sum, value) => sum + value, 0);
      return Math.max(0, Math.ceil(total - elapsedBefore - Number(state.audio.currentTime || 0)));
    };

    const updateAudioTime = () => {
      if (state.audio.duration) refs.fillbar.style.width = `${(state.audio.currentTime / state.audio.duration) * 100}%`;
      refs.time.textContent = `${formatTime(state.audio.currentTime)} / ${state.audio.duration ? formatTime(state.audio.duration) : "00:00"}`;
    };

    state.audio.addEventListener("play", () => {
      state.audioStarted = true;
      refs.play.textContent = "⏸";
      setSuiteStatus(`正在播放 ${state.suite.items[state.audioPart]?.part || "当前题目"} 对应音频。`, "ok");
      persist();
    });
    state.audio.addEventListener("pause", () => {
      refs.play.textContent = "▶";
      persist();
    });
    state.audio.addEventListener("timeupdate", () => {
      updateAudioTime();
      if (Date.now() - state.lastAudioPersistAt >= 1000) {
        state.lastAudioPersistAt = Date.now();
        persist();
      }
    });
    state.audio.addEventListener("loadedmetadata", () => {
      if (Number(state.audio.duration || 0) > 0) {
        state.audioDurations[state.audioPart] = Number(state.audio.duration);
      }
      updateAudioTime();
      updateTimer();
    });
    state.audio.addEventListener("ended", () => {
      if (state.audioPart < state.parts.length - 1) {
        goToPart(state.audioPart + 1);
      } else if (!state.suite.completedAt && !explicitSuiteReview && !state.autoFinishPending) {
        state.checking = true;
        state.checkRemainingSeconds = SUITE_REVIEW_GRACE_SECONDS;
        state.checkTickAt = Date.now();
        setSuiteStatus("音频结束，进入 2 分钟检查时间；可提前点 Finish 提交。", "warn");
        persist();
      }
    });
    refs.play.addEventListener("click", () => {
      ensureAudioReady();
      if (state.audio.paused) requestAudioPlayback();
      else state.audio.pause();
    });

    const updateTimer = () => {
      const currentSuite = window.SuitePractice?.getSuite?.(suiteId) || state.suite;
      if (currentSuite.completedAt || explicitSuiteReview) {
        refs.timer.textContent = getSuiteSummaryText(currentSuite) || "已完成";
        return;
      }
      if (!state.audioStarted) {
        refs.timer.textContent = state.audioDurations.length === state.parts.length
          ? formatSuiteRemaining(state.audioDurations.reduce((sum, value) => sum + value, SUITE_REVIEW_GRACE_SECONDS))
          : "未开始";
        return;
      }
      if (state.checking) {
        if (document.visibilityState !== "hidden") {
          const now = Date.now();
          if (state.checkTickAt) {
            state.checkRemainingSeconds = Math.max(0, state.checkRemainingSeconds - ((now - state.checkTickAt) / 1000));
          }
          state.checkTickAt = now;
        } else {
          state.checkTickAt = 0;
        }
        const checkSeconds = Math.max(0, Math.ceil(state.checkRemainingSeconds));
        refs.timer.textContent = `检查 ${formatSuiteRemaining(checkSeconds)}`;
        if (checkSeconds <= 0 && !state.autoFinishPending) {
          state.autoFinishPending = true;
          window.setTimeout(() => finishSuite(true), 0);
        }
        return;
      }
      const seconds = getAudioRemainingSeconds();
      refs.timer.textContent = seconds == null ? "音频播放中" : formatSuiteRemaining(seconds + SUITE_REVIEW_GRACE_SECONDS);
    };

    const extractSuiteHighlightTexts = (sourceHtml) => {
      const html = String(sourceHtml || "");
      if (!html) return [];
      try {
        const template = document.createElement("template");
        template.innerHTML = html;
        const seen = new Set();
        return [...template.content.querySelectorAll(".hl-brown,.hl-rose,.hl-blue")].map((element) => {
          const text = String(element.textContent || "").trim();
          const className = String(element.className || "hl-brown").trim() || "hl-brown";
          const key = `${className}::${text}`;
          if (!text || seen.has(key)) return null;
          seen.add(key);
          return { text, className };
        }).filter(Boolean);
      } catch (error) {
        return [];
      }
    };

    const collectInputs = () => {
      const partState = getPartState();
      partState.text = {};
      partState.single = {};
      partState.multiple = {};
      partState.matching = {};
      partState.map = {};
      refs.content.querySelectorAll(".suite-blank").forEach((input) => {
        partState.text[`q${input.dataset.q}`] = input.value || "";
      });
      refs.content.querySelectorAll(".single-choice.selected").forEach((button) => {
        partState.single[`q${button.dataset.q}`] = button.dataset.value || "";
      });
      refs.content.querySelectorAll(".map-choice.selected").forEach((button) => {
        partState.map[`q${button.dataset.q}`] = button.dataset.value || "";
      });
      refs.content.querySelectorAll(".question-block[data-q][data-limit]").forEach((block) => {
        const key = `q${String(block.dataset.q || "").replace("-", "_")}`;
        partState.multiple[key] = [...block.querySelectorAll(".multi-choice.selected")].map((button) => button.dataset.value || "").filter(Boolean).sort();
      });
      refs.content.querySelectorAll(".suite-slot").forEach((slot) => {
        const value = slot.dataset.value || "";
        if (value) partState.matching[`q${slot.dataset.q}`] = value;
      });
      const clone = refs.content.cloneNode(true);
      clone.querySelectorAll(".review").forEach((node) => node.remove());
      clone.querySelectorAll(".suite-blank").forEach((input) => {
        input.setAttribute("value", input.value || "");
        input.removeAttribute("disabled");
      });
      clone.querySelectorAll(".choice, button.slot").forEach((button) => {
        button.removeAttribute("disabled");
      });
      partState.highlightHtml = clone.innerHTML;
      partState.highlights = collectSuiteHighlightSnapshots();
      partState.highlightTexts = extractSuiteHighlightTexts(partState.highlightHtml);
      partState.contentHtml = "";
      persist();
    };

    const isSuiteFillHighlightNode = (node) => {
      const element = nodeElement(node);
      if (!element) return false;
      return !!element.closest?.(".blank-q,.suite-blank");
    };

    const collectSuiteHighlightSnapshots = () => {
      return [...refs.content.querySelectorAll(".hl-brown,.hl-rose,.hl-blue")]
        .map((element) => {
          const parent = element.parentElement;
          if (!parent || isHighlightElement(parent) || isSuiteFillHighlightNode(element)) return null;
          const path = getElementPath(refs.content, parent);
          if (!path) return null;
          const range = document.createRange();
          range.selectNodeContents(element);
          const prefix = document.createRange();
          prefix.selectNodeContents(parent);
          prefix.setEnd(range.startContainer, range.startOffset);
          const start = prefix.toString().length;
          const text = range.toString();
          return text ? {
            path,
            start,
            end: start + text.length,
            text,
            className: String(element.className || "hl-brown").trim() || "hl-brown",
            hid: element.dataset.hid || ""
          } : null;
        })
        .filter(Boolean);
    };

    const extractSuiteHighlightSnapshotsFromHtml = (html) => {
      if (!html) return [];
      try {
        const holder = document.createElement("div");
        holder.innerHTML = String(html || "");
        return [...holder.querySelectorAll(".hl-brown,.hl-rose,.hl-blue")]
          .map((element) => {
            const parent = element.parentElement;
            if (!parent || isHighlightElement(parent) || isSuiteFillHighlightNode(element)) return null;
            const path = getElementPath(holder, parent);
            if (!path) return null;
            const range = document.createRange();
            range.selectNodeContents(element);
            const prefix = document.createRange();
            prefix.selectNodeContents(parent);
            prefix.setEnd(range.startContainer, range.startOffset);
            const start = prefix.toString().length;
            const text = range.toString();
            return text ? {
              path,
              start,
              end: start + text.length,
              text,
              className: String(element.className || "hl-brown").trim() || "hl-brown",
              hid: element.dataset.hid || ""
            } : null;
          })
          .filter(Boolean);
      } catch (error) {
        return [];
      }
    };

    const restoreSuiteHighlightSnapshots = (highlights) => {
      if (!Array.isArray(highlights) || !highlights.length) return 0;
      let restored = 0;
      highlights.forEach((item) => {
        const parent = resolveElementPath(refs.content, item.path);
        if (!parent) return;
        const range = createRangeFromOffsets(document, parent, Number(item.start || 0), Number(item.end || 0));
        if (!range) return;
        const span = wrapSafeHighlightRange(document, range, String(item.className || "hl-brown"), refs.content);
        if (span) {
          if (item.hid) span.dataset.hid = item.hid;
          restored += 1;
        }
      });
      return restored;
    };

    const copySuiteHighlights = (source) => {
      const sourceHtml = typeof source === "string" ? source : source?.highlightHtml;
      const sourceTexts = Array.isArray(source?.highlightTexts) ? source.highlightTexts : [];
      const savedSnapshotHighlights = Array.isArray(source?.highlights) ? source.highlights : [];
      const htmlSnapshotHighlights = extractSuiteHighlightSnapshotsFromHtml(sourceHtml);
      const sourceHighlights = savedSnapshotHighlights.length ? savedSnapshotHighlights : htmlSnapshotHighlights;
      if (!sourceHtml && !sourceTexts.length) return;
      const template = document.createElement("template");
      template.innerHTML = String(sourceHtml || "");
      const savedHighlights = [...template.content.querySelectorAll(".hl-brown,.hl-rose,.hl-blue")];
      const restoredSnapshots = restoreSuiteHighlightSnapshots(sourceHighlights);
      const fallbackTexts = restoredSnapshots ? [] : (sourceTexts.length ? sourceTexts : extractSuiteHighlightTexts(sourceHtml));

      const hasHighlightText = (text, className) => [...refs.content.querySelectorAll(".hl-brown,.hl-rose,.hl-blue")]
        .some((element) => String(element.textContent || "").trim() === text && String(element.className || "").includes(className));

      const applyTextHighlight = (text, className, hid = "") => {
        const value = String(text || "").replace(/\s+/g, " " ).trim();
        const highlightClass = String(className || "hl-brown").trim() || "hl-brown";
        // Text fallback is intentionally conservative: short fragments such as
        // "a" or "in" can match unrelated words after a suite part rerenders.
        if (value.length < 4 || hasHighlightText(value, highlightClass)) return false;
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const boundaryPattern = /^[A-Za-z0-9]+$/.test(value)
          ? new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=$|[^A-Za-z0-9])`)
          : null;
        const currentWalk = document.createTreeWalker(refs.content, NodeFilter.SHOW_TEXT);
        let cursor;
        while ((cursor = currentWalk.nextNode())) {
          const parent = cursor.parentElement;
          if (!parent || isSuiteFillHighlightNode(cursor) || parent.closest?.(".hl-brown,.hl-rose,.hl-blue")) continue;
          const nodeText = String(cursor.nodeValue || "");
          const match = boundaryPattern ? boundaryPattern.exec(nodeText) : null;
          const index = boundaryPattern ? (match ? match.index + match[1].length : -1) : nodeText.indexOf(value);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(cursor, index);
          range.setEnd(cursor, index + value.length);
          const span = wrapSafeHighlightRange(document, range, highlightClass, refs.content);
          if (span) {
            if (hid) span.dataset.hid = hid;
            return true;
          }
        }
        return false;
      };

      savedHighlights.forEach((saved) => {
        if (isSuiteFillHighlightNode(saved)) return;
        applyTextHighlight(saved.textContent, saved.className, saved.dataset.hid || "");
      });
      fallbackTexts.forEach((item) => applyTextHighlight(item.text, item.className));
    };

    const ensureSuiteFillInputs = (part) => {
      const fillGroups = (part?.data?.groups || []).filter((group) => group?.type === "fill");
      if (!fillGroups.length) return;
      const makeInput = (qid) => {
        const id = String(qid || "").trim();
        const input = document.createElement("input");
        input.className = "suite-blank";
        input.name = `q${id}`;
        input.dataset.q = id;
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;
        return input;
      };
      fillGroups.forEach((group) => {
        const qids = (group.questions || [])
          .map((question) => String(question?.id || "").trim())
          .filter(Boolean);
        if (!qids.length) return;
        const groupNodes = [...refs.content.querySelectorAll(".group")].filter((node) => {
          const title = node.querySelector("h3")?.textContent || "";
          return !group.title || title.includes(String(group.title || ""));
        });
        const targetGroup = groupNodes[0] || refs.content.querySelector(".group") || refs.content;
        qids.forEach((qid) => {
          let input = refs.content.querySelector(`.suite-blank[data-q="${CSS.escape(qid)}"]`);
          if (input) {
            if (!(state.suite.completedAt || explicitSuiteReview)) input.disabled = false;
            return;
          }
          const labels = [...refs.content.querySelectorAll(".blank-q")];
          const label = labels.find((node) => String(node.textContent || "").trim() === qid);
          input = makeInput(qid);
          if (label) {
            label.insertAdjacentElement("afterend", input);
            return;
          }
          const row = document.createElement("div");
          row.className = "doc-line suite-fill-fallback";
          row.innerHTML = `<span class="blank-q">${escSuite(qid)}</span>`;
          row.appendChild(input);
          targetGroup.appendChild(row);
        });
      });
    };

    const restoreInputs = () => {
      const partState = getPartState();
      refs.content.querySelectorAll(".suite-blank").forEach((input) => {
        input.value = partState.text?.[`q${input.dataset.q}`] || "";
      });
      refs.content.querySelectorAll(".single-choice").forEach((button) => {
        button.classList.toggle("selected", partState.single?.[`q${button.dataset.q}`] === button.dataset.value);
      });
      refs.content.querySelectorAll(".multi-choice").forEach((button) => {
        const values = partState.multiple?.[button.dataset.name] || [];
        button.classList.toggle("selected", values.includes(button.dataset.value));
      });
      refs.content.querySelectorAll(".suite-slot").forEach((slot) => {
        const value = partState.matching?.[`q${slot.dataset.q}`] || "";
        const option = slot.closest(".matching-group")?.querySelector(`.match-choice[data-value="${CSS.escape(String(value))}"]`);
        slot.textContent = value ? (option?.textContent?.trim() || value) : "选择";
        if (value) slot.dataset.value = value;
        else delete slot.dataset.value;
        slot.classList.toggle("selected", !!value);
      });
      refs.content.querySelectorAll(".map-choice").forEach((button) => {
        button.classList.toggle("selected", partState.map?.[`q${button.dataset.q}`] === button.dataset.value);
      });
      refs.content.querySelectorAll(".match-choice").forEach((button) => {
        const group = button.closest(".matching-group");
        const groupUsedValues = new Set([...group?.querySelectorAll?.(".suite-slot") || []]
          .map((slot) => partState.matching?.[`q${slot.dataset.q}`])
          .filter(Boolean)
          .map(String));
        const allowRepeat = group?.dataset?.repeat === "true"
          || group?.querySelectorAll?.(".suite-slot")?.length > group?.querySelectorAll?.(".match-choice")?.length;
        button.classList.toggle("selected", state.selectedMatch === button.dataset.value && state.selectedMatchGroup === group?.dataset?.matchGroup);
        button.classList.toggle("hidden", !allowRepeat && groupUsedValues.has(String(button.dataset.value || "")));
      });
      if (state.suite.completedAt || explicitSuiteReview) {
        refs.content.querySelectorAll("input, button.slot").forEach((element) => {
          element.disabled = true;
        });
        refs.content.querySelectorAll(".choice").forEach((element) => {
          element.classList.add("disabled");
          element.setAttribute("aria-disabled", "true");
        });
      }
      if (refs.notesText) {
        refs.notesText.value = state.draft.notes?.[String(state.index)] || "";
      }
    };

    const isAnswered = (qid, index = state.index) => !!suiteGetUserAnswer(getPartState(index), state.parts[index]?.data, qid);

    const updateNav = () => {
      const part = state.parts[state.index];
      refs.nav.replaceChildren();
      (part?.data?.questionIds || []).forEach((qid) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = qid;
        button.dataset.q = qid;
        if (isAnswered(qid)) button.classList.add("answered");
        const result = state.suite.results?.[String(state.index)]?.attempt?.details?.find((detail) => String(detail.question) === String(qid));
        if (state.suite.completedAt && result) button.classList.add(result.isCorrect ? "correct" : "incorrect");
        button.addEventListener("click", () => {
          refs.content.querySelector(`[data-q="${CSS.escape(String(qid))}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        refs.nav.appendChild(button);
      });
    };

    const renderReviewTable = (attempt) => {
      if (!attempt?.details?.length) return "";
      const answerCell = (answer) => (
        `<div class="answer-cell"><span class="answer-value is-hidden" data-answer="${escSuite(answer)}">Hidden</span><button class="answer-toggle" type="button">查看答案</button></div>`
      );
      const resultCell = (detail) => (
        `<div class="result-wrap"><span>${detail.isCorrect ? "√ Correct" : "× Incorrect"}</span><button class="analysis-jump" type="button" data-q="${escSuite(detail.question)}">查看解析</button></div>`
      );
      const rows = attempt.details.map((detail) => (
        `<tr><td>${escSuite(detail.question)}</td><td>${escSuite(detail.userAnswer || "--")}</td><td>${answerCell(detail.correctAnswer)}</td><td class="${detail.isCorrect ? "result-correct" : "result-incorrect"}">${resultCell(detail)}</td></tr>`
      )).join("");
      return `<section class="group review"><div class="review-head"><h3>Answer Review</h3><button class="show-all-answers" type="button">一键显示答案</button></div><table class="review-table results-table"><thead><tr><th>Question</th><th>Your Answer</th><th>Correct Answer</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    };

    const applySuiteReviewFeedback = (attempt) => {
      refs.content.querySelectorAll(".suite-review-correct,.suite-review-incorrect,.suite-review-row-correct,.suite-review-row-incorrect")
        .forEach((element) => element.classList.remove("suite-review-correct", "suite-review-incorrect", "suite-review-row-correct", "suite-review-row-incorrect"));
      refs.content.querySelectorAll(".single-choice,.multi-choice,.map-choice").forEach((element) => element.classList.remove("selected"));
      (attempt?.details || []).forEach((detail) => {
        const qid = String(detail.question || "");
        const answer = String(detail.userAnswer || "").trim();
        const stateClass = detail.isCorrect ? "suite-review-correct" : "suite-review-incorrect";
        const targets = new Set();
        const input = refs.content.querySelector(`.suite-blank[data-q="${CSS.escape(qid)}"]`);
        if (input) {
          input.value = isBlankAnswer(answer) ? "" : answer;
          targets.add(input);
        }
        refs.content.querySelectorAll(`.single-choice[data-q="${CSS.escape(qid)}"],.map-choice[data-q="${CSS.escape(qid)}"]`).forEach((choice) => {
          const selected = String(choice.dataset.value || "") === answer;
          choice.classList.toggle("selected", selected);
          if (selected) targets.add(choice);
        });
        const multipleGroup = suiteMultipleGroupFor(state.parts[state.index]?.data, qid);
        if (multipleGroup) {
          const groupName = `q${String(multipleGroup.id || "").replace("-", "_")}`;
          refs.content.querySelectorAll(`.multi-choice[data-name="${CSS.escape(groupName)}"]`).forEach((choice) => {
            if (String(choice.dataset.value || "") === answer) {
              choice.classList.add("selected");
              targets.add(choice);
            }
          });
        }
        const slot = refs.content.querySelector(`.suite-slot[data-q="${CSS.escape(qid)}"]`);
        if (slot) {
          const option = slot.closest(".matching-group")?.querySelector(`.match-choice[data-value="${CSS.escape(answer)}"]`);
          slot.textContent = answer ? (option?.textContent?.trim() || answer) : "选择";
          if (answer) slot.dataset.value = answer;
          else delete slot.dataset.value;
          slot.classList.toggle("selected", !!answer);
          targets.add(slot);
        }
        targets.forEach((target) => {
          target.classList.add(stateClass);
        });
      });
    };

    const renderTranscript = (study = false) => {
      const part = state.parts[state.index];
      const lines = (part?.data?.transcriptLines || []).filter((line) => line && typeof line === "object");
      refs.transcript.classList.toggle("hide-cn", study && !state.intensive.showCn);
      refs.transcript.classList.toggle("hide-analysis", study && !state.intensive.showAnalysis);
      if (study) {
        refs.transcript.innerHTML = `<div class="study-head"><h3>原文和精听</h3><div class="study-controls"><button id="study-prev" type="button">上一句</button><button id="study-play" type="button">播放 / 暂停</button><button id="study-next" type="button">下一句</button><button id="study-loop" class="${state.intensive.loop ? "active" : ""}" type="button">循环当前句</button><button id="study-slow" class="${state.intensive.slow ? "active" : ""}" type="button">0.8x 慢速</button></div><div class="study-controls"><button id="study-cn" class="${state.intensive.showCn ? "active" : ""}" type="button">显示中文</button><button id="study-analysis" class="${state.intensive.showAnalysis ? "active" : ""}" type="button">显示解析</button></div></div>${lines.map((line, i) => `<button class="study-cue" type="button" data-idx="${i}"><span class="cue-time">${escSuite(formatCueTimeLabel(line.time))}</span><p>${sanitizeInlineHtml(line.html || "")}</p>${line.cn ? `<div class="cue-cn">${sanitizeInlineHtml(line.cn)}</div>` : ""}${line.analysis ? `<div class="cue-analysis">${sanitizeInlineHtml(line.analysis)}</div>` : ""}</button>`).join("")}`;
        const playLine = (idx) => {
          const line = lines[Math.max(0, Math.min(idx, lines.length - 1))];
          state.intensive.activeIndex = Math.max(0, Math.min(idx, lines.length - 1));
          const range = suiteCueRange(line);
          loadAudioPart(state.index);
          state.audio.currentTime = range.start || 0;
          state.audio.playbackRate = state.intensive.slow ? 0.8 : 1;
          state.audio.play().catch(() => {});
          refs.transcript.querySelectorAll(".study-cue").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.idx) === state.intensive.activeIndex));
        };
        refs.transcript.querySelectorAll(".study-cue").forEach((btn) => btn.addEventListener("click", () => playLine(Number(btn.dataset.idx))));
        refs.transcript.querySelector("#study-prev")?.addEventListener("click", () => playLine(state.intensive.activeIndex - 1));
        refs.transcript.querySelector("#study-next")?.addEventListener("click", () => playLine(state.intensive.activeIndex + 1));
        refs.transcript.querySelector("#study-play")?.addEventListener("click", () => state.audio.paused ? state.audio.play().catch(() => {}) : state.audio.pause());
        refs.transcript.querySelector("#study-loop")?.addEventListener("click", () => { state.intensive.loop = !state.intensive.loop; renderTranscript(true); });
        refs.transcript.querySelector("#study-slow")?.addEventListener("click", () => { state.intensive.slow = !state.intensive.slow; state.audio.playbackRate = state.intensive.slow ? 0.8 : 1; renderTranscript(true); });
        refs.transcript.querySelector("#study-cn")?.addEventListener("click", () => { state.intensive.showCn = !state.intensive.showCn; renderTranscript(true); });
        refs.transcript.querySelector("#study-analysis")?.addEventListener("click", () => { state.intensive.showAnalysis = !state.intensive.showAnalysis; renderTranscript(true); });
        return;
      }
      refs.transcript.innerHTML = `<h3>Listening Transcript</h3>${lines.map((line) => `<section class="cue"><div class="cue-time">${escSuite(formatCueTimeLabel(line.time))}</div><p>${sanitizeInlineHtml(line.html || "")}</p>${line.cn ? `<div class="cue-cn">${sanitizeInlineHtml(line.cn)}</div>` : ""}${line.analysis ? `<div class="cue-analysis">${sanitizeInlineHtml(line.analysis)}</div>` : ""}</section>`).join("")}`;
    };

    const setSuiteAnswerVisible = (button, visible) => {
      const cell = button?.closest?.(".answer-cell");
      const value = cell?.querySelector?.(".answer-value");
      if (!value) return;
      value.textContent = visible ? (value.dataset.answer || "") : "Hidden";
      value.classList.toggle("is-hidden", !visible);
      button.textContent = visible ? "隐藏答案" : "查看答案";
      button.dataset.visible = visible ? "1" : "0";
    };

    const syncSuiteAllAnswersButton = () => {
      const all = refs.content.querySelector(".show-all-answers");
      const buttons = [...refs.content.querySelectorAll(".answer-toggle")];
      if (!all || !buttons.length) return;
      const visible = buttons.every((button) => button.dataset.visible === "1");
      all.textContent = visible ? "一键隐藏答案" : "一键显示答案";
      all.dataset.visible = visible ? "1" : "0";
    };

    const suiteQuestionInText = (qid, value) => {
      const number = Number(String(qid || "").replace(/\D/g, ""));
      if (!number || !value) return false;
      const text = String(value).replace(/&nbsp;/gi, " ");
      if (new RegExp(`(?:问题|Question|Q)\\s*0?${number}(?!\\d)|第\\s*0?${number}\\s*题|(^|\\D)0?${number}\\s*题`, "i").test(text)) {
        return true;
      }
      const rangePattern = /(?:Questions?|问题|Q)\s*(\d+)\s*(?:-|–|—|至|到|和|and|to|&)\s*(\d+)(?:\s*题)?|第\s*(\d+)\s*(?:-|–|—|至|到|和|&)\s*(\d+)\s*题/gi;
      let match = null;
      while ((match = rangePattern.exec(text))) {
        const start = Number(match[1] || match[3]);
        const end = Number(match[2] || match[4]);
        if (number >= Math.min(start, end) && number <= Math.max(start, end)) return true;
      }
      return false;
    };

    const suitePlainText = (value) => {
      const template = document.createElement("template");
      template.innerHTML = String(value || "");
      return String(template.content.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
    };

    const getSuiteAnalysisLineIndex = (qid, lines) => {
      const exactAnalysis = lines.findIndex((line) => suiteQuestionInText(qid, line?.analysis || ""));
      if (exactAnalysis >= 0) {
        if (getReviewPreferences().analysisTarget === "analysis") return exactAnalysis;
        let previousAnalysis = exactAnalysis - 1;
        while (previousAnalysis >= 0 && !lines[previousAnalysis]?.analysis) previousAnalysis -= 1;
        const correctEvidence = lines.findIndex((line, index) => index > previousAnalysis && index <= exactAnalysis
          && /#bbf7d0|rgb\s*\(\s*187\s*,\s*247\s*,\s*208\s*\)|background-color\s*:\s*(?:lightgreen|limegreen|palegreen)/i.test(String(line?.html || "")));
        return correctEvidence >= 0 ? correctEvidence : exactAnalysis;
      }

      const highlights = (state.parts[state.index]?.data?.transcriptHighlights || [])
        .filter((item) => String(item?.qid || item?.question || "").replace(/\D/g, "") === String(qid || "").replace(/\D/g, ""))
        .flatMap((item) => [item?.text, item?.answer])
        .map((value) => suitePlainText(value))
        .filter((value, index, list) => value.length > 1 && list.indexOf(value) === index);
      if (highlights.length) {
        const highlightedLine = lines.findIndex((line) => {
          const text = suitePlainText(line?.html || "");
          return highlights.some((term) => text.includes(term));
        });
        if (highlightedLine >= 0) return highlightedLine;
      }

      const taggedLine = lines.findIndex((line) => suiteQuestionInText(qid, `${line?.html || ""} ${line?.analysis || ""}`));
      if (taggedLine >= 0) return taggedLine;
      return lines.findIndex((line) => line?.analysis);
    };

    const playSuiteAnalysisLine = (partIndex, line) => {
      if (!line) return;
      const range = suiteCueRange(line);
      const expectedUrl = getAudioUrl(partIndex);
      const sourceChanged = state.audioPart !== partIndex || state.audio.src !== expectedUrl;
      loadAudioPart(partIndex, { suppressPlay: true });

      const seekAndPlay = () => {
        const duration = Number(state.audio.duration || 0);
        const target = Math.max(0, Math.min(Number(range.start || 0), duration > 0 ? Math.max(0, duration - 0.05) : Number(range.start || 0)));
        try {
          state.audio.currentTime = target;
          state.audio.playbackRate = state.intensive.slow ? 0.8 : 1;
          if (getReviewPreferences().analysisPlayback === "play") state.audio.play().catch(() => {});
          else state.audio.pause();
          updateAudioTime();
        } catch (error) {
          console.error("Failed to seek suite analysis audio:", error);
        }
      };

      if (sourceChanged || state.audio.readyState < 1) {
        state.audio.addEventListener("loadedmetadata", seekAndPlay, { once: true });
        state.audio.load?.();
      } else {
        seekAndPlay();
      }
    };

    const jumpSuiteAnalysis = (qid) => {
      refs.main.classList.add("split");
      refs.transcript.hidden = false;
      renderTranscript(true);
      const lines = (state.parts[state.index]?.data?.transcriptLines || []).filter((line) => line && typeof line === "object");
      const targetIndex = getSuiteAnalysisLineIndex(qid, lines);
      const buttons = [...refs.transcript.querySelectorAll(".study-cue")];
      const target = buttons.find((button) => Number(button.dataset.idx) === targetIndex);
      state.intensive.activeIndex = Math.max(0, targetIndex);
      buttons.forEach((button) => button.classList.toggle("active", button === target));
      target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      if (targetIndex >= 0) {
        playSuiteAnalysisLine(state.index, lines[targetIndex]);
        setSuiteStatus("已跳到对应题目的解析与音频位置。", "ok");
      } else {
        setSuiteStatus("没有找到这道题对应的解析位置。", "warn");
      }
    };

    const syncSuiteQuestionAnalysisShortcuts = () => {
      refs.content.querySelectorAll(".question-analysis-shortcut").forEach((button) => button.remove());
      const part = state.parts[state.index];
      (part?.data?.questionIds || []).forEach((rawQid) => {
        const qid = String(rawQid || "").trim();
        if (!qid || !refs.content.querySelector(`.analysis-jump[data-q="${CSS.escape(qid)}"]`)) return;
        const exactLabel = [...refs.content.querySelectorAll(".blank-q,.flow-num,.map-row-label strong,.match-row strong,.question-block p > strong")]
          .find((node) => String(node.textContent || "").trim().replace(/[.：:]$/, "") === qid);
        const field = refs.content.querySelector(`.suite-blank[data-q="${CSS.escape(qid)}"],.suite-slot[data-q="${CSS.escape(qid)}"],.single-choice[data-q="${CSS.escape(qid)}"],.map-choice[data-q="${CSS.escape(qid)}"]`);
        const rangeBlock = [...refs.content.querySelectorAll(".question-block[data-q]")].find((node) => suiteQuestionRange(node.dataset.q).includes(qid));
        let anchor = exactLabel || rangeBlock?.querySelector("p") || field;
        if (exactLabel?.matches(".blank-q") && exactLabel.closest(".match-row")) anchor = exactLabel.closest(".match-row").querySelector("span:not(.blank-q)") || exactLabel.closest(".match-row");
        else if (exactLabel?.matches(".flow-num")) anchor = exactLabel.closest(".flow-step")?.querySelector(".flow-text") || exactLabel.parentElement;
        else if (exactLabel?.closest(".map-row-label")) anchor = exactLabel.closest(".map-row-label");
        else if (exactLabel?.matches(".question-block p > strong")) anchor = exactLabel.parentElement;
        else if (exactLabel?.matches(".blank-q")) anchor = exactLabel.closest(".doc-line-content,p,td,li") || exactLabel.parentElement;
        if (!anchor || anchor.querySelector?.(".question-analysis-shortcut")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "question-analysis-shortcut";
        button.dataset.q = qid;
        button.textContent = "解析";
        button.setAttribute("aria-label", `查看第 ${qid} 题解析并播放对应录音`);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          jumpSuiteAnalysis(qid);
        });
        anchor.appendChild(button);
      });
    };

    const bindSuiteReviewTable = () => {
      refs.content.querySelectorAll(".answer-toggle").forEach((button) => {
        button.addEventListener("click", () => {
          setSuiteAnswerVisible(button, button.dataset.visible !== "1");
          syncSuiteAllAnswersButton();
        });
      });
      refs.content.querySelector(".show-all-answers")?.addEventListener("click", (event) => {
        const show = event.currentTarget.dataset.visible !== "1";
        refs.content.querySelectorAll(".answer-toggle").forEach((button) => setSuiteAnswerVisible(button, show));
        syncSuiteAllAnswersButton();
      });
      refs.content.querySelectorAll(".analysis-jump").forEach((button) => {
        button.addEventListener("click", () => jumpSuiteAnalysis(button.dataset.q));
      });
      if (getReviewPreferences().answerVisibility === "shown") {
        refs.content.querySelectorAll(".answer-toggle").forEach((button) => setSuiteAnswerVisible(button, true));
      }
      syncSuiteAllAnswersButton();
    };

    const renderPart = () => {
      const part = state.parts[state.index];
      const currentSuite = window.SuitePractice?.getSuite?.(suiteId) || state.suite;
      state.suite = currentSuite;
      refs.title.textContent = `套题 ${part.item.part}：${part.data.title || part.item.title}`;
      document.title = refs.title.textContent;
      const groupsHtml = (part.data.groups || []).map((group) => renderSuiteQuestionGroup(group, part, state.index)).join("");
      const reviewAttempt = currentSuite.results?.[String(state.index)]?.attempt;
      const partState = getPartState();
      refs.content.innerHTML = groupsHtml + (currentSuite.completedAt || explicitSuiteReview ? renderReviewTable(reviewAttempt) : "");
      ensureSuiteFillInputs(part);
      copySuiteHighlights((currentSuite.completedAt || explicitSuiteReview ? reviewAttempt : partState) || "");
      refs.prev.disabled = state.index <= 0;
      refs.next.disabled = !!(currentSuite.completedAt && state.index >= state.parts.length - 1);
      refs.next.textContent = currentSuite.completedAt || explicitSuiteReview ? "Next" : (state.index >= state.parts.length - 1 ? "Finish" : "Next");
      refs.clear.disabled = !!currentSuite.completedAt || explicitSuiteReview;
      refs.intensive.disabled = !(currentSuite.completedAt || explicitSuiteReview);
      if (refs.intensive.disabled && refs.main.classList.contains("split")) {
        refs.main.classList.remove("split");
        refs.transcript.hidden = true;
      }
      restoreInputs();
      if (currentSuite.completedAt || explicitSuiteReview) applySuiteReviewFeedback(reviewAttempt);
      updateNav();
      renderTranscript(refs.main.classList.contains("split"));
      if (currentSuite.completedAt || explicitSuiteReview) {
        bindSuiteReviewTable();
        syncSuiteQuestionAnalysisShortcuts();
      }
      ensureAudioReady();
      setSuiteStatus(currentSuite.completedAt ? getSuiteSummaryText(currentSuite) : "套题作答中，音频会连续播放。", currentSuite.completedAt ? "ok" : "warn");
    };

    const unwrapSuiteHighlight = (element) => {
      unwrapHighlightElementSafely(element);
    };

    const wrapSuiteSelection = (className) => {
      const selection = window.getSelection?.();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      if (!refs.content.contains(range.commonAncestorContainer)) return null;
      const span = wrapSafeHighlightRange(document, range, className, refs.content);
      if (!span) return null;
      span.dataset.hid = `suite_${Date.now()}`;
      selection.removeAllRanges();
      collectInputs();
      return span;
    };

    const hideSuiteSelbar = () => {
      refs.selbar.hidden = true;
      refs.selbar.targetElement = null;
    };

    const showSuiteSelbarAt = (rect) => {
      refs.selbar.hidden = false;
      refs.selbar.style.left = `${Math.max(8, window.scrollX + rect.left + rect.width / 2 - 92)}px`;
      refs.selbar.style.top = `${Math.max(8, window.scrollY + rect.top - 46)}px`;
    };

    const updateSuiteSelectionBar = (event) => {
      if (event?.target?.closest?.(".suite-selbar,.suite-notes,.suite-bottom")) return;
      const highlight = event?.target?.closest?.(".hl-brown,.hl-rose,.hl-blue");
      const selection = window.getSelection?.();
      if (highlight && (!selection || selection.isCollapsed)) {
        refs.selbar.targetElement = highlight;
        showSuiteSelbarAt(highlight.getBoundingClientRect());
        return;
      }
      if (selection && !selection.isCollapsed && selection.rangeCount && refs.content.contains(selection.anchorNode)) {
        refs.selbar.targetElement = null;
        showSuiteSelbarAt(selection.getRangeAt(0).getBoundingClientRect());
        return;
      }
      hideSuiteSelbar();
    };

    const handleSuiteSelbarAction = (act) => {
      const target = refs.selbar.targetElement;
      if (act === "del" && target) {
        unwrapSuiteHighlight(target);
        collectInputs();
      } else if (act === "hl") {
        if (target) {
          target.className = target.classList.contains("hl-brown") ? "hl-rose" : "hl-brown";
          collectInputs();
        } else {
          wrapSuiteSelection("hl-brown");
        }
      } else if (act === "note") {
        const span = target || wrapSuiteSelection("hl-blue");
        if (span) {
          span.className = "hl-blue";
          refs.notes.hidden = false;
          refs.notesText.focus();
          if (!refs.notesText.value) refs.notesText.value = `${span.textContent.slice(0, 120)}\n`;
          collectInputs();
          persist();
        }
      }
      hideSuiteSelbar();
    };

    const bindInputEvents = () => {
      let choicePointer = null;
      let choiceSelectionTarget = null;
      refs.content.addEventListener("mousedown", (event) => {
        const choice = event.target?.closest?.(".choice");
        choicePointer = choice ? { choice, x: event.clientX || 0, y: event.clientY || 0 } : null;
        choiceSelectionTarget = null;
      }, true);
      refs.content.addEventListener("mouseup", () => {
        const selection = window.getSelection?.();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        choiceSelectionTarget = [...refs.content.querySelectorAll(".choice")].find((choice) => (
          choice.contains(range.commonAncestorContainer)
          || (typeof range.intersectsNode === "function" && range.intersectsNode(choice))
        )) || null;
      }, true);
      refs.content.addEventListener("mouseup", updateSuiteSelectionBar, true);
      refs.content.addEventListener("keyup", updateSuiteSelectionBar, true);
      refs.content.addEventListener("input", (event) => {
        if (event.target?.matches?.(".suite-blank")) {
          collectInputs();
          updateNav();
        }
      }, true);
      refs.content.addEventListener("dragstart", (event) => {
        const match = event.target?.closest?.(".match-choice,.suite-slot");
        if (!match || state.suite.completedAt || explicitSuiteReview) return;
        const value = match.dataset.value || "";
        if (!value) return;
        state.selectedMatch = value;
        state.selectedMatchGroup = match.closest(".matching-group")?.dataset?.matchGroup || "";
        if (match.classList.contains("suite-slot")) state.dragFromSlot = match.dataset.q || "";
        else state.dragFromSlot = "";
        event.dataTransfer?.setData?.("text/plain", value);
      }, true);
      refs.content.addEventListener("dragover", (event) => {
        if (event.target?.closest?.(".suite-slot,.pool")) event.preventDefault();
      }, true);
      refs.content.addEventListener("drop", (event) => {
        const slot = event.target?.closest?.(".suite-slot");
        const pool = event.target?.closest?.(".pool");
        if ((!slot && !pool) || state.suite.completedAt || explicitSuiteReview) return;
        event.preventDefault();
        const value = event.dataTransfer?.getData?.("text/plain") || state.selectedMatch || "";
        if (!value) return;
        const partState = getPartState();
        if (state.dragFromSlot) delete partState.matching[`q${state.dragFromSlot}`];
        const targetGroup = slot?.closest(".matching-group")?.dataset?.matchGroup || pool?.closest(".matching-group")?.dataset?.matchGroup || "";
        if (slot && (!state.selectedMatchGroup || state.selectedMatchGroup === targetGroup)) partState.matching[`q${slot.dataset.q}`] = value;
        state.selectedMatch = "";
        state.selectedMatchGroup = "";
        state.dragFromSlot = "";
        restoreInputs();
        collectInputs();
        updateNav();
      }, true);
      refs.content.addEventListener("click", (event) => {
        const partState = getPartState();
        const slot = event.target?.closest?.(".suite-slot");
        if (slot && !state.suite.completedAt && !explicitSuiteReview) {
          if (!state.selectedMatch && slot.dataset.value) {
            delete partState.matching[`q${slot.dataset.q}`];
            restoreInputs();
            collectInputs();
            updateNav();
            return;
          }
          const slotGroup = slot.closest(".matching-group")?.dataset?.matchGroup || "";
          if (!state.selectedMatch || state.selectedMatchGroup !== slotGroup) return;
          partState.matching[`q${slot.dataset.q}`] = state.selectedMatch;
          state.selectedMatch = "";
          state.selectedMatchGroup = "";
          restoreInputs();
          collectInputs();
          updateNav();
          return;
        }
        const choice = event.target?.closest?.(".choice");
        if (!choice || state.suite.completedAt || explicitSuiteReview) return;
        if (choiceSelectionTarget === choice) {
          choiceSelectionTarget = null;
          choicePointer = null;
          return;
        }
        if (choicePointer?.choice === choice) {
          const dx = (event.clientX || 0) - choicePointer.x;
          const dy = (event.clientY || 0) - choicePointer.y;
          choicePointer = null;
          if (Math.hypot(dx, dy) > 4) return;
        } else {
          choicePointer = null;
        }
        const selection = window.getSelection?.();
        if (selection && !selection.isCollapsed && selection.rangeCount) {
          const range = selection.getRangeAt(0);
          const selectingInsideChoice = choice.contains(range.commonAncestorContainer)
            || (typeof range.intersectsNode === "function" && range.intersectsNode(choice));
          if (selectingInsideChoice) return;
          selection.removeAllRanges();
        }
        if (choice.classList.contains("single-choice")) {
          refs.content.querySelectorAll(`.single-choice[data-q="${CSS.escape(String(choice.dataset.q || ""))}"]`).forEach((button) => {
            button.classList.toggle("selected", button === choice);
          });
        } else if (choice.classList.contains("multi-choice")) {
          const block = choice.closest(".question-block");
          const limit = Number(block?.dataset.limit || 99);
          const selected = block ? [...block.querySelectorAll(".multi-choice.selected")] : [];
          if (choice.classList.contains("selected")) {
            choice.classList.remove("selected");
          } else if (selected.length < limit) {
            choice.classList.add("selected");
          }
        } else if (choice.classList.contains("match-choice")) {
          state.selectedMatch = choice.dataset.value;
          state.selectedMatchGroup = choice.closest(".matching-group")?.dataset?.matchGroup || "";
          restoreInputs();
          return;
        } else if (choice.classList.contains("map-choice")) {
          refs.content.querySelectorAll(`.map-choice[data-q="${CSS.escape(String(choice.dataset.q || ""))}"]`).forEach((button) => {
            button.classList.toggle("selected", button === choice);
          });
        }
        collectInputs();
        restoreInputs();
        updateNav();
      }, true);
      refs.content.addEventListener("keydown", (event) => {
        if (!["Enter", " "].includes(event.key)) return;
        const choice = event.target?.closest?.(".choice");
        if (!choice) return;
        event.preventDefault();
        choice.click();
      }, true);
    };

    const saveCurrentPart = () => {
      collectInputs();
      const part = state.parts[state.index];
      const attempt = buildSuiteAttempt(getPartState(), part, part.item, state.index);
      const updated = window.SuitePractice?.updateSuitePart?.(suiteId, state.index, attempt);
      syncSuitePartAttemptToWrongbook(suiteId, state.index, attempt);
      if (updated) state.suite = window.SuitePractice?.getSuite?.(suiteId) || updated;
      return state.suite;
    };

    const goToPart = (nextIndex, options = {}) => {
      collectInputs();
      const leavingFinalPart = state.index >= state.parts.length - 1;
      if (!state.suite.completedAt && !explicitSuiteReview && options.save !== false && !leavingFinalPart) {
        saveCurrentPart();
      }
      state.index = Math.max(0, Math.min(nextIndex, state.parts.length - 1));
      suiteIndex = state.index;
      suiteItem = state.suite.items[state.index];
      decodedSrc = suiteItem.path;
      if (!state.suite.completedAt && !explicitSuiteReview) window.SuitePractice?.setCurrentIndex?.(suiteId, state.index);
      renderPart();
      loadAudioPart(state.index, { suppressPlay: true });
      setSuiteStatus(`已切换到 ${suiteItem.part} 对应音频，请点击播放。`, "ok");
    };

    const finishSuite = (force = false) => {
      if (state.suite.completedAt) return;
      state.audio.pause();
      saveCurrentPart();
      for (let i = 0; i < state.parts.length; i += 1) {
        const attempt = buildSuiteAttempt(getPartState(i), state.parts[i], state.parts[i].item, i);
        state.suite = window.SuitePractice?.updateSuitePart?.(suiteId, i, attempt) || state.suite;
        syncSuitePartAttemptToWrongbook(suiteId, i, attempt);
      }
      state.suite = window.SuitePractice?.getSuite?.(suiteId) || state.suite;
      syncCompletedSuiteAttemptsToWrongbook(state.suite);
      clearSuiteDraft();
      notifySuitePanelUpdated();
      setSuiteStatus(getSuiteSummaryText(state.suite), "ok");
      window.alert(getSuiteSummaryText(state.suite));
      renderPart();
    };

    refs.prev.addEventListener("click", () => goToPart(state.index - 1));
    refs.next.addEventListener("click", () => {
      if (state.suite.completedAt || explicitSuiteReview) {
        if (state.index < state.parts.length - 1) goToPart(state.index + 1, { save: false });
        return;
      }
      if (state.index >= state.parts.length - 1) finishSuite();
      else goToPart(state.index + 1);
    });
    refs.clear.addEventListener("click", () => {
      if (state.suite.completedAt || explicitSuiteReview) return;
      if (!window.confirm("Clear current part?")) return;
      state.draft.parts[String(state.index)] = { text: {}, single: {}, multiple: {}, matching: {}, map: {}, highlights: [], highlightHtml: "", highlightTexts: [], contentHtml: "" };
      state.suite = window.SuitePractice?.clearSuitePart?.(suiteId, state.index) || state.suite;
      persist();
      renderPart();
    });
    refs.note.addEventListener("click", () => {
      refs.notes.hidden = !refs.notes.hidden;
      if (!refs.notes.hidden) refs.notesText.focus();
    });
    refs.notesClose.addEventListener("click", () => {
      refs.notes.hidden = true;
      persist();
    });
    refs.notesText.addEventListener("input", persist);
    refs.selbar.addEventListener("click", (event) => {
      const act = event.target?.closest?.("button")?.dataset.act;
      if (act) handleSuiteSelbarAction(act);
    });
    document.addEventListener("mousedown", (event) => {
      if (!event.target?.closest?.(".suite-selbar") && !refs.content.contains(event.target)) hideSuiteSelbar();
    }, true);
    refs.intensive.addEventListener("click", () => {
      const currentSuite = window.SuitePractice?.getSuite?.(suiteId) || state.suite;
      if (!(currentSuite.completedAt || explicitSuiteReview)) return;
      refs.main.classList.toggle("split");
      refs.transcript.hidden = !refs.main.classList.contains("split");
      renderTranscript(refs.main.classList.contains("split"));
    });
    document.querySelector(".back-link")?.addEventListener("click", handleBackToLibrary);
    const pauseAndPersist = () => {
      state.audio.pause();
      state.checkTickAt = 0;
      persist();
    };
    window.addEventListener("pagehide", pauseAndPersist, true);
    window.addEventListener("beforeunload", pauseAndPersist, true);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") pauseAndPersist();
    }, true);
    window.setInterval(updateTimer, 1000);

    bindInputEvents();
    Promise.all(suite.items.map((item) => loadSuitePartData(item)))
      .then((parts) => {
        state.parts = parts;
        const savedAudio = state.draft.audio;
        const savedCheck = state.draft.check;
        if (savedCheck?.active && Number(savedCheck.remainingSeconds) > 0 && !state.suite.completedAt && !explicitSuiteReview) {
          state.checking = true;
          state.checkRemainingSeconds = Math.min(SUITE_REVIEW_GRACE_SECONDS, Number(savedCheck.remainingSeconds));
          state.checkTickAt = Date.now();
          setSuiteStatus("继续 2 分钟检查时间；可提前点 Finish 提交。", "warn");
        }
        if (savedAudio?.started && !state.suite.completedAt && !explicitSuiteReview) {
          state.audioStarted = true;
          state.audioPart = Math.max(0, Math.min(Number(savedAudio.partIndex || 0), state.parts.length - 1));
          loadAudioPart(state.audioPart, { suppressPlay: true });
          state.audio.addEventListener("loadedmetadata", () => {
            if (state.restoredAudio) return;
            state.restoredAudio = true;
            try {
              state.audio.currentTime = Math.max(0, Math.min(Number(savedAudio.currentTime || 0), Number(state.audio.duration || Infinity)));
            } catch (error) {}
            updateAudioTime();
          }, { once: true });
          state.audio.load?.();
        } else {
          state.audioPart = state.index;
          loadAudioPart(state.index, { suppressPlay: true });
        }
        setSuiteStatus("题目读取完成。", "ok");
        renderPart();
        updateTimer();
        return Promise.all(parts.map((_, index) => loadAudioDuration(index)));
      })
      .then((durations) => {
        state.audioDurations = durations;
        updateTimer();
      })
      .catch((error) => {
        console.error(error);
        setSuiteStatus("套题加载失败。", "error");
        refs.content.innerHTML = `<p style="color:#b91c1c;padding:24px">无法读取套题题目，请返回题库重试。</p>`;
      });
  }

  if (!decodedSrc) {
    showError("缺少题目路径，无法打开原题。");
    return;
  }

  if (isSuiteMode) {
    startSuiteOuterRenderer();
    return;
  }

  on(window, "storage", (event) => {
    if (event.key != null && event.key !== PLAYER_STATE_KEY) return;
    invalidatePlayerStateCache();
  });
  on(window, "pagehide", () => persistCurrentDraft(), true);
  on(window, "beforeunload", () => persistCurrentDraft(), true);
  on(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") persistCurrentDraft();
  }, true);

  title.textContent = suiteItem ? `套题 ${suiteItem.part}：${decodedSrc}` : decodedSrc;
  setStatus("正在加载题目...", "warn");

  on(frame, "load", handleFrameLoad);
  loadQuestion();
  if (isSuiteReadOnlyReview()) {
    window.setTimeout(revealFrameForSuiteReview, 1200);
  }

  on(finishButton, "click", handleFinishClick);
  on(clearButton, "click", (event) => {
    if (isSuiteMode) {
      event.preventDefault();
      handleSuitePreviousClick();
      return;
    }
    handleClearClick();
  });
  on(noteButton, "click", handleNoteToggle);
  on(transcriptButton, "click", handleTranscriptClick);
  on(suiteNextButton, "click", handleSuiteNextClick);
  on(document.querySelector(".back-link"), "click", handleBackToLibrary);

  syncSuiteButton();
  if (isSuiteMode) {
    const suite = getCurrentSuite();
    if (finishButton) finishButton.textContent = getSuiteFinishButtonText(suite);
    if (clearButton) {
      clearButton.textContent = "Previous";
      clearButton.disabled = suiteIndex <= 0;
    }
    if (transcriptButton) transcriptButton.hidden = !suite?.completedAt;
    window.SuitePractice?.setCurrentIndex?.(suiteId, suiteIndex);
    updateSuiteTimer();
    window.setInterval(updateSuiteTimer, 1000);
  }

  let bootstrapTries = 0;
  const bootstrapTimer = window.setInterval(() => {
    bootstrapTries += 1;
    if (bootstrapFrame() || bootstrapTries >= 20) {
      window.clearInterval(bootstrapTimer);
    }
  }, 250);
}());
