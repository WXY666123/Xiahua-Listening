(function () {
  const STORAGE_KEY = "xiahua_auth_state_v2";
  const DEVICE_KEY = "xiahua_device_id_v1";

  function readStorage(key) {
    try {
      return window.localStorage?.getItem(key) || "";
    } catch (error) {
      return "";
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage?.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function removeStorage(key) {
    try {
      window.localStorage?.removeItem(key);
    } catch (error) {}
  }

  function getDeviceId() {
    let id = readStorage(DEVICE_KEY);
    if (id) return id;
    id = `XH-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    writeStorage(DEVICE_KEY, id);
    return id;
  }

  function getState() {
    try {
      const raw = readStorage(STORAGE_KEY) || window.NativeDiskStorage?.readAuthState?.() || "";
      if (raw && !readStorage(STORAGE_KEY)) writeStorage(STORAGE_KEY, raw);
      const parsed = JSON.parse(raw || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function isExpired(state) {
    const expiresAt = Number(state?.expiresAtMs || Date.parse(state?.expiresAt || state?.licenseExpiresAt || ""));
    if (!Number.isFinite(expiresAt)) return true;
    const lastLocalSeen = Number(state?.lastLocalSeenAtMs || state?.localVerifiedAtMs || 0);
    const networkSeen = Number(state?.networkVerifiedAtMs || 0);
    const now = Date.now();
    if (Number.isFinite(lastLocalSeen) && lastLocalSeen > 0 && now + 5 * 60 * 1000 < lastLocalSeen) return true;
    if (Number.isFinite(networkSeen) && networkSeen > 0 && networkSeen > expiresAt) return true;
    return now > expiresAt;
  }

  function isAuthorized() {
    const state = getState();
    if (!(state.authorized && state.deviceId === getDeviceId())) return false;
    if (!isExpired(state)) return true;
    logout();
    return false;
  }

  function saveState(nextState) {
    const serialized = JSON.stringify({
      ...nextState,
      updatedAt: new Date().toISOString()
    });
    writeStorage(STORAGE_KEY, serialized);
    window.NativeDiskStorage?.writeAuthState?.(serialized);
    window.dispatchEvent(new CustomEvent("xiahua-auth-change"));
  }

  async function login(code) {
    const licenseCode = String(code || "").trim();
    if (!licenseCode) throw new Error("请输入授权码。");
    const result = await window.NativeDiskStorage?.verifyLicenseCode?.({
      code: licenseCode
    });
    if (!result?.ok) throw new Error(result?.message || "授权码无效。");
    saveState({
      authorized: true,
      username: result.username || "用户",
      deviceId: getDeviceId(),
      activatedAt: result.activatedAt || result.verifiedAt || new Date().toISOString(),
      expiresAt: result.expiresAt || "",
      expiresAtMs: Number(result.expiresAtMs || Date.parse(result.expiresAt || "")),
      validDays: Number(result.validDays || 7),
      networkVerifiedAt: result.verifiedAt || "",
      networkVerifiedAtMs: Number(result.verifiedAtMs || 0),
      localVerifiedAtMs: Date.now(),
      lastLocalSeenAtMs: Date.now(),
      timeSource: result.timeSource || "",
      licenseIssuedAt: result.issuedAt || "",
      licenseNotBefore: result.notBefore || "",
      licenseNotAfter: result.notAfter || "",
      features: result.features || { vip: true, suite: true }
    });
    return getState();
  }

  async function refresh() {
    const state = getState();
    if (state.authorized && state.deviceId !== getDeviceId()) {
      logout();
      return getState();
    }
    if (state.authorized) {
      const now = Date.now();
      if (isExpired(state)) {
        logout();
        return getState();
      }
      let nextState = { ...state, lastLocalSeenAtMs: Math.max(Number(state.lastLocalSeenAtMs || 0), now) };
      try {
        const networkTime = await window.NativeDiskStorage?.getNetworkTime?.();
        if (networkTime?.ok) {
          const expiresAt = Number(nextState.expiresAtMs || Date.parse(nextState.expiresAt || ""));
          if (Number.isFinite(expiresAt) && Number(networkTime.now || 0) > expiresAt) {
            logout();
            return getState();
          }
          nextState = {
            ...nextState,
            networkVerifiedAt: networkTime.iso || nextState.networkVerifiedAt || "",
            networkVerifiedAtMs: Number(networkTime.now || nextState.networkVerifiedAtMs || 0),
            localVerifiedAtMs: now,
            timeSource: networkTime.source || nextState.timeSource || ""
          };
        }
      } catch (error) {}
      saveState(nextState);
    }
    return getState();
  }

  function logout() {
    removeStorage(STORAGE_KEY);
    window.NativeDiskStorage?.deleteAuthState?.();
    window.dispatchEvent(new CustomEvent("xiahua-auth-change"));
  }

  window.AuthClient = {
    getDeviceId,
    getState,
    isAuthorized,
    isExpired,
    login,
    refresh,
    logout
  };
}());
