(function () {
  const entries = Array.isArray(window.XIAHUA_LIBRARY_MANIFEST)
    ? window.XIAHUA_LIBRARY_MANIFEST
    : [];
  const siteRootUrl = /\/JS\/[^/]*$/i.test(window.location.pathname)
    ? new URL("../", window.location.href)
    : new URL("./", window.location.href);

  function normalizePath(value) {
    return String(value || "")
      .normalize("NFC")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^IELTS Listening 虾滑\//, "普通/");
  }

  function encodePath(value) {
    return normalizePath(value)
      .split("/")
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join("/");
  }

  function resolveQuestionUrl(relativePath) {
    return new URL(encodePath(relativePath), siteRootUrl).href;
  }

  const files = entries.map((entry) => {
    const relativePath = normalizePath(entry.path);
    return {
      name: relativePath.split("/").pop() || relativePath,
      size: Number(entry.size || 0),
      type: "text/html",
      lastModified: Number(entry.lastModified || 0),
      webkitRelativePath: relativePath,
      _sourceSignature: String(entry.signature || "web-v1"),
      _testData: entry.testData || null,
      async text() {
        const response = await fetch(resolveQuestionUrl(relativePath));
        if (!response.ok) throw new Error("题目加载失败：" + response.status);
        return response.text();
      }
    };
  });

  function notifyProgress(progress) {
    if (typeof progress !== "function") return;
    progress({
      phase: "done",
      current: files.length,
      total: files.length,
      message: "网页版题库已加载，共 " + files.length + " 篇。"
    });
  }

  window.NativeDiskStorage = {
    getLibraryRootPath() {
      return "网页版内置题库";
    },
    readLibraryFiles() {
      return { rootPath: "网页版内置题库", files, cached: true };
    },
    async readLibraryFilesWithProgress(options, progress) {
      notifyProgress(progress);
      return { rootPath: "网页版内置题库", files, cached: true };
    },
    async pickLibraryDirectory() {
      return "网页版内置题库";
    },
    readQuestionHtml() {
      return "";
    },
    resolveQuestionUrl,
    backToLibrary() {
      window.location.href = new URL("index.html", siteRootUrl).href;
    },
    flush() {},
    readAnswerRecordBackups() {
      return [];
    },
    clearAnswerRecordBackups() {},
    removeAnswerRecordBackup() {}
  };
}());
