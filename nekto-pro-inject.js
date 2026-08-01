
(function () {
    'use strict';

    const START_SOUND = 'https://zvukogram.com/mp3/22/skype-sound-message-received-message-received.mp3';
    const END_SOUND = 'https://www.myinstants.com/media/sounds/teleport1_Cw1ot9l.mp3';

    function loadSetting(key, def, transform = JSON.parse) {
        const val = localStorage.getItem(key);
        return val !== null ? transform(val) : def;
    }

    const settings = {
        gainValue: loadSetting('gainValue', 1.0, parseFloat),
        pitchLevel: loadSetting('pitchLevel', 0.7, parseFloat),
        conversationCount: loadSetting('conversationCount', 0, parseInt),
        totalConversationTime: loadSetting('totalConversationTime', 0, parseInt),
        panelTheme: (() => {
            const t = localStorage.getItem('panelTheme');
            return t && /^[a-z]+$/i.test(t) ? t : 'dark';
        })(),
        fxEnabled: loadSetting('fxEnabled', false),
        fxReverb: loadSetting('fxReverb', false),
        fxReverbMix: loadSetting('fxReverbMix', 0.35, parseFloat),
        fxBassBoost: loadSetting('fxBassBoost', false),
        fxBassGain: loadSetting('fxBassGain', 8, parseInt),
        fxRadio: loadSetting('fxRadio', false),
        longestConversation: loadSetting('longestConversation', 0, parseInt),
        dailyStats: (() => {
            try {
                const raw = localStorage.getItem('dailyStats');
                if (!raw) return { date: '', count: 0 };
                return JSON.parse(raw);
            } catch (_) { return { date: '', count: 0 }; }
        })(),
        streakData: (() => {
            try {
                const raw = localStorage.getItem('streakData');
                if (!raw) return { lastDate: '', count: 0 };
                return JSON.parse(raw);
            } catch (_) { return { lastDate: '', count: 0 }; }
        })(),
        skipKey: (() => {
            const raw = localStorage.getItem('nkSkipKey');
            if (!raw) return { key: 'l', code: 'KeyL', label: 'L', ctrl: false, alt: false, shift: false };
            try { return JSON.parse(raw); } catch (_) { return { key: 'l', code: 'KeyL', label: 'L', ctrl: false, alt: false, shift: false }; }
        })(),
        micKey: (() => {
            const raw = localStorage.getItem('nkMicKey');
            if (!raw) return { key: 'm', code: 'KeyM', label: 'M', ctrl: false, alt: false, shift: false };
            try { return JSON.parse(raw); } catch (_) { return { key: 'm', code: 'KeyM', label: 'M', ctrl: false, alt: false, shift: false }; }
        })(),
        voiceSkipEnabled: localStorage.getItem('nkVoiceSkipEnabled') !== '0'
    };

    let isAutoModeEnabled = true;
    let isConversationActive = false;
    let hasConversationInSession = false;
    let conversationStartTime = null;
    let isMicMuted = false;
    let currentGumStream = null;
    let isHeadphonesMuted = false;
    let globalStream = null;
    let originalMicStream = null;
    let nkRemoteStream = null;
    let nkRecorder = null;
    let nkRecordChunks = [];
    let nkRecordCtx = null;
    let nkRecordMerger = null;
    let nkRecordRemoteSrc = null;
    let nkRecordState = 'idle'; // idle | recording | paused
    let nkRecordStartTime = 0;
    let nkRecordTimerInterval = null;
    let nkAutoRecord = loadSetting('nkAutoRecord', false);
    let isPanelCollapsed = false;
    let fxConvolverNode = null;
    let fxReverbDryGain = null;
    let fxReverbWetGain = null;
    let fxBassFilter = null;
    let fxRadioFilter = null;
    let fxMixNode = null;
    let convMilestoneTimer = null;
    let convMilestoneShown = new Set();
    const CONV_MILESTONES = [1, 5, 15, 30, 45, 60, 90, 120];

    let activePeerConnection = null;
    let rtcStatsInterval = null;

    function updateP2pUI(rtt, loss) {
        const rttEl = document.getElementById('p2p-ping-val');
        const lossEl = document.getElementById('p2p-loss-val');

        if (rttEl) {
            if (rtt !== null) {
                rttEl.textContent = rtt + ' ms';
                rttEl.style.color = rtt < 100 ? 'var(--nk-logo-b)' : (rtt < 250 ? '#ffaa00' : '#ff3366');
                rttEl.style.textShadow = `0 0 5px ${rtt < 100 ? 'var(--nk-glow-b)' : (rtt < 250 ? 'rgba(255,170,0,0.5)' : 'rgba(255,51,102,0.5)')}`;
            } else {
                rttEl.textContent = '—';
                rttEl.style.color = 'var(--nk-logo-b)';
                rttEl.style.textShadow = '0 0 5px var(--nk-glow-b)';
            }
        }

        if (lossEl) {
            if (loss !== null) {
                lossEl.textContent = loss + '%';
                lossEl.style.color = loss < 2 ? 'var(--nk-logo-b)' : (loss < 10 ? '#ffaa00' : '#ff3366');
                lossEl.style.textShadow = `0 0 5px ${loss < 2 ? 'var(--nk-glow-b)' : (loss < 10 ? 'rgba(255,170,0,0.5)' : 'rgba(255,51,102,0.5)')}`;
            } else {
                lossEl.textContent = '—';
                lossEl.style.color = 'var(--nk-logo-b)';
                lossEl.style.textShadow = '0 0 5px var(--nk-glow-b)';
            }
        }
    }

    try {
        // Capture remote audio stream without replacing the global RTCPeerConnection constructor
        const _srcObjDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
        if (_srcObjDesc && _srcObjDesc.set) {
            Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
                get() { return _srcObjDesc.get.call(this); },
                set(stream) {
                    _srcObjDesc.set.call(this, stream);
                    if (stream && typeof stream.getAudioTracks === 'function' && stream.getAudioTracks().length > 0) {
                        nkRemoteStream = stream;
                        if (nkRecordState !== 'idle') nkConnectRemoteToRecording(nkRemoteStream);
                    }
                },
                configurable: true
            });
        }
    } catch (e) { }


    try {
        window.nektoOnlineLiveWS = null;
        // Cache DOM refs and last values to avoid getElementById + textContent on every parse
        let _onlineEl = null, _waitingEl = null;
        let _lastOnline = null, _lastWaiting = null;
        const origParse = JSON.parse;
        JSON.parse = function (text, reviver) {
            const data = origParse(text, reviver);
            if (data && typeof data === 'object') {
                let msgType = data.type || (Array.isArray(data) ? data[0] : null);
                let payload = data.data || (Array.isArray(data) ? data[1] : data);

                let onlineCount = null;
                let waitingCount = null;
                if (payload && payload.type === 'users-count') {
                    onlineCount = payload.usersCount;
                    waitingCount = payload.waitingUsersCount;
                } else if (msgType === 'users-count') {
                    onlineCount = data.usersCount;
                    waitingCount = data.waitingUsersCount;
                } else if (data && data.type === 'users-count') {
                    onlineCount = data.usersCount;
                    waitingCount = data.waitingUsersCount;
                }

                if (onlineCount !== null && onlineCount !== undefined && onlineCount !== _lastOnline) {
                    _lastOnline = onlineCount;
                    window.nektoOnlineLiveWS = String(onlineCount).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
                    if (!_onlineEl) _onlineEl = document.getElementById('ping-online-val');
                    if (_onlineEl) _onlineEl.textContent = window.nektoOnlineLiveWS;
                }
                if (waitingCount !== null && waitingCount !== undefined && waitingCount !== _lastWaiting) {
                    _lastWaiting = waitingCount;
                    if (!_waitingEl) _waitingEl = document.getElementById('ping-waiting-val');
                    if (_waitingEl) _waitingEl.textContent = String(waitingCount);
                }
            }
            return data;
        };
    } catch (e) { }

    const PAGE_MSG = 'nekto-pro';
    const EXT_MSG = 'nekto-pro-ext';
    let fetchHtmlSeq = 0;
    const fetchHtmlWait = new Map();

    window.addEventListener('message', (ev) => {
        if (!ev.data || ev.data.source !== EXT_MSG) return;
        if (ev.origin) {
            try {
                const h = new URL(ev.origin).hostname;
                if (h !== 'nekto.me' && h !== 'www.nekto.me' && !h.endsWith('.nekto.me')) return;
            } catch (_) {

            }
        }
        const { type, id, err } = ev.data;
        if (type === 'FETCH_NEKTO_HTML_OK') {
            const p = fetchHtmlWait.get(id);
            if (p) {
                fetchHtmlWait.delete(id);
                const { text } = ev.data;
                try { p.resolve(typeof text === 'string' ? text : ''); } catch (e) { p.reject(e); }
            }
            return;
        }
        if (type === 'FETCH_NEKTO_HTML_ERR') {
            const p = fetchHtmlWait.get(id);
            if (p) { fetchHtmlWait.delete(id); p.reject(new Error(err || 'fetch')); }
            return;
        }
    });

    function extFetchNektoHtml(url) {
        return new Promise((resolve, reject) => {
            const id = ++fetchHtmlSeq;
            fetchHtmlWait.set(id, { resolve, reject });
            window.postMessage({ source: PAGE_MSG, type: 'FETCH_NEKTO_HTML', id, url }, '*');
            setTimeout(() => {
                if (fetchHtmlWait.has(id)) {
                    fetchHtmlWait.delete(id);
                    reject(new Error('bridge-timeout'));
                }
            }, 45000);
        });
    }

    let vuAnalyser = null;
    let vuAudioContext = null;
    let vuAnimFrame = null;
    let vuSourceNode = null;

    function setupVUMeter(stream) {
        try {
            if (!vuAudioContext) vuAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (vuSourceNode) {
                try { vuSourceNode.disconnect(); } catch (_) { }
                vuSourceNode = null;
            }
            vuSourceNode = vuAudioContext.createMediaStreamSource(stream);
            if (!vuAnalyser) {
                vuAnalyser = vuAudioContext.createAnalyser();
                vuAnalyser.fftSize = 256;
                vuAnalyser.smoothingTimeConstant = 0.75;
            }
            vuSourceNode.connect(vuAnalyser);
            runVULoop();
        } catch (_) { }
    }

    function runVULoop() {
        if (vuAnimFrame) cancelAnimationFrame(vuAnimFrame);
        const data = new Uint8Array(vuAnalyser ? vuAnalyser.frequencyBinCount : 0);
        const bars = document.querySelectorAll('.vu-bar');
        const numBars = bars.length;

        // Cache panel-level values outside the hot tick path
        const panel = document.getElementById('nekto-panel');
        const hb = parseFloat(panel && panel.dataset.vuHue ? panel.dataset.vuHue : '148', 10);
        const hueBase = Number.isFinite(hb) ? hb : 148;
        const inactOp = nkCssVar('--nk-vu-bar-inactive-op', '0.08');
        // Track previous per-bar state to skip redundant style writes
        const prevActive = new Uint8Array(numBars);
        const prevIntensity = new Float32Array(numBars);

        function tick() {
            vuAnimFrame = requestAnimationFrame(tick);
            if (!vuAnalyser || !bars.length) return;
            vuAnalyser.getByteFrequencyData(data);

            // Manual loop — avoids slice() allocation every frame
            let sum = 0;
            for (let k = 0; k < 60; k++) sum += data[k];
            const level = Math.min(1, sum / (60 * 110));

            for (let i = 0; i < numBars; i++) {
                const threshold = i / numBars;
                const active = level > threshold ? 1 : 0;
                const intensity = active ? Math.min(1, (level - threshold) / (1 / numBars) * 1.5) : 0;
                // Skip write if nothing changed (avoids repaint)
                if (prevActive[i] === active && Math.abs(prevIntensity[i] - intensity) < 0.02) continue;
                prevActive[i] = active;
                prevIntensity[i] = intensity;
                const bar = bars[i];
                const hue = hueBase - threshold * 100;
                if (!active) {
                    bar.style.background = '';
                    bar.style.boxShadow = '';
                    bar.style.opacity = inactOp;
                    continue;
                }
                bar.style.opacity = (0.4 + intensity * 0.6).toFixed(2);
                bar.style.boxShadow = `0 0 ${(6 + intensity * 10).toFixed(1)}px hsl(${hue | 0}, 100%, 60%)`;
                bar.style.background = `hsl(${hue | 0}, 100%, ${(55 + intensity * 20) | 0}%)`;
            }
        }
        tick();
    }

    let pingInterval = null;
    let lastPing = null;
    let pingMissCount = 0;

    async function measurePing() {
        const t = performance.now();
        try {
            await fetch((typeof location !== 'undefined' && location.origin ? location.origin : 'https://nekto.me') + '/favicon.ico?_=' + Date.now(), {
                method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(4000)
            });
            const ms = Math.round(performance.now() - t);
            pingMissCount = 0;
            return ms;
        } catch {
            pingMissCount++;
            return null;
        }
    }

    function updatePingUI(ms) {
        const val = document.getElementById('ping-val');
        const drop = document.getElementById('drop-alert');
        if (!val) return;

        if (ms === null || pingMissCount >= 2) {
            const bad = nkCssVar('--nk-ping-bad', '#ff3355');
            val.textContent = 'ОБРЫВ';
            val.style.color = bad;
            if (drop) { drop.style.display = 'flex'; drop.style.animation = 'dropFlash 0.5s ease'; }
        } else {
            if (drop) drop.style.display = 'none';
            const g = nkCssVar('--nk-ping-good', '#00ff9d');
            const w = nkCssVar('--nk-ping-warn', '#ffcc00');
            const o = nkCssVar('--nk-ping-orange', '#ff7700');
            if (ms < 120) val.style.color = g;
            else if (ms < 300) val.style.color = w;
            else val.style.color = o;
            val.textContent = ms + 'ms';
        }
    }

    function startPingLoop() {
        if (pingInterval) clearInterval(pingInterval);
        measurePing().then(updatePingUI);
        pingInterval = setInterval(async () => {
            const ms = await measurePing();
            updatePingUI(ms);
        }, 9000);
    }

    const startAudio = new Audio(START_SOUND); startAudio.volume = 0.4;
    const endAudio = new Audio(END_SOUND); endAudio.volume = 0.3;

    const originalPlay = HTMLAudioElement.prototype.play;
    HTMLAudioElement.prototype.play = function () {
        if (this.src.includes('connect.mp3') && !this.dataset.custom) return Promise.resolve();
        return originalPlay.apply(this, arguments);
    };



    function saveStats() {
        localStorage.setItem('conversationCount', settings.conversationCount);
        localStorage.setItem('totalConversationTime', settings.totalConversationTime);
    }

    function nkFormatRecTime(ms) {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        return `${m}:${String(s % 60).padStart(2, '0')}`;
    }

    function nkUpdateRecUI() {
        const btn = document.getElementById('nk-rec-btn');
        const stop = document.getElementById('nk-rec-stop');
        const timer = document.getElementById('nk-rec-timer');
        const label = document.getElementById('nk-rec-label');
        const row = document.getElementById('nk-rec-row');
        const toggle = document.getElementById('nk-rec-toggle');
        if (toggle) toggle.classList.toggle('on', nkAutoRecord);
        if (nkRecordState === 'idle') {
            if (btn) { btn.textContent = '⏺'; btn.title = 'Начать запись'; btn.classList.remove('nk-rec-recording', 'nk-rec-paused'); }
            if (stop) stop.style.display = 'none';
            if (timer) { timer.textContent = ''; timer.style.display = 'none'; }
            if (label) label.textContent = 'Запись звонка';
            if (row) row.classList.remove('nk-rec-active');
        } else if (nkRecordState === 'recording') {
            if (btn) { btn.textContent = '⏸'; btn.title = 'Пауза'; btn.classList.add('nk-rec-recording'); btn.classList.remove('nk-rec-paused'); }
            if (stop) stop.style.display = '';
            if (timer) { timer.textContent = nkFormatRecTime(Date.now() - nkRecordStartTime); timer.style.display = ''; }
            if (label) label.textContent = 'Идёт запись';
            if (row) row.classList.add('nk-rec-active');
        } else if (nkRecordState === 'paused') {
            if (btn) { btn.textContent = '▶'; btn.title = 'Продолжить'; btn.classList.remove('nk-rec-recording'); btn.classList.add('nk-rec-paused'); }
            if (stop) stop.style.display = '';
            if (timer) { timer.textContent = nkFormatRecTime(Date.now() - nkRecordStartTime); timer.style.display = ''; }
            if (label) label.textContent = 'Пауза';
            if (row) row.classList.remove('nk-rec-active');
        }
    }

    function nkConnectRemoteToRecording(stream) {
        if (!nkRecordCtx || !nkRecordMerger || !stream) return;
        try {
            if (nkRecordRemoteSrc) { try { nkRecordRemoteSrc.disconnect(); } catch (_) {} }
            nkRecordRemoteSrc = nkRecordCtx.createMediaStreamSource(stream);
            nkRecordRemoteSrc.connect(nkRecordMerger, 0, 1);
        } catch (_) {}
    }

    async function nkStartRecording() {
        if (nkRecordState === 'recording') return;
        if (nkRecordCtx) { try { nkRecordCtx.close(); } catch (_) {} }
        nkRecordChunks = [];
        nkRecordRemoteSrc = null;
        nkRecordCtx = new (window.AudioContext || window.webkitAudioContext)();
        nkRecordMerger = nkRecordCtx.createChannelMerger(2);
        // Left — mic
        if (originalMicStream) {
            const micSrc = nkRecordCtx.createMediaStreamSource(originalMicStream);
            micSrc.connect(nkRecordMerger, 0, 0);
        }
        // Right — remote (connect now if already available, ontrack will reconnect if late)
        if (nkRemoteStream) nkConnectRemoteToRecording(nkRemoteStream);
        const dest = nkRecordCtx.createMediaStreamDestination();
        nkRecordMerger.connect(dest);
        const mimeType = ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm;codecs=opus', 'audio/webm']
            .find(t => MediaRecorder.isTypeSupported(t)) || '';
        nkRecorder = new MediaRecorder(dest.stream, mimeType ? { mimeType } : {});
        nkRecorder.ondataavailable = (e) => { if (e.data.size > 0) nkRecordChunks.push(e.data); };
        nkRecorder.start(200);
        nkRecordState = 'recording';
        nkRecordStartTime = Date.now();
        clearInterval(nkRecordTimerInterval);
        nkRecordTimerInterval = setInterval(nkUpdateRecUI, 1000);
        nkUpdateRecUI();
    }

    function nkPauseRecording() {
        if (nkRecorder && nkRecorder.state === 'recording') {
            nkRecorder.pause();
            nkRecordState = 'paused';
            nkUpdateRecUI();
        }
    }

    function nkResumeRecording() {
        if (nkRecorder && nkRecorder.state === 'paused') {
            nkRecorder.resume();
            nkRecordState = 'recording';
            clearInterval(nkRecordTimerInterval);
            nkRecordTimerInterval = setInterval(nkUpdateRecUI, 1000);
            nkUpdateRecUI();
        }
    }

    function nkDownloadRecording(minDurationMs) {
        clearInterval(nkRecordTimerInterval);
        nkRecordTimerInterval = null;
        if (!nkRecorder) { nkRecordState = 'idle'; nkUpdateRecUI(); return; }
        const durationMs = Date.now() - nkRecordStartTime;
        const savedMimeType = nkRecorder.mimeType || 'audio/webm';
        nkRecorder.onstop = () => {
            if (durationMs >= minDurationMs) {
                const ext = savedMimeType.includes('ogg') ? 'ogg' : 'webm';
                const blob = new Blob(nkRecordChunks, { type: savedMimeType });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                a.href = url;
                a.download = `nekto-call-${ts}.${ext}`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
            }
            nkRecordChunks = [];
            nkRecorder = null;
            nkRecordMerger = null;
            nkRecordRemoteSrc = null;
            if (nkRecordCtx) { try { nkRecordCtx.close(); } catch (_) {} nkRecordCtx = null; }
        };
        try { nkRecorder.stop(); } catch (_) {}
        nkRecordState = 'idle';
        nkUpdateRecUI();
    }

    // Manual stop — always downloads regardless of duration
    function nkStopManual() { nkDownloadRecording(0); }

    // Auto stop (on skip/end) — discard if < 1 min
    function nkStopRecording() { nkDownloadRecording(60000); }

    function nkOnMainBtnClick() {
        if (nkRecordState === 'idle') nkStartRecording();
        else if (nkRecordState === 'recording') nkPauseRecording();
        else if (nkRecordState === 'paused') nkResumeRecording();
    }

    function hasConversationUnlock() {
        return Boolean(isConversationActive || hasConversationInSession);
    }

    let featureLockToastTimer = 0;
    function showFeatureLockPopup() {
        let el = document.getElementById('nk-feature-lock-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'nk-feature-lock-toast';
            el.innerHTML = `
                <div class="nk-fl-backdrop"></div>
                <div class="nk-fl-card" role="status" aria-live="polite">
                    <div class="nk-fl-icon">🔒</div>
                    <div class="nk-fl-title">Функция пока недоступна</div>
                    <div class="nk-fl-text">Для использования функций войдите один раз в разговор</div>
                </div>
            `;
            document.body.appendChild(el);
        }
        el.classList.remove('show');
        void el.offsetWidth;
        el.classList.add('show');
        if (featureLockToastTimer) clearTimeout(featureLockToastTimer);
        featureLockToastTimer = setTimeout(() => {
            const t = document.getElementById('nk-feature-lock-toast');
            if (t) t.classList.remove('show');
            featureLockToastTimer = 0;
        }, 2500);
    }





    let nkToastContainer = null;

    function ensureToastContainer() {
        if (nkToastContainer && document.body.contains(nkToastContainer)) return nkToastContainer;
        nkToastContainer = document.createElement('div');
        nkToastContainer.id = 'nk-toast-container';
        nkToastContainer.dataset.theme = settings.panelTheme;
        document.body.appendChild(nkToastContainer);
        return nkToastContainer;
    }

    const TOAST_ICONS = {
        info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64b4ff" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        time: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        skip: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
        search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
        success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00ff9d" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffbe32" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    };

    function showNkToast(text, type = 'info', duration = 4000) {
        const container = ensureToastContainer();

        while (container.querySelectorAll('.nk-toast').length >= 3) {
            const oldest = container.querySelector('.nk-toast:first-child');
            if (!oldest) break;
            container.removeChild(oldest);
        }
        const toast = document.createElement('div');
        toast.className = 'nk-toast nk-toast-' + type;
        const icon = TOAST_ICONS[type] || TOAST_ICONS.info;
        const iconEl = document.createElement('div');
        iconEl.className = 'nk-toast-icon';
        iconEl.innerHTML = icon;
        const body = document.createElement('div');
        body.className = 'nk-toast-body';
        const brand = document.createElement('div');
        brand.className = 'nk-toast-brand';
        brand.textContent = 'NektoULTRA';
        const textEl = document.createElement('div');
        textEl.className = 'nk-toast-text';
        textEl.textContent = String(text);
        body.appendChild(brand);
        body.appendChild(textEl);
        toast.appendChild(iconEl);
        toast.appendChild(body);
        container.appendChild(toast);
        void toast.offsetWidth;
        toast.classList.add('nk-toast-show');
        const dismiss = () => {
            toast.classList.remove('nk-toast-show');
            toast.classList.add('nk-toast-hide');
            setTimeout(() => { try { if (toast.parentNode) toast.parentNode.removeChild(toast); } catch (_) { } }, 420);
        };
        if (duration > 0) {
            const tid = setTimeout(dismiss, duration);
            toast.addEventListener('click', () => { clearTimeout(tid); dismiss(); });
        } else {
            toast.classList.add('nk-persistent-toast');
            toast.addEventListener('click', () => { dismiss(); });
        }
    }





    function startConvMilestoneTimer() {
        stopConvMilestoneTimer();
        convMilestoneShown.clear();
        convMilestoneTimer = setInterval(() => {
            if (!isConversationActive || !conversationStartTime) return;
            const mins = Math.floor((Date.now() - conversationStartTime) / 60000);
            for (const m of CONV_MILESTONES) {
                if (mins >= m && !convMilestoneShown.has(m)) {
                    convMilestoneShown.add(m);
                    const label = m >= 60 ? `${Math.floor(m / 60)}ч ${m % 60 ? m % 60 + 'м' : ''}` : `${m} мин`;
                    showNkToast(`Вы общаетесь уже ${label}`, 'time', 5000);
                }
            }
        }, 10000);
    }

    function stopConvMilestoneTimer() {
        if (convMilestoneTimer) { clearInterval(convMilestoneTimer); convMilestoneTimer = null; }
        convMilestoneShown.clear();
    }





    function todayDateStr() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function updateDailyStats() {
        const today = todayDateStr();
        if (settings.dailyStats.date !== today) {
            settings.dailyStats = { date: today, count: 1 };
        } else {
            settings.dailyStats.count++;
        }
        localStorage.setItem('dailyStats', JSON.stringify(settings.dailyStats));
    }

    function updateStreak() {
        const today = todayDateStr();
        const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
        if (settings.streakData.lastDate === today) return;
        if (settings.streakData.lastDate === yesterday) {
            settings.streakData.count++;
        } else if (settings.streakData.lastDate !== today) {
            settings.streakData.count = 1;
        }
        settings.streakData.lastDate = today;
        localStorage.setItem('streakData', JSON.stringify(settings.streakData));
    }

    function updateLongestConversation(durationSec) {
        if (durationSec > settings.longestConversation) {
            settings.longestConversation = durationSec;
            localStorage.setItem('longestConversation', String(durationSec));
        }
    }

    function formatDuration(seconds) {
        if (!seconds || seconds < 0) return '0с';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}ч ${m}м ${s}с`;
        if (m > 0) return `${m}м ${s}с`;
        return `${s}с`;
    }

    function getAverageConversation() {
        if (!settings.conversationCount) return '—';
        return formatDuration(Math.floor(settings.totalConversationTime / settings.conversationCount));
    }

    function refreshDetailedStatsUI() {
        const avgEl = document.getElementById('nk-stat-avg');
        const longestEl = document.getElementById('nk-stat-longest');
        const todayEl = document.getElementById('nk-stat-today');
        const streakEl = document.getElementById('nk-stat-streak');
        if (avgEl) avgEl.textContent = getAverageConversation();
        if (longestEl) longestEl.textContent = formatDuration(settings.longestConversation);
        const today = todayDateStr();
        if (todayEl) todayEl.textContent = settings.dailyStats.date === today ? settings.dailyStats.count : '0';
        if (streakEl) streakEl.textContent = (settings.streakData.lastDate === today || settings.streakData.lastDate === (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()) ? settings.streakData.count + ' д.' : '0 д.';
    }





    function generateImpulseResponse(ctx, duration, decay) {
        const rate = ctx.sampleRate;
        const length = Math.floor(rate * duration);
        const impulse = ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = impulse.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
        }
        return impulse;
    }

    function buildFxChain() {
        if (!pitchAudioContext || !micPostPitchGain || !micToMixGain) return;
        teardownFxChain();
        try {
            micPostPitchGain.disconnect(micToMixGain);
        } catch (_) { }

        fxMixNode = pitchAudioContext.createGain();
        fxMixNode.gain.value = 1;


        fxReverbDryGain = pitchAudioContext.createGain();
        fxReverbWetGain = pitchAudioContext.createGain();
        fxConvolverNode = pitchAudioContext.createConvolver();
        fxConvolverNode.buffer = generateImpulseResponse(pitchAudioContext, 2.5, 3.5);
        fxReverbDryGain.gain.value = settings.fxReverb ? (1 - settings.fxReverbMix) : 1;
        fxReverbWetGain.gain.value = settings.fxReverb ? settings.fxReverbMix : 0;


        fxBassFilter = pitchAudioContext.createBiquadFilter();
        fxBassFilter.type = 'lowshelf';
        fxBassFilter.frequency.value = 250;
        fxBassFilter.gain.value = settings.fxBassBoost ? settings.fxBassGain : 0;


        fxRadioFilter = pitchAudioContext.createBiquadFilter();
        fxRadioFilter.type = 'bandpass';
        fxRadioFilter.frequency.value = 2000;
        fxRadioFilter.Q.value = settings.fxRadio ? 3.5 : 0.001;


        micPostPitchGain.connect(fxReverbDryGain);
        micPostPitchGain.connect(fxReverbWetGain);
        fxReverbWetGain.connect(fxConvolverNode);
        fxReverbDryGain.connect(fxMixNode);
        fxConvolverNode.connect(fxMixNode);
        fxMixNode.connect(fxBassFilter);
        fxBassFilter.connect(fxRadioFilter);
        fxRadioFilter.connect(micToMixGain);
    }

    function teardownFxChain() {
        try { if (fxReverbDryGain) fxReverbDryGain.disconnect(); } catch (_) { }
        try { if (fxReverbWetGain) fxReverbWetGain.disconnect(); } catch (_) { }
        try { if (fxConvolverNode) fxConvolverNode.disconnect(); } catch (_) { }
        try { if (fxMixNode) fxMixNode.disconnect(); } catch (_) { }
        try { if (fxBassFilter) fxBassFilter.disconnect(); } catch (_) { }
        try { if (fxRadioFilter) fxRadioFilter.disconnect(); } catch (_) { }
        fxConvolverNode = null;
        fxReverbDryGain = null;
        fxReverbWetGain = null;
        fxBassFilter = null;
        fxRadioFilter = null;
        fxMixNode = null;
    }

    function reconnectFxOrDirect() {
        if (!pitchAudioContext || !micPostPitchGain || !micToMixGain) return;
        teardownFxChain();
        try { micPostPitchGain.disconnect(micToMixGain); } catch (_) { }
        if (settings.fxEnabled) {
            buildFxChain();
        } else {
            micPostPitchGain.connect(micToMixGain);
        }
    }

    function updateFxReverb() {
        if (!fxReverbDryGain || !fxReverbWetGain) return;
        fxReverbDryGain.gain.value = settings.fxReverb ? (1 - settings.fxReverbMix) : 1;
        fxReverbWetGain.gain.value = settings.fxReverb ? settings.fxReverbMix : 0;
    }

    function updateFxBass() {
        if (!fxBassFilter) return;
        fxBassFilter.gain.value = settings.fxBassBoost ? settings.fxBassGain : 0;
    }

    function updateFxRadio() {
        if (!fxRadioFilter) return;
        fxRadioFilter.Q.value = settings.fxRadio ? 3.5 : 0.001;
    }





    const SITE_THEME_MAP = {
        dark: { 
            bg: '#000000', 
            chat: '#121212', 
            nav: '#121212', 
            accent: '#ffffff', 
            accent2: '#969696', 
            avatar: '#121212', 
            text: '#ffffff', 
            headerBg: '#000000', 
            headerBd: '#121212', 
            btnChecked: '#121212', 
            filterBg: '#000000', 
            filterBd: '#121212' },
    };

    let _siteThemeApplied = null;
    let _siteThemeBodyObs = null;

    function applySiteTheme(theme) {
        _siteThemeApplied = theme;
        let styleEl = document.getElementById('nk-site-theme');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'nk-site-theme';
            document.head.appendChild(styleEl);
        }
        const t = SITE_THEME_MAP[theme] || SITE_THEME_MAP.cyber;

        if (t.isLight) {
            document.body.classList.remove('night_theme');
        } else {
            document.body.classList.add('night_theme');
        }
        styleEl.textContent = `
            body { background: ${t.bg} !important; color: ${t.text} !important; }
            .audio-chat, .chat_container .audio-chat { background: ${t.chat} !important; color: ${t.text} !important; }
            .audio-chat > div, .audio-chat .main-panel, .audio-chat .chat-step { background: transparent !important; }
            .audio-chat .header, .header.header_chat { background: transparent !important; border-bottom-color: ${t.headerBd} !important; }
            .audio-chat .header .chat, .audio-chat .header span, .header.header_chat .chat, .header_chat span { color: ${t.accent} !important; }
            .header_chat h1.chat { color: ${t.accent} !important; }
            .navbar.navbar-inverse, .a.navbar.navbar-inverse { background-color: ${t.nav} !important; border-bottom-color: ${t.headerBd} !important; }
            .navbar.navbar-inverse .navbar-brand span, .navbar.navbar-inverse .navbar-brand { color: ${t.accent} !important; }
            .navbar.navbar-inverse .navbar-nav > li > a { color: ${t.text} !important; }
            .navbar.navbar-inverse .navbar-nav > li.sel > a { color: ${t.accent} !important; }
            .audio-chat .scan-button, .audio-chat .go-scan-button { background-color: ${t.accent} !important; }
            .audio-chat .scan-button:hover, .audio-chat .go-scan-button:hover { opacity: 0.88; }
            .audio-chat .stop-talk-button { border-color: ${t.accent2} !important; color: ${t.accent2} !important; background-color: transparent !important; }
            .audio-chat .go-idle-button { border-color: ${t.accent} !important; color: ${t.accent} !important; background-color: transparent !important; }
            .audio-chat .stop-scan-button { border-color: ${t.accent} !important; color: ${t.accent} !important; }
            .audio-chat .nekto { background-color: ${t.avatar} !important; color: ${t.chat} !important; }
            .audio-chat .nekto:after { border-color: ${t.chat} !important; }
            .audio-chat .talk-label, .audio-chat .timer-label { color: ${t.accent} !important; }
            .audio-chat .description .title { color: ${t.accent} !important; }
            .audio-chat .filter-label { color: ${t.text} !important; }
            .audio-chat .btn-default { background: ${t.filterBg} !important; border-color: ${t.filterBd} !important; color: ${t.text} !important; }
            .audio-chat .btn-default.checked { background: ${t.btnChecked} !important; border-color: ${t.accent} !important; color: ${t.btnCheckedFg || '#fff'} !important; }
            .audio-chat .companion-label span { background: ${t.chat} !important; color: ${t.accent2} !important; }
            .audio-chat .companion-label:after { border-color: ${t.accent2} !important; }
            .audio-chat .mute-button { background-color: ${t.filterBg} !important; border: 1px solid ${t.filterBd} !important; }
            .audio-chat .mute-button.muted { background-color: ${t.btnChecked} !important; border: none !important; }
            .audio-chat .description, .audio-chat .description a { color: ${t.text} !important; }
            .audio-chat .description a { color: ${t.accent} !important; }
            .swal2-modal { background-color: ${t.chat} !important; }
            .swal2-modal .swal2-title, .swal2-modal .swal2-content div, .swal2-modal .swal2-content { color: ${t.text} !important; }
            .audio-chat .users-count-panel { color: ${t.text} !important; }
            .outer-container { color: ${t.text}; }
            body.nk-clean-site .chat_container,
            body.nk-clean-site .audio-chat,
            body.nk-clean-site .callScreen,
            body.nk-clean-site .searchScreen {
                margin-left: auto !important;
                margin-right: auto !important;
                float: none !important;
                max-width: min(760px, calc(100vw - 28px)) !important;
                width: 100% !important;
                position: relative !important;
                background: transparent !important;
            }
            body.nk-clean-site .flex-spacer {
                transform: none !important;
            }
            body.nk-clean-site .outer-container,
            body.nk-clean-site .container,
            body.nk-clean-site .row,
            body.nk-clean-site #app,
            body.nk-clean-site #app > div {
                width: 100% !important;
                max-width: 100% !important;
                margin-left: 0 !important;
                margin-right: 0 !important;
                padding-left: 0 !important;
                padding-right: 0 !important;
                float: none !important;
                background: transparent !important;
            }
            /* callScreen / searchScreen / all SPA views */
            .callScreen, .callScreen > div, .searchScreen, .searchScreen > div,
            [class*="Screen"], [class*="Screen"] > div { background: transparent !important; color: ${t.text} !important; }
            .callScreen__time, .searchScreen__time, [class*="__time"] { color: ${t.accent} !important; }
            .callScreen__findBtn, .searchScreen__findBtn, [class*="__findBtn"] { background-color: ${t.accent} !important; color: #fff !important; }
            .callScreen__stopBtn, .callScreen__endBtn, .searchScreen__stopBtn,
            [class*="__stopBtn"], [class*="__endBtn"] { border-color: ${t.accent2} !important; color: ${t.accent2} !important; }
            .searchScreen__status, [class*="__status"] { color: ${t.text} !important; }
            .searchScreen__spinner, [class*="__spinner"] { border-top-color: ${t.accent} !important; }
            body:not(.nk-clean-site) #app, body:not(.nk-clean-site) #app > div { background: ${t.bg} !important; color: ${t.text} !important; }
            /* NektoPRO clean interface */
            body.nk-clean-site {
                min-height: 100vh !important;
                background:
                    radial-gradient(circle at 16% 12%, color-mix(in srgb, ${t.accent} 18%, transparent), transparent 34%),
                    radial-gradient(circle at 82% 18%, color-mix(in srgb, ${t.accent2} 14%, transparent), transparent 32%),
                    ${t.bg} !important;
                background-repeat: no-repeat !important;
                background-attachment: fixed !important;
                background-size: cover !important;
            }
            body.nk-clean-site .navbar.navbar-inverse,
            body.nk-clean-site footer,
            body.nk-clean-site .footer,
            body.nk-clean-site [class*="footer"]:not(.nk-changelog-footer),
            body.nk-clean-site .breadcrumb,
            body.nk-clean-site .audio-chat .description {
                display: none !important;
                visibility: hidden !important;
            }
            body.nk-clean-site .description,
            body.nk-clean-site #devel,
            body.nk-clean-site img[src*="gplaybtn"],
            body.nk-clean-site .theme,
            body.nk-clean-site .theme-switch,
            body.nk-clean-site .theme_toggler,
            body.nk-clean-site .theme-filter-panel,
            body.nk-clean-site .users-count-panel,
            body.nk-clean-site .users_count,
            body.nk-clean-site .nk-site-clutter {
                display: none !important;
                visibility: hidden !important;
            }
            body.nk-clean-site #app,
            body.nk-clean-site #app > div,
            body.nk-clean-site .outer-container,
            body.nk-clean-site .chat_container {
                min-height: 100vh !important;
                display: grid !important;
                place-items: center !important;
                padding: 22px 14px !important;
                box-sizing: border-box !important;
            }
            body.nk-clean-site .audio-chat {
                width: min(760px, calc(100vw - 28px)) !important;
                min-height: 430px !important;
                position: relative !important;
                margin: 0 auto !important;
                padding: 32px !important;
                border-radius: 22px !important;
                border: 1px solid color-mix(in srgb, ${t.accent} 24%, transparent) !important;
                background: color-mix(in srgb, ${t.chat} 60%, transparent) !important;
                backdrop-filter: blur(24px) !important;
                -webkit-backdrop-filter: blur(24px) !important;
                box-shadow: 0 24px 70px rgba(0,0,0,0.36), 0 0 0 1px rgba(255,255,255,0.03) inset !important;
                color: ${t.text} !important;
                box-sizing: border-box !important;
                overflow: hidden !important;
                transition: all 0.3s ease !important;
            }
            body.nk-clean-site .audio-chat:not(:has(.idle)) {
                width: min(600px, calc(100vw - 28px)) !important;
                aspect-ratio: 1 / 1 !important;
                border-radius: 32px !important;
            }
            body.nk-clean-site .row > div:not(.chat_container):not(.modal),
            body.nk-clean-site .row > section:not(.chat_container):not(.modal) {
                display: none !important;
                visibility: hidden !important;
            }
            body.nk-clean-site #audio-chat-container {
                position: relative !important;
            }
            body.nk-captcha-mode {
                background: ${t.bg} !important;
                color: ${t.text} !important;
            }
            body.nk-captcha-mode #mask_cap:not([style*="display: none"]):not([style*="display:none"]) {
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                display: flex !important;
                flex-direction: column !important;
                justify-content: center !important;
                align-items: center !important;
                z-index: 999999 !important;
                background: rgba(8, 8, 14, 0.96) !important;
                backdrop-filter: blur(12px) !important;
                -webkit-backdrop-filter: blur(12px) !important;
            }
            body.nk-captcha-mode #mask_cap[style*="display: none"],
            body.nk-captcha-mode #mask_cap[style*="display:none"] {
                display: none !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }
            body.nk-captcha-mode .hcapsect {
                position: relative !important;
                z-index: 100000 !important;
                margin: 0 auto !important;
                width: 360px !important;
                max-width: 90vw !important;
                height: fit-content !important;
                flex: 0 0 auto !important;
                padding: 16px 20px 12px !important;
                border-radius: 16px !important;
                border: 1px solid color-mix(in srgb, ${t.accent} 24%, transparent) !important;
                background: linear-gradient(145deg, color-mix(in srgb, ${t.chat} 94%, #ffffff 6%), color-mix(in srgb, ${t.chat} 86%, #000000 14%)) !important;
                box-shadow: 0 24px 70px rgba(0,0,0,0.36), 0 0 0 1px rgba(255,255,255,0.03) inset !important;
                color: ${t.text} !important;
            }
            body.nk-captcha-mode .hcapsect div {
                color: ${t.text} !important;
                text-align: center !important;
            }
            body.nk-captcha-mode .hcapsect div[style*="font-size: 16px"] {
                font-size: 14px !important;
                margin-top: 0 !important;
                margin-bottom: 12px !important;
                line-height: 1.35 !important;
            }
            body.nk-captcha-mode .hcapsect div[style*="color: rgb(11, 68, 110)"] {
                color: ${t.accent} !important;
                font-weight: 800 !important;
                font-size: 18px !important;
                margin-top: 0 !important;
                margin-bottom: 6px !important;
                text-shadow: 0 0 10px color-mix(in srgb, ${t.accent} 40%, transparent) !important;
            }
            body.nk-captcha-mode .hcapsect span {
                color: ${t.accent2} !important;
                font-weight: bold !important;
            }
            body.nk-captcha-mode .hcapsect div[style*="margin-top: 10px"] {
                display: none !important;
            }
            body.nk-captcha-mode .hcapsect div[style*="margin-top: 10px"] center {
                color: ${t.text} !important;
                opacity: 0.8 !important;
            }
            body.nk-captcha-mode .hcapsect img.gplaybotbut,
            body.nk-captcha-mode .hcapsect img.gplaybotbut + img {
                border-radius: 8px !important;
                border: 1px solid rgba(255,255,255,0.08) !important;
                transition: transform 0.2s !important;
            }
            body.nk-captcha-mode .hcapsect img.gplaybotbut:hover {
                transform: scale(1.04) !important;
            }
            body.nk-clean-site .audio-chat .header,
            body.nk-clean-site .header.header_chat {
                margin: -32px -32px 24px !important;
                padding: 20px 32px !important;
                border: 0 !important;
                border-bottom: 1px solid color-mix(in srgb, ${t.accent} 15%, transparent) !important;
                background: color-mix(in srgb, ${t.headerBg} 60%, transparent) !important;
                backdrop-filter: blur(12px) !important;
                -webkit-backdrop-filter: blur(12px) !important;
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
            }
            body.nk-clean-site .audio-chat .header div,
            body.nk-clean-site .header.header_chat div {
                font-size: 14px !important;
                color: color-mix(in srgb, ${t.text} 60%, transparent) !important;
                font-weight: 500 !important;
            }
            body.nk-clean-site .audio-chat .header .chat,
            body.nk-clean-site .header_chat h1.chat {
                font-size: 24px !important;
                line-height: 1.2 !important;
                font-weight: 900 !important;
                background: linear-gradient(135deg, ${t.accent}, ${t.accent2}) !important;
                -webkit-background-clip: text !important;
                -webkit-text-fill-color: transparent !important;
                text-shadow: 0 4px 16px color-mix(in srgb, ${t.accent} 30%, transparent) !important;
                letter-spacing: -0.5px !important;
                margin: 0 0 4px 0 !important;
            }
            body.nk-clean-site .audio-chat .filters,
            body.nk-clean-site [class*="filter"],
            body.nk-clean-site .settings,
            body.nk-clean-site .searchScreen__filters {
                gap: 10px !important;
            }
            body.nk-clean-site .audio-chat .btn-default,
            body.nk-clean-site .audio-chat button,
            body.nk-clean-site .callScreen button,
            body.nk-clean-site .searchScreen button {
                border-radius: 12px !important;
                min-height: 40px !important;
                font-weight: 700 !important;
                box-shadow: none !important;
                transition: transform 0.16s ease, opacity 0.16s ease, border-color 0.16s ease !important;
            }
            body.nk-clean-site .audio-chat button:hover,
            body.nk-clean-site .callScreen button:hover,
            body.nk-clean-site .searchScreen button:hover {
                transform: translateY(-1px) !important;
            }
            body.nk-clean-site .audio-chat .scan-button,
            body.nk-clean-site .audio-chat .go-scan-button,
            body.nk-clean-site .callScreen__findBtn,
            body.nk-clean-site .searchScreen__findBtn,
            body.nk-clean-site [class*="__findBtn"] {
                display: flex !important;
                width: max-content !important;
                margin: 8px auto 16px auto !important;
                align-items: center !important;
                justify-content: center !important;
                border: 0 !important;
                border-radius: 16px !important;
                min-height: 48px !important;
                padding: 0 24px !important;
                background: linear-gradient(135deg, ${t.accent}, ${t.accent2}) !important;
                color: #fff !important;
                box-shadow: 0 14px 32px color-mix(in srgb, ${t.accent} 32%, transparent) !important;
            }
            
            /* Visual styles for ALL cancel/stop buttons */
            body.nk-clean-site .btn-danger,
            body.nk-clean-site .callScreen__cancelCallBtn,
            body.nk-clean-site .cancelCallBtnNoMess,
            body.nk-clean-site button.stop-talk-button,
            body.nk-clean-site [class*="cancelCall"],
            body.nk-clean-site [class*="stop-talk"],
            body.nk-clean-site button.go-idle-button,
            body.nk-clean-site [class*="__stopBtn"] {
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                z-index: 50 !important;
                background: transparent !important;
                color: #ff4b4b !important;
                border: 2px solid #ff4b4b !important;
                border-radius: 16px !important;
                min-height: 48px !important;
                padding: 0 28px !important;
                box-shadow: 0 0 16px rgba(255, 75, 75, 0.15), 0 0 8px rgba(255, 75, 75, 0.1) inset !important;
                font-weight: 800 !important;
                text-transform: uppercase !important;
                letter-spacing: 0.5px !important;
                transition: all 0.2s ease !important;
                width: max-content !important;

                /* Default absolute positioning centered correctly without left/right 0 bug */
                position: absolute !important;
                bottom: 24px !important;
                left: 50% !important;
                right: auto !important;
                transform: translateX(-50%) !important;
                margin: 0 !important;
            }

            /* Override positioning exclusively for searchScreen stop button so .flex-spacer can push it */
            body.nk-clean-site .searchScreen__stopBtn {
                position: static !important;
                transform: none !important;
                margin: 0 auto 24px auto !important;
                left: auto !important;
                bottom: auto !important;
            }
            body.nk-clean-site .stop-and-complain-button,
            body.nk-clean-site .callScreen__complaintBtn,
            body.nk-clean-site button:has(svg path[d^="M12 1L3"]) {
                display: none !important;
                visibility: hidden !important;
                pointer-events: none !important;
                opacity: 0 !important;
                width: 0 !important;
                height: 0 !important;
                margin: 0 !important;
                padding: 0 !important;
                min-width: 0 !important;
                min-height: 0 !important;
                border: 0 !important;
            }
            body.nk-clean-site .audio-chat .callScreen__microBtn {
                width: 48px !important;
                height: 48px !important;
                border-radius: 16px !important;
                background-color: color-mix(in srgb, ${t.bg} 80%, transparent) !important;
                border: 1px solid rgba(255,255,255,0.05) !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                padding: 0 !important;
                margin: 0 !important;
                color: ${t.text} !important;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2) !important;
                transition: all 0.2s ease !important;
            }
            body.nk-clean-site .audio-chat .callScreen__microBtn svg {
                width: 24px !important;
                height: 24px !important;
                fill: currentColor !important;
            }
            body.nk-clean-site .audio-chat .callScreen__microBtn.disabled {
                background-color: color-mix(in srgb, #ff4b4b 15%, transparent) !important;
                color: #ff4b4b !important;
                border-color: rgba(255, 75, 75, 0.2) !important;
            }
            body.nk-clean-site .nk-custom-button-bar {
                display: flex !important;
                justify-content: center !important;
                align-items: center !important;
                gap: 16px !important;
                width: 100% !important;
                margin-top: 12px !important;
            }
            body.nk-clean-site .nk-custom-button-bar button {
                margin: 0 !important;
                float: none !important;
                position: static !important;
                transform: none !important;
                left: auto !important;
                right: auto !important;
                top: auto !important;
                bottom: auto !important;
            }
            body.nk-clean-site button:disabled,
            body.nk-clean-site [class*="__findBtn"]:disabled,
            body.nk-clean-site [class*="__stopBtn"]:disabled,
            body.nk-clean-site .btn-danger:disabled {
                opacity: 0.4 !important;
                filter: grayscale(100%) !important;
                cursor: not-allowed !important;
                pointer-events: none !important;
                box-shadow: none !important;
                transform: none !important;
            }
            body.nk-clean-site .btn-danger:hover,
            body.nk-clean-site [class*="cancelCall"]:hover,
            body.nk-clean-site [class*="stop-talk"]:hover,
            body.nk-clean-site [class*="__stopBtn"]:hover {
                background: rgba(255, 75, 75, 0.1) !important;
                box-shadow: 0 0 24px rgba(255, 75, 75, 0.3), 0 0 12px rgba(255, 75, 75, 0.2) inset !important;
                transform: translateY(-2px) !important;
            }
            body.nk-clean-site .callScreen button:not(.btn-danger):not([class*="cancelCall"]):not([class*="findBtn"]):not([class*="stop"]) {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                background: rgba(255, 255, 255, 0.05) !important;
                border: 1px solid rgba(255, 255, 255, 0.1) !important;
                border-radius: 16px !important;
                min-height: 48px !important;
                min-width: 48px !important;
                box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2) !important;
                backdrop-filter: blur(8px) !important;
                -webkit-backdrop-filter: blur(8px) !important;
            }
            @keyframes nk-glow-pulse {
                0% { text-shadow: 0 0 8px color-mix(in srgb, ${t.accent} 40%, transparent); }
                50% { text-shadow: 0 0 24px color-mix(in srgb, ${t.accent} 90%, transparent); }
                100% { text-shadow: 0 0 8px color-mix(in srgb, ${t.accent} 40%, transparent); }
            }
            body.nk-clean-site .load_init_step,
            body.nk-clean-site .search_company_step,
            body.nk-clean-site .status-end,
            body.nk-clean-site .bade_301 {
                font-weight: 800 !important;
                font-size: 22px !important;
                color: ${t.text} !important;
                background: transparent !important;
                border: 0 !important;
                box-shadow: none !important;
                padding-top: 20px !important;
            }
            body.nk-clean-site .window_chat_statuss {
                background: transparent !important;
                color: ${t.accent} !important;
                font-size: 16px !important;
                font-weight: 900 !important;
                border: 0 !important;
                box-shadow: none !important;
                animation: nk-glow-pulse 2s infinite !important;
                letter-spacing: 0.5px !important;
                pointer-events: none !important;
            }
            body.nk-clean-site .status_infoc {
                color: ${t.text} !important;
                opacity: 0.7 !important;
                font-size: 15px !important;
            }
            body.nk-clean-site .main-panel,
            body.nk-clean-site .chat-step {
                background: transparent !important;
                border: 0 !important;
                box-shadow: none !important;
            }
            body.nk-clean-site #audio-chat-container {
                background: transparent !important;
                border: 0 !important;
                box-shadow: none !important;
                height: auto !important;
                min-height: 100% !important;
                width: 100% !important;
                display: flex !important;
                flex-direction: column !important;
                justify-content: center !important;
                position: relative !important;
                z-index: 10 !important;
            }
            body.nk-clean-site canvas {
                filter: drop-shadow(0 0 16px ${t.accent}) !important;
                transform: scale(1.02) !important;
                border-radius: 16px !important;
            }
            body.nk-clean-site .users-count-panel,
            body.nk-clean-site .companion-label,
            body.nk-clean-site .talk-label,
            body.nk-clean-site .timer-label,
            body.nk-clean-site .callScreen__time,
            body.nk-clean-site [class*="__time"] {
                font-weight: 800 !important;
                letter-spacing: 0 !important;
            }
            body.nk-clean-site .swal2-container {
                z-index: 999999 !important;
                backdrop-filter: blur(10px) !important;
                -webkit-backdrop-filter: blur(10px) !important;
            }
            body.nk-clean-site .swal2-container:not(.swal2-shown) {
                pointer-events: none !important;
                display: none !important;
            }
            body.nk-clean-site .swal2-popup,
            body.nk-clean-site .swal2-modal {
                background: color-mix(in srgb, ${t.chat} 80%, transparent) !important;
                backdrop-filter: blur(24px) !important;
                -webkit-backdrop-filter: blur(24px) !important;
                border: 1px solid rgba(255,255,255,0.1) !important;
                border-radius: 24px !important;
                color: ${t.text} !important;
                box-shadow: 0 20px 60px rgba(0,0,0,0.5) !important;
            }
            body.nk-clean-site .swal2-title,
            body.nk-clean-site .swal2-content,
            body.nk-clean-site .swal2-html-container {
                color: ${t.text} !important;
            }
            body.nk-clean-site .mask_error,
            body.nk-clean-site .sign_in_loading,
            body.nk-clean-site .sign_in_loading2 {
                background: color-mix(in srgb, ${t.bg} 80%, transparent) !important;
                backdrop-filter: blur(16px) !important;
                -webkit-backdrop-filter: blur(16px) !important;
                border: 1px solid rgba(255,255,255,0.05) !important;
                color: ${t.text} !important;
                z-index: 999999 !important;
                display: flex !important;
                flex-direction: column !important;
                align-items: center !important;
                justify-content: center !important;
            }
            body.nk-clean-site .mask_error[style*="display: none"],
            body.nk-clean-site .mask_error[style*="display:none"],
            body.nk-clean-site .sign_in_loading[style*="display: none"],
            body.nk-clean-site .sign_in_loading[style*="display:none"],
            body.nk-clean-site .sign_in_loading2[style*="display: none"] {
                display: none !important;
                pointer-events: none !important;
            }
            body.nk-clean-site .modal {
                z-index: 1000000 !important;
            }
            body.nk-clean-site .modal[style*="display: none"],
            body.nk-clean-site .modal[style*="display:none"] {
                display: none !important;
                pointer-events: none !important;
            }
            body.nk-clean-site .modal-backdrop {
                z-index: 999999 !important;
                backdrop-filter: blur(12px) !important;
                -webkit-backdrop-filter: blur(12px) !important;
                background: color-mix(in srgb, ${t.bg} 80%, transparent) !important;
                opacity: 1 !important;
            }
            body.nk-clean-site .modal-backdrop[style*="display: none"],
            body.nk-clean-site .modal-backdrop[style*="display:none"] {
                display: none !important;
                pointer-events: none !important;
            }
            body.nk-clean-site .modal-content {
                background: color-mix(in srgb, ${t.chat} 80%, transparent) !important;
                backdrop-filter: blur(24px) !important;
                -webkit-backdrop-filter: blur(24px) !important;
                border: 1px solid rgba(255,255,255,0.1) !important;
                border-radius: 24px !important;
                color: ${t.text} !important;
                box-shadow: 0 20px 60px rgba(0,0,0,0.5) !important;
            }
            body.nk-clean-site .modal-header {
                border-bottom: 1px solid rgba(255,255,255,0.05) !important;
            }
            body.nk-clean-site .modal-footer {
                border-top: 1px solid rgba(255,255,255,0.05) !important;
            }
            ${t.isLight ? `
                .audio-chat .mute-button { background-image: url('/audiochat/images/ic_mic_black_18dp.png') !important; }
                .audio-chat .stop-talk-button { background-image: url('/audiochat/images/ic_call_end_white_18dp.png') !important; }
            ` : `
                .audio-chat .mute-button { background-image: url('/audiochat/images/night/ic_mic_white_18dp.png') !important; }
                .audio-chat .mute-button.muted { background-image: url('/audiochat/images/night/mic_off-gray-18dp.png') !important; }
                .audio-chat .stop-talk-button { background-image: url('/audiochat/images/night/ic_call_end_white_18dpn.png') !important; }
                .audio-chat .go-idle-button { background-image: url('/audiochat/images/night/ic_menu_white_48dpn.png') !important; }
                .audio-chat .stop-and-complain-button { background-image: url('/audiochat/images/night/ezgif.png') !important; }
            `}
            @media (max-width: 767px) {
                body.nk-clean-site #app,
                body.nk-clean-site #app > div,
                body.nk-clean-site .outer-container,
                body.nk-clean-site .chat_container {
                    padding: 8px 0 !important;
                }
                body.nk-clean-site .audio-chat,
                body.nk-clean-site .hcapsect {
                    width: calc(100vw - 16px) !important;
                    margin: 8px auto !important;
                    padding: 16px !important;
                    border-radius: 16px !important;
                    min-height: auto !important;
                }
                body.nk-clean-site .audio-chat .header,
                body.nk-clean-site .header.header_chat {
                    margin: -16px -16px 14px !important;
                    padding: 12px 16px !important;
                }
                body.nk-clean-site .audio-chat .header .chat,
                body.nk-clean-site .header_chat h1.chat {
                    font-size: 16px !important;
                }
                body.nk-clean-site .audio-chat .btn-default,
                body.nk-clean-site .audio-chat button,
                body.nk-clean-site .callScreen button,
                body.nk-clean-site .searchScreen button {
                    min-height: 36px !important;
                    border-radius: 10px !important;
                    font-size: 13px !important;
                }
                body.nk-clean-site .audio-chat .scan-button,
                body.nk-clean-site .audio-chat .go-scan-button,
                body.nk-clean-site .callScreen__findBtn,
                body.nk-clean-site .searchScreen__findBtn,
                body.nk-clean-site [class*="__findBtn"] {
                    min-height: 44px !important;
                    border-radius: 12px !important;
                    font-size: 14px !important;
                }
            }
        `;

        if (!_siteThemeBodyObs) {
            _siteThemeBodyObs = new MutationObserver(() => {
                if (!_siteThemeApplied) return;
                const t2 = SITE_THEME_MAP[_siteThemeApplied] || SITE_THEME_MAP.neon;
                const hasNight = document.body.classList.contains('night_theme');
                if (t2.isLight && hasNight) document.body.classList.remove('night_theme');
                if (!t2.isLight && !hasNight) document.body.classList.add('night_theme');
            });
            _siteThemeBodyObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
    }

    function formatTotalTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return h > 0 ? `${h}ч ${m}м` : `${m} мин`;
    }

    function nkCssVar(name, fallback) {
        const p = document.getElementById('nekto-panel');
        if (!p) return fallback;
        const v = getComputedStyle(p).getPropertyValue(name).trim();
        return v || fallback;
    }

    function applyPanelTheme(theme) {
        theme = 'dark';
        settings.panelTheme = theme;
        localStorage.setItem('panelTheme', theme);
        const t = SITE_THEME_MAP[theme] || SITE_THEME_MAP.neon;
        const p = document.getElementById('nekto-panel');
        if (p) {
            p.dataset.theme = theme;
            const vu = { dark: '206'};
            p.dataset.vuHue = vu[theme] || '160';
            // Apply theme colours as CSS variables directly on the panel element
            const a = t.accent, a2 = t.accent2, bg = t.chat, isLight = t.isLight;
            const alpha = (hex, op) => {
                // Convert any colour to rgba by drawing on a tiny canvas or just trust hex
                return hex + Math.round(op * 255).toString(16).padStart(2, '0');
            };
            p.style.setProperty('--nk-logo-a', a);
            p.style.setProperty('--nk-logo-b', a2);
            p.style.setProperty('--nk-inner-bg-a', isLight ? 'rgba(248,250,255,0.99)' : bg + 'f7');
            p.style.setProperty('--nk-inner-bg-b', isLight ? 'rgba(235,242,255,0.97)' : bg + 'f0');
            p.style.setProperty('--nk-border', a + '55');
            p.style.setProperty('--nk-inset-pink', a + '08');
            p.style.setProperty('--nk-inset-cyan', a2 + '10');
            p.style.setProperty('--nk-header-border', a + '2e');
            p.style.setProperty('--nk-header-bg', a + '0a');
            p.style.setProperty('--nk-logo-filter', `drop-shadow(0 0 8px ${a}88)`);
            p.style.setProperty('--nk-version', a2 + '85');
            p.style.setProperty('--nk-collapse-br', a + '50');
            p.style.setProperty('--nk-collapse-bg', a + '15');
            p.style.setProperty('--nk-collapse-fg', a);
            p.style.setProperty('--nk-ping-good', a);
            p.style.setProperty('--nk-ping-warn', '#ffcc00');
            p.style.setProperty('--nk-ping-orange', '#ff7700');
            p.style.setProperty('--nk-ping-bad', '#ff3355');
            p.style.setProperty('--nk-stat-a', a);
            p.style.setProperty('--nk-stat-b', a2);
            p.style.setProperty('--nk-stat-glow-a', a + '72');
            p.style.setProperty('--nk-stat-glow-b', a2 + '72');
            p.style.setProperty('--nk-glow-a', a + '88');
            p.style.setProperty('--nk-glow-b', a2 + '88');
            p.style.setProperty('--nk-text', isLight ? 'rgba(30,30,58,0.88)' : 'rgba(255,255,255,0.78)');
            p.style.setProperty('--nk-label', isLight ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.32)');
            p.style.setProperty('--nk-card-bg', isLight ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.035)');
            p.style.setProperty('--nk-card-bd', isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.08)');
            p.style.setProperty('--nk-divider', isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.09)');
            p.style.setProperty('--nk-shadow', isLight ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.82)');
            p.style.setProperty('--nk-toggle-on', a);
            p.style.setProperty('--nk-accent-range', a);
            p.style.setProperty('--nk-slider-val', a);
            p.style.setProperty('--nk-ctrl-a1', a);
            p.style.setProperty('--nk-ctrl-a2', a2);
            p.style.setProperty('--nk-vu-bar-inactive-op', '0.08');
            p.style.setProperty('--nk-scan', isLight ? 'rgba(0,0,0,0.01)' : 'rgba(255,255,255,0.014)');
            p.style.setProperty('color-scheme', isLight ? 'light' : 'dark');
        }
        const tc = document.getElementById('nk-toast-container');
        if (tc) tc.dataset.theme = theme;
        const sel = document.getElementById('nekto-theme-select');
        if (sel) sel.value = theme;
        applySiteTheme(theme);
    }

    function applyAccentColor() {
        const hue = (() => { try { const v = localStorage.getItem('nkAccentHue'); return v !== null ? parseInt(v, 10) : 331; } catch(_) { return 331; } })();
        const light = (() => { try { const v = localStorage.getItem('nkAccentLight'); return v !== null ? parseInt(v, 10) : 55; } catch(_) { return 55; } })();
        const h = ((hue % 360) + 360) % 360;
        const l = Math.max(0, Math.min(100, light));
        const a = l === 0 ? '#000000' : l === 100 ? '#ffffff' : `hsl(${h}, 100%, ${l}%)`;
        const a2 = a;
        const glow = l < 5 || l > 95 ? 0 : l < 15 ? (l / 15) * 0.45 : l > 85 ? ((100 - l) / 15) * 0.45 : 0.55;
        const p = document.getElementById('nekto-panel');
        if (p) {
            ['--nk-logo-a', '--nk-toggle-on', '--nk-accent-range', '--nk-slider-val', '--nk-collapse-fg', '--nk-ping-good', '--nk-stat-a', '--nk-ctrl-a1'].forEach(v => p.style.setProperty(v, a));
            p.style.setProperty('--nk-logo-b', a2);
            p.style.setProperty('--nk-stat-b', a2);
            p.style.setProperty('--nk-ctrl-a2', a2);
            p.style.setProperty('--nk-version', a2 + (glow > 0 ? '85' : ''));
            p.style.setProperty('--nk-logo-filter', glow > 0 ? `drop-shadow(0 0 8px hsla(${h}, 100%, ${l}%, ${glow}))` : 'none');
            p.style.setProperty('--nk-glow-a', glow > 0 ? `hsla(${h}, 100%, ${l}%, ${glow})` : 'rgba(0,0,0,0)');
            p.style.setProperty('--nk-glow-b', glow > 0 ? `hsla(${h}, 100%, ${l}%, ${glow})` : 'rgba(0,0,0,0)');
            p.style.setProperty('--nk-stat-glow-a', glow > 0 ? `hsla(${h}, 100%, ${l}%, ${glow - 0.1})` : 'rgba(0,0,0,0)');
            p.style.setProperty('--nk-stat-glow-b', glow > 0 ? `hsla(${h}, 100%, ${l}%, ${glow - 0.1})` : 'rgba(0,0,0,0)');
            const bAlpha = glow > 0 ? 0.32 : 0.12;
            const bBgAlpha = glow > 0 ? 0.09 : 0.03;
            p.style.setProperty('--nk-collapse-br', glow > 0 ? `hsla(${h}, 100%, ${l}%, ${bAlpha})` : 'rgba(255,255,255,0.12)');
            p.style.setProperty('--nk-collapse-bg', glow > 0 ? `hsla(${h}, 100%, ${l}%, ${bBgAlpha})` : 'rgba(255,255,255,0.03)');
            p.style.setProperty('--nk-border', glow > 0 ? `hsla(${h}, 100%, ${l}%, 0.35)` : 'rgba(255,255,255,0.12)');
            p.style.setProperty('--nk-header-border', glow > 0 ? `hsla(${h}, 100%, ${l}%, 0.18)` : 'rgba(255,255,255,0.06)');
            p.style.setProperty('--nk-header-bg', glow > 0 ? `hsla(${h}, 100%, ${l}%, 0.04)` : 'rgba(255,255,255,0.02)');
            p.dataset.vuHue = String(h);
        }
        SITE_THEME_MAP.dark.accent = a;
        SITE_THEME_MAP.dark.accent2 = a2;
        applySiteTheme('dark');
        const preview = document.getElementById('nk-accent-preview');
        if (preview) preview.style.backgroundColor = a;
    }

    function packOnlineDigits(digits) {
        if (!digits || digits.length > 10) return null;
        const n = parseInt(digits, 10);
        if (!n || n > 80000000) return null;
        return n.toLocaleString('ru-RU');
    }

    function extractOnlineFromTextBlob(blob) {
        if (!blob || blob.length < 8) return null;
        for (const s of blob.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
            const t = s[1];
            if (t.length < 20 || t.length > 500000) continue;
            const jm = t.match(/"(?:online|onlineCount|usersOnline|totalOnline)"\s*:\s*(\d+)/i)
                || t.match(/online["']?\s*[:=]\s*(\d+)/i);
            if (jm) {
                const f = packOnlineDigits(jm[1]);
                if (f) return f;
            }
        }
        const patterns = [
            /(\d[\d\s\u00A0\u202F]*)[\s\u00A0]*(?:пользовател|человек|онлайн|online|в\s+сети|участник|сейчас)/i,
            /(?:онлайн|online|в\s+сети)[\s:]*(\d[\d\s\u00A0\u202F]{0,14})/i
        ];
        for (const re of patterns) {
            const m = blob.match(re);
            if (m && m[1]) {
                const f = packOnlineDigits(m[1].replace(/[^\d]/g, ''));
                if (f) return f;
            }
        }
        return null;
    }

    let lastOnlineFromNetwork = null;
    let onlineFetchBusy = false;
    let onlineFetchBackoffMs = 0;
    let onlineMetaTimer = null;
    const ONLINE_META_MIN_MS = 38000;
    const ONLINE_META_JITTER_MS = 28000;
    const ONLINE_BACKOFF_CAP_MS = 240000;

    function shallowFindOnlineInObject(root, maxNodes) {
        if (!root || typeof root !== 'object') return null;
        const stack = [root];
        let steps = 0;
        while (stack.length && steps < maxNodes) {
            const o = stack.pop();
            steps++;
            if (!o || typeof o !== 'object') continue;
            for (const [k, v] of Object.entries(o)) {
                if (/online|usersonline|totalonline|onlinecount/i.test(k) && !/latency|ping|delay|last/i.test(k)
                    && typeof v === 'number' && v >= 80 && v < 80000000) {
                    const f = packOnlineDigits(String(Math.floor(v)));
                    if (f) return f;
                }
                if (typeof v === 'object' && v !== null && stack.length < 120) stack.push(v);
            }
        }
        return null;
    }

    function scrapeOnlineFromDom() {
        for (const key of ['__NUXT__', '__INITIAL_STATE__', '__NEXT_DATA__']) {
            try {
                const w = window[key];
                const n = shallowFindOnlineInObject(w, 220);
                if (n) return n;
            } catch (_) { }
        }
        for (const s of document.querySelectorAll('script:not([src])')) {
            const t = s.textContent || '';
            if (t.length < 20 || t.length > 400000) continue;
            const jm = t.match(/"(?:online|onlineCount|usersOnline|totalOnline)"\s*:\s*(\d+)/i)
                || t.match(/online["']?\s*[:=]\s*(\d+)/i);
            if (jm) {
                const f = packOnlineDigits(jm[1]);
                if (f) return f;
            }
        }

        const roots = [
            document.body,
            document.documentElement,
            document.querySelector('#app'),
            document.querySelector('[data-v-app]'),
            document.querySelector('main')
        ].filter(Boolean);
        const txt = roots.map((r) => r.innerText || '').join('\n');
        return extractOnlineFromTextBlob(txt);
    }

    function scrapeSiteOnlineCount() {
        const dom = scrapeOnlineFromDom();
        if (dom) return dom;
        return lastOnlineFromNetwork;
    }

    async function refreshOnlineFromFetchedPage() {
        if (onlineFetchBusy) return;
        onlineFetchBusy = true;
        const host = (typeof location !== 'undefined' && location.hostname)
            ? (location.hostname === 'www.nekto.me' ? 'https://www.nekto.me' : 'https://nekto.me')
            : 'https://nekto.me';
        const stamp = Date.now();
        const urls = [
            host + '/audiochat?_nkto=' + stamp,
            host + '/audiochat/?_nkto=' + stamp,
            'https://nekto.me/audiochat?_nkto=' + stamp,
            'https://www.nekto.me/audiochat?_nkto=' + stamp
        ];
        try {
            let html = '';
            for (const url of urls) {
                try {
                    html = await extFetchNektoHtml(url);
                } catch (_) {
                    html = '';
                }
                if (html && html.length >= 80) break;
            }
            if (!html || html.length < 80) {
                for (const url of urls) {
                    try {
                        const r = await fetch(url, {
                            credentials: 'include',
                            cache: 'no-store',
                            headers: { Accept: 'text/html,application/xhtml+xml' }
                        });
                        if (r.ok) {
                            html = await r.text();
                            if (html && html.length >= 80) break;
                        } else {
                            onlineFetchBackoffMs = Math.min(ONLINE_BACKOFF_CAP_MS, onlineFetchBackoffMs + 20000);
                        }
                    } catch (_) {
                        onlineFetchBackoffMs = Math.min(ONLINE_BACKOFF_CAP_MS, onlineFetchBackoffMs + 25000);
                    }
                }
            }
            if (html && html.length >= 80) {
                const n = extractOnlineFromTextBlob(html);
                if (n) {
                    lastOnlineFromNetwork = n;
                    onlineFetchBackoffMs = Math.max(0, onlineFetchBackoffMs - 15000);
                }
            } else if (!html) {
                onlineFetchBackoffMs = Math.min(ONLINE_BACKOFF_CAP_MS, onlineFetchBackoffMs + 12000);
            }
        } catch (_) {
            onlineFetchBackoffMs = Math.min(ONLINE_BACKOFF_CAP_MS, onlineFetchBackoffMs + 25000);
        }
        onlineFetchBusy = false;
    }

    function updateMetaHints() {
        const onlineEl = document.getElementById('ping-online-val');
        try {
            if (window.nektoOnlineLiveWS) {
                if (onlineEl) onlineEl.textContent = window.nektoOnlineLiveWS;
                return;
            }
            const n = scrapeSiteOnlineCount();
            if (onlineEl) onlineEl.textContent = n || '—';
        } catch (_) { }
    }

    function scheduleNextOnlineMetaTick() {
        if (onlineMetaTimer) clearTimeout(onlineMetaTimer);
        const delay = ONLINE_META_MIN_MS + Math.random() * ONLINE_META_JITTER_MS + onlineFetchBackoffMs;
        onlineMetaTimer = setTimeout(() => {
            void refreshOnlineFromFetchedPage().finally(() => {
                updateMetaHints();
                scheduleNextOnlineMetaTick();
            });
        }, delay);
    }

    function startSiteMetaWatcher() {
        if (onlineMetaTimer) clearTimeout(onlineMetaTimer);
        updateMetaHints();
        void refreshOnlineFromFetchedPage().finally(() => {
            updateMetaHints();
            scheduleNextOnlineMetaTick();
        });
    }


    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');
            #nekto-panel {
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 999999;
                width: 270px;
                font-family: 'Share Tech Mono', monospace;
                user-select: none;
                -webkit-user-select: none;
                color-scheme: dark;
                opacity: 0;
                transform: translateY(-14px) scale(0.97);
                pointer-events: none;
                transition: opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1), transform 0.6s cubic-bezier(0.22, 1, 0.36, 1);
                --nk-inner-bg-a: #000000;
                --nk-inner-bg-b: #000000;
                --nk-border: rgba(255,0,122,0.35);
                --nk-inset-pink: rgba(255,0,122,0.03);
                --nk-inset-cyan: rgba(0,229,255,0.06);
                --nk-header-border: rgba(255,0,122,0.18);
                --nk-header-bg: rgba(255,0,122,0.04);
                --nk-logo-a: #ff007a;
                --nk-logo-b: #00e5ff;
                --nk-logo-filter: drop-shadow(0 0 8px rgba(255,0,122,0.55));
                --nk-version: rgba(0,229,255,0.52);
                --nk-collapse-br: rgba(255,0,122,0.32);
                --nk-collapse-bg: rgba(255,0,122,0.09);
                --nk-collapse-fg: #ff007a;
                --nk-ping-row-bg: rgba(0,229,255,0.05);
                --nk-ping-row-bd: rgba(0,229,255,0.14);
                --nk-ping-good: #00ff9d;
                --nk-ping-warn: #ffcc00;
                --nk-ping-orange: #ff7700;
                --nk-ping-bad: #ff3355;
                --nk-ping-label: rgba(255,255,255,0.34);
                --nk-stat-line-a: #00ff9d;
                --nk-stat-line-b: #00e5ff;
                --nk-stat-a: #00ff9d;
                --nk-stat-b: #00e5ff;
                --nk-stat-glow-a: rgba(0,255,157,0.45);
                --nk-stat-glow-b: rgba(0,229,255,0.45);
                --nk-label: rgba(255,255,255,0.32);
                --nk-card-bg: rgba(255,255,255,0.035);
                --nk-card-bd: rgba(255,255,255,0.08);
                --nk-vu-bg: rgba(0,0,0,0.32);
                --nk-vu-bd: rgba(255,255,255,0.07);
                --nk-vu-idle: rgba(255,255,255,0.06);
                --nk-vu-bar-inactive-op: 0.08;
                --nk-text: rgba(255,255,255,0.78);
                --nk-row-hover: rgba(255,255,255,0.045);
                --nk-toggle-bg: rgba(255,255,255,0.11);
                --nk-toggle-bd: rgba(255,255,255,0.09);
                --nk-toggle-on: #ff007a;
                --nk-slider-val: rgba(255,0,122,0.92);
                --nk-slider-sub: rgba(255,255,255,0.32);
                --nk-slider-wrap-bg: rgba(0,0,0,0.22);
                --nk-accent-range: #ff007a;
                --nk-glow-a: rgba(255,0,122,0.55);
                --nk-glow-b: rgba(0,229,255,0.55);
                --nk-divider: rgba(255,255,255,0.09);
                --nk-scan: rgba(255,255,255,0.014);
                --nk-shadow: rgba(0,0,0,0.82);
                --nk-ctrl-a1: #00ff9d;
                --nk-ctrl-a2: #00cc7a;
                --nk-ctrl-mic-1: #00ff9d;
                --nk-ctrl-mic-2: #00c853;
                --nk-ctrl-hp-1: #00e5ff;
                --nk-ctrl-hp-2: #0091ea;
                --nk-mute-1: #ff4d4d;
                --nk-mute-2: #cc2222;
                --nk-drop-bg: rgba(255,51,85,0.14);
                --nk-drop-bd: rgba(255,51,85,0.42);
                --nk-drop-txt: #ff3355;
                --nk-meta: rgba(255,255,255,0.36);
                --nk-theme-bg: rgba(0,0,0,0.28);
                --nk-theme-fg: rgba(255,255,255,0.88);
                --nk-theme-bd: rgba(255,255,255,0.12);
                --nk-pitch-norm: #00ff9d;
                --nk-pitch-low: #00e5ff;
                --nk-pitch-high: #ff007a;
                --nk-select-opt-bg: #14141a;
                --nk-select-opt-fg: #e8eaef;
            }

            /* ═══ TOAST NOTIFICATIONS ═══ */
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
            #nk-toast-container {
                position: fixed;
                bottom: 28px;
                right: 28px;
                z-index: 1000000;
                display: flex;
                flex-direction: column-reverse;
                gap: 12px;
                pointer-events: none;
                user-select: none;
                -webkit-user-select: none;
                --nk-inner-bg-a: #000000 !important;
                --nk-inner-bg-b: #000000 !important;
                --nk-border: rgba(255,0,122,0.35);
                --nk-inset-pink: rgba(255,0,122,0.03);
                --nk-inset-cyan: rgba(0,229,255,0.06);
                --nk-header-border: rgba(255,0,122,0.18);
                --nk-header-bg: rgba(255,0,122,0.04);
                --nk-logo-a: #ff007a;
                --nk-logo-b: #00e5ff;
                --nk-logo-filter: drop-shadow(0 0 8px rgba(255,0,122,0.55));
                --nk-version: rgba(0,229,255,0.52);
                --nk-collapse-br: rgba(255,0,122,0.32);
                --nk-collapse-bg: rgba(255,0,122,0.09);
                --nk-collapse-fg: #ff007a;
                --nk-ping-row-bg: rgba(0,229,255,0.05);
                --nk-ping-row-bd: rgba(0,229,255,0.14);
                --nk-ping-good: #00ff9d;
                --nk-ping-warn: #ffcc00;
                --nk-ping-orange: #ff7700;
                --nk-ping-bad: #ff3355;
                --nk-ping-label: rgba(255,255,255,0.34);
                --nk-stat-line-a: #00ff9d;
                --nk-stat-line-b: #00e5ff;
                --nk-stat-a: #00ff9d;
                --nk-stat-b: #00e5ff;
                --nk-stat-glow-a: rgba(0,255,157,0.45);
                --nk-stat-glow-b: rgba(0,229,255,0.45);
                --nk-label: rgba(255,255,255,0.32);
                --nk-card-bg: rgba(255,255,255,0.035);
                --nk-card-bd: rgba(255,255,255,0.08);
                --nk-vu-bg: rgba(0,0,0,0.32);
                --nk-vu-bd: rgba(255,255,255,0.07);
                --nk-vu-idle: rgba(255,255,255,0.06);
                --nk-vu-bar-inactive-op: 0.08;
                --nk-text: rgba(255,255,255,0.78);
                --nk-row-hover: rgba(255,255,255,0.045);
                --nk-toggle-bg: rgba(255,255,255,0.11);
                --nk-toggle-bd: rgba(255,255,255,0.09);
                --nk-toggle-on: #ff007a;
                --nk-slider-val: rgba(255,0,122,0.92);
                --nk-slider-sub: rgba(255,255,255,0.32);
                --nk-slider-wrap-bg: rgba(0,0,0,0.22);
                --nk-accent-range: #ff007a;
                --nk-glow-a: rgba(255,0,122,0.55);
                --nk-glow-b: rgba(0,229,255,0.55);
                --nk-divider: rgba(255,255,255,0.09);
                --nk-scan: rgba(255,255,255,0.014);
                --nk-shadow: rgba(0,0,0,0.82);
                --nk-ctrl-a1: #00ff9d;
                --nk-ctrl-a2: #00cc7a;
                --nk-ctrl-mic-1: #00ff9d;
                --nk-ctrl-mic-2: #00c853;
                --nk-ctrl-hp-1: #00e5ff;
                --nk-ctrl-hp-2: #0091ea;
                --nk-mute-1: #ff4d4d;
                --nk-mute-2: #cc2222;
                --nk-drop-bg: rgba(255,51,85,0.14);
                --nk-drop-bd: rgba(255,51,85,0.42);
                --nk-drop-txt: #ff3355;
                --nk-meta: rgba(255,255,255,0.36);
                --nk-theme-bg: rgba(0,0,0,0.28);
                --nk-theme-fg: rgba(255,255,255,0.88);
                --nk-theme-bd: rgba(255,255,255,0.12);
                --nk-pitch-norm: #00ff9d;
                --nk-pitch-low: #00e5ff;
                --nk-pitch-high: #ff007a;
                --nk-select-opt-bg: #14141a;
                --nk-select-opt-fg: #e8eaef;
            }
            #nekto-panel.nk-panel-visible {
                opacity: 1;
                transform: none;
                pointer-events: auto;
            }
            #nekto-panel * { box-sizing: border-box; }
            #nekto-inner {
                position: relative;
                background: linear-gradient(155deg, var(--nk-inner-bg-a) 0%, var(--nk-inner-bg-b) 55%, rgba(12,14,28,0.92) 100%);
                border: 1px solid var(--nk-border);
                border-radius: 20px;
                overflow: hidden;
                box-shadow:
                    0 0 0 1px var(--nk-inset-cyan),
                    0 16px 48px var(--nk-shadow),
                    inset 0 1px 0 rgba(255,255,255,0.06),
                    inset 0 0 56px var(--nk-inset-pink);
            }
            #nekto-inner::before {
                content: '';
                position: absolute;
                inset: 0;
                background: repeating-linear-gradient(0deg, var(--nk-scan) 0px, var(--nk-scan) 1px, transparent 1px, transparent 3px);
                pointer-events: none;
                z-index: 0;
            }
            #nekto-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 16px 12px;
                cursor: grab;
                border-bottom: 1px solid var(--nk-header-border);
                background: var(--nk-header-bg);
                position: relative;
                z-index: 1;
            }
            #nekto-header:active { cursor: grabbing; }
            .nekto-logo {
                font-family: 'Orbitron', sans-serif;
                font-weight: 900;
                font-size: 15px;
                letter-spacing: 4px;
                background: linear-gradient(100deg, var(--nk-logo-a), var(--nk-logo-b), var(--nk-logo-a));
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
                filter: var(--nk-logo-filter);
            }
            .nekto-version {
                font-size: 9px;
                color: var(--nk-version);
                letter-spacing: 1.5px;
                margin-top: 2px;
            }
            .nekto-header-actions {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .nekto-contact-btn {
                width: 28px;
                height: 28px;
                border-radius: 8px;
                border: 1px solid var(--nk-collapse-br);
                background: var(--nk-collapse-bg);
                color: var(--nk-collapse-fg);
                font-size: 13px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                text-decoration: none;
                flex-shrink: 0;
            }
            .nekto-contact-btn:hover { opacity: 0.8; }
            .nk-rec-row, .nk-rec-auto-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 5px 10px;
                margin-top: 4px;
                background: rgba(255,255,255,0.03);
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.06);
                transition: border-color 0.3s, background 0.3s;
            }
            .nk-rec-row.nk-rec-active {
                border-color: rgba(255,51,85,0.35);
                background: rgba(255,51,85,0.06);
            }
            .nk-rec-label {
                flex: 1;
                font-size: 10px;
                letter-spacing: 0.6px;
                text-transform: uppercase;
                color: rgba(255,255,255,0.35);
                font-family: system-ui, sans-serif;
            }
            .nk-rec-timer {
                font-size: 11px;
                font-family: 'Orbitron', monospace;
                font-weight: 700;
                color: #ff3355;
                letter-spacing: 1px;
                animation: nk-rec-pulse 1.2s ease-in-out infinite;
            }
            .nk-rec-main-btn, .nk-rec-stop-btn {
                background: none;
                border: none;
                cursor: pointer;
                font-size: 14px;
                padding: 2px 3px;
                border-radius: 5px;
                color: rgba(255,255,255,0.45);
                transition: color 0.2s, background 0.2s;
                line-height: 1;
                flex-shrink: 0;
            }
            .nk-rec-main-btn:hover { color: rgba(255,255,255,0.9); background: rgba(255,255,255,0.08); }
            .nk-rec-main-btn.nk-rec-recording { color: #ff3355; animation: nk-rec-pulse 1.2s ease-in-out infinite; }
            .nk-rec-main-btn.nk-rec-paused { color: #ffaa00; }
            .nk-rec-stop-btn { color: rgba(255,80,80,0.55); }
            .nk-rec-stop-btn:hover { color: #ff3355; background: rgba(255,50,50,0.12); }
            @keyframes nk-rec-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.4; }
            }
            #collapse-btn {
                width: 28px;
                height: 28px;
                border-radius: 8px;
                border: 1px solid var(--nk-collapse-br);
                background: var(--nk-collapse-bg);
                color: var(--nk-collapse-fg);
                font-size: 11px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }
            #nekto-body {
                max-height: 80vh;
                overflow-x: hidden;
                overflow-y: auto;
                scrollbar-width: none;
                -ms-overflow-style: none;
                transition: max-height 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.2s ease;
                position: relative;
                z-index: 1;
            }
            #nekto-body::-webkit-scrollbar { display: none; }
            #nekto-body.collapsed {
                max-height: 0 !important;
                overflow: hidden;
                opacity: 0;
            }
            #nekto-content {
                padding: 12px 14px 8px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .stats-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
            }
            .stat-card {
                background: var(--nk-card-bg);
                border: 1px solid var(--nk-card-bd);
                border-radius: 11px;
                padding: 8px 10px;
                text-align: center;
            }
            .stat-card.interactive { cursor: pointer; }
            .stat-card.interactive:hover { background: var(--nk-row-hover); }
            .stat-label {
                font-size: 9px;
                color: var(--nk-label);
                letter-spacing: 0.8px;
                text-transform: uppercase;
                margin-bottom: 3px;
            }
            .stat-val {
                font-size: 15px;
                font-weight: bold;
                color: var(--nk-stat-a);
                font-family: 'Orbitron', sans-serif;
                text-shadow: 0 0 8px var(--nk-stat-glow-a);
            }
            #drop-alert {
                display: none;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 8px 12px;
                background: var(--nk-drop-bg);
                border: 1px solid var(--nk-drop-bd);
                border-radius: 10px;
                color: var(--nk-drop-txt);
                font-size: 11px;
                letter-spacing: 0.5px;
            }
            .vu-wrap {
                background: var(--nk-vu-bg);
                border: 1px solid var(--nk-vu-bd);
                border-radius: 10px;
                padding: 6px 8px;
                height: 36px;
                display: flex;
                align-items: center;
            }
            .vu-bars {
                display: flex;
                align-items: center;
                gap: 2px;
                width: 100%;
                height: 100%;
            }
            .vu-bar {
                flex: 1;
                border-radius: 2px;
                background: var(--nk-logo-b);
                opacity: 0.08;
                transition: none;
            }
            .ctrl-row {
                display: flex;
                gap: 8px;
                justify-content: center;
            }
            .ctrl-btn {
                flex: 1;
                padding: 8px 4px;
                border-radius: 12px;
                border: none;
                background: linear-gradient(145deg, var(--nk-ctrl-a1), var(--nk-ctrl-a2));
                color: #0a1a0a;
                font-size: 16px;
                cursor: pointer;
                transition: opacity 0.15s, transform 0.1s;
                box-shadow: 0 2px 8px rgba(235, 235, 235, 0.3);
            }
            .ctrl-btn:hover { opacity: 0.85; transform: translateY(-1px); }
            .ctrl-btn:active { transform: translateY(0); }
            .ctrl-btn.muted {
                background: linear-gradient(145deg, var(--nk-mute-1), var(--nk-mute-2));
                box-shadow: 0 2px 8px rgba(255,77,77,0.35);
            }
            .panel-divider {
                height: 1px;
                background: var(--nk-divider);
                margin: 2px 0;
            }
            .panel-glow-line {
                height: 2px;
                background: linear-gradient(90deg, transparent, var(--nk-logo-a), var(--nk-logo-b), transparent);
                opacity: 0.4;
            }
            .toggle-list {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .toggle-wrap {
                border-radius: 12px;
            }
            .nk-toggle-card {
                background: var(--nk-card-bg);
                border: 1px solid var(--nk-card-bd);
                padding: 8px 12px;
            }
            .toggle-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                cursor: pointer;
                font-size: 12px;
                color: var(--nk-text);
                gap: 8px;
            }
            .toggle-row:hover { color: #fff; }
            .nk-toggle {
                width: 36px;
                height: 20px;
                border-radius: 10px;
                background: var(--nk-toggle-bg);
                border: 1px solid var(--nk-toggle-bd);
                position: relative;
                flex-shrink: 0;
                transition: background 0.2s;
                cursor: pointer;
            }
            .nk-toggle.on { background: var(--nk-toggle-on); border-color: var(--nk-toggle-on); }
            .nk-dot {
                position: absolute;
                width: 14px;
                height: 14px;
                border-radius: 50%;
                background: #fff;
                top: 2px;
                left: 2px;
                transition: left 0.2s;
                box-shadow: 0 1px 4px rgba(0,0,0,0.4);
            }
            .nk-toggle.on .nk-dot { left: 18px; }
            .nk-slider-row {
                display: flex;
                flex-direction: column;
                gap: 4px;
                padding-top: 6px;
            }
            .nk-slider-label {
                display: flex;
                justify-content: space-between;
                font-size: 10px;
                color: var(--nk-slider-sub);
            }
            .nk-slider-val { color: var(--nk-slider-val); font-weight: bold; }
            input[type=range].nk-range {
                width: 100%;
                height: 4px;
                border-radius: 2px;
                background: var(--nk-slider-wrap-bg);
                accent-color: var(--nk-accent-range);
                cursor: pointer;
            }
            .nekto-theme-panel {
                display: flex;
                align-items: center;
                justify-content: space-between;
                font-size: 11px;
                color: var(--nk-theme-fg);
                padding: 6px 0 4px;
            }
            .nekto-theme-panel-label { opacity: 0.7; }
            .nekto-theme-panel-select {
                background: var(--nk-theme-bg);
                color: var(--nk-theme-fg);
                border: 1px solid var(--nk-theme-bd);
                border-radius: 8px;
                padding: 4px 8px;
                font-size: 11px;
                cursor: pointer;
                font-family: inherit;
            }
            .nekto-theme-panel-select option {
                background: var(--nk-select-opt-bg);
                color: var(--nk-select-opt-fg);
            }
            .nk-stats-detail-wrap {
                padding-top: 4px;
            }
            .nk-stats-detail-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
            }
            .nekto-reset-stats {
                grid-column: 1 / -1;
                padding: 6px;
                border-radius: 8px;
                border: 1px solid rgba(255,51,85,0.3);
                background: rgba(255,51,85,0.1);
                color: #ff3355;
                font-size: 10px;
                cursor: pointer;
                font-family: inherit;
            }
            .nekto-reset-stats:hover { background: rgba(255,51,85,0.2); }
            .ping-label {
                font-size: 9px;
                color: var(--nk-ping-label);
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .ping-online-val {
                font-size: 15px;
                font-weight: bold;
                font-family: 'Orbitron', sans-serif;
                color: var(--nk-stat-a);
            }
            #ping-val {
                font-size: 14px;
                font-weight: bold;
                font-family: 'Orbitron', sans-serif;
                color: var(--nk-ping-good);
            }
            .nk-online-dot-core {
                display: inline-block;
                border-radius: 50%;
                background: var(--nk-logo-b);
            }
            /* Theme overrides */
            #nekto-panel[data-theme="light"] { color-scheme: light; }
            #nekto-panel[data-theme="light"] #nekto-inner {
                background: linear-gradient(155deg, rgba(248,250,255,0.98), rgba(235,242,255,0.97));
                border-color: rgba(99,102,241,0.3);
                box-shadow: 0 16px 48px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.9);
            }
            #nekto-panel[data-theme="light"] .stat-card {
                background: rgba(255,255,255,0.7);
                border-color: rgba(99,102,241,0.15);
            }
            #nekto-panel[data-theme="light"] .toggle-row { color: #1e1e3a; }
            #nekto-panel[data-theme="light"] .nk-toggle { background: rgba(0,0,0,0.12); border-color: rgba(0,0,0,0.15); }
            .nk-toast {
                pointer-events: auto;
                display: flex;
                align-items: center;
                gap: 14px;
                min-width: 300px;
                max-width: 420px;
                padding: 16px 20px;
                border-radius: 18px;
                background: linear-gradient(135deg, var(--nk-inner-bg-a), var(--nk-inner-bg-b)) !important;
                border: 1px solid var(--nk-border) !important;
                box-shadow:
                    0 12px 40px var(--nk-shadow),
                    0 0 20px var(--nk-glow-a),
                    inset 0 1px 0 rgba(255,255,255,0.08) !important;
                color: var(--nk-text) !important;
                cursor: pointer;
                transform: translateX(120%) scale(0.92);
                opacity: 0;
                transition: transform 0.5s cubic-bezier(0.16,1,0.3,1), opacity 0.4s ease;
                backdrop-filter: blur(24px) saturate(180%);
                -webkit-backdrop-filter: blur(24px) saturate(180%);
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            }
            .nk-toast-show {
                transform: translateX(0) scale(1);
                opacity: 1;
            }
            .nk-toast-hide {
                transform: translateX(120%) scale(0.92);
                opacity: 0;
                transition: transform 0.35s cubic-bezier(0.55,0,1,0.45), opacity 0.25s ease;
            }
            .nk-toast-icon {
                font-size: 28px;
                flex-shrink: 0;
                width: 42px;
                height: 42px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 12px;
                background: var(--nk-card-bg) !important;
                border: 1px solid var(--nk-card-bd) !important;
            }
            .nk-toast-body { flex: 1; min-width: 0; }
            .nk-toast-brand {
                font-family: 'Orbitron', 'Inter', sans-serif;
                font-size: 9px;
                font-weight: 600;
                letter-spacing: 2.5px;
                text-transform: uppercase;
                background: linear-gradient(90deg, var(--nk-logo-a), var(--nk-logo-b)) !important;
                -webkit-background-clip: text !important;
                -webkit-text-fill-color: transparent !important;
                background-clip: text !important;
                margin-bottom: 4px;
            }
            .nk-toast-text {
                font-size: 13.5px;
                font-weight: 500;
                line-height: 1.45;
                letter-spacing: 0.2px;
                color: var(--nk-text) !important;
            }
            /* ══ Type-specific glow ══ */
            .nk-toast-info {
                border-color: rgba(100,180,255,0.32) !important;
                box-shadow: 0 12px 40px var(--nk-shadow), 0 0 20px rgba(100,180,255,0.12), inset 0 1px 0 rgba(255,255,255,0.08) !important;
            }
            .nk-toast-info .nk-toast-icon { background: rgba(100,180,255,0.1) !important; border-color: rgba(100,180,255,0.15) !important; }
            .nk-toast-time {
                border-color: var(--nk-logo-b) !important;
                box-shadow: 0 12px 40px var(--nk-shadow), 0 0 24px var(--nk-glow-b), inset 0 1px 0 rgba(255,255,255,0.08) !important;
            }
            .nk-toast-time .nk-toast-icon { background: var(--nk-card-bg) !important; border-color: var(--nk-logo-b) !important; color: var(--nk-logo-b) !important; }
            .nk-toast-time .nk-toast-text { color: var(--nk-logo-b) !important; }
            .nk-toast-skip {
                border-color: var(--nk-logo-b) !important;
                box-shadow: 0 12px 40px var(--nk-shadow), 0 0 24px var(--nk-glow-b), inset 0 1px 0 rgba(255,255,255,0.08) !important;
            }
            .nk-toast-skip .nk-toast-icon { background: var(--nk-card-bg) !important; border-color: var(--nk-logo-b) !important; color: var(--nk-logo-b) !important; }
            .nk-toast-search {
                border-color: var(--nk-logo-a) !important;
                box-shadow: 0 12px 40px var(--nk-shadow), 0 0 20px var(--nk-glow-a), inset 0 1px 0 rgba(255,255,255,0.08) !important;
            }
            .nk-toast-search .nk-toast-icon { background: var(--nk-card-bg) !important; border-color: var(--nk-logo-a) !important; color: var(--nk-logo-a) !important; }
            .nk-toast-success {
                border-color: rgba(0,255,157,0.32) !important;
                box-shadow: 0 12px 40px var(--nk-shadow), 0 0 20px rgba(0,255,157,0.12), inset 0 1px 0 rgba(255,255,255,0.08) !important;
            }
            .nk-toast-success .nk-toast-icon { background: rgba(0,255,157,0.1) !important; border-color: rgba(0,255,157,0.18) !important; }
            .nk-toast-warn {
                border-color: rgba(255,190,50,0.35) !important;
                box-shadow: 0 12px 40px var(--nk-shadow), 0 0 20px rgba(255,190,50,0.12), inset 0 1px 0 rgba(255,255,255,0.08) !important;
            }
            .nk-toast-warn .nk-toast-icon { background: rgba(255,190,50,0.1) !important; border-color: rgba(255,190,50,0.18) !important; }
            .nk-toast-warn .nk-toast-text { color: rgba(255,220,120,0.95) !important; }

            /* ═══ DETAILED STATS PANEL ═══ */
            .nk-stats-detail-btn {
                grid-column: 1 / -1;
                margin-top: 2px;
                padding: 4px 0;
                background: transparent;
                border: none;
                color: var(--nk-label);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .nk-stats-detail-btn svg {
                opacity: 0.5;
                transition: transform 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.2s ease, stroke 0.2s;
            }
            .nk-stats-detail-btn:hover svg {
                opacity: 1;
                stroke: var(--nk-logo-a);
            }
            .nk-stats-detail-wrap {
                grid-column: 1 / -1;
                overflow: hidden;
                max-height: 0;
                opacity: 0;
                transition: max-height 0.4s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease, margin 0.3s ease;
                margin-top: 0;
            }
            .nk-stats-detail-wrap.nk-stats-open {
                max-height: 300px;
                opacity: 1;
                margin-top: 6px;
            }
            .nk-stats-detail-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
            }
            .nk-stats-detail-grid .stat-card::after {
                background: linear-gradient(90deg, transparent, var(--nk-stat-line-a), transparent);
            }
            .nk-stats-detail-grid .stat-card:nth-child(even)::after {
                background: linear-gradient(90deg, transparent, var(--nk-stat-line-b), transparent);
            }
            .nk-stats-detail-grid .stat-val {
                font-size: 13px;
            }

            /* ═══ HOTKEY BIND UI ═══ */
            .nk-hotkey-card {
                border-radius: 22px;
                border: 1px solid var(--nk-card-bd);
                background: var(--nk-card-bg);
                overflow: hidden;
                padding: 9px 12px;
            }
            .nk-hotkey-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
            }
            .nk-hotkey-label {
                font-size: 11px;
                color: var(--nk-text);
                letter-spacing: 0.3px;
            }
            .nk-hotkey-btn {
                padding: 5px 14px;
                border-radius: 8px;
                border: 1px solid var(--nk-collapse-br);
                background: var(--nk-collapse-bg);
                color: var(--nk-collapse-fg);
                font-family: 'Orbitron', sans-serif;
                font-size: 10px;
                letter-spacing: 1px;
                cursor: pointer;
                transition: all 0.2s;
                min-width: 50px;
                text-align: center;
            }
            .nk-hotkey-btn:hover {
                box-shadow: 0 0 10px var(--nk-glow-a);
            }
            .nk-hotkey-btn.nk-hotkey-listening {
                animation: nkHotkeyPulse 1s ease-in-out infinite;
                border-color: var(--nk-toggle-on);
                color: var(--nk-toggle-on);
            }
            @keyframes nkHotkeyPulse {
                0%, 100% { box-shadow: 0 0 6px var(--nk-glow-a); }
                50% { box-shadow: 0 0 18px var(--nk-glow-a); }
            }
            .nk-hotkey-hint {
                font-size: 7px;
                color: var(--nk-meta);
                margin-top: 6px;
                line-height: 1.4;
                letter-spacing: 0.2px;
            }

            /* ═══ WAKE WORDS PANEL ═══ */
            .nk-ww-card {
                background: var(--nk-card-bg);
                border: 1px solid var(--nk-card-bd);
                border-radius: 12px;
                overflow: hidden;
            }
            .nk-ww-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                cursor: pointer;
                font-size: 11px;
                color: var(--nk-text);
                user-select: none;
                gap: 6px;
            }
            .nk-ww-header:hover { color: #fff; }
            .nk-ww-chevron {
                font-size: 9px;
                opacity: 0.5;
                transition: transform 0.22s ease;
                flex-shrink: 0;
            }
            .nk-ww-card.open .nk-ww-chevron { transform: rotate(180deg); }
            .nk-ww-body {
                display: none;
                padding: 0 12px 10px;
                flex-direction: column;
                gap: 10px;
            }
            .nk-ww-card.open .nk-ww-body { display: flex; }
            .nk-ww-section-label {
                font-size: 9px;
                letter-spacing: 0.6px;
                text-transform: uppercase;
                color: var(--nk-logo-b, #00e5ff);
                opacity: 0.7;
                margin-bottom: 4px;
            }
            .nk-ww-chips {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                min-height: 20px;
            }
            .nk-ww-chip {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 3px 8px;
                border-radius: 20px;
                background: rgba(255,255,255,0.06);
                border: 1px solid var(--nk-card-bd);
                font-size: 11px;
                color: var(--nk-text);
                line-height: 1;
            }
            .nk-ww-chip-del {
                background: none;
                border: none;
                color: var(--nk-meta, rgba(255,255,255,0.35));
                cursor: pointer;
                padding: 0;
                font-size: 12px;
                line-height: 1;
                display: flex;
                align-items: center;
            }
            .nk-ww-chip-del:hover { color: #ff4b4b; }
            .nk-ww-input-row {
                display: flex;
                gap: 5px;
                margin-top: 4px;
            }
            .nk-ww-input {
                flex: 1;
                background: rgba(255,255,255,0.05);
                border: 1px solid var(--nk-card-bd);
                border-radius: 8px;
                padding: 5px 9px;
                font-size: 11px;
                color: var(--nk-text);
                outline: none;
                font-family: inherit;
            }
            .nk-ww-input::placeholder { color: var(--nk-meta, rgba(255,255,255,0.3)); }
            .nk-ww-input:focus { border-color: var(--nk-logo-b, #00e5ff); box-shadow: 0 0 6px var(--nk-glow-b, rgba(0,229,255,0.15)); }
            .nk-ww-add-btn {
                padding: 5px 10px;
                border-radius: 8px;
                background: rgba(0,229,255,0.1);
                border: 1px solid var(--nk-logo-b, #00e5ff);
                color: var(--nk-logo-b, #00e5ff);
                font-size: 11px;
                cursor: pointer;
                font-family: inherit;
                transition: background 0.15s;
            }
            .nk-ww-add-btn:hover { background: rgba(0,229,255,0.2); }
            .nk-ww-divider { height: 1px; background: var(--nk-card-bd); }

            /* ═══ MINIMALIST ONLINE COUNTER ═══ */
            .nk-online-dot-core {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: var(--nk-logo-b, #00e5ff);
                display: inline-block;
                box-shadow: 0 0 6px var(--nk-logo-b, #00e5ff);
                animation: nkPingPulse 1.4s infinite alternate;
                margin-right: 2px;
                vertical-align: middle;
            }
            @keyframes nkPingPulse {
                0% {
                    box-shadow: 0 0 2px var(--nk-logo-b, #00e5ff);
                    opacity: 0.65;
                }
                100% {
                    box-shadow: 0 0 8px var(--nk-logo-b, #00e5ff);
                    opacity: 1;
                }
            }
            --night-background-color: #121212 !important;

            /* AD BLOCKER SYSTEM */
            div[id^="yandex_rtb_"],
            .yandex-rtb,
            .yandex_rtb,
            div[class*="yandex-rtb"],
            div[class*="ya-rtb"],
            iframe[src*="yandex.ru/ads"],
            iframe[src*="an.yandex.ru"],
            iframe[src*="doubleclick.net"],
            iframe[src*="googleads"],
            div.audiochat__banner,
            div.audiochat__ads,
            div.ads-container,
            div.ads-wrapper,
            .banner-ad,
            .advertisement,
            .promo-block,
            #promo-block {
                display: none !important;
                visibility: hidden !important;
                height: 0 !important;
                width: 0 !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    function createSettingsUI() {
        injectStyles();

        const panel = document.createElement('div');
        panel.id = 'nekto-panel';
        panel.dataset.theme = settings.panelTheme;

        panel.innerHTML = `
            <div id="nekto-inner">
                <div id="nekto-header">
                    <div>
                        <div class="nekto-logo">NEKTOULTRA</div>
                        <div class="nekto-version">v 1.3.6</div>
                    </div>
                    <div class="nekto-header-actions">
                        <button id="collapse-btn" title="Свернуть">▲</button>
                    </div>
                </div>

                <div id="nekto-body">
                    <div id="nekto-content">

                        <div id="drop-alert">
                            <span class="drop-icon">⚡</span>
                            <span class="drop-text">Обнаружен обрыв соединения</span>
                        </div>
                        <div class="stats-grid" style="margin-bottom: 8px;">
                            <div class="stat-card">
                                <div class="stat-label">Разговоров</div>
                                <div class="stat-val" id="conv-count">${settings.conversationCount}</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-label">Общее время</div>
                                <div class="stat-val" id="total-time">${formatTotalTime(settings.totalConversationTime)}</div>
                            </div>
                            <div class="stat-card interactive" id="ping-toggle-btn" title="Техническая информация">
                                <div class="stat-label">Пинг</div>
                                <div class="stat-val" style="display:flex; justify-content:center; align-items:center; height: 19px;">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6; margin-top:1px;"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                                </div>
                            </div>
                            <div class="stat-card interactive" id="nk-stats-detail-btn" title="Расширенная статистика">
                                <div class="stat-label">Статистика</div>
                                <div class="stat-val" style="display:flex; justify-content:center; align-items:center; height: 19px;">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6; margin-top:1px;"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                                </div>
                            </div>

                            <!-- Network / Ping Panel -->
                            <div class="ping-row" id="nekto-ping-row" style="display: none; flex-direction: column; gap: 8px; padding: 10px 12px; grid-column: 1 / -1; background: var(--nk-slider-wrap-bg); border-radius: 11px;">
                                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                                    <div class="ping-ping-stack" style="text-align: left; display: flex; flex-direction: column; gap: 3px; flex: 1;">
                                        <span class="ping-label">Пинг</span>
                                        <span id="ping-val">—</span>
                                    </div>
                                    <div class="ping-split" aria-hidden="true" style="min-height: 28px; background: var(--nk-ping-row-bd); opacity: 0.65; width: 1px;"></div>
                                    <div class="ping-waiting-stack" style="text-align: center; display: flex; flex-direction: column; gap: 3px; flex: 1;">
                                        <span class="ping-label" style="text-align: center;">В очереди</span>
                                        <span id="ping-waiting-val" class="ping-online-val" style="color: var(--nk-stat-b); text-align: center;">—</span>
                                    </div>
                                    <div class="ping-split" aria-hidden="true" style="min-height: 28px; background: var(--nk-ping-row-bd); opacity: 0.65; width: 1px;"></div>
                                    <div class="ping-online-side" style="text-align: right; display: flex; flex-direction: column; gap: 3px; align-items: flex-end; flex: 1;">
                                        <span class="ping-online-label">Онлайн</span>
                                        <span id="ping-online-val" class="ping-online-val">—</span>
                                    </div>
                                </div>
                                
                                <!-- Divider line -->
                                <div style="width: 100%; height: 1px; background: var(--nk-divider, rgba(255,255,255,0.09)); margin: 2px 0;"></div>
                                
                                <!-- WebRTC P2P Stats Row -->
                                <div id="webrtc-stats-row" style="display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 2px 4px;">
                                    <div style="display: flex; align-items: center; gap: 5px;">
                                        <span style="font-size: 9px; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.5px;">P2P Пинг:</span>
                                        <span id="p2p-ping-val" style="font-size: 11px; color: var(--nk-logo-b); font-family: 'Orbitron', sans-serif; font-weight: bold; text-shadow: 0 0 5px var(--nk-glow-b);">—</span>
                                    </div>
                                    <div style="display: flex; align-items: center; gap: 5px;">
                                        <span style="font-size: 9px; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.5px;">Потеря пакетов:</span>
                                        <span id="p2p-loss-val" style="font-size: 11px; color: var(--nk-logo-b); font-family: 'Orbitron', sans-serif; font-weight: bold; text-shadow: 0 0 5px var(--nk-glow-b);">—</span>
                                    </div>
                                </div>
                                
                            </div>
                            <div class="nk-stats-detail-wrap" id="nk-stats-detail-wrap">
                                <div class="nk-stats-detail-grid">
                                    <div class="stat-card">
                                        <div class="stat-label">Среднее время</div>
                                        <div class="stat-val" id="nk-stat-avg" style="color:var(--nk-stat-a);font-size:13px">${getAverageConversation()}</div>
                                    </div>
                                    <div class="stat-card">
                                        <div class="stat-label">Рекорд</div>
                                        <div class="stat-val" id="nk-stat-longest" style="color:var(--nk-stat-b);font-size:13px">${formatDuration(settings.longestConversation)}</div>
                                    </div>
                                    <div class="stat-card">
                                        <div class="stat-label">Разговоров сегодня</div>
                                        <div class="stat-val" id="nk-stat-today" style="color:var(--nk-stat-a);font-size:13px">${settings.dailyStats.date === todayDateStr() ? settings.dailyStats.count : 0}</div>
                                    </div>
                                    <div class="stat-card">
                                        <div class="stat-label">Серия дней</div>
                                        <div class="stat-val" id="nk-stat-streak" style="color:var(--nk-stat-b);font-size:13px">0 д.</div>
                                    </div>
                                    <button type="button" class="nekto-reset-stats" id="nekto-reset-stats" title="Сбросить статистику">Сбросить статистику</button>
                                </div>
                            </div>
                        </div>

                        <div class="nk-rec-row" id="nk-rec-row">
                            <button id="nk-rec-btn" class="nk-rec-main-btn" title="Начать запись">⏺</button>
                            <span class="nk-rec-label" id="nk-rec-label">Запись звонка</span>
                            <span class="nk-rec-timer" id="nk-rec-timer" style="display:none"></span>
                            <button id="nk-rec-stop" class="nk-rec-stop-btn" title="Стоп и скачать" style="display:none">⏹</button>
                        </div>
                        <div class="nk-rec-auto-row">
                            <span class="nk-rec-label">Авто-запись</span>
                            <div class="nk-toggle${nkAutoRecord ? ' on' : ''}" id="nk-rec-toggle"><div class="nk-dot"></div></div>
                        </div>

                        <div class="vu-wrap">
                            <div class="vu-bars" id="vu-bars"></div>
                        </div>

                        <div class="ctrl-row">
                            <button id="mic-toggle" class="ctrl-btn active">🎤</button>
                            <button id="headphone-toggle" class="ctrl-btn active">🎧</button>
                        </div>

                        <div class="panel-divider"></div>

                        <div class="toggle-list" id="toggle-list"></div>

                        <div class="toggle-wrap nk-toggle-card" style="margin-top:4px">
                            <div class="toggle-row" style="cursor:default">
                                <span style="font-size:11px;color:var(--nk-text)">Оттенок</span>
                                <div style="display:flex;align-items:center;gap:8px;flex:1;justify-content:flex-end">
                                    <input type="range" id="nk-accent-slider" class="nk-range" min="0" max="360" value="331" style="width:100px">
                                    <span id="nk-accent-preview" style="width:16px;height:16px;border-radius:50%;border:2px solid var(--nk-card-bd);flex-shrink:0"></span>
                                </div>
                            </div>
                            <div class="nk-slider-row" style="margin-top:6px">
                                <div class="nk-slider-label">
                                    <span>Яркость</span>
                                    <span class="nk-slider-val" id="nk-light-val">55%</span>
                                </div>
                                <input type="range" id="nk-light-slider" class="nk-range" min="0" max="100" value="55">
                            </div>
                        </div>

                    </div>
                    <div class="panel-glow-line"></div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);
        applyPanelTheme(settings.panelTheme);
        window.setTimeout(() => panel.classList.add('nk-panel-visible'), 2500);



        const vuBarsEl = document.getElementById('vu-bars');
        for (let i = 0; i < 20; i++) {
            const bar = document.createElement('div');
            bar.className = 'vu-bar';
            bar.style.height = `${40 + Math.sin(i * 0.5) * 20}%`;
            vuBarsEl.appendChild(bar);
        }

        const recMainBtn = document.getElementById('nk-rec-btn');
        const recStopBtn = document.getElementById('nk-rec-stop');
        const recToggle = document.getElementById('nk-rec-toggle');
        if (recMainBtn) recMainBtn.addEventListener('click', (e) => { e.stopPropagation(); nkOnMainBtnClick(); });
        if (recStopBtn) recStopBtn.addEventListener('click', (e) => { e.stopPropagation(); nkStopManual(); });
        if (recToggle) {
            recToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                nkAutoRecord = !nkAutoRecord;
                localStorage.setItem('nkAutoRecord', JSON.stringify(nkAutoRecord));
                nkUpdateRecUI();
            });
        }

        const collapseBtn = document.getElementById('collapse-btn');
        const body = document.getElementById('nekto-body');
        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isPanelCollapsed = !isPanelCollapsed;
            body.classList.toggle('collapsed', isPanelCollapsed);
            collapseBtn.textContent = isPanelCollapsed ? '▼' : '▲';
        });

        const header = document.getElementById('nekto-header');
        let pos3 = 0, pos4 = 0;
        header.onmousedown = (e) => {
            if (e.target === collapseBtn || e.target.closest('.nekto-header-actions')) return;
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            panel.style.right = 'auto';
            panel.style.left = Math.round(rect.left) + 'px';
            panel.style.top = Math.round(rect.top) + 'px';
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = () => {
                document.onmouseup = document.onmousemove = null;
            };
            document.onmousemove = (ev) => {
                ev.preventDefault();
                const dx = pos3 - ev.clientX;
                const dy = pos4 - ev.clientY;
                pos3 = ev.clientX;
                pos4 = ev.clientY;
                panel.style.top = (panel.offsetTop - dy) + 'px';
                panel.style.left = (panel.offsetLeft - dx) + 'px';
            };
        };

        document.getElementById('mic-toggle').onclick = toggleMic;
        document.getElementById('headphone-toggle').onclick = toggleHeadphones;

        const resetStatsBtn = document.getElementById('nekto-reset-stats');
        if (resetStatsBtn) {
            resetStatsBtn.addEventListener('click', () => {
                settings.conversationCount = 0;
                settings.totalConversationTime = 0;
                settings.longestConversation = 0;
                settings.dailyStats = { date: '', count: 0 };
                settings.streakData = { lastDate: '', count: 0 };
                localStorage.setItem('longestConversation', '0');
                localStorage.setItem('dailyStats', JSON.stringify(settings.dailyStats));
                localStorage.setItem('streakData', JSON.stringify(settings.streakData));
                saveStats();
                const c = document.getElementById('conv-count');
                const t = document.getElementById('total-time');
                if (c) c.textContent = '0';
                if (t) t.textContent = formatTotalTime(0);
                refreshDetailedStatsUI();
                showNkToast('Статистика сброшена', 'warn', 2500);
            });
        }



        const detailBtn = document.getElementById('nk-stats-detail-btn');
        const detailWrap = document.getElementById('nk-stats-detail-wrap');
        if (detailBtn && detailWrap) {
            detailBtn.addEventListener('click', () => {
                const isOpen = detailWrap.classList.toggle('nk-stats-open');
                detailBtn.classList.toggle('active', isOpen);
                if (isOpen) refreshDetailedStatsUI();
            });
        }

        const pingToggleBtn = document.getElementById('ping-toggle-btn');
        const pingRow = document.getElementById('nekto-ping-row');
        let isPingOpen = false;
        if (pingToggleBtn && pingRow) {
            pingToggleBtn.addEventListener('click', () => {
                isPingOpen = !isPingOpen;
                pingRow.style.display = isPingOpen ? 'flex' : 'none';
                pingToggleBtn.classList.toggle('active', isPingOpen);
            });
        }

        buildToggles();

        const savedHue = (() => { try { const v = localStorage.getItem('nkAccentHue'); return v !== null ? parseInt(v, 10) : 331; } catch(_) { return 331; } })();
        const savedLight = (() => { try { const v = localStorage.getItem('nkAccentLight'); return v !== null ? parseInt(v, 10) : 55; } catch(_) { return 55; } })();
        const accentSlider = document.getElementById('nk-accent-slider');
        const lightSlider = document.getElementById('nk-light-slider');
        const lightVal = document.getElementById('nk-light-val');
        const updateAccent = () => {
            const h = parseInt(accentSlider.value, 10);
            const l = parseInt(lightSlider.value, 10);
            localStorage.setItem('nkAccentHue', String(h));
            localStorage.setItem('nkAccentLight', String(l));
            if (lightVal) lightVal.textContent = l + '%';
            applyAccentColor();
        };
        if (accentSlider) {
            accentSlider.value = String(savedHue);
            accentSlider.addEventListener('input', updateAccent);
        }
        if (lightSlider) {
            lightSlider.value = String(savedLight);
            lightSlider.addEventListener('input', updateAccent);
            if (lightVal) lightVal.textContent = savedLight + '%';
        }
        setTimeout(updateAccent, 50);
    }

    function buildToggles() {
        const list = document.getElementById('toggle-list');
        if (!list) return;

        const addToggle = (label, key, isAuto = false, sliderConfig = null) => {
            const wrap = document.createElement('div');
            wrap.className = 'toggle-wrap nk-toggle-card' + (sliderConfig ? ' has-slider' : '');

            const active = isAuto ? isAutoModeEnabled : settings[key];

            const row = document.createElement('div');
            row.className = 'toggle-row';
            const labelEl = document.createElement('span');
            labelEl.textContent = label;
            const toggleEl = document.createElement('div');
            toggleEl.className = 'nk-toggle' + (active ? ' on' : '');
            toggleEl.dataset.key = String(key);
            const dotEl = document.createElement('div');
            dotEl.className = 'nk-dot';
            toggleEl.appendChild(dotEl);
            row.appendChild(labelEl);
            row.appendChild(toggleEl);

            wrap.appendChild(row);

            let sliderWrap = null;
            if (sliderConfig) {
                sliderWrap = document.createElement('div');
                sliderWrap.className = 'slider-wrap' + (active ? ' visible' : '');
                const sub = document.createElement('div');
                sub.className = 'slider-sub';
                const sliderLabel = document.createElement('span');
                sliderLabel.className = 'nk-slider-label';
                sliderLabel.textContent = sliderConfig.label;
                const sliderVal = document.createElement('span');
                sliderVal.className = 'nk-slider-val';
                sliderVal.id = sliderConfig.valId;
                sliderVal.textContent = sliderConfig.current.toFixed(1);
                sub.appendChild(sliderLabel);
                sub.appendChild(sliderVal);
                const slider = document.createElement('input');
                slider.type = 'range';
                slider.id = sliderConfig.id;
                slider.min = String(sliderConfig.min);
                slider.max = String(sliderConfig.max);
                slider.step = String(sliderConfig.step);
                slider.value = String(sliderConfig.current);
                sliderWrap.appendChild(sub);
                sliderWrap.appendChild(slider);
                if (sliderConfig.id === 'pitch-slider') {
                    const dirRow = document.createElement('div');
                    dirRow.className = 'nekto-pitch-dir-row';
                    const dirLabel = document.createElement('span');
                    dirLabel.id = 'pitch-dir-label';
                    dirLabel.className = 'pitch-dir-norm';
                    dirLabel.textContent = 'НОРМ';
                    dirRow.appendChild(dirLabel);
                    sliderWrap.appendChild(dirRow);
                }
                wrap.appendChild(sliderWrap);

                setTimeout(() => {
                    const sl = document.getElementById(sliderConfig.id);
                    if (sl) sl.oninput = (e) => {
                        const v = parseFloat(e.target.value);
                        const el = document.getElementById(sliderConfig.valId);
                        if (el) el.textContent = v.toFixed(1);
                        sliderConfig.onChange(v);
                    };
                    if (sliderConfig.id === 'pitch-slider') {
                        const dir = document.getElementById('pitch-dir-label');
                        if (dir) {
                            const v = sliderConfig.current;
                            dir.classList.remove('pitch-dir-norm', 'pitch-dir-low', 'pitch-dir-high');
                            if (Math.abs(v - 1.0) < 0.03) { dir.textContent = 'НОРМ'; dir.classList.add('pitch-dir-norm'); }
                            else if (v < 1.0) { dir.textContent = v.toFixed(2); dir.classList.add('pitch-dir-low'); }
                            else { dir.textContent = v.toFixed(2); dir.classList.add('pitch-dir-high'); }
                        }
                    }
                }, 100);
            }

            const toggle = row.querySelector('.nk-toggle');
            const toastLabels = {
                null: ['Авто-скип включён', 'Авто-скип выключен']
            };
            row.onclick = () => {
                let newVal;
                if (isAuto) {
                    isAutoModeEnabled = !isAutoModeEnabled;
                    newVal = isAutoModeEnabled;
                    if (newVal) checkAndClickButton();
                } else {
                    settings[key] = !settings[key];
                    newVal = settings[key];
                    localStorage.setItem(key, JSON.stringify(newVal));
                }
                toggle.classList.toggle('on', newVal);
                if (sliderWrap) sliderWrap.classList.toggle('visible', newVal);
                const tl = toastLabels[isAuto ? null : key];
                if (tl) showNkToast(newVal ? tl[0] : tl[1], newVal ? 'success' : 'info', 2200);
            };

            list.appendChild(wrap);
        };

        addToggle('Авто-скип', null, true);

        const vsWrap = document.createElement('div');
        vsWrap.className = 'toggle-wrap nk-toggle-card';
        const vsRow = document.createElement('div');
        vsRow.className = 'toggle-row';
        const vsLabel = document.createElement('span');
        vsLabel.textContent = 'Голосовое управление';
        const vsToggle = document.createElement('div');
        vsToggle.className = 'nk-toggle' + (settings.voiceSkipEnabled ? ' on' : '');
        vsToggle.dataset.key = 'voiceSkipEnabled';
        const vsDot = document.createElement('div');
        vsDot.className = 'nk-dot';
        vsToggle.appendChild(vsDot);
        vsRow.appendChild(vsLabel);
        vsRow.appendChild(vsToggle);
        vsRow.addEventListener('click', () => {
            const newVal = !settings.voiceSkipEnabled;
            vsToggle.classList.toggle('on', newVal);
            if (window.nkSetVoiceSkipEnabled) window.nkSetVoiceSkipEnabled(newVal);
            else {
                settings.voiceSkipEnabled = newVal;
                localStorage.setItem('nkVoiceSkipEnabled', newVal ? '1' : '0');
            }
            showNkToast(newVal ? 'Голосовое управление включено' : 'Голосовое управление выключено', newVal ? 'success' : 'info', 2200);
        });
        vsWrap.appendChild(vsRow);
        list.appendChild(vsWrap);

        // ── Wake-words panel ──
        const WW_SKIP_KEY = 'nkSkipWords';
        const WW_MUTE_KEY = 'nkMuteWords';
        const WW_SKIP_DEF = ['скип', 'скипни', 'скипнуть', 'skip'];
        const WW_MUTE_DEF = ['мут', 'мьют'];

        function nkLoadWords(key, def) {
            try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : [...def]; } catch (_) { return [...def]; }
        }
        function nkSaveWords(key, arr) { localStorage.setItem(key, JSON.stringify(arr)); }

        // Expose live arrays for the voice pipeline
        window.nkSkipWords = nkLoadWords(WW_SKIP_KEY, WW_SKIP_DEF);
        window.nkMuteWords = nkLoadWords(WW_MUTE_KEY, WW_MUTE_DEF);

        const wwCard = document.createElement('div');
        wwCard.className = 'nk-ww-card';

        const wwHeader = document.createElement('div');
        wwHeader.className = 'nk-ww-header';
        wwHeader.innerHTML = `<span>🎙 Слова-триггеры</span><span class="nk-ww-chevron">▼</span>`;
        wwHeader.addEventListener('click', () => wwCard.classList.toggle('open'));
        wwCard.appendChild(wwHeader);

        const wwBody = document.createElement('div');
        wwBody.className = 'nk-ww-body';

        function nkBuildWordSection(labelText, storageKey, liveArr) {
            const wrap = document.createElement('div');

            const lbl = document.createElement('div');
            lbl.className = 'nk-ww-section-label';
            lbl.textContent = labelText;
            wrap.appendChild(lbl);

            const chips = document.createElement('div');
            chips.className = 'nk-ww-chips';
            wrap.appendChild(chips);

            function renderChips() {
                chips.innerHTML = '';
                liveArr.forEach((word, i) => {
                    const chip = document.createElement('span');
                    chip.className = 'nk-ww-chip';
                    chip.textContent = word;
                    const del = document.createElement('button');
                    del.className = 'nk-ww-chip-del';
                    del.title = 'Удалить';
                    del.textContent = '×';
                    del.addEventListener('click', (e) => {
                        e.stopPropagation();
                        liveArr.splice(i, 1);
                        nkSaveWords(storageKey, liveArr);
                        renderChips();
                    });
                    chip.appendChild(del);
                    chips.appendChild(chip);
                });
            }
            renderChips();

            const inputRow = document.createElement('div');
            inputRow.className = 'nk-ww-input-row';
            const input = document.createElement('input');
            input.className = 'nk-ww-input';
            input.type = 'text';
            input.placeholder = 'Новое слово...';
            const addBtn = document.createElement('button');
            addBtn.className = 'nk-ww-add-btn';
            addBtn.textContent = '+ Добавить';

            function addWord() {
                const w = input.value.trim().toLowerCase();
                if (!w || liveArr.includes(w)) { input.value = ''; return; }
                liveArr.push(w);
                nkSaveWords(storageKey, liveArr);
                input.value = '';
                renderChips();
                showNkToast(`Слово «${w}» добавлено`, 'success', 1800);
            }
            addBtn.addEventListener('click', addWord);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addWord(); } });

            inputRow.appendChild(input);
            inputRow.appendChild(addBtn);
            wrap.appendChild(inputRow);
            return wrap;
        }

        wwBody.appendChild(nkBuildWordSection('Скип-слова', WW_SKIP_KEY, window.nkSkipWords));

        const wwDiv = document.createElement('div');
        wwDiv.className = 'nk-ww-divider';
        wwBody.appendChild(wwDiv);

        wwBody.appendChild(nkBuildWordSection('Мут-слова', WW_MUTE_KEY, window.nkMuteWords));

        wwCard.appendChild(wwBody);
        list.appendChild(wwCard);

        const hotkeyCard = document.createElement('div');
        hotkeyCard.className = 'nk-hotkey-card';

        const skipRow = document.createElement('div');
        skipRow.className = 'nk-hotkey-row';
        const skipLabel = document.createElement('span');
        skipLabel.className = 'nk-hotkey-label';
        skipLabel.textContent = 'Скип / Поиск';
        const skipButton = document.createElement('button');
        skipButton.type = 'button';
        skipButton.className = 'nk-hotkey-btn';
        skipButton.id = 'nk-hotkey-btn-skip';
        skipButton.textContent = settings.skipKey.label;
        skipRow.appendChild(skipLabel);
        skipRow.appendChild(skipButton);

        const skipHint = document.createElement('div');
        skipHint.id = 'nk-hint-skip';
        skipHint.style.cssText = 'font-size: 9px; opacity: 0.75; margin-top: 5px; margin-bottom: 12px; text-align: left; line-height: 1.4; color: var(--nk-meta, rgba(255,255,255,0.45)); font-family: system-ui, sans-serif;';
        skipHint.innerHTML = `💡 Чтобы скипнуть собеседника вне вкладки, нажмите <b style="color:var(--nk-logo-b);text-shadow:0 0 4px rgba(0,229,255,0.2)">Alt+L</b>`;

        const micRow = document.createElement('div');
        micRow.className = 'nk-hotkey-row';
        micRow.style.borderTop = '1px dashed rgba(255,255,255,0.06)';
        micRow.style.paddingTop = '10px';
        const micLabel = document.createElement('span');
        micLabel.className = 'nk-hotkey-label';
        micLabel.textContent = 'Вкл/Выкл Микрофон';
        const micButton = document.createElement('button');
        micButton.type = 'button';
        micButton.className = 'nk-hotkey-btn';
        micButton.id = 'nk-hotkey-btn-mic';
        micButton.textContent = settings.micKey.label;
        micRow.appendChild(micLabel);
        micRow.appendChild(micButton);

        const micHint = document.createElement('div');
        micHint.id = 'nk-hint-mic';
        micHint.style.cssText = 'font-size: 9px; opacity: 0.75; margin-top: 5px; text-align: left; line-height: 1.4; color: var(--nk-meta, rgba(255,255,255,0.45)); font-family: system-ui, sans-serif;';
        micHint.innerHTML = `💡 Чтобы выключить микрофон вне вкладки, нажмите <b style="color:var(--nk-logo-b);text-shadow:0 0 4px rgba(0,229,255,0.2)">Alt+M</b>`;

        hotkeyCard.appendChild(skipRow);
        hotkeyCard.appendChild(skipHint);
        hotkeyCard.appendChild(micRow);
        hotkeyCard.appendChild(micHint);
        list.appendChild(hotkeyCard);

        const attachBindLogic = (btnId, settingKey, storageKey) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            let listening = false;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                listening = !listening;
                btn.classList.toggle('nk-hotkey-listening', listening);
                btn.textContent = listening ? '...' : settings[settingKey].label;
                if (listening) {
                    showNkToast('Нажмите любую клавишу...', 'info', 3000);
                    const handler = (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        const parts = [];
                        if (ev.ctrlKey) parts.push('Ctrl');
                        if (ev.altKey) parts.push('Alt');
                        if (ev.shiftKey) parts.push('Shift');
                        let keyName = ev.key.length === 1 ? ev.key.toUpperCase() : ev.key;
                        if (keyName === ' ') keyName = 'Space';
                        if (!['Control', 'Alt', 'Shift', 'Meta'].includes(ev.key)) parts.push(keyName);
                        if (parts.length === 0) return;
                        const label = parts.join('+');
                        settings[settingKey] = { key: ev.key, code: ev.code, label, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey };
                        localStorage.setItem(storageKey, JSON.stringify(settings[settingKey]));
                        btn.textContent = label;
                        btn.classList.remove('nk-hotkey-listening');
                        listening = false;

                        const hintEl = document.getElementById(`nk-hint-${btnId.split('-').pop()}`);
                        if (hintEl) {
                            const actionText = btnId.includes('skip') ? 'скипнуть собеседника' : 'выключить микрофон';
                            hintEl.innerHTML = `💡 Чтобы ${actionText} вне вкладки, нажмите <b style="color:var(--nk-logo-b);text-shadow:0 0 4px rgba(0,229,255,0.2)">Alt+${keyName}</b>`;
                        }

                        document.removeEventListener('keydown', handler, true);
                        showNkToast(`Клавиша установлена: ${label}`, 'success', 2500);
                    };
                    document.addEventListener('keydown', handler, true);
                }
            });
        };

        attachBindLogic('nk-hotkey-btn-skip', 'skipKey', 'nkSkipKey');
        attachBindLogic('nk-hotkey-btn-mic', 'micKey', 'nkMicKey');
    }

    function toggleMic() {
        isMicMuted = !isMicMuted;
        if (globalStream) globalStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
        if (currentGumStream) currentGumStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
        const btn = document.getElementById('mic-toggle');
        if (btn) {
            btn.classList.toggle('active', !isMicMuted);
            btn.classList.toggle('muted', isMicMuted);
        }
        showNkToast(isMicMuted ? 'Микрофон выключен' : 'Микрофон включён', isMicMuted ? 'warn' : 'success', 2000);
    }

    function toggleHeadphones() {
        isHeadphonesMuted = !isHeadphonesMuted;
        const audio = document.querySelector('audio#audioStream');
        if (audio) audio.muted = isHeadphonesMuted;
        const btn = document.getElementById('headphone-toggle');
        if (btn) {
            btn.classList.toggle('active', !isHeadphonesMuted);
            btn.classList.toggle('muted', isHeadphonesMuted);
        }
        showNkToast(isHeadphonesMuted ? 'Наушники выключены' : 'Наушники включены', isHeadphonesMuted ? 'warn' : 'success', 2000);
    }

    const originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints?.audio) {
            constraints.audio = { ...constraints.audio, autoGainControl: false, noiseSuppression: false, echoCancellation: false };
        }


        if (globalStream && globalStream.getAudioTracks().some(t => t.readyState === 'live')) {
            const clonedStream = new MediaStream();
            globalStream.getAudioTracks().forEach(t => {
                const clone = t.clone();
                clonedStream.addTrack(clone);
            });
            if (isMicMuted) clonedStream.getAudioTracks().forEach(t => t.enabled = false);
            currentGumStream = clonedStream;
            return clonedStream;
        }

        try {
            if (originalMicStream) {
                originalMicStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
                originalMicStream = null;
            }
            globalStream = null;
            originalMicStream = await originalGUM(constraints);
        } catch (e) {
            throw e;
        }
        setupVUMeter(originalMicStream);
        globalStream = originalMicStream;


        globalStream.getAudioTracks().forEach(track => {
            const originalStop = track.stop;
            track._realStop = function () {
                originalStop.call(this);
            };
            track.stop = function () {

            };
        });


        const clonedStream = new MediaStream();
        globalStream.getAudioTracks().forEach(t => {
            const clone = t.clone();
            clonedStream.addTrack(clone);
        });
        if (isMicMuted) clonedStream.getAudioTracks().forEach(t => t.enabled = false);
        currentGumStream = clonedStream;
        return clonedStream;
    };

    function isCaptchaVisible() {
        const mask = document.getElementById('mask_cap');
        return mask && !mask.style.display.includes('none');
    }

    function removeAds() {
        if (isCaptchaVisible()) return;
        const selectors = [
            'div[id^="yandex_rtb_"]',
            '.yandex-rtb',
            '.yandex_rtb',
            'div[class*="yandex-rtb"]',
            'div[class*="ya-rtb"]',
            'iframe[src*="yandex.ru/ads"]',
            'iframe[src*="an.yandex.ru"]',
            'iframe[src*="doubleclick.net"]',
            'iframe[src*="googleads"]',
            'div.audiochat__banner',
            'div.audiochat__ads',
            'div.ads-container',
            'div.ads-wrapper',
            '.banner-ad',
            '.advertisement',
            '.promo-block',
            '#promo-block'
        ];
        try {
            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    el.remove();
                });
            });
        } catch (_) { }
    }


    


    function cleanSiteInterface() {
        if (isCaptchaVisible()) {
            document.body.classList.remove('nk-clean-site');
            document.body.classList.add('nk-captcha-mode');
            return;
        }
        try {
            document.body.classList.remove('nk-captcha-mode');
            document.body.classList.add('nk-clean-site');
            const clutterText = [
                'добро пожаловать в голосовую чат рулетку',
                'выберите нужные параметры',
                'знакомьтесь и общайтесь',
                'разговоры не записываются',
                'совершенно незнакомыми людьми',
                'на любые темы',
                'nekto.me',
                'nektome',
                'доступно в google play',
                '©'
            ];
            const directClutter = document.querySelectorAll([
                '#devel',
                'a#devel',
                'a[href="//nekto.me/"]',
                'a[href*="nekto.me/"]#devel',
                'img[src*="gplaybtn"]',
                'img[alt*="Google Play"]'
            ].join(','));
            directClutter.forEach((el) => {
                if (!el || el.closest('#nekto-panel, #nk-toast-container')) return;
                const parentText = (el.parentElement?.innerText || el.parentElement?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (parentText.includes('©') || el.tagName === 'IMG') {
                    (el.parentElement || el).classList.add('nk-site-clutter');
                } else {
                    el.classList.add('nk-site-clutter');
                }
            });
            const candidates = document.querySelectorAll([
                '.description',
                '.audio-chat .description',
                '.audio-chat p',
                '.audio-chat h1',
                '.audio-chat h2',
                '.audio-chat h3',
                '.audio-chat .title',
                'footer',
                '.footer',
                '[class*="footer"]',
                '[class*="description"]',
                '[class*="welcome"]',
                '[class*="intro"]',
                '[class*="promo"]',
                'center',
                'p'
            ].join(','));

            candidates.forEach((el) => {
                if (!el || el.id === 'nekto-panel' || el.closest('#nekto-panel, #nk-toast-container')) return;
                const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!text) return;
                if (clutterText.some((needle) => text.includes(needle))) {
                    el.classList.add('nk-site-clutter');
                }
            });
        } catch (_) { }
    }

    let _autoClickPending = false;
    function checkAndClickButton() {
        if (!isAutoModeEnabled) return;
        if (_autoClickPending) return;
        const btn = document.querySelector('.callScreen.callFinished button.callScreen__findBtn') || document.querySelector('button.go-scan-button');
        if (!btn) return;
        _autoClickPending = true;
        // Random human-like delay 1.2–3.8s to avoid bot detection
        const delay = 1200 + Math.random() * 2600;
        setTimeout(() => {
            _autoClickPending = false;
            if (!isAutoModeEnabled) return;
            const b = document.querySelector('.callScreen.callFinished button.callScreen__findBtn') || document.querySelector('button.go-scan-button');
            if (b) b.click();
        }, delay);
    }

    let metaHintRaf = 0;
    function scheduleMetaHintsUpdate() {
        if (metaHintRaf) return;
        metaHintRaf = requestAnimationFrame(() => {
            metaHintRaf = 0;
            updateMetaHints();
        });
    }

    const observer = new MutationObserver(() => {
        scheduleMetaHintsUpdate();
        checkAndClickButton();
        removeAds();
        cleanSiteInterface();
        const timer = document.querySelector('.callScreen__time');

        if (timer && !isConversationActive) {
            isConversationActive = true;
            hasConversationInSession = true;
            conversationStartTime = Date.now();
            settings.conversationCount++;
            saveStats();
            updateDailyStats();
            updateStreak();
            const countEl = document.getElementById('conv-count');
            if (countEl) countEl.textContent = settings.conversationCount;
            startAudio.dataset.custom = 'true';
            startAudio.play().catch(() => { });
            startConvMilestoneTimer();
            if (nkAutoRecord) nkStartRecording();
        }

        if (!timer && isConversationActive) {
            isConversationActive = false;
            if (nkRecordState !== 'idle') nkStopRecording(true);
            stopConvMilestoneTimer();
            document.querySelectorAll('.nk-persistent-toast').forEach(t => {
                t.classList.remove('nk-toast-show');
                t.classList.add('nk-toast-hide');
                setTimeout(() => { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (e) { } }, 420);
            });
            if (conversationStartTime) {
                const durationSec = Math.floor((Date.now() - conversationStartTime) / 1000);
                settings.totalConversationTime += durationSec;
                saveStats();
                updateLongestConversation(durationSec);
                const totalEl = document.getElementById('total-time');
                if (totalEl) totalEl.textContent = formatTotalTime(settings.totalConversationTime);
                refreshDetailedStatsUI();
            }
            conversationStartTime = null;
            endAudio.play().catch(() => { });
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            updateMetaHints();
        }
    });

    function showNkConfirm(message, subtext, onConfirm) {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(10, 10, 16, 0.75);
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            z-index: 9999999; display: flex; align-items: center; justify-content: center;
            opacity: 0; transition: opacity 0.3s ease;
        `;
        const box = document.createElement('div');
        box.style.cssText = `
            background: var(--nk-inner-bg-a, #1a1a24);
            border: 1px solid var(--nk-border, rgba(255,0,122,0.3));
            border-radius: 16px; padding: 24px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.6), 0 0 30px var(--nk-glow-a, rgba(255,0,122,0.15));
            max-width: 340px; text-align: center; font-family: 'Share Tech Mono', sans-serif;
            transform: scale(0.9); transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            color: var(--nk-text, #fff);
        `;
        box.innerHTML = `
            <div style="font-size: 38px; margin-bottom: 12px; filter: drop-shadow(0 0 10px var(--nk-logo-a, #ff007a));">⚠️</div>
            <div style="font-size: 16px; font-weight: bold; margin-bottom: 8px;">${message}</div>
            <div style="font-size: 13px; opacity: 0.75; margin-bottom: 24px; line-height: 1.5; font-family: system-ui, sans-serif;">${subtext}</div>
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="nk-confirm-no" style="
                    background: transparent; border: 1px solid rgba(255,255,255,0.15); color: rgba(255,255,255,0.8);
                    padding: 10px 16px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px;
                    transition: background 0.2s, border-color 0.2s; flex: 1; outline: none;
                ">Отмена (Esc)</button>
                <button id="nk-confirm-yes" style="
                    background: var(--nk-logo-a, #ff007a); border: none; color: #fff;
                    padding: 10px 16px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: bold;
                    box-shadow: 0 0 15px var(--nk-glow-a, rgba(255,0,122,0.4)); transition: filter 0.2s; flex: 1; outline: none;
                ">Завершить</button>
            </div>
        `;

        const panel = document.getElementById('nekto-panel');
        if (panel) {
            const cs = getComputedStyle(panel);
            ['--nk-inner-bg-a', '--nk-border', '--nk-glow-a', '--nk-text', '--nk-logo-a'].forEach(v => {
                const val = cs.getPropertyValue(v);
                if (val) box.style.setProperty(v, val);
            });
        }

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
            overlay.style.opacity = '1';
            box.style.transform = 'scale(1)';
        });

        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            overlay.style.opacity = '0';
            box.style.transform = 'scale(0.9)';
            document.removeEventListener('keydown', keyHandler, true);
            setTimeout(() => overlay.remove(), 300);
        };

        const keyHandler = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
            if (e.key === 'Enter' || e.code === 'Space') { e.stopPropagation(); e.preventDefault(); close(); onConfirm(); return; }

            const sk = settings.skipKey;
            if (sk) {
                const keyMatch = e.key === sk.key || e.code === sk.code;
                const ctrlOk = sk.ctrl ? e.ctrlKey : !e.ctrlKey;
                const altOk = sk.alt ? e.altKey : !e.altKey;
                const shiftOk = sk.shift ? e.shiftKey : !e.shiftKey;
                if (keyMatch && ctrlOk && altOk && shiftOk) {
                    e.stopPropagation(); e.preventDefault();
                    close();
                    onConfirm();
                }
            }
        };
        document.addEventListener('keydown', keyHandler, true);

        const btnNo = overlay.querySelector('#nk-confirm-no');
        const btnYes = overlay.querySelector('#nk-confirm-yes');
        btnNo.onmouseenter = () => btnNo.style.background = 'rgba(255,255,255,0.05)';
        btnNo.onmouseleave = () => btnNo.style.background = 'transparent';
        btnYes.onmouseenter = () => btnYes.style.filter = 'brightness(1.2)';
        btnYes.onmouseleave = () => btnYes.style.filter = 'none';

        btnNo.onclick = close;
        btnYes.onclick = () => {
            close();
            onConfirm();
        };
    }

    function skipConversation(force = false) {
        if (!force && isConversationActive && conversationStartTime) {
            const mins = (Date.now() - conversationStartTime) / 60000;
            if (mins >= 10) {
                showNkConfirm(
                    'Долгий разговор',
                    'Вы общаетесь уже больше 10 минут. Вы уверены, что хотите завершить разговор?',
                    () => skipConversation(true)
                );
                return true;
            }
        }

        const cancelBtn = document.querySelector('.callScreen__cancelCallBtn')
            || document.querySelector('.cancelCallBtnNoMess')
            || document.querySelector('button.stop-talk-button')
            || document.querySelector('[class*="cancelCall"]')
            || document.querySelector('[class*="stop-talk"]');
        if (cancelBtn) {
            cancelBtn.click();
            showNkToast('Собеседник пропущен', 'skip', 2500);

            const findDelay = () => 700 + Math.random() * 800;

            const swalBtn = document.querySelector('.swal2-confirm.swal2-styled');
            if (swalBtn) {
                setTimeout(() => {
                    swalBtn.click();
                    setTimeout(() => {
                        const findBtn = document.querySelector('.callScreen__findBtn')
                            || document.querySelector('button.go-scan-button');
                        if (findBtn) findBtn.click();
                    }, findDelay());
                }, 300 + Math.random() * 300);
            } else {
                let attempt = 0;
                const timer = setInterval(() => {
                    attempt++;
                    const btn = document.querySelector('.swal2-confirm.swal2-styled');
                    if (btn) {
                        clearInterval(timer);
                        btn.click();
                        setTimeout(() => {
                            const findBtn = document.querySelector('.callScreen__findBtn')
                                || document.querySelector('button.go-scan-button');
                            if (findBtn) findBtn.click();
                        }, findDelay());
                    } else if (attempt > 30) {
                        clearInterval(timer);
                    }
                }, 150);
            }
            return true;
        }

        const scanBtn = document.querySelector('.callScreen__findBtn')
            || document.querySelector('button.go-scan-button')
            || document.querySelector('button.scan-button')
            || document.querySelector('[class*="findBtn"]')
            || document.querySelector('[class*="go-scan"]')
            || document.querySelector('[class*="scan-button"]');
        if (scanBtn) {
            scanBtn.click();
            showNkToast('Поиск собеседника...', 'search', 2000);
            return true;
        }
        return false;
    }

    document.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable)) return;

        const sk = settings.skipKey;
        if (sk) {
            const keyMatch = e.key === sk.key || e.code === sk.code;
            const ctrlOk = sk.ctrl ? e.ctrlKey : !e.ctrlKey;
            const altOk = sk.alt ? e.altKey : !e.altKey;
            const shiftOk = sk.shift ? e.shiftKey : !e.shiftKey;
            if (keyMatch && ctrlOk && altOk && shiftOk) {
                e.preventDefault();
                skipConversation();
                return;
            }
        }

        const mk = settings.micKey;
        if (mk) {
            const keyMatch = e.key === mk.key || e.code === mk.code;
            const ctrlOk = mk.ctrl ? e.ctrlKey : !e.ctrlKey;
            const altOk = mk.alt ? e.altKey : !e.altKey;
            const shiftOk = mk.shift ? e.shiftKey : !e.shiftKey;
            if (keyMatch && ctrlOk && altOk && shiftOk) {
                e.preventDefault();
                const micToggle = document.getElementById('mic-toggle');
                if (micToggle) micToggle.click();
                return;
            }
        }
    });


    window.addEventListener('message', (ev) => {
        if (ev.data && ev.data.source === EXT_MSG) {
            if (ev.data.type === 'GLOBAL_SKIP') {
                skipConversation();
            } else if (ev.data.type === 'GLOBAL_TOGGLE_MIC') {
                const micToggle = document.getElementById('mic-toggle');
                if (micToggle) micToggle.click();
            }
        }
    });


    (function initVoiceSkip() {
        const VOSK_LIB_URL = document.currentScript?.dataset?.voskLibUrl || null;
        const VOSK_MODEL_URL = document.currentScript?.dataset?.voskModelUrl || null;
        if (!VOSK_LIB_URL || !VOSK_MODEL_URL) return;

        const SKIP_WORDS_DEF = ['скип', 'скипни', 'скипнуть', 'skip'];
        const MUTE_WORDS_DEF = ['мут', 'мьют'];
        const getSkipWords = () => window.nkSkipWords && window.nkSkipWords.length ? window.nkSkipWords : SKIP_WORDS_DEF;
        const getMuteWords = () => window.nkMuteWords && window.nkMuteWords.length ? window.nkMuteWords : MUTE_WORDS_DEF;

        const findMatchedWord = (text, words) => {
            const t = text.toLowerCase();
            return words.find((w) => t.includes(w)) || null;
        };

        let voskModel = null;
        let recognizer = null;
        let audioCtx = null;
        let micStream = null;
        let sourceNode = null;
        let processorNode = null;
        let silenceGain = null;
        let triggeredThisUtterance = false;
        let lastTriggerAt = 0;
        let starting = false;

        const handleText = (text) => {
            if (!text || !settings.voiceSkipEnabled || triggeredThisUtterance) return;
            const now = Date.now();
            if (now - lastTriggerAt <= 2000) return;

            const skipWord = findMatchedWord(text, getSkipWords());
            if (skipWord) {
                console.log(`[NK voice] триггер "${skipWord}" -> скип собеседника`);
                triggeredThisUtterance = true;
                lastTriggerAt = now;
                // Human reaction delay after hearing the word
                skipConversation();
                return;
            }

            const muteWord = findMatchedWord(text, getMuteWords());
            if (muteWord) {
                console.log(`[NK voice] триггер "${muteWord}" -> переключение микрофона`);
                triggeredThisUtterance = true;
                lastTriggerAt = now;
                const micToggle = document.getElementById('mic-toggle');
                if (micToggle) micToggle.click();
            }
        };

        const loadVoskLib = () => new Promise((resolve, reject) => {
            if (window.Vosk) { resolve(window.Vosk); return; }
            const el = document.createElement('script');
            el.src = VOSK_LIB_URL;
            el.onload = () => resolve(window.Vosk);
            el.onerror = (e) => reject(e);
            (document.documentElement || document.head).appendChild(el);
        });

        const stopPipeline = () => {
            try { if (processorNode) { processorNode.port.onmessage = null; processorNode.disconnect(); } } catch (_) {}
            try { if (sourceNode) sourceNode.disconnect(); } catch (_) {}
            try { if (silenceGain) silenceGain.disconnect(); } catch (_) {}
            try { if (audioCtx) audioCtx.close(); } catch (_) {}
            try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            try { if (recognizer) recognizer.remove(); } catch (_) {}
            try { if (voskModel) voskModel.terminate(); } catch (_) {}
            processorNode = null;
            sourceNode = null;
            silenceGain = null;
            audioCtx = null;
            micStream = null;
            recognizer = null;
            voskModel = null;
        };

        const startPipeline = async () => {
            if (starting || recognizer) return;
            starting = true;
            try {
                await loadVoskLib();
                console.log('[NK voice] загрузка модели...');
                voskModel = await window.Vosk.createModel(VOSK_MODEL_URL);
                console.log('[NK voice] модель загружена, слушаю...');

                micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                recognizer = new voskModel.KaldiRecognizer(audioCtx.sampleRate);

                recognizer.on('result', (msg) => {
                    triggeredThisUtterance = false;
                    handleText(msg.result && msg.result.text);
                });
                recognizer.on('partialresult', (msg) => {
                    handleText(msg.result && msg.result.partial);
                });

                sourceNode = audioCtx.createMediaStreamSource(micStream);

                // AudioWorkletNode runs on dedicated audio thread — no main-thread spikes
                const workletCode = `
class VoskCapture extends AudioWorkletProcessor {
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch && ch.length) this.port.postMessage(ch);
        return true;
    }
}
registerProcessor('vosk-capture', VoskCapture);`;
                const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
                const workletUrl = URL.createObjectURL(workletBlob);
                await audioCtx.audioWorklet.addModule(workletUrl);
                URL.revokeObjectURL(workletUrl);

                processorNode = new AudioWorkletNode(audioCtx, 'vosk-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
                processorNode.port.onmessage = (ev) => {
                    if (!settings.voiceSkipEnabled || !recognizer) return;
                    recognizer.acceptWaveformFloat(ev.data, audioCtx.sampleRate);
                };

                sourceNode.connect(processorNode);
            } catch (e) {
                console.warn('[NK voice] ⚠️ ошибка инициализации голосового управления:', e);
                stopPipeline();
            } finally {
                starting = false;
            }
        };

        window.nkSetVoiceSkipEnabled = (enabled) => {
            settings.voiceSkipEnabled = !!enabled;
            localStorage.setItem('nkVoiceSkipEnabled', enabled ? '1' : '0');
            if (enabled) startPipeline();
            else stopPipeline();
        };

        if (settings.voiceSkipEnabled) startPipeline();
    })();


    window.addEventListener('hashchange', () => {
        if (_siteThemeApplied) {
            setTimeout(() => applySiteTheme(_siteThemeApplied), 150);
            setTimeout(() => applySiteTheme(_siteThemeApplied), 600);
        }
    });


    const _routeObs = new MutationObserver(() => {
        if (_siteThemeApplied) {
            const siteStyleEl = document.getElementById('nk-site-theme');
            if (!siteStyleEl || !siteStyleEl.textContent) {
                applySiteTheme(_siteThemeApplied);
            }
        }
    });


    function enforceButtonLayout() {
        const callScreen = document.querySelector('.callScreen:not(.callFinished)');
        if (callScreen && !document.querySelector('.nk-custom-button-bar')) {
            const muteBtn = callScreen.querySelector('.mute-button') || callScreen.querySelector('.callScreen__microBtn');
            const cancelBtn = callScreen.querySelector('.callScreen__cancelCallBtn') || callScreen.querySelector('.btn-danger') || callScreen.querySelector('[class*="cancelCall"]');

            if (muteBtn && cancelBtn) {
                const complaintBtn = callScreen.querySelector('.callScreen__complaintBtn') || callScreen.querySelector('.stop-and-complain-button');
                if (complaintBtn) {
                    complaintBtn.style.display = 'none';
                    complaintBtn.style.position = 'absolute';
                    complaintBtn.style.opacity = '0';
                }

                const bar = document.createElement('div');
                bar.className = 'nk-custom-button-bar';
                cancelBtn.parentNode.insertBefore(bar, cancelBtn);
                bar.appendChild(cancelBtn);
                bar.appendChild(muteBtn);
            }
        }
    }

    window.addEventListener('load', () => {
        setInterval(enforceButtonLayout, 500);
        removeAds();
        cleanSiteInterface();
        createSettingsUI();
        observer.observe(document.body, { childList: true, subtree: true });
        _routeObs.observe(document.body, { childList: true, subtree: true });
        startPingLoop();
        startSiteMetaWatcher();
        applySiteTheme(settings.panelTheme);
        showNkToast('NektoULTRA загружен', 'success', 3000);
        showChangelogIfNeeded();
    });
})();


