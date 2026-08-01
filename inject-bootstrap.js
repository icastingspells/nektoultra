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

        if (d.type === 'FETCH_NEKTO_HTML') {
            const { id, url } = d;
            if (!isAllowedNektoHtmlUrl(url)) {
                postHtmlErr(id, 'blocked url');
                return;
            }
            void fetchNektoHtmlReliable(url, id);
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
