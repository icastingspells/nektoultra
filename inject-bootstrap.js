(function () {
    const EXT_SRC = 'nekto-pro-ext';
    const PAGE_SRC = 'nekto-pro';
    const BG_NS = 'nekto-pro-uwu';

    const rt = globalThis.browser?.runtime || globalThis.chrome?.runtime;

    function rtLastError() {
        try {
            return globalThis.chrome?.runtime?.lastError?.message || null;
        } catch (_) {
            return null;
        }
    }

    function isNektoPageOrigin(origin) {
        if (!origin) return true;
        try {
            const h = new URL(origin).hostname;
            return h === 'nekto.me' || h === 'www.nekto.me' || h.endsWith('.nekto.me');
        } catch (_) {
            return true;
        }
    }

    function isAllowedProxyUrl(urlStr) {
        try {
            const u = new URL(urlStr);
            return u.protocol === 'https:' && (u.hostname === 'uwupad.me' || u.hostname === 'www.uwupad.me' || u.hostname === 'cdn.uwupad.me');
        } catch (_) {
            return false;
        }
    }

    function isAllowedNektoHtmlUrl(urlStr) {
        try {
            const u = new URL(urlStr);
            if (u.protocol !== 'https:') return false;
            if (u.hostname !== 'nekto.me' && u.hostname !== 'www.nekto.me') return false;
            if (u.hash) return false;
            const p = u.pathname || '/';
            return p === '/' || /^\/audiochat(\/|$)/.test(p);
        } catch (_) {
            return false;
        }
    }

    function postJsonErr(id, err) {
        window.postMessage({ source: EXT_SRC, type: 'FETCH_JSON_ERR', id, err: String(err) }, '*');
    }
    function postJsonOk(id, data) {
        window.postMessage({ source: EXT_SRC, type: 'FETCH_JSON_OK', id, data }, '*');
    }
    function postBinErr(id, err) {
        window.postMessage({ source: EXT_SRC, type: 'FETCH_BIN_ERR', id, err: String(err) }, '*');
    }
    function postBinOk(id, b64) {
        window.postMessage({ source: EXT_SRC, type: 'FETCH_BIN_OK', id, b64 }, '*');
    }
    function postHtmlErr(id, err) {
        window.postMessage({ source: EXT_SRC, type: 'FETCH_NEKTO_HTML_ERR', id, err: String(err) }, '*');
    }
    function postHtmlOk(id, text) {
        window.postMessage({ source: EXT_SRC, type: 'FETCH_NEKTO_HTML_OK', id, text }, '*');
    }

    function delay(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    
    function sendBg(kind, url) {
        if (!rt?.sendMessage) {
            return Promise.resolve({ ok: false, err: 'no runtime' });
        }
        try {
            const p = rt.sendMessage({ ns: BG_NS, kind, url });
            if (p && typeof p.then === 'function') {
                return p.then((res) => {
                    return res && typeof res === 'object' ? res : { ok: false, err: 'empty' };
                }).catch((err) => {
                    return { ok: false, err: String(err) };
                });
            }
            return new Promise((resolve) => {
                rt.sendMessage({ ns: BG_NS, kind, url }, (res) => {
                    const le = rtLastError();
                    if (le) resolve({ ok: false, err: le });
                    else resolve(res && typeof res === 'object' ? res : { ok: false, err: 'empty' });
                });
            });
        } catch (e) {
            return Promise.resolve({ ok: false, err: String(e) });
        }
    }

    async function fetchJsonReliable(url, id) {
        let lastErr = 'fetch';
        for (let i = 0; i < 4; i++) {
            const res = await sendBg('json', url);
            if (res.ok && res.data !== undefined) {
                postJsonOk(id, res.data);
                return;
            }
            lastErr = res.err || 'fail';
            await delay(180 + i * 220);
        }
        postJsonErr(id, lastErr);
    }

    async function fetchBinReliable(url, id) {
        let lastErr = 'fetch';
        for (let i = 0; i < 4; i++) {
            const res = await sendBg('bin', url);
            if (res.ok && typeof res.b64 === 'string') {
                postBinOk(id, res.b64);
                return;
            }
            lastErr = res.err || 'fail';
            await delay(180 + i * 220);
        }
        postBinErr(id, lastErr);
    }

    async function fetchNektoHtmlReliable(url, id) {
        let lastErr = 'fetch';
        for (let i = 0; i < 3; i++) {
            const res = await sendBg('nektoHtml', url);
            if (res.ok && typeof res.text === 'string' && res.text.length > 0) {
                postHtmlOk(id, res.text);
                return;
            }
            lastErr = res.err || 'fail';
            await delay(200 + i * 400);
        }
        postHtmlErr(id, lastErr);
    }

    window.addEventListener('message', (ev) => {
        if (!isNektoPageOrigin(ev.origin)) return;
        const d = ev.data;
        if (!d || d.source !== PAGE_SRC) return;

        if (d.type === 'FETCH_BIN') {
            const { id, url } = d;
            if (!isAllowedProxyUrl(url)) {
                postBinErr(id, 'blocked url');
                return;
            }
            void fetchBinReliable(url, id);
            return;
        }

        if (d.type === 'FETCH_JSON') {
            const { id, url } = d;
            if (!isAllowedProxyUrl(url)) {
                postJsonErr(id, 'blocked url');
                return;
            }
            void fetchJsonReliable(url, id);
            return;
        }

        if (d.type === 'FETCH_NEKTO_HTML') {
            const { id, url } = d;
            if (!isAllowedNektoHtmlUrl(url)) {
                postHtmlErr(id, 'blocked url');
                return;
            }
            void fetchNektoHtmlReliable(url, id);
            return;
        }

        if (d.type === 'CHECK_PERMISSIONS') {
            const { id } = d;
            sendBg('checkPermissions', '')
                .then((res) => {
                    window.postMessage({ source: EXT_SRC, type: 'CHECK_PERMISSIONS_OK', id, granted: res.ok ? res.granted : false }, '*');
                })
                .catch(() => {
                    window.postMessage({ source: EXT_SRC, type: 'CHECK_PERMISSIONS_OK', id, granted: false }, '*');
                });
            return;
        }

        if (d.type === 'REQUEST_PERMISSIONS') {
            const { id } = d;
            sendBg('requestPermissions', '')
                .then((res) => {
                    if (res.ok) {
                        window.postMessage({ source: EXT_SRC, type: 'REQUEST_PERMISSIONS_OK', id, granted: res.granted }, '*');
                    } else {
                        window.postMessage({ source: EXT_SRC, type: 'REQUEST_PERMISSIONS_ERR', id, err: res.err || 'fail' }, '*');
                    }
                })
                .catch((err) => {
                    window.postMessage({ source: EXT_SRC, type: 'REQUEST_PERMISSIONS_ERR', id, err: String(err) }, '*');
                });
            return;
        }


    });

    
    if (rt?.onMessage) {
        rt.onMessage.addListener((msg) => {
            if (msg && msg.ns === BG_NS) {
                if (msg.kind === 'globalSkip') {
                    window.postMessage({ source: EXT_SRC, type: 'GLOBAL_SKIP' }, '*');
                } else if (msg.kind === 'globalToggleMic') {
                    window.postMessage({ source: EXT_SRC, type: 'GLOBAL_TOGGLE_MIC' }, '*');
                }
            }
        });
    }

    const injectRt = globalThis.browser?.runtime || globalThis.chrome?.runtime;
    
    (async function init() {
        const src = injectRt.getURL('nekto-pro-inject.js');
        const el = document.createElement('script');
        el.src = src;
        el.dataset.voskLibUrl = injectRt.getURL('vosk-lib.js');
        el.dataset.voskModelUrl = injectRt.getURL('vosk-model-ru.tar.gz');
        el.onload = () => el.remove();
        (document.documentElement || document.head).appendChild(el);
    })();
})();
