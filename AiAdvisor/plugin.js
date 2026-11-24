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
        // Вес записи по проценту досмотра (стартовая эвристика, не научные коэффициенты).
        // p < 0 или не задан: прогресс неизвестен, запись весит как раньше.
        function completionWeight(p) {
            if (p === undefined || p === null || p < 0) return 1;
            if (p >= 90) return 1;
            if (p >= 70) return 0.8;
            if (p >= 40) return 0.45;
            if (p >= 15) return 0.15;
            return 0.05;
        }

        function buildProfile(items) {
            var sorted = items.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
            var genres = {};
            var langs = {};
            sorted.forEach(function (it, rank) {
                var w = (1 / (1 + 0.05 * rank)) * completionWeight(it.p);
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
        // Нет русской локализации: название без кириллицы совпадает с оригинальным, а оригинал не английский
        // (английские названия без перевода допустимы)
        function untranslated(cand) {
            var title = String(cand.title || cand.name || '').trim();
            var orig = String(cand.original_title || cand.original_name || '').trim();
            var lang = String(cand.original_language || '').toLowerCase();
            if (!title || !orig || lang === 'en' || lang === 'ru') return false;
            return !/[а-яё]/i.test(title) && title === orig;
        }

        function score(cand, ctx) {
            var prefs = ctx.prefs;
            var profile = ctx.profile;
            var gs = genreIds(cand);
            var year = yearOf(cand);
            var lang = String(cand.original_language || '').toLowerCase();
            var votes = cand.vote_count || 0;
            var rating = cand.vote_average || 0;

            if (ctx.watched && ctx.watched[seenKey(mediaOf(cand), cand.id)]) return null;
            if (untranslated(cand)) return null;
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
            // hits: сумма весов источников (рекомендации и похожие на просмотренное весят до 1,
            // общая подборка по жанрам 0,2), поэтому «следствие истории» обгоняет просто популярное
            s += 2.5 * Math.min(cand.hits || 0, 4);

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

        // История Lampa хранит урезанные карточки без жанров. details: ответ TMDB tv/{id} или movie/{id}.
        // Возвращает новую запись журнала с жанрами, языком, категорией; null, если жанров нет.
        function enrich(item, details) {
            if (!item || !details) return null;

            var card = {
                id: item.id,
                media_type: item.media,
                genres: details.genres,
                genre_ids: details.genre_ids,
                original_language: details.original_language || item.l,
                origin_country: details.origin_country,
                production_countries: details.production_countries,
                release_date: details.release_date,
                first_air_date: details.first_air_date
            };

            var g = genreIds(card);
            if (!g.length) return null;

            var out = {};
            for (var k in item) out[k] = item[k];
            out.g = g.slice(0, 10);
            out.l = String(card.original_language || '').toLowerCase().slice(0, 8);
            out.cat = categoryOf(card);
            out.y = yearOf(card) || item.y || 0;
            return out;
        }

        // Сводка по истории группы для экрана настроек
        function describe(items) {
            var total = items.length;
            var withGenres = 0;
            var gc = {};
            var lc = {};
            var years = [];

            items.forEach(function (it) {
                if (it.g && it.g.length) {
                    withGenres++;
                    it.g.forEach(function (g) { gc[g] = (gc[g] || 0) + 1; });
                }
                if (it.l) lc[it.l] = (lc[it.l] || 0) + 1;
                if (it.y) years.push(it.y);
            });

            function top(map, limit, denom) {
                return Object.keys(map).map(function (key) {
                    return { key: key, count: map[key], share: denom ? map[key] / denom : 0 };
                }).sort(function (a, b) { return b.count - a.count; }).slice(0, limit);
            }

            years.sort(function (a, b) { return a - b; });

            return {
                count: total,
                withGenres: withGenres,
                genres: top(gc, 8, withGenres).map(function (g) {
                    return { id: toInt(g.key), name: GENRES[g.key] || String(g.key), share: g.share };
                }),
                langs: top(lc, 3, total).map(function (l) { return { code: l.key, share: l.share }; }),
                years: years.length ? { from: years[0], to: years[years.length - 1], median: years[Math.floor(years.length / 2)] } : null
            };
        }

        // Самые весомые жанры профиля без служебного «мультфильм» (16)
        function topGenres(profile, limit) {
            return Object.keys(profile.genres).map(toInt).filter(function (g) { return g !== 16; })
                .sort(function (a, b) { return profile.genres[b] - profile.genres[a]; })
                .slice(0, limit);
        }

        return {
            CATS: CATS,
            describe: describe,
            topGenres: topGenres,
            enrich: enrich,
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
            untranslated: untranslated,
            completionWeight: completionWeight,
            rank: rank
        };
    })();

    if (typeof module !== 'undefined' && module.exports) module.exports = Core;
    if (typeof Lampa === 'undefined') return;

    // Плагин могут подключить дважды (customPlugins и расширения Lampa): без этой защиты
    // ряды и настройки регистрируются по два раза
    if (window.aiadvisor_loaded) return;
    window.aiadvisor_loaded = true;
    window.aiadvisor_version = '0.9';

    // =====================================================================
    //  Часть Lampa
    // =====================================================================
    var VERSION = '0.9';
    var HOST = '{localhost}';
    var TOKEN = '{token}';
    var CACHE_HOURS = 6;
    var SEEDS = 8;
    var PARALLEL = 4;
    var ENRICH_MAX = 40;

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
                        r._w = req.weight || 1;
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

    // Процент досмотра по таймлайну Lampa: -1 — неизвестно.
    // Сериал: серии 1–24 первого сезона (3 и больше серий считаем полным интересом), 0 — неизвестно
    // (мог смотреться другой сезон). Фильм: процент просмотра, 0 — почти не смотрел.
    function completionOf(card, media) {
        try {
            if (!Lampa.Timeline || typeof Lampa.Timeline.watched !== 'function') return -1;
            if (!card.original_name && !card.original_title) return -1;
            var v = Lampa.Timeline.watched(card, true);
            if (media === 'tv') {
                if (!v || !v.length) return -1;
                if (v.length >= 3) return 100;
                return Math.max.apply(null, v.map(function (e) { return (e.view && e.view.percent) || 0; }));
            }
            return (v && v.percent) || 0;
        } catch (e) {
            return -1;
        }
    }

    function snapshotHistory() {
        var history = [];
        try { history = Lampa.Favorite.get({ type: 'history' }) || []; } catch (e) { /* нет истории */ }
        var now = Date.now();
        var out = [];
        history.forEach(function (card, rank) {
            var item = Core.toSeen(card, now - rank * 60000);
            if (item) {
                item.p = completionOf(card, item.media);
                out.push(item);
            }
        });
        return out;
    }

    function postJournal(items, force) {
        if (!items.length) return;
        if (!force && Date.now() - lastPost < 60000) return;
        lastPost = Date.now();
        var net = new Lampa.Reguest();
        net.silent(apiUrl('/aiadvisor/seen'), function () { }, function () { }, JSON.stringify(items), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    function hasGenres(it) {
        return !!(it && it.g && it.g.length);
    }

    // Журнал сервера и снимок истории в один словарь media:id. Снимок свежее, но карточки истории
    // урезаны (без жанров): такая запись не затирает обогащённую из журнала, только обновляет время.
    function mergeMap(serverSeen, snapshot) {
        var map = {};
        Core.CATS.forEach(function (cat) {
            (serverSeen[cat] || []).forEach(function (it) { map[Core.seenKey(it.media, it.id)] = it; });
        });
        snapshot.forEach(function (it) {
            var k = Core.seenKey(it.media, it.id);
            var old = map[k];
            if (hasGenres(old) && !hasGenres(it)) {
                old.ts = Math.max(old.ts || 0, it.ts);
                if (it.p !== undefined) old.p = it.p;
                return;
            }
            if (!old || (old.ts || 0) < it.ts || (!hasGenres(old) && hasGenres(it))) {
                if (old && it.p === undefined && old.p !== undefined) it.p = old.p;
                map[k] = it;
            }
        });
        return map;
    }

    function group(map) {
        var byCat = { anime: [], cartoon: [], tv: [], movie: [] };
        var watched = {};
        for (var k in map) {
            watched[k] = true;
            if (byCat[map[k].cat]) byCat[map[k].cat].push(map[k]);
        }
        return { byCat: byCat, watched: watched };
    }

    // Дозапрос жанров у TMDB для записей без них: до ENRICH_MAX за раз, самые свежие первыми.
    // Записи, по которым TMDB жанров не дал, неделю не перепроверяются.
    function enrichMissing(map, done) {
        var skip = Lampa.Storage.get('aiadvisor_enrich_skip', '');
        if (!skip || typeof skip !== 'object') skip = {};
        var now = Date.now();

        var todo = [];
        for (var k in map) {
            if (hasGenres(map[k])) continue;
            if (skip[k] && now - skip[k] < 7 * 86400000) continue;
            todo.push(map[k]);
        }
        todo.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
        todo = todo.slice(0, ENRICH_MAX);
        if (!todo.length) return done([]);

        var changed = [];
        var left = todo.length;

        function finish() {
            if (--left === 0) {
                Lampa.Storage.set('aiadvisor_enrich_skip', skip);
                done(changed);
            }
        }

        todo.forEach(function (it) {
            var key = Core.seenKey(it.media, it.id);
            enqueue(function (release) {
                tmdbGet(it.media + '/' + it.id, {}, function (json) {
                    var fresh = Core.enrich(it, json);
                    if (fresh) {
                        map[key] = fresh;
                        changed.push(fresh);
                    } else {
                        skip[key] = now;
                    }
                    release();
                    finish();
                }, function () {
                    release();
                    finish();
                });
            });
        });
    }

    // Общая подготовка для всех рядов: четыре ряда запрашиваются одновременно, а журнал,
    // снимок и дозапрос жанров нужны один раз
    var preparing = null;
    var prepared = null;

    function prepare(cb) {
        if (prepared && Date.now() - prepared.ts < 30000) return cb(prepared.data);
        if (preparing) return preparing.push(cb);
        preparing = [cb];

        loadJournal(function (journal) {
            var snapshot = snapshotHistory();
            var map = mergeMap(journal.seen || {}, snapshot);

            enrichMissing(map, function (changed) {
                var post = {};
                changed.forEach(function (it) { post[Core.seenKey(it.media, it.id)] = it; });
                snapshot.forEach(function (it) {
                    var k = Core.seenKey(it.media, it.id);
                    post[k] = map[k] || it;
                });
                var list = [];
                for (var k in post) list.push(post[k]);
                postJournal(list, changed.length > 0);

                var grouped = group(map);
                var data = { journal: journal, snapshot: snapshot, merged: grouped, enriched: changed.length };
                prepared = { ts: Date.now(), data: data };

                var waiters = preparing;
                preparing = null;
                waiters.forEach(function (f) { f(data); });
            });
        });
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
    function discoverFilter(cat, prefs, profile, lang) {
        var filter = { sort_by: 'popularity.desc', 'vote_count.gte': 100 };

        var liked = prefs.liked.filter(function (g) { return g !== 16; });
        if (!liked.length) liked = Core.topGenres(profile, 3);

        if (cat === 'anime' || cat === 'cartoon') {
            filter.with_genres = liked.length ? '16,' + liked[0] : '16';
        } else if (liked.length) {
            filter.with_genres = liked.slice(0, 3).join('|');
        }

        if (lang) filter.with_original_language = lang;
        if (prefs.year_from) {
            filter['primary_release_date.gte'] = prefs.year_from + '-01-01';
            filter['first_air_date.gte'] = prefs.year_from + '-01-01';
        }
        return filter;
    }

    function buildRequests(cat, prefs, profile) {
        var requests = [];
        profile.seeds.slice(0, SEEDS).forEach(function (seed, rank) {
            seed.weight = 1 / (1 + 0.05 * rank);
            ['recommendations', 'similar'].forEach(function (kind) {
                requests.push({ method: seed.media + '/' + seed.id + '/' + kind, params: {}, media: seed.media, weight: seed.weight });
            });
        });

        // Языки общей подборки: из настроек; для аниме без настроек японский, китайский и корейский
        // (аниме не обязательно японское); для остальных групп без настроек язык не ограничиваем
        var langs = prefs.langs.length ? prefs.langs.slice(0, 4) : (cat === 'anime' ? ['ja', 'zh', 'ko'] : [null]);

        var medias = cat === 'tv' ? ['tv'] : cat === 'movie' ? ['movie'] : ['tv', 'movie'];
        medias.forEach(function (media) {
            langs.forEach(function (lang) {
                requests.push({
                    method: 'discover/' + media,
                    params: { filter: discoverFilter(cat, prefs, profile, lang) },
                    media: media,
                    weight: 0.2
                });
            });
        });
        return requests;
    }

    function recommend(cat, cb, debug) {
        var prefs = Core.normalizePrefs(rawPrefs(cat));
        if (!prefs.enabled) return cb([]);

        prepare(function (data) {
            var journal = data.journal;
            var snapshot = data.snapshot;
            var merged = data.merged;
            var items = merged.byCat[cat] || [];
            var sig = JSON.stringify(rawPrefs(cat)) + '|' + items.slice(0, SEEDS).map(function (i) { return i.media + i.id; }).join(',');

            var cached = cacheGet(cat, sig);
            if (cached) return cb(cached);

            var profile = Core.buildProfile(items);

            if (debug) {
                console.log('[aiadvisor] версия', VERSION);
                console.log('[aiadvisor] история Lampa:', snapshot.length, 'записей; дозапрошено жанров:', data.enriched, '; после обогащения по категориям:',
                    Core.CATS.map(function (c) { return c + '=' + (merged.byCat[c] || []).length; }).join(' '));
                console.log('[aiadvisor] категория', cat, ': записей', items.length, '; опорные:',
                    profile.seeds.slice(0, SEEDS).map(function (i) { return i.t + ' (' + i.media + ' ' + i.id + ')'; }).join(' | '));
                console.log('[aiadvisor] жанры профиля:', JSON.stringify(profile.genres), 'языки:', JSON.stringify(profile.langs));
            }

            fetchAll(buildRequests(cat, prefs, profile), function (raw) {
                var map = {};
                raw.forEach(function (r) {
                    var k = Core.seenKey(Core.mediaOf(r), r.id);
                    var w = r._w || 1;
                    delete r._w;
                    if (map[k]) map[k].hits += w;
                    else { r.hits = w; map[k] = r; }
                });

                var cands = [];
                var skippedTimeline = 0;
                for (var k2 in map) {
                    // карточка из рекомендаций должна принадлежать той же категории
                    if (Core.categoryOf(map[k2]) !== cat) continue;
                    // просмотренное по таймлайну Lampa в рекомендации не попадает
                    if (timelineWatched(map[k2])) { skippedTimeline++; continue; }
                    cands.push(map[k2]);
                }

                var rankCtx = {
                    prefs: prefs,
                    profile: profile,
                    watched: merged.watched,
                    currentYear: new Date().getFullYear()
                };
                var results = Core.rank(cands, rankCtx, 20);

                if (debug) {
                    console.log('[aiadvisor] запросов к TMDB:', raw.length ? 'получено ' + raw.length + ' карточек' : 'пусто', '; кандидатов категории:', cands.length, '; исключено по таймлайну:', skippedTimeline);
                    console.log('[aiadvisor] итог:', results.map(function (c) {
                        return (c.title || c.name) + ' [hits ' + Math.round(c.hits * 10) / 10 + ', score ' + Math.round(Core.score(c, rankCtx) * 10) / 10 + ']';
                    }).join(' | '));
                }

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
        setTimeout(refreshInfo, 200);
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

    function genreNames(ids) {
        return ids.map(function (id) { return Core.GENRES[id] || String(id); }).join(', ');
    }

    function percent(share) {
        return Math.round(share * 100) + '%';
    }

    // Что плагин определил по истории группы
    function infoText(cat, items) {
        var d = Core.describe(items);
        if (!d.count) return 'В истории пока нет записей этой группы';

        var skip = (cat === 'anime' || cat === 'cartoon') ? 16 : 0;
        var genres = d.genres.filter(function (g) { return g.id !== skip; }).slice(0, 5).map(function (g) {
            return g.name + ' ' + percent(g.share);
        });
        var langs = d.langs.map(function (l) { return l.code + ' ' + percent(l.share); });

        var parts = ['Записей: ' + d.count];
        if (genres.length) parts.push('жанры: ' + genres.join(', '));
        if (langs.length) parts.push('языки: ' + langs.join(', '));
        if (d.years) parts.push('годы: ' + d.years.from + '–' + d.years.to + ', чаще около ' + d.years.median);
        if (d.withGenres < d.count) parts.push('жанры определены для ' + d.withGenres + ' из ' + d.count + ', остальное дозагрузится');
        return parts.join(' · ');
    }

    // Какие значения реально используются при подборе: настройки, а где они пусты, выводы из истории
    function effectiveText(cat, items) {
        var prefs = Core.normalizePrefs(rawPrefs(cat));
        var profile = Core.buildProfile(items);
        var top = Core.topGenres(profile, 3);
        var parts = [];

        if (prefs.liked.length) parts.push('любимые жанры: ' + genreNames(prefs.liked) + ' (из настроек)');
        else if (top.length) parts.push('любимые жанры: ' + genreNames(top) + ' (из истории)');
        else parts.push('любимые жанры: пока не определены');

        if (prefs.langs.length) parts.push('языки: ' + prefs.langs.join(', ') + ' (из настроек)');
        else if (cat === 'anime') parts.push('языки подборки: ja, zh, ko; в оценке выше языки из истории');
        else parts.push('языки: любые; в оценке выше языки из истории');

        parts.push('рейтинг: ' + (prefs.min_rating ? 'от ' + prefs.min_rating : 'любой'));
        parts.push('год: ' + (prefs.year_from ? 'не старше ' + prefs.year_from : 'любой'));
        if (prefs.disliked.length) parts.push('скрываю жанры: ' + genreNames(prefs.disliked));
        if (prefs.stop.length) parts.push('стоп-слов: ' + prefs.stop.length);
        return parts.join(' · ');
    }

    // Просмотр по таймлайну Lampa (прогресс серий/фильма) есть и у тех, кого нет в «Истории».
    // Lampa.Timeline.watched: сериал — серии 1–24 первого сезона по original_name, фильм — по original_title.
    function timelineWatched(card) {
        try {
            if (!Lampa.Timeline || typeof Lampa.Timeline.watched !== 'function') return false;
            if (!card.original_name && !card.original_title) return false;
            var v = Lampa.Timeline.watched(card);
            return Core.mediaOf(card) === 'tv' ? v > 0 : v >= 30;
        } catch (e) {
            return false;
        }
    }

    var settingsBody = null;
    var INFO_NAME = 'что видно в истории';
    var NOW_NAME = 'сейчас применяется';

    // Строки типа static в Lampa рисуются без data-name: ищем по тексту заголовка
    function setDescr(name, text) {
        var root = settingsBody && (settingsBody[0] || settingsBody);
        if (!root || !root.querySelectorAll) return;
        var rows = root.querySelectorAll('.settings-param[data-static="true"]');
        for (var i = 0; i < rows.length; i++) {
            var n = rows[i].querySelector('.settings-param__name');
            if (n && n.textContent.trim() === name) {
                var d = rows[i].querySelector('.settings-param__descr');
                if (d) d.textContent = text;
                return;
            }
        }
    }

    function refreshInfo() {
        if (!settingsBody) return;
        prepare(function (data) {
            Core.CATS.forEach(function (cat) {
                var items = data.merged.byCat[cat] || [];
                setDescr(Core.CAT_TITLES[cat] + ': ' + INFO_NAME, infoText(cat, items));
                setDescr(Core.CAT_TITLES[cat] + ': ' + NOW_NAME, effectiveText(cat, items));
            });
        });
    }

    function registerSettings() {
        if (!Lampa.SettingsApi) return;

        if (Lampa.Settings && Lampa.Settings.listener && typeof Lampa.Settings.listener.follow === 'function') {
            Lampa.Settings.listener.follow('open', function (e) {
                if (e && e.name === 'aiadvisor') {
                    settingsBody = e.body;
                    refreshInfo();
                }
            });
        }

        Lampa.SettingsApi.addComponent({
            component: 'aiadvisor',
            name: 'Рекомендации для вас',
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.5 5.5L20 9.3l-4 4 1 5.7-5-2.7-5 2.7 1-5.7-4-4 5.5-.8z"></path></svg>'
        });

        // Версия плагина: текст задан сразу, не зависит от загрузки данных
        Lampa.SettingsApi.addParam({
            component: 'aiadvisor',
            param: { name: 'aiadvisor_version', type: 'static' },
            field: { name: 'Версия плагина', description: VERSION }
        });

        Core.CATS.forEach(function (cat) {
            var t = Core.CAT_TITLES[cat];

            Lampa.SettingsApi.addParam({
                component: 'aiadvisor',
                param: { name: 'aiadvisor_title_' + cat, type: 'title' },
                field: { name: t }
            });

            // Только для информации: заполняется при открытии раздела (refreshInfo)
            Lampa.SettingsApi.addParam({
                component: 'aiadvisor',
                param: { name: 'aiadvisor_info_' + cat, type: 'static' },
                field: { name: t + ': ' + INFO_NAME, description: 'Загрузка…' }
            });

            Lampa.SettingsApi.addParam({
                component: 'aiadvisor',
                param: { name: 'aiadvisor_now_' + cat, type: 'static' },
                field: { name: t + ': ' + NOW_NAME, description: 'Загрузка…' }
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

    // Диагностика в консоли браузера: aiadvisorDebug('anime') | 'cartoon' | 'tv' | 'movie'
    window.aiadvisorDebug = function (cat) {
        cat = cat || 'anime';
        Lampa.Storage.set(storageKey(cat, 'cache'), '');
        lastPost = 0;
        prepared = null;
        recommend(cat, function (results) {
            console.log('[aiadvisor] готово,', results.length, 'карточек');
        }, true);
    };

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
