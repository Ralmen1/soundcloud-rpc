/**
 * @name AI Transition
 * @author Ral
 * @version 0.1.0
 * @description 8 seconds before a track ends, splits voice from music and blends into the next track: swaps voices, keeps the voice over the next beat, or crossfades.
 * @license MIT
 */

// Everything below runs inside the SoundCloud page. The heavy part (voice/music split) runs in the app's
// separator process via window.soundcloudAPI.aiTransitionRender, which a phone build can swap for onnxruntime-web.
function aiTransitionPage() {
    if (window.__scrpcAiTransition) return;

    var WINDOW_SECONDS = 8;
    var PREPARE_AT_REMAINING = 50;
    var FETCH_MARGIN = 1.5;
    var SAMPLE_RATE = 44100;
    var API = 'https://api-v2.soundcloud.com';
    var LOG = '[ai-transition]';

    var media = new Set();
    var patched = [];
    var clientId = null;
    var authHeader = null;
    var trackCache = new Map();
    var ctx = null;
    var tickTimer = null;
    var queueStyle = null;

    // idle -> preparing -> ready -> mixing -> handoff -> idle
    var state = { phase: 'idle', trackUrl: null, nextUrl: null, mix: null, kind: null };
    var mixing = null;

    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(LOG);
        console.log.apply(console, args);
    }

    // ---- SoundCloud API access, reusing the client_id and auth the web app itself sends ----

    function sniffUrl(url) {
        if (typeof url !== 'string' || url.indexOf('api-v2.soundcloud.com') === -1) return;
        var match = url.match(/[?&]client_id=([A-Za-z0-9]+)/);
        if (match) clientId = match[1];
    }

    function sniffFromPerformance() {
        try {
            performance.getEntriesByType('resource').forEach(function (entry) {
                sniffUrl(entry.name);
            });
        } catch (e) {}
    }

    function patchNetwork() {
        var originalFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                var url = typeof input === 'string' ? input : input && input.url;
                sniffUrl(url);
                var headers = init && init.headers;
                if (url && url.indexOf('api-v2.soundcloud.com') !== -1 && headers) {
                    var auth = headers instanceof Headers ? headers.get('Authorization') : headers.Authorization;
                    if (auth) authHeader = auth;
                }
            } catch (e) {}
            return originalFetch.apply(this, arguments);
        };
        patched.push(function () {
            window.fetch = originalFetch;
        });

        var originalOpen = XMLHttpRequest.prototype.open;
        var originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function (method, url) {
            this.__aitxUrl = String(url);
            sniffUrl(this.__aitxUrl);
            return originalOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            if (/^authorization$/i.test(name) && this.__aitxUrl && this.__aitxUrl.indexOf('api-v2.soundcloud.com') !== -1) {
                authHeader = value;
            }
            return originalSetHeader.apply(this, arguments);
        };
        patched.push(function () {
            XMLHttpRequest.prototype.open = originalOpen;
            XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
        });
    }

    function api(path) {
        if (!clientId) sniffFromPerformance();
        if (!clientId) return Promise.reject(new Error('no client_id seen yet'));
        var url = (path.indexOf('http') === 0 ? path : API + path) + (path.indexOf('?') === -1 ? '?' : '&') + 'client_id=' + clientId;
        var headers = authHeader ? { Authorization: authHeader } : {};
        return fetch(url, { headers: headers }).then(function (r) {
            if (!r.ok) throw new Error('api ' + r.status + ' for ' + path);
            return r.json();
        });
    }

    function resolveTrack(permalink) {
        if (trackCache.has(permalink)) return Promise.resolve(trackCache.get(permalink));
        return api('/resolve?url=' + encodeURIComponent(permalink)).then(function (track) {
            if (!track || track.kind !== 'track') throw new Error('not a track: ' + permalink);
            trackCache.set(permalink, track);
            return track;
        });
    }

    function pickTranscoding(track) {
        var list = (track.media && track.media.transcodings) || [];
        var plain = list.filter(function (t) {
            return t.format && (t.format.protocol === 'hls' || t.format.protocol === 'progressive') && !t.snipped;
        });
        // mp3 HLS decodes from any segment; AAC HLS needs its init segment; progressive is a whole file.
        var order = [
            function (t) { return t.format.protocol === 'hls' && /mpeg/.test(t.format.mime_type); },
            function (t) { return t.format.protocol === 'hls' && /mp4|aac/.test(t.format.mime_type); },
            function (t) { return t.format.protocol === 'progressive'; },
        ];
        for (var i = 0; i < order.length; i++) {
            var found = plain.find(order[i]);
            if (found) return found;
        }
        return null; // encrypted / Go+ only: no transition, SoundCloud plays as usual
    }

    function streamUrl(track, transcoding) {
        var path = transcoding.url + (track.track_authorization ? '?track_authorization=' + track.track_authorization : '');
        return api(path).then(function (r) {
            return r.url;
        });
    }

    // ---- audio fetching and decoding ----

    function parsePlaylist(text, base) {
        var lines = text.split('\n');
        var segments = [];
        var init = null;
        var t = 0;
        var duration = 0;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('#EXT-X-KEY') === 0 && !/METHOD=NONE/.test(line)) throw new Error('encrypted stream');
            if (line.indexOf('#EXT-X-MAP') === 0) {
                var uri = line.match(/URI="([^"]+)"/);
                if (uri) init = new URL(uri[1], base).href;
            } else if (line.indexOf('#EXTINF:') === 0) {
                duration = parseFloat(line.slice(8));
            } else if (line && line[0] !== '#') {
                segments.push({ url: new URL(line, base).href, start: t, end: t + duration });
                t += duration;
            }
        }
        return { init: init, segments: segments, duration: t };
    }

    function fetchBytes(url) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('segment ' + r.status);
            return r.arrayBuffer();
        });
    }

    function concat(buffers) {
        var size = buffers.reduce(function (n, b) { return n + b.byteLength; }, 0);
        var out = new Uint8Array(size);
        var offset = 0;
        buffers.forEach(function (b) {
            out.set(new Uint8Array(b), offset);
            offset += b.byteLength;
        });
        return out.buffer;
    }

    function decode(bytes) {
        var offline = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
        return offline.decodeAudioData(bytes);
    }

    // Returns { left, right, sampleRate } covering exactly [from, from + length) seconds of the track.
    function slice(audio, skipSeconds, lengthSeconds) {
        var start = Math.max(0, Math.round(skipSeconds * SAMPLE_RATE));
        var length = Math.round(lengthSeconds * SAMPLE_RATE);
        var left = new Float32Array(length);
        var right = new Float32Array(length);
        var l = audio.getChannelData(0);
        var r = audio.numberOfChannels > 1 ? audio.getChannelData(1) : l;
        left.set(l.subarray(start, Math.min(l.length, start + length)));
        right.set(r.subarray(start, Math.min(r.length, start + length)));
        return { left: left, right: right, sampleRate: SAMPLE_RATE };
    }

    function fetchRange(track, from, to) {
        var transcoding = pickTranscoding(track);
        if (!transcoding) return Promise.reject(new Error('no unencrypted stream'));
        return streamUrl(track, transcoding).then(function (url) {
            if (transcoding.format.protocol === 'progressive') {
                return fetchBytes(url).then(decode).then(function (audio) {
                    return slice(audio, from, to - from);
                });
            }
            return fetch(url)
                .then(function (r) { return r.text(); })
                .then(function (text) {
                    var playlist = parsePlaylist(text, url);
                    var wanted = playlist.segments.filter(function (s) {
                        return s.end > from - FETCH_MARGIN && s.start < to + FETCH_MARGIN;
                    });
                    if (!wanted.length) throw new Error('no segments for range');
                    var urls = (playlist.init ? [playlist.init] : []).concat(wanted.map(function (s) { return s.url; }));
                    return Promise.all(urls.map(fetchBytes)).then(function (parts) {
                        return decode(concat(parts)).then(function (audio) {
                            return slice(audio, from - wanted[0].start, to - from);
                        });
                    });
                });
        });
    }

    // ---- page state: current element, current and next track ----

    function isAudio(el) {
        return el && typeof HTMLMediaElement !== 'undefined' && el instanceof HTMLMediaElement;
    }

    function remember(el) {
        if (!isAudio(el) || media.has(el)) return el;
        media.add(el);
        if (media.size > 8) media.delete(media.values().next().value);
        return el;
    }

    function patchMedia() {
        var proto = HTMLMediaElement.prototype;
        var originalPlay = proto.play;
        proto.play = function () {
            remember(this);
            onElementPlay(this);
            return originalPlay.apply(this, arguments);
        };
        patched.push(function () {
            proto.play = originalPlay;
        });
        document.querySelectorAll('audio').forEach(remember);
    }

    function activeElement() {
        var best = null;
        media.forEach(function (el) {
            if (!el.paused && !el.ended && (!best || el.currentTime > 0)) best = el;
        });
        return best;
    }

    function currentPermalink() {
        var link = document.querySelector('.playbackSoundBadge__titleLink');
        return link ? link.href.split('?')[0] : null;
    }

    function queueItems() {
        return Array.prototype.slice.call(document.querySelectorAll('.queue .queueItemView'));
    }

    function readNextFromQueue() {
        var items = queueItems();
        var index = items.findIndex(function (item) {
            return /\bm-(active|playing)\b/.test(item.className);
        });
        if (index === -1 || index + 1 >= items.length) return null;
        var link = items[index + 1].querySelector('.queueItemView__title a, a.queueItemView__title, a[href]');
        return link ? link.href.split('?')[0] : null;
    }

    function queueButton() {
        // Only the "Next up" toggle: broader selectors also match the panel's "Clear" button and would wipe the queue.
        return document.querySelector('.playbackSoundBadge__showQueue');
    }

    // The queue list only exists in the DOM after the panel is opened once; open it invisibly and close it again.
    function nextTrackPermalink() {
        var next = readNextFromQueue();
        if (next || queueItems().length) return Promise.resolve(next);
        var button = queueButton();
        if (!button) return Promise.resolve(null);
        if (!queueStyle) {
            queueStyle = document.createElement('style');
            queueStyle.textContent = '.queue{opacity:0!important;pointer-events:none!important}';
        }
        document.head.appendChild(queueStyle);
        button.click();
        return new Promise(function (resolve) {
            setTimeout(function () {
                var found = readNextFromQueue();
                button.click();
                setTimeout(function () {
                    queueStyle.remove();
                }, 400);
                resolve(found);
            }, 600);
        });
    }

    function audioContext() {
        if (!ctx) ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    // ---- the transition itself ----

    function reset(reason) {
        if (reason) log('reset:', reason);
        state = { phase: 'idle', trackUrl: null, nextUrl: null, mix: null, kind: null };
    }

    function prepare(trackUrl, durationSeconds) {
        state = { phase: 'preparing', trackUrl: trackUrl, nextUrl: null, mix: null, kind: null };
        var started = Date.now();
        nextTrackPermalink()
            .then(function (nextUrl) {
                if (!nextUrl || nextUrl === trackUrl) throw new Error('no next track in queue');
                state.nextUrl = nextUrl;
                return Promise.all([resolveTrack(trackUrl), resolveTrack(nextUrl)]);
            })
            .then(function (tracks) {
                var a = tracks[0];
                var b = tracks[1];
                var aDuration = (a.full_duration || a.duration) / 1000 || durationSeconds;
                return Promise.all([
                    fetchRange(a, aDuration - WINDOW_SECONDS, aDuration),
                    fetchRange(b, 0, WINDOW_SECONDS),
                ]);
            })
            .then(function (parts) {
                if (state.trackUrl !== trackUrl) return;
                return window.soundcloudAPI.aiTransitionRender(parts[0], parts[1]).then(function (result) {
                    if (state.trackUrl !== trackUrl) return;
                    var c = audioContext();
                    var buffer = c.createBuffer(2, result.mix.left.length, result.mix.sampleRate);
                    buffer.copyToChannel(result.mix.left, 0);
                    buffer.copyToChannel(result.mix.right, 1);
                    state.mix = buffer;
                    state.kind = result.kind;
                    state.phase = 'ready';
                    log('ready:', result.kind, 'in', Date.now() - started, 'ms (model', result.ms, 'ms)');
                });
            })
            .catch(function (error) {
                if (state.trackUrl === trackUrl) state.phase = 'skipped';
                log('skipping this transition:', error && error.message ? error.message : error);
            });
    }

    function setVolume(el, value) {
        try {
            el.volume = Math.max(0, Math.min(1, value));
        } catch (e) {}
    }

    function startMix(el, remaining) {
        var c = audioContext();
        var source = c.createBufferSource();
        var gain = c.createGain();
        var volume = el.volume;
        source.buffer = state.mix;
        gain.gain.value = volume;
        source.connect(gain).connect(c.destination);
        var offset = Math.max(0, WINDOW_SECONDS - remaining);
        var startAt = c.currentTime + 0.02;
        source.start(startAt, offset);
        setVolume(el, 0);
        mixing = {
            source: source,
            gain: gain,
            volume: volume,
            from: el,
            next: null,
            nextUrl: state.nextUrl,
            startAt: startAt - offset,
            done: false,
        };
        source.onended = finishMix;
        state.phase = 'mixing';
        log('mixing', state.kind, 'offset', offset.toFixed(2));
    }

    function mixElapsed() {
        return mixing ? audioContext().currentTime - mixing.startAt : 0;
    }

    function onElementPlay(el) {
        if (!mixing || el === mixing.from) return;
        takeOverNext(el);
    }

    // SoundCloud started B (on a new element or by reusing A's): keep it silent and jump it to where our mix hands over.
    function takeOverNext(el) {
        if (!mixing || mixing.next === el) return;
        mixing.next = el;
        setVolume(el, 0);
        var seek = function () {
            if (!mixing || mixing.next !== el) return;
            var target = Math.min(WINDOW_SECONDS, mixElapsed() + 0.25);
            try {
                el.currentTime = target;
            } catch (e) {}
            setTimeout(function () {
                if (mixing && mixing.next === el && Math.abs(el.currentTime - mixElapsed()) > 1.5) seekWithTimeline(mixElapsed() + 0.3);
            }, 700);
        };
        if (el.readyState >= 1) setTimeout(seek, 0);
        else el.addEventListener('loadedmetadata', seek, { once: true });
    }

    // Fallback when the player ignores a direct currentTime change: click its own progress bar.
    function seekWithTimeline(seconds) {
        var bar = document.querySelector('.playbackTimeline__progressWrapper');
        var el = mixing && mixing.next;
        if (!bar || !el || !el.duration) return;
        var rect = bar.getBoundingClientRect();
        var x = rect.left + rect.width * Math.min(0.99, seconds / el.duration);
        var opts = { bubbles: true, clientX: x, clientY: rect.top + rect.height / 2 };
        bar.dispatchEvent(new MouseEvent('mousedown', opts));
        bar.dispatchEvent(new MouseEvent('mouseup', opts));
        bar.dispatchEvent(new MouseEvent('click', opts));
    }

    function finishMix() {
        if (!mixing || mixing.done) return;
        var m = mixing;
        m.done = true;
        mixing = null;
        var target = m.next || activeElement();
        if (target && target !== m.from) {
            // Short ramp from our mix into SoundCloud's own playback of B.
            var steps = 6;
            for (var i = 1; i <= steps; i++) {
                (function (k) {
                    setTimeout(function () {
                        setVolume(target, (m.volume * k) / steps);
                    }, k * 15);
                })(i);
            }
        }
        if (m.from !== target) setVolume(m.from, m.volume);
        reset();
    }

    function abortMix(reason) {
        if (!mixing) return;
        var m = mixing;
        mixing = null;
        try {
            m.source.onended = null;
            m.source.stop();
        } catch (e) {}
        setVolume(m.from, m.volume);
        if (m.next) setVolume(m.next, m.volume);
        reset(reason);
    }

    function parseClock(text) {
        if (!text) return NaN;
        return text
            .trim()
            .split(':')
            .reduce(function (total, part) {
                return total * 60 + parseFloat(part);
            }, 0);
    }

    function durationOf(el) {
        if (isFinite(el.duration) && el.duration > 0) return el.duration;
        var label = document.querySelector('.playbackTimeline__duration span:last-child');
        return parseClock(label && label.textContent);
    }

    function tick() {
        var trackUrl = currentPermalink();
        if (mixing) {
            var playing = activeElement();
            if (trackUrl && trackUrl === mixing.nextUrl && playing && !mixing.next) takeOverNext(playing);
            if (mixing.next) setVolume(mixing.next, 0);
            if (mixing.from.paused && !mixing.from.ended && !mixing.next) abortMix('paused during transition');
            else if (trackUrl && trackUrl !== mixing.nextUrl && trackUrl !== state.trackUrl) abortMix('user picked another track');
            return;
        }
        var el = activeElement();
        var duration = el ? durationOf(el) : NaN;
        if (!el || !trackUrl || !isFinite(duration) || duration < WINDOW_SECONDS * 3) return;
        if (state.trackUrl && state.trackUrl !== trackUrl) reset();
        var remaining = duration - el.currentTime;
        if (state.phase === 'idle' && remaining <= PREPARE_AT_REMAINING && remaining > WINDOW_SECONDS + 2) {
            prepare(trackUrl, duration);
        } else if (state.phase === 'ready' && remaining <= WINDOW_SECONDS && remaining > 0.5) {
            startMix(el, remaining);
        }
    }

    patchNetwork();
    patchMedia();
    sniffFromPerformance();
    tickTimer = setInterval(tick, 100);
    if (window.soundcloudAPI && window.soundcloudAPI.aiTransitionPrepareModel) {
        window.soundcloudAPI.aiTransitionPrepareModel().catch(function (e) {
            log('model download failed:', e && e.message);
        });
    }

    window.__scrpcAiTransition = {
        state: function () {
            return { phase: state.phase, kind: state.kind, next: state.nextUrl, mixing: !!mixing, clientId: !!clientId };
        },
    };
    window.__scrpc_cleanup_ai_transition = function () {
        clearInterval(tickTimer);
        abortMix('plugin disabled');
        patched.forEach(function (undo) {
            undo();
        });
        if (ctx) ctx.close();
        delete window.__scrpcAiTransition;
    };
    log('loaded');
}

module.exports = {
    onEnable() {
        console.log('AI Transition enabled');
    },

    onDisable() {
        console.log('AI Transition disabled');
    },

    contentScript() {
        return '(' + aiTransitionPage.toString() + ')();';
    },
};
