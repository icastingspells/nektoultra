'use strict';

const UWU_NS = 'nekto-pro-uwu';
const NEKTO_HOSTS = new Set(['nekto.me', 'www.nekto.me']);

const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;

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

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

async function doNektoHtmlWithRetry(url) {
    let last = 'fetch';
    for (let i = 0; i < 3; i++) {
        try {
            return await fetchNektoHtmlOnce(url);
        } catch (e) {
            last = String(e.message || e);
            await delay(200 + i * 400);
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

        if (msg.kind === 'nektoHtml') {
            const url = msg.url;
            if (!allowedNektoHtmlUrl(url)) {
                sendResponse({ ok: false, err: 'blocked url' });
                return false;
            }
            return respond(doNektoHtmlWithRetry(url)
                .then((text) => ({ ok: true, text }))
                .catch((e) => ({ ok: false, err: String(e.message || e) })));
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
