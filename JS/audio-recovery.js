(function () {
  const controllers = new Set();
  function attach(audio, getUrl, options = {}) {
    if (!audio || audio.__listeningRecovery) return audio?.__listeningRecovery;
    const report = options.report || (() => {});
    let retries = 0, timer = null, restore = null, reloading = false;
    let wanted = !audio.paused, disposed = false;
    let position = Number(audio.currentTime || 0), source = audio.src;
    let retryPosition = position;
    const cancel = () => { window.clearTimeout(timer); timer = null; };
    const failedPlay = () => { wanted = false; report('音频已暂停，请点播放继续；若仍无声，请点“恢复声音”。', 'warn'); };
    function reload(play) {
      cancel();
      const url = String(getUrl?.() || audio.currentSrc || audio.src || '');
      if (!url || disposed) return;
      const at = Math.max(position, Number(audio.currentTime || 0));
      const rate = audio.playbackRate || 1;
      if (restore) audio.removeEventListener('loadedmetadata', restore);
      reloading = true;
      audio.pause();
      wanted = play;
      audio.muted = false;
      audio.volume = 1;
      restore = () => {
        audio.removeEventListener('loadedmetadata', restore);
        restore = null;
        if (audio.src !== url || disposed) { reloading = false; return; }
        audio.currentTime = Math.min(at, Number.isFinite(audio.duration) ? audio.duration : at);
        audio.playbackRate = rate;
        position = audio.currentTime;
        reloading = false;
      };
      audio.addEventListener('loadedmetadata', restore);
      if (audio.src !== url) audio.src = url;
      source = audio.src;
      audio.load();
      // Invoke play in the button's gesture, not in a later metadata callback (iOS).
      if (wanted && document.visibilityState !== 'hidden') audio.play()?.catch(failedPlay);
    }
    const onTime = () => {
      if (reloading) return;
      if (audio.src !== source) { source = audio.src; retries = 0; }
      position = Number(audio.currentTime || 0);
      // Metadata alone is not proof that a broken stream recovered.
      if (!audio.paused && position > retryPosition + 5) retries = 0;
    };
    const onSource = () => {
      if (!reloading && audio.src !== source) {
        source = audio.src; position = 0; retryPosition = 0; retries = 0;
        cancel();
      }
    };
    const onPlay = () => { wanted = true; };
    const onPause = () => {
      if (reloading) return;
      wanted = false;
      cancel();
    };
    const onError = () => {
      if (disposed || timer) return;
      if (retries >= 3) { report('音频暂时无法加载，请检查网络后点“恢复声音”。', 'error'); return; }
      retries += 1;
      const requested = audio.src;
      retryPosition = position;
      report('音频连接中断，正在保留进度重试…', 'warn');
      timer = window.setTimeout(() => {
        timer = null;
        if (audio.src !== requested || disposed) return;
        reload(wanted);
      }, retries * 800);
    };
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.addEventListener('loadstart', onSource);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);
    const control = {
      audio,
      recover() { retries = 0; position = Number(audio.currentTime || position); reload(true); },
      suspend() {
        const playing = wanted || !audio.paused;
        wanted = false;
        cancel();
        audio.pause();
        if (playing) report('离开页面后音频已暂停，返回后请点播放继续。', 'warn');
      },
      dispose() {
        disposed = true; cancel();
        if (restore) audio.removeEventListener('loadedmetadata', restore);
        audio.removeEventListener('loadstart', onSource);
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('play', onPlay);
        audio.removeEventListener('pause', onPause);
        audio.removeEventListener('error', onError);
        controllers.delete(control);
      }
    };
    audio.__listeningRecovery = control;
    controllers.add(control);
    return control;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') controllers.forEach(c => c.suspend());
  });
  window.addEventListener('pagehide', () => controllers.forEach(c => c.suspend()));
  window.ListeningAudio = { attach };
}());
