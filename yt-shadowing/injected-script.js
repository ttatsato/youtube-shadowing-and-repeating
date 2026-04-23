(function() {
    'use strict';

    // =========================================================
    // 1. YouTube の fetch / XHR をインターセプトして
    //    timedtext レスポンスを横取りする
    // =========================================================

    let interceptedCaptions = []; // { url, text }

    // -- fetch インターセプト --
    const origFetch = window.fetch;
    window.fetch = function(...args) {
        const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
        if (url.includes('/api/timedtext') || url.includes('timedtext')) {
            return origFetch.apply(this, args).then(res => {
                const clone = res.clone();
                clone.text().then(text => {
                    if (text && text.length > 0) {
                        console.log('[YT Shadowing intercept] fetch captured timedtext, len:', text.length);
                        interceptedCaptions.push({ url, text });
                        trySendIntercepted();
                    }
                }).catch(() => {});
                return res;
            });
        }
        return origFetch.apply(this, args);
    };

    // -- XHR インターセプト --
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._ytShadowUrl = (typeof url === 'string') ? url : '';
        return origXhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        if (this._ytShadowUrl && (this._ytShadowUrl.includes('/api/timedtext') || this._ytShadowUrl.includes('timedtext'))) {
            this.addEventListener('load', function() {
                if (this.responseText && this.responseText.length > 0) {
                    console.log('[YT Shadowing intercept] XHR captured timedtext, len:', this.responseText.length);
                    interceptedCaptions.push({ url: this._ytShadowUrl, text: this.responseText });
                    trySendIntercepted();
                }
            });
        }
        return origXhrSend.call(this, ...args);
    };

    // =========================================================
    // 2. playerResponse からトラック一覧を取得
    // =========================================================

    function getCaptionTracks() {
        try {
            if (window.ytInitialPlayerResponse &&
                window.ytInitialPlayerResponse.captions &&
                window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer) {
                const tracks = window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
                if (tracks && tracks.length > 0) return tracks;
            }
        } catch (e) {}
        try {
            const player = document.getElementById('movie_player');
            if (player && typeof player.getPlayerResponse === 'function') {
                const resp = player.getPlayerResponse();
                if (resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer) {
                    const tracks = resp.captions.playerCaptionsTracklistRenderer.captionTracks;
                    if (tracks && tracks.length > 0) return tracks;
                }
            }
        } catch (e) {}
        return null;
    }

    // =========================================================
    // 3. パーサー
    // =========================================================

    function parseXml(text) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/xml');
            const nodes = doc.querySelectorAll('text');
            if (nodes.length === 0) return null;
            const phrases = Array.from(nodes).map(n => {
                const start = parseFloat(n.getAttribute('start') || '0');
                const dur = parseFloat(n.getAttribute('dur') || '0');
                const el = document.createElement('div');
                el.innerHTML = n.textContent;
                return {
                    start, duration: dur, end: start + dur,
                    text: (el.textContent || '').replace(/\n/g, ' ').trim(),
                };
            }).filter(e => e.text);
            return phrases.length > 0 ? phrases : null;
        } catch (e) { return null; }
    }

    function parseJson3(text) {
        try {
            const data = JSON.parse(text);
            if (!data.events) return null;
            const phrases = data.events
                .filter(e => e.segs)
                .map(e => ({
                    start: e.tStartMs / 1000,
                    duration: (e.dDurationMs || 0) / 1000,
                    end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
                    text: e.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim(),
                }))
                .filter(e => e.text);
            return phrases.length > 0 ? phrases : null;
        } catch (e) { return null; }
    }

    function parseVtt(text) {
        const phrases = [];
        const lines = text.split('\n');
        let i = 0;
        while (i < lines.length) {
            const m = lines[i].match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);
            if (m) {
                const start = hhmmss(m[1]), end = hhmmss(m[2]);
                i++;
                let buf = [];
                while (i < lines.length && lines[i].trim() !== '') {
                    buf.push(lines[i].replace(/<[^>]+>/g, '').trim());
                    i++;
                }
                const text = buf.join(' ').trim();
                if (text) phrases.push({ start, duration: end - start, end, text });
            } else { i++; }
        }
        return phrases.length > 0 ? phrases : null;
    }

    function hhmmss(ts) {
        const p = ts.split(':');
        return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
    }

    function autoParse(text) {
        return parseJson3(text) || parseXml(text) || parseVtt(text);
    }

    // =========================================================
    // 4. XHR で自力フェッチ（Service Worker 回避）
    // =========================================================

    function xhrFetch(url) {
        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.onload = function() {
                resolve(xhr.status >= 200 && xhr.status < 300 ? xhr.responseText : '');
            };
            xhr.onerror = function() { resolve(''); };
            xhr.ontimeout = function() { resolve(''); };
            xhr.timeout = 10000;
            xhr.send();
        });
    }

    // =========================================================
    // 5. メインフロー
    // =========================================================

    let sent = false;

    function sendResult(phrases, trackLang, tracks) {
        if (sent) return;
        sent = true;
        window.postMessage({
            type: 'YOUTUBE_CAPTIONS_RESULT',
            phrases: phrases,
            trackLang: trackLang || '',
            availableTracks: (tracks || []).map(t => ({ languageCode: t.languageCode }))
        }, '*');
    }

    function sendError(error) {
        if (sent) return;
        sent = true;
        window.postMessage({ type: 'YOUTUBE_CAPTIONS_RESULT', phrases: null, error }, '*');
    }

    function trySendIntercepted() {
        if (sent || interceptedCaptions.length === 0) return;
        for (const { url, text } of interceptedCaptions) {
            const phrases = autoParse(text);
            if (phrases) {
                // Determine language from URL
                const langMatch = url.match(/[&?]lang=([^&]+)/);
                const lang = langMatch ? langMatch[1] : '';
                console.log('[YT Shadowing intercept] Parsed intercepted captions:', phrases.length, 'lang:', lang);
                sendResult(phrases, lang, getCaptionTracks());
                return;
            }
        }
    }

    async function run() {
        // Wait for tracks
        let tracks = null;
        for (let i = 0; i < 80; i++) {
            tracks = getCaptionTracks();
            if (tracks) break;
            await new Promise(r => setTimeout(r, 100));
        }

        if (!tracks || tracks.length === 0) {
            sendError('no caption tracks found');
            return;
        }

        const track = tracks.find(t => t.languageCode === 'en') || tracks[0];
        if (!track || !track.baseUrl) {
            sendError('no baseUrl');
            return;
        }

        console.log('[YT Shadowing injected] Track:', track.languageCode, 'trying XHR fetch...');

        // Try XHR fetch with multiple formats (bypasses Service Worker)
        const fmts = ['srv3', 'srv1', 'json3', 'vtt', ''];
        for (const fmt of fmts) {
            if (sent) return;
            const url = fmt ? (track.baseUrl + '&fmt=' + fmt) : track.baseUrl;
            const text = await xhrFetch(url);
            console.log('[YT Shadowing injected] XHR', fmt || 'bare', 'len:', text.length);
            if (text.length > 0) {
                const phrases = autoParse(text);
                if (phrases) {
                    console.log('[YT Shadowing injected] XHR', fmt || 'bare', '=> OK,', phrases.length, 'phrases');
                    sendResult(phrases, track.languageCode, tracks);
                    return;
                }
            }
        }

        // If XHR also failed, try triggering YouTube to load captions
        console.log('[YT Shadowing injected] XHR failed, trying player.setOption to trigger caption load...');
        try {
            const player = document.getElementById('movie_player');
            if (player && typeof player.setOption === 'function') {
                player.setOption('captions', 'track', { languageCode: track.languageCode });
                // Wait for intercepted data
                for (let i = 0; i < 50; i++) {
                    if (sent) return;
                    await new Promise(r => setTimeout(r, 200));
                    trySendIntercepted();
                }
            }
        } catch (e) {
            console.warn('[YT Shadowing injected] setOption error:', e);
        }

        if (!sent) {
            sendError('all methods failed');
        }
    }

    run();
})();
