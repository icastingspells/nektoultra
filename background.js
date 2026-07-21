'use strict';

const UWU_NS = 'nekto-pro-uwu';
const ALLOWED = new Set(['uwupad.me', 'www.uwupad.me', 'cdn.uwupad.me']);
const NEKTO_HOSTS = new Set(['nekto.me', 'www.nekto.me']);

const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;

function allowedUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        return u.protocol === 'https:' && ALLOWED.has(u.hostname);
    } catch (_) {
        return false;
    }
}

function allowedNektoHtmlUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'https:' || !NEKTO_HOSTS.has(u.hostname)) return false;
        if (u.hash) return false;
        const p = u.pathname || '/';
        return p === '/' || /^\/audiochat(\/|$)/.test(p);
    } catch (_) {
        return false;
    }
}

function abToB64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.byteLength; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.byteLength)));
    }
    return btoa(binary);
}

const UWU_REFERER = { Referer: 'https://uwupad.me/' };

function jsonHeaders() {
    return {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: 'https://uwupad.me',
        ...UWU_REFERER
    };
}

function binHeaders() {
    return {
        Accept: 'audio/mpeg, audio/*, application/octet-stream, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: 'https://uwupad.me',
        ...UWU_REFERER
    };
}

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonOnce(url) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 22000);
    try {
        const r = await fetch(url, {
            credentials: 'omit',
            cache: 'no-store',
            headers: jsonHeaders(),
            signal: ctrl.signal
        });
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        const text = await r.text();
        return JSON.parse(text);
    } finally {
        clearTimeout(tid);
    }
}

async function fetchNektoHtmlOnce(url) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 22000);
    try {
        const r = await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'follow',
            headers: {
                Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.6'
            },
            signal: ctrl.signal
        });
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        let text = await r.text();
        if (text.length > 600000) text = text.slice(0, 600000);
        return text;
    } finally {
        clearTimeout(tid);
    }
}

async function fetchBinOnce(url) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 25000);
    try {
        const r = await fetch(url, {
            credentials: 'omit',
            cache: 'no-store',
            headers: binHeaders(),
            signal: ctrl.signal
        });
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        const buf = await r.arrayBuffer();
        return abToB64(buf);
    } finally {
        clearTimeout(tid);
    }
}

async function doJsonWithRetry(url) {
    let last = 'fetch';
    for (let i = 0; i < 3; i++) {
        try {
            return await fetchJsonOnce(url);
        } catch (e) {
            last = String(e.message || e);
            await delay(200 + i * 300);
        }
    }
    throw new Error(last);
}

async function doBinWithRetry(url) {
    let last = 'fetch';
    for (let i = 0; i < 3; i++) {
        try {
            return await fetchBinOnce(url);
        } catch (e) {
            last = String(e.message || e);
            await delay(200 + i * 300);
        }
    }
    throw new Error(last);
}

if (runtime?.onMessage) {
    runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.ns !== UWU_NS) return false;

        const respond = (promise) => {
            promise
                .then((res) => sendResponse(res))
                .catch((e) => sendResponse({ ok: false, err: String(e.message || e) }));
            return true;
        };

        function callPermission(method, details, fallback) {
            const pm = globalThis.browser?.permissions || globalThis.chrome?.permissions;
            if (!pm?.[method]) return Promise.resolve(fallback);
            try {
                const res = pm[method](details);
                if (res && typeof res.then === 'function') return res;
                return new Promise((resolve) => {
                    pm[method](details, (granted) => {
                        const err = globalThis.chrome?.runtime?.lastError;
                        resolve(err ? fallback : Boolean(granted));
                    });
                });
            } catch (_) {
                return Promise.resolve(fallback);
            }
        }

        if (msg.kind === 'json') {
            const url = msg.url;
            if (!allowedUrl(url)) {
                sendResponse({ ok: false, err: 'blocked url' });
                return false;
            }
            return respond(doJsonWithRetry(url)
                .then((data) => ({ ok: true, data }))
                .catch((e) => ({ ok: false, err: String(e.message || e) })));
        }

        if (msg.kind === 'bin') {
            const url = msg.url;
            if (!allowedUrl(url)) {
                sendResponse({ ok: false, err: 'blocked url' });
                return false;
            }
            return respond(doBinWithRetry(url)
                .then((b64) => ({ ok: true, b64 }))
                .catch((e) => ({ ok: false, err: String(e.message || e) })));
        }

        if (msg.kind === 'nektoHtml') {
            const url = msg.url;
            if (!allowedNektoHtmlUrl(url)) {
                sendResponse({ ok: false, err: 'blocked url' });
                return false;
            }
            return respond(fetchNektoHtmlOnce(url)
                .then((text) => ({ ok: true, text }))
                .catch((e) => ({ ok: false, err: String(e.message || e) })));
        }

        if (msg.kind === 'checkPermissions') {
            return respond(callPermission('contains', {
                origins: ['https://uwupad.me/*', 'https://cdn.uwupad.me/*']
            }, true).then((granted) => ({ ok: true, granted })));
        }

        if (msg.kind === 'requestPermissions') {
            return respond(callPermission('request', {
                origins: ['https://uwupad.me/*', 'https://cdn.uwupad.me/*']
            }, true).then((granted) => ({ ok: true, granted })));
        }

        return false;
    });
}


const commands = globalThis.browser?.commands || globalThis.chrome?.commands;
if (commands?.onCommand) {
    commands.onCommand.addListener((command) => {
        let kind;
        if (command === 'skip-conversation') kind = 'globalSkip';
        else if (command === 'toggle-mic') kind = 'globalToggleMic';
        else return;

        const tabs = globalThis.browser?.tabs || globalThis.chrome?.tabs;
        if (!tabs) return;

        const notifyTabs = (matched) => {
            for (const tab of matched) {
                try {
                    const sendRes = tabs.sendMessage(tab.id, { ns: UWU_NS, kind });
                    if (sendRes && typeof sendRes.catch === 'function') sendRes.catch(() => {});
                } catch (_) {}
            }
        };
        const query = { url: ['https://nekto.me/*', 'https://www.nekto.me/*'] };
        if (globalThis.browser?.tabs) {
            tabs.query(query).then(notifyTabs).catch(() => {});
        } else {
            tabs.query(query, notifyTabs);
        }
    });
}
