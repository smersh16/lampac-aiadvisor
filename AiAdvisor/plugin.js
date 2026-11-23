(function () {
    'use strict';

    // =====================================================================
    //  Ядро: чистые функции без обращений к Lampa (проверяются в tests/core.test.js)
    // =====================================================================
    var Core = (function () {
        var CATS = ['anime', 'cartoon', 'tv', 'movie'];

        var CAT_TITLES = {
            anime: 'Аниме',
            cartoon: 'Мультфильмы',
            tv: 'Сериалы',
            movie: 'Фильмы'
        };

        // id и русские названия жанров TMDB: список взят из клиента Lampa (app.js)
        var GENRES = {
            28: 'боевик', 12: 'приключения', 16: 'мультфильм', 35: 'комедия', 80: 'криминал',
            99: 'документальный', 18: 'драма', 10751: 'семейный', 14: 'фэнтези', 36: 'история',
            27: 'ужасы', 10402: 'музыка', 9648: 'детектив', 10749: 'мелодрама', 878: 'фантастика',
            10770: 'телевизионный фильм', 53: 'триллер', 10752: 'военный', 37: 'вестерн',
            10759: 'боевик и приключения', 10762: 'детский', 10763: 'новости', 10764: 'реалити-шоу',
            10765: 'нф и фэнтези', 10766: 'мыльная опера', 10767: 'ток-шоу', 10768: 'война и политика'
        };

        // Страны и языки, по которым карточка считается аниме (как в lampac-aniskip: JP, CN, KR)
        var ANIME_COUNTRIES = ['JP', 'CN', 'KR'];
        var ANIME_LANGS = ['ja', 'zh', 'cn', 'ko'];

        function toInt(v) {
            var n = parseInt(v, 10);
            return isNaN(n) ? 0 : n;
        }

        function mediaOf(card) {
            if (!card) return 'movie';
            if (card.media_type === 'tv' || card.media_type === 'movie') return card.media_type;
            if (card.first_air_date || card.number_of_seasons || card.seasons) return 'tv';
            if (card.name && !card.title) return 'tv';
            return 'movie';
        }

        function genreIds(card) {
            var out = [];
            if (card && Array.isArray(card.genre_ids)) {
                card.genre_ids.forEach(function (g) { out.push(toInt(g)); });
            } else if (card && Array.isArray(card.genres)) {
                card.genres.forEach(function (g) { out.push(toInt(g && typeof g === 'object' ? g.id : g)); });
            }
            return out.filter(function (g) { return g > 0; });
        }

        function countries(card) {
            var out = [];
            if (card && Array.isArray(card.origin_country)) {
                card.origin_country.forEach(function (c) { out.push(String(c).toUpperCase()); });
            }
            if (!out.length && card && Array.isArray(card.production_countries)) {
                card.production_countries.forEach(function (c) {
                    if (c && c.iso_3166_1) out.push(String(c.iso_3166_1).toUpperCase());
                });
            }
            return out;
        }

        function categoryOf(card) {
            var animation = genreIds(card).indexOf(16) >= 0;
            if (animation) {
                var lang = String((card && card.original_language) || '').toLowerCase();
                var cs = countries(card);
                var byCountry = cs.some(function (c) { return ANIME_COUNTRIES.indexOf(c) >= 0; });
                if (byCountry || ANIME_LANGS.indexOf(lang) >= 0) return 'anime';
                return 'cartoon';
            }
            return mediaOf(card) === 'tv' ? 'tv' : 'movie';
        }

        function yearOf(card) {
            var d = (card && (card.release_date || card.first_air_date)) || '';
            return toInt(String(d).slice(0, 4));
        }

        function titleOf(card) {
            return String((card && (card.title || card.name || card.original_title || card.original_name)) || '');
        }

        // Компактная запись для журнала на сервере
        function toSeen(card, ts) {
            if (!card || !toInt(card.id)) return null;
            return {
                id: toInt(card.id),
                media: mediaOf(card),
                cat: categoryOf(card),
                t: titleOf(card).slice(0, 200),
                y: yearOf(card),
                g: genreIds(card).slice(0, 10),
                l: String(card.original_language || '').toLowerCase().slice(0, 8),
                ts: ts
            };
        }

        function seenKey(media, id) {
            return media + ':' + id;
        }

        // ------------------------------------------------------------------
        //  Предпочтения
        // ------------------------------------------------------------------
        function splitList(text) {
            return String(text || '').split(/[,;\n]+/).map(function (s) {
                return s.trim().toLowerCase();
            }).filter(Boolean);
        }

        // У сериалов TMDB свои жанры («Боевик и Приключения», «НФ и Фэнтези»): слово пользователя
        // ищем как целое название или как целое слово внутри него («драма» не должна находить
        // «мелодрама»), а фантастику добавляем вручную
        var GENRE_ALIASES = { 'фантастика': [10765] };

        function genreIdsFromText(text) {
            var ids = [];
            function add(id) { if (ids.indexOf(id) < 0) ids.push(id); }

            splitList(text).forEach(function (word) {
                for (var id in GENRES) {
                    var name = GENRES[id];
                    if (name === word || name.split(/[\s\-]+/).indexOf(word) >= 0) add(toInt(id));
                }
                (GENRE_ALIASES[word] || []).forEach(add);
            });
            return ids.sort(function (a, b) { return a - b; });
        }

        function normalizePrefs(raw) {
            raw = raw || {};
            var minRating = parseFloat(String(raw.min_rating || '0').replace(',', '.'));
            return {
                enabled: raw.enabled !== false,
                liked: genreIdsFromText(raw.liked),
                disliked: genreIdsFromText(raw.disliked),
                stop: splitList(raw.stop),
                langs: splitList(raw.langs),
                min_rating: isNaN(minRating) ? 0 : minRating,
                year_from: toInt(raw.year_from)
            };
        }

        // ------------------------------------------------------------------
        //  Профиль вкуса по категории: вес жанров и языков, свежее просмотренное весит больше
        // ------------------------------------------------------------------
        function buildProfile(items) {
            var sorted = items.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
            var genres = {};
            var langs = {};
            sorted.forEach(function (it, rank) {
                var w = 1 / (1 + 0.05 * rank);
                (it.g || []).forEach(function (g) { genres[g] = (genres[g] || 0) + w; });
                if (it.l) langs[it.l] = (langs[it.l] || 0) + w;
            });
            return { genres: normalize(genres), langs: normalize(langs), seeds: sorted };
        }

        function normalize(map) {
            var max = 0;
            for (var k in map) if (map[k] > max) max = map[k];
            var out = {};
            if (!max) return out;
            for (var k2 in map) out[k2] = map[k2] / max;
            return out;
        }

        // ------------------------------------------------------------------
        //  Оценка кандидата. Вернуть null значит «исключить».
        //  cand: {id, media, title, original_title, overview, genre_ids, original_language,
        //         release_date|first_air_date, vote_average, vote_count, hits}
        // ------------------------------------------------------------------
        function score(cand, ctx) {
            var prefs = ctx.prefs;
            var profile = ctx.profile;
            var gs = genreIds(cand);
            var year = yearOf(cand);
            var lang = String(cand.original_language || '').toLowerCase();
            var votes = cand.vote_count || 0;
            var rating = cand.vote_average || 0;

            if (ctx.watched && ctx.watched[seenKey(mediaOf(cand), cand.id)]) return null;
            if (prefs.year_from && year && year < prefs.year_from) return null;
            if (prefs.min_rating && votes >= 50 && rating < prefs.min_rating) return null;

            for (var i = 0; i < gs.length; i++) {
                if (prefs.disliked.indexOf(gs[i]) >= 0) return null;
            }

            if (prefs.stop.length) {
                var hay = (titleOf(cand) + ' ' + (cand.original_title || cand.original_name || '') + ' ' + (cand.overview || '')).toLowerCase();
                for (var j = 0; j < prefs.stop.length; j++) {
                    if (hay.indexOf(prefs.stop[j]) >= 0) return null;
                }
            }

            var s = 0;
            s += Math.min(cand.hits || 0, 5);

            gs.forEach(function (g) {
                s += 2 * (profile.genres[g] || 0);
                if (prefs.liked.indexOf(g) >= 0) s += 1.5;
            });

            if (prefs.langs.length) s += prefs.langs.indexOf(lang) >= 0 ? 1.5 : -1;
            else s += profile.langs[lang] || 0;

            s += (rating / 10) * 2 + Math.log10(votes + 1) * 0.3;

            if (year && year >= ctx.currentYear - 3) s += 0.3;

            return s;
        }

        function rank(cands, ctx, limit) {
            var out = [];
            cands.forEach(function (c) {
                var s = score(c, ctx);
                if (s !== null) out.push({ card: c, score: s });
            });
            out.sort(function (a, b) { return b.score - a.score; });
            return out.slice(0, limit || 20).map(function (x) { return x.card; });
        }

        return {
            CATS: CATS,
            CAT_TITLES: CAT_TITLES,
            GENRES: GENRES,
            mediaOf: mediaOf,
            categoryOf: categoryOf,
            genreIds: genreIds,
            yearOf: yearOf,
            toSeen: toSeen,
            seenKey: seenKey,
            genreIdsFromText: genreIdsFromText,
            normalizePrefs: normalizePrefs,
            buildProfile: buildProfile,
            score: score,
            rank: rank
        };
    })();

    if (typeof module !== 'undefined' && module.exports) module.exports = Core;
    if (typeof Lampa === 'undefined') return;

    // =====================================================================
    //  Часть Lampa
    // =====================================================================
    var HOST = '{localhost}';
    var TOKEN = '{token}';
    var CACHE_HOURS = 6;
    var SEEDS = 8;
    var PARALLEL = 4;

    var ready = false;

    function apiUrl(path) {
        var url = HOST + path;
        var ids = {
            token: Lampa.Storage.get('token', '') || (TOKEN.charAt(0) === '{' ? '' : TOKEN),
            account_email: Lampa.Storage.get('account_email', ''),
            uid: Lampa.Storage.get('lampac_unic_id', '')
        };
        for (var name in ids) {
            if (ids[name]) url = Lampa.Utils.addUrlComponent(url, name + '=' + encodeURIComponent(ids[name]));
        }
        return url;
    }

    function storageKey(cat, name) {
        return 'aiadvisor_' + cat + '_' + name;
    }

    function rawPrefs(cat) {
        return {
            enabled: Lampa.Storage.get(storageKey(cat, 'enabled'), true) !== false,
            liked: Lampa.Storage.get(storageKey(cat, 'liked'), ''),
            disliked: Lampa.Storage.get(storageKey(cat, 'disliked'), ''),
            stop: Lampa.Storage.get(storageKey(cat, 'stop'), ''),
            langs: Lampa.Storage.get(storageKey(cat, 'langs'), ''),
            min_rating: Lampa.Storage.get(storageKey(cat, 'min_rating'), '0'),
            year_from: Lampa.Storage.get(storageKey(cat, 'year_from'), '')
        };
    }

    // ---- сеть: TMDB через встроенный источник Lampa (учитывает прокси и ключ) ----
    function tmdbGet(method, params, ok, fail) {
        try {
            Lampa.Api.sources.tmdb.get(method, params || {}, ok, fail);
        } catch (e) {
            fail && fail(e);
        }
    }

    var queue = [];
    var active = 0;

    function enqueue(job) {
        queue.push(job);
        pump();
    }

    function pump() {
        while (active < PARALLEL && queue.length) {
            active++;
            queue.shift()(function () {
                active--;
                pump();
            });
        }
    }

    function fetchAll(requests, done) {
        var results = [];
        var left = requests.length;
        if (!left) return done(results);

        requests.forEach(function (req) {
            enqueue(function (release) {
                tmdbGet(req.method, req.params, function (json) {
                    (json.results || []).forEach(function (r) {
                        r.media_type = req.media;
                        results.push(r);
                    });
                    release();
                    if (--left === 0) done(results);
                }, function () {
                    release();
                    if (--left === 0) done(results);
                });
            });
        });
    }

    // ---- журнал на сервере ----
    function loadJournal(cb) {
        var net = new Lampa.Reguest();
        net.timeout(15000);
        net.silent(apiUrl('/aiadvisor/data'), function (json) {
            cb(json && json.seen ? json : { seen: {}, prefs: {} });
        }, function () {
            cb({ seen: {}, prefs: {} });
        });
    }

    var lastPost = 0;

    function snapshotHistory() {
        var history = [];
        try { history = Lampa.Favorite.get({ type: 'history' }) || []; } catch (e) { /* нет истории */ }
        var now = Date.now();
        var out = [];
        history.forEach(function (card, rank) {
            var item = Core.toSeen(card, now - rank * 60000);
            if (item) out.push(item);
        });
        return out;
    }

    function postJournal(items) {
        if (!items.length || Date.now() - lastPost < 60000) return;
        lastPost = Date.now();
        var net = new Lampa.Reguest();
        net.silent(apiUrl('/aiadvisor/seen'), function () { }, function () { }, JSON.stringify(items), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    function mergeSeen(serverSeen, snapshot) {
        // snapshot актуальнее сервера: ключ media:id, берём большее ts
        var map = {};
        Core.CATS.forEach(function (cat) {
            var list = serverSeen[cat] || [];
            list.forEach(function (it) { map[Core.seenKey(it.media, it.id)] = it; });
        });
        snapshot.forEach(function (it) {
            var k = Core.seenKey(it.media, it.id);
            if (!map[k] || (map[k].ts || 0) < it.ts) map[k] = it;
        });
        var byCat = { anime: [], cartoon: [], tv: [], movie: [] };
        var watched = {};
        for (var k2 in map) {
            watched[k2] = true;
            if (byCat[map[k2].cat]) byCat[map[k2].cat].push(map[k2]);
        }
        return { byCat: byCat, watched: watched };
    }

    // ---- кэш результата на устройстве ----
    function cacheGet(cat, sig) {
        var c = Lampa.Storage.get(storageKey(cat, 'cache'), '');
        if (!c || typeof c !== 'object') return null;
        if (c.sig !== sig || Date.now() - c.ts > CACHE_HOURS * 3600 * 1000) return null;
        return c.results;
    }

    function cacheSet(cat, sig, results) {
        Lampa.Storage.set(storageKey(cat, 'cache'), { ts: Date.now(), sig: sig, results: results });
    }

    // ---- запросы кандидатов ----
    // В TMDB with_genres: запятая значит «И», вертикальная черта «ИЛИ», смешивать нельзя.
    // Аниме и мультфильмы: жанр 16 обязателен, к нему добавляем один любимый жанр через «И».
    // Сериалы и фильмы: любимые жанры (до трёх) через «ИЛИ».
    function discoverFilter(cat, prefs, profile) {
        var filter = { sort_by: 'popularity.desc', 'vote_count.gte': 100 };

        var liked = prefs.liked.filter(function (g) { return g !== 16; });
        if (!liked.length) {
            liked = Object.keys(profile.genres).map(Number).filter(function (g) { return g !== 16; })
                .sort(function (a, b) { return profile.genres[b] - profile.genres[a]; })
                .slice(0, 3);
        }

        if (cat === 'anime' || cat === 'cartoon') {
            filter.with_genres = liked.length ? '16,' + liked[0] : '16';
        } else if (liked.length) {
            filter.with_genres = liked.slice(0, 3).join('|');
        }

        if (cat === 'anime') filter.with_original_language = 'ja';
        if (prefs.year_from) {
            filter['primary_release_date.gte'] = prefs.year_from + '-01-01';
            filter['first_air_date.gte'] = prefs.year_from + '-01-01';
        }
        return filter;
    }

    function buildRequests(cat, prefs, profile) {
        var requests = [];
        profile.seeds.slice(0, SEEDS).forEach(function (seed) {
            ['recommendations', 'similar'].forEach(function (kind) {
                requests.push({ method: seed.media + '/' + seed.id + '/' + kind, params: {}, media: seed.media });
            });
        });

        var medias = cat === 'tv' ? ['tv'] : cat === 'movie' ? ['movie'] : ['tv', 'movie'];
        medias.forEach(function (media) {
            requests.push({
                method: 'discover/' + media,
                params: { filter: discoverFilter(cat, prefs, profile) },
                media: media
            });
        });
        return requests;
    }

    function recommend(cat, cb) {
        var prefs = Core.normalizePrefs(rawPrefs(cat));
        if (!prefs.enabled) return cb([]);

        loadJournal(function (journal) {
            var snapshot = snapshotHistory();
            postJournal(snapshot);

            var merged = mergeSeen(journal.seen || {}, snapshot);
            var items = merged.byCat[cat] || [];
            var sig = JSON.stringify(rawPrefs(cat)) + '|' + items.slice(0, SEEDS).map(function (i) { return i.media + i.id; }).join(',');

            var cached = cacheGet(cat, sig);
            if (cached) return cb(cached);

            var profile = Core.buildProfile(items);

            fetchAll(buildRequests(cat, prefs, profile), function (raw) {
                var map = {};
                raw.forEach(function (r) {
                    var k = Core.seenKey(Core.mediaOf(r), r.id);
                    if (map[k]) map[k].hits++;
                    else { r.hits = 1; map[k] = r; }
                });

                var cands = [];
                for (var k2 in map) {
                    // карточка из рекомендаций должна принадлежать той же категории
                    if (Core.categoryOf(map[k2]) === cat) cands.push(map[k2]);
                }

                var results = Core.rank(cands, {
                    prefs: prefs,
                    profile: profile,
                    watched: merged.watched,
                    currentYear: new Date().getFullYear()
                }, 20);

                cacheSet(cat, sig, results);
                cb(results);
            });
        });
    }

    // ---- ряды на главной ----
    function registerRows() {
        if (!Lampa.ContentRows || typeof Lampa.ContentRows.add !== 'function') return;

        Core.CATS.forEach(function (cat, i) {
            Lampa.ContentRows.add({
                name: 'aiadvisor_' + cat,
                title: 'Для вас: ' + Core.CAT_TITLES[cat],
                index: 1 + i,
                screen: ['main'],
                call: function () {
                    if (rawPrefs(cat).enabled === false) return;

                    return function (callback) {
                        recommend(cat, function (results) {
                            callback({ title: 'Для вас: ' + Core.CAT_TITLES[cat], results: results });
                        });
                    };
                }
            });
        });
    }

    // ---- настройки ----
    function pushPrefs() {
        var all = {};
        Core.CATS.forEach(function (cat) { all[cat] = rawPrefs(cat); });
        var net = new Lampa.Reguest();
        net.silent(apiUrl('/aiadvisor/prefs'), function () { }, function () { }, JSON.stringify(all), {
            headers: { 'Content-Type': 'application/json' }
        });
        Core.CATS.forEach(function (cat) { Lampa.Storage.set(storageKey(cat, 'cache'), ''); });
    }

    function pullPrefs(done) {
        var net = new Lampa.Reguest();
        net.timeout(15000);
        net.silent(apiUrl('/aiadvisor/data'), function (json) {
            var prefs = json && json.prefs;
            if (prefs) {
                Core.CATS.forEach(function (cat) {
                    var p = prefs[cat];
                    if (!p) return;
                    ['liked', 'disliked', 'stop', 'langs', 'min_rating', 'year_from'].forEach(function (name) {
                        if (p[name] !== undefined) Lampa.Storage.set(storageKey(cat, name), p[name]);
                    });
                    if (p.enabled !== undefined) Lampa.Storage.set(storageKey(cat, 'enabled'), p.enabled);
                });
            }
            done && done();
        }, function () { done && done(); });
    }

    function registerSettings() {
        if (!Lampa.SettingsApi) return;

        Lampa.SettingsApi.addComponent({
            component: 'aiadvisor',
            name: 'Рекомендации для вас',
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.5 5.5L20 9.3l-4 4 1 5.7-5-2.7-5 2.7 1-5.7-4-4 5.5-.8z"></path></svg>'
        });

        Core.CATS.forEach(function (cat) {
            var t = Core.CAT_TITLES[cat];

            Lampa.SettingsApi.addParam({
                component: 'aiadvisor',
                param: { name: 'aiadvisor_title_' + cat, type: 'title' },
                field: { name: t }
            });

            Lampa.SettingsApi.addParam({
                component: 'aiadvisor',
                param: { name: storageKey(cat, 'enabled'), type: 'trigger', default: true },
                field: { name: 'Показывать ряд на главной', description: 'Ряд «Для вас: ' + t + '»' },
                onChange: pushPrefs
            });

            [
                ['liked', 'Любимые жанры', 'Через запятую, например: драма, детектив'],
                ['disliked', 'Не показывать жанры', 'Через запятую, например: ужасы'],
                ['stop', 'Стоп-слова', 'Если слово есть в названии или описании, карточка скрывается'],
                ['langs', 'Языки оригинала', 'Коды через запятую, например: ja, ko. Пусто: любые'],
                ['year_from', 'Не старше года', 'Например: 2000. Пусто: без ограничения']
            ].forEach(function (p) {
                Lampa.SettingsApi.addParam({
                    component: 'aiadvisor',
                    param: { name: storageKey(cat, p[0]), type: 'input', values: '', default: '' },
                    field: { name: p[1], description: p[2] },
                    onChange: pushPrefs
                });
            });

            Lampa.SettingsApi.addParam({
                component: 'aiadvisor',
                param: {
                    name: storageKey(cat, 'min_rating'),
                    type: 'select',
                    values: { '0': 'Любой', '5': 'от 5', '6': 'от 6', '7': 'от 7', '8': 'от 8' },
                    default: '0'
                },
                field: { name: 'Минимальный рейтинг', description: 'Для карточек с достаточным числом голосов' },
                onChange: pushPrefs
            });
        });
    }

    function start() {
        if (ready) return;
        ready = true;
        registerSettings();
        registerRows();
        pullPrefs();
    }

    if (window.appready) start();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    }
})();
