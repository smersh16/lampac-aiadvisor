'use strict';

// Имитация Lampa: проверяет поток «история → запросы к TMDB → ранжирование → ряд на главной».
// Запуск: node tests/lampa-sim.test.js
const assert = require('assert');
const path = require('path');

const store = {};
const rows = [];
const settings = [];
const tmdbCalls = [];
const posts = [];
const openHandlers = [];
const rowsDom = {};
function makeBody() {
    // имитация DOM: строки static с заголовком и описанием
    const mk = (name) => rowsDom[name] || (rowsDom[name] = {
        descr: { textContent: 'Загрузка…' },
        querySelector(sel) { return sel.includes('name') ? { textContent: name } : this.descr; }
    });
    const names = [];
    settings.filter(p => p.param.type === 'static').forEach(p => names.push(p.field.name));
    return [{ querySelectorAll: () => names.map(mk) }];
}
const tmdbDetails = {
    'tv/92?append_to_response=credits,keywords': { vote_average: 5.46, created_by: [{ name: 'Автор Скучный' }], networks: [{ name: 'Сеть Х' }], origin_country: ['JP'], overview: 'Скучный   сюжет\nпро ничего', keywords: { results: [{ name: 'школа' }] }, credits: { cast: [{ name: 'Актёр А' }, { name: 'Актёр Б' }] } },
    'tv/1': { id: 1, name: 'Наруто', original_name: 'Naruto', genres: [{ id: 16 }, { id: 10759 }], original_language: 'ja', origin_country: ['JP'], first_air_date: '2002-10-03', last_episode_to_air: { season_number: 3, episode_number: 1, air_date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) } },
    'movie/2': { id: 2, genres: [{ id: 28 }, { id: 878 }], original_language: 'en', release_date: '2010-07-15' }
};

const tmdbData = {
    // рекомендации к аниме-сериалу 1
    'tv/1/recommendations': [
        { id: 50, name: 'Другое аниме', first_air_date: '2015-01-01', genre_ids: [16, 10759], original_language: 'ja', vote_average: 8, vote_count: 900 },
        { id: 51, name: 'Мультсериал', first_air_date: '2015-01-01', genre_ids: [16, 35], original_language: 'en', vote_average: 8, vote_count: 900 },
        { id: 52, name: 'Обычный сериал', first_air_date: '2015-01-01', genre_ids: [18], original_language: 'en', vote_average: 8, vote_count: 900 }
    ],
    'tv/1/similar': [
        { id: 50, name: 'Другое аниме', first_air_date: '2015-01-01', genre_ids: [16, 10759], original_language: 'ja', vote_average: 8, vote_count: 900 },
        { id: 1, name: 'Уже смотрели', first_air_date: '2002-01-01', genre_ids: [16], original_language: 'ja', vote_average: 8, vote_count: 900 }
    ],
    'discover/tv': [
        { id: 53, name: 'Аниме про реалити', first_air_date: '2019-01-01', genre_ids: [16], original_language: 'ja', overview: 'реалити', vote_average: 7, vote_count: 500 }
    ],
    'search/tv': [
        { id: 80, name: 'Новое аниме', original_name: 'Atarashii', first_air_date: '2020-05-01', genre_ids: [16], original_language: 'ja', vote_average: 7, vote_count: 100 }
    ],
    'discover/movie': [
        { id: 60, title: 'Аниме-фильм', release_date: '2016-01-01', genre_ids: [16, 10749], original_language: 'ja', vote_average: 8.5, vote_count: 2000 },
        { id: 61, title: 'Обычный фильм', release_date: '2016-01-01', genre_ids: [28], original_language: 'en', vote_average: 8.5, vote_count: 2000 },
        { id: 62, title: 'Мультфильм из подборки', release_date: '2016-01-01', genre_ids: [16, 35], original_language: 'en', vote_average: 8, vote_count: 2000 }
    ]
};

global.window = { appready: true };
global.__manifest = [];
global.Lampa = {
    Manifest: Object.defineProperty({}, 'plugins', { get: () => global.__manifest, set: (p) => { global.__manifest.push(p); } }),
    Noty: { show: (t) => { global.__noty = t; } },
    Storage: {
        get: (k, d) => (k in store ? store[k] : (d === undefined ? '' : d)),
        set: (k, v) => { store[k] = v; }
    },
    Utils: { addUrlComponent: (u, c) => u + (u.includes('?') ? '&' : '?') + c },
    Reguest: function () {
        this.timeout = () => { };
        this.silent = (url, ok, fail, body) => {
            if (body && url.includes('/aiadvisor/ai')) {
                posts.push({ url, body: JSON.parse(body) });
                return ok(global.__aiFail ? { success: false, error: 'not_configured' } : { success: true, taste: 'любит тайны', titles: ['Новое аниме (2020)', 'Выдумка (2019)'] });
            }
            if (body) { posts.push({ url, body: JSON.parse(body) }); return ok({ success: true }); }
            if (url.includes('/aiadvisor/data')) return ok({ seen: global.__seen || { anime: [], cartoon: [], tv: [], movie: [] }, prefs: {} });
            fail();
        };
    },
    Api: {
        sources: {
            tmdb: {
                get: (method, params, ok) => {
                    tmdbCalls.push({ method, params });
                    if (tmdbDetails[method]) return setTimeout(() => ok({ ...tmdbDetails[method] }), 0);
                    const results = tmdbData[method] || [];
                    setTimeout(() => ok({ results: results.map(r => ({ ...r })) }), 0);
                }
            }
        }
    },
    Favorite: {
        get: (o) => (o && o.type && o.type !== 'history') ? (global.__fav && global.__fav[o.type]) || [] : [
            { id: 1, name: 'Наруто', first_air_date: '2002-10-03', original_language: 'ja' },
            { id: 2, title: 'Начало', release_date: '2010-07-15', original_language: 'en' }
        ]
    },
    Timeline: { watched: (c, t) => { const w = (global.__watchedIds || []).includes(c.id) ? 100 : 0; return t ? (c.original_name ? (w ? [{ ep: 1, view: { percent: w } }] : []) : { percent: w }) : w; } },
    ContentRows: { add: (row) => rows.push(row) },
    Settings: { listener: { follow: (name, fn) => { if (name === 'open') openHandlers.push(fn); } } },
    SettingsApi: {
        addComponent: () => { },
        addParam: (p) => settings.push(p)
    },
    Listener: { follow: () => { } }
};

require(path.join(__dirname, '..', 'AiAdvisor', 'plugin.js'));

function run(name) {
    const row = rows.find(r => r.name === name);
    const fn = row.call({}, 'main');
    return new Promise(resolve => fn(resolve));
}

(async () => {
    assert.strictEqual(rows.length, 5, 'четыре ряда + «Новое у ваших сериалов»');
    assert.deepStrictEqual(rows.map(r => r.name), ['aiadvisor_anime', 'aiadvisor_cartoon', 'aiadvisor_tv', 'aiadvisor_movie', 'aiadvisor_new']);
    assert.ok(rows.every(r => r.screen.includes('main')));
    assert.ok(settings.length > 20, 'настройки зарегистрированы');
    const ver = settings.find(p => p.param.name === 'aiadvisor_version');
    assert.ok(ver && ver.field.description === '0.22', 'версия показана в настройках');

    // повторная загрузка плагина не дублирует ряды и настройки
    const settingsBefore = settings.length;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'AiAdvisor', 'plugin.js'))];
    require(path.join(__dirname, '..', 'AiAdvisor', 'plugin.js'));
    assert.strictEqual(rows.length, 5, 'после второй загрузки рядов по-прежнему пять');
    assert.strictEqual(settings.length, settingsBefore, 'настройки не продублированы');

    // аниме: из кандидатов остаются только аниме, просмотренное (id 1) и стоп-слова исключены
    store['aiadvisor_anime_stop'] = 'реалити';
    const anime = await run('aiadvisor_anime');
    const ids = anime.results.map(r => r.id);
    console.log('anime ids:', ids);
    assert.ok(ids.includes(50), 'аниме-рекомендация есть');
    assert.ok(ids.includes(60), 'аниме-фильм из подборки есть');
    assert.ok(!ids.includes(1), 'просмотренное исключено');
    assert.ok(!ids.includes(51), 'мультсериал не попал в аниме');
    assert.ok(!ids.includes(52), 'обычный сериал не попал в аниме');
    assert.ok(!ids.includes(61), 'обычный фильм не попал в аниме');
    assert.ok(!ids.includes(62), 'мультфильм из подборки не попал в аниме');
    assert.ok(!ids.includes(53), 'стоп-слово сработало');
    assert.strictEqual(ids[0], 50, 'карточка с двумя попаданиями первая');
    assert.strictEqual(anime.title, 'Для вас: Аниме');
    const first = anime.results.find(r => r.id === 50);
    assert.ok(first.overview.startsWith('Потому что вы смотрели «Наруто»'), 'подпись «почему» с названием опорной записи');

    // жанры дозапрошены один раз, хотя рядов четыре; в журнале записи с жанрами и верной категорией
    assert.strictEqual(tmdbCalls.filter(c => c.method === 'tv/1').length, 1, 'детали сериала запрошены один раз');
    assert.strictEqual(tmdbCalls.filter(c => c.method === 'movie/2').length, 1, 'детали фильма запрошены один раз');
    const seenPost = posts.find(p => Array.isArray(p.body));
    assert.ok(seenPost, 'журнал отправлен');
    assert.deepStrictEqual(seenPost.body.map(i => i.cat).sort(), ['anime', 'movie']);
    assert.ok(seenPost.body.every(i => i.g.length > 0), 'в журнал ушли записи с жанрами');
    assert.ok(tmdbCalls.some(c => c.method === 'tv/1/recommendations'), 'рекомендации запрошены по обогащённой записи');

    // мультфильмы: просмотренного нет, кандидаты только из подборки, аниме среди них нет
    const cartoon = await run('aiadvisor_cartoon');
    assert.deepStrictEqual(cartoon.results.map(r => r.id), [62]);

    // выключенный ряд ничего не возвращает
    store['aiadvisor_tv_enabled'] = false;
    const tvRow = rows.find(r => r.name === 'aiadvisor_tv');
    assert.strictEqual(tvRow.call({}, 'main'), undefined);

    // запросы discover для аниме: жанр 16 и языки ja, zh, ko (аниме не обязательно японское)
    const discAnime = tmdbCalls.filter(c => c.method === 'discover/tv' && c.params.filter.with_genres.split(',')[0] === '16');
    assert.deepStrictEqual([...new Set(discAnime.map(c => c.params.filter.with_original_language).filter(Boolean))].sort(), ['ja', 'ko', 'zh']);
    assert.ok(discAnime.some(c => !c.params.filter.with_original_language), 'у мультфильмов язык подборки не ограничен');

    // настройка языков для аниме заменяет умолчание
    store['aiadvisor_anime_langs'] = 'ja';
    store['aiadvisor_anime_cache'] = '';
    const before2 = tmdbCalls.length;
    await run('aiadvisor_anime');
    const newCalls = tmdbCalls.slice(before2).filter(c => c.method === 'discover/tv');
    assert.deepStrictEqual([...new Set(newCalls.map(c => c.params.filter.with_original_language))], ['ja']);
    store['aiadvisor_anime_langs'] = '';
    store['aiadvisor_anime_cache'] = '';

    // просмотр по таймлайну Lampa (нет в истории) исключает карточку; нужны original_*
    global.__watchedIds = [50];
    store['aiadvisor_anime_cache'] = '';
    tmdbData['tv/1/recommendations'][0].original_name = 'Other Anime';
    const tl = (await run('aiadvisor_anime')).results.map(r => r.id);
    assert.ok(!tl.includes(50), 'просмотренное по таймлайну исключено');
    global.__watchedIds = [];
    store['aiadvisor_anime_cache'] = '';

    // ИИ-подбор: названия от сервера ищутся в TMDB, выдуманные отсеиваются, места ограничены
    store['aiadvisor_anime_ai'] = true;
    window.aiadvisorReset();
    const t0 = Date.now();
    const firstRow = await run('aiadvisor_anime');
    assert.ok(!firstRow.results.some(r => r.id === 80), 'первый ряд строится сразу, без ожидания ИИ (ответа ещё нет)');
    await new Promise(r => setTimeout(r, 100));
    assert.ok(posts.some(p => p.url.includes('/aiadvisor/ai')), 'запрос к ИИ ушёл в фоне');
    // без ручного сброса: новый ответ ИИ сам делает кэш ряда недействительным
    const withAi = await run('aiadvisor_anime');
    const aiIds = withAi.results.map(r => r.id);
    assert.ok(aiIds.includes(80), 'при следующем открытии название от ИИ, найденное в TMDB, попало в ряд');
    assert.ok(withAi.results.find(r => r.id === 80).overview.startsWith('Рекомендует ИИ'), 'подпись ИИ');
    assert.ok(tmdbCalls.some(c => c.method === 'search/tv' && c.params.query === encodeURIComponent('Новое аниме')), 'поиск по названию');
    const aiPost = posts.filter(p => p.url.includes('/aiadvisor/ai')).pop();
    assert.ok(aiPost && aiPost.body.cat === 'anime' && aiPost.body.history.length >= 1, 'на сервер ушла история группы');
    assert.ok(!('uid' in aiPost.body), 'идентификаторов пользователя в теле нет');
    // «Брошено» (Lampa) и «Не интересно» (журнал) уходят ИИ отдельным списком своей группы
    global.__fav = { thrown: [{ id: 91, name: 'Брошенное аниме', first_air_date: '2019-01-01', genre_ids: [16, 35], original_language: 'ja' }] };
    global.__seen = { anime: [{ id: 92, media: 'tv', cat: 'anime', t: 'Скучное аниме', y: 2018, g: [16, 18], l: 'ja', ts: Date.now(), x: 1, p: -1 }], cartoon: [], tv: [], movie: [] };
    store['aiadvisor_ai_anime'] = '';
    window.aiadvisorReset();
    await run('aiadvisor_anime');
    await new Promise(r => setTimeout(r, 100));
    const skipPost = posts.filter(p => p.url.includes('/aiadvisor/ai')).pop();
    const skipTitles = (skipPost.body.skip || []).map(e => e.t).sort();
    assert.deepStrictEqual(skipTitles, ['Брошенное аниме', 'Скучное аниме'], 'ИИ получил «брошено» и «не интересно» своей группы');
    const rich = skipPost.body.skip.find(e => e.t === 'Скучное аниме');
    assert.deepStrictEqual([rich.r, rich.d, rich.a, rich.k, rich.c, rich.s, rich.o], [5.5, 'Автор Скучный', 'Актёр А, Актёр Б', 'школа', 'JP', 'Сеть Х', 'Скучный сюжет про ничего'], 'ИИ получил рейтинг, автора, актёров, сюжет и т.д.');
    assert.ok(Object.keys(store['aiadvisor_meta'] || {}).length >= 1, 'метаданные закэшированы на устройстве');
    global.__fav = {};
    global.__seen = null;
    store['aiadvisor_ai_anime'] = '';
    window.aiadvisorReset();
    await run('aiadvisor_anime');
    await new Promise(r => setTimeout(r, 100));

    // кэш ответа ИИ на 24 часа: второй расчёт не обращается к серверу
    const aiCalls = posts.filter(p => p.url.includes('/aiadvisor/ai')).length;
    window.aiadvisorReset();
    await run('aiadvisor_anime');
    assert.strictEqual(posts.filter(p => p.url.includes('/aiadvisor/ai')).length, aiCalls, 'ответ ИИ взят из кэша');
    // сервер ИИ не настроен: ряд строится локально, без ошибок
    store['aiadvisor_ai_anime'] = '';
    global.__aiFail = true;
    window.aiadvisorReset();
    const noAi = await run('aiadvisor_anime');
    assert.ok(noAi.results.length > 0 && !noAi.results.some(r => r.id === 80), 'без ИИ ряд локальный');
    global.__aiFail = false;
    store['aiadvisor_anime_ai'] = false;
    store['aiadvisor_ai_anime'] = '';
    window.aiadvisorReset();

    // отметки в меню карточки: два пункта, запись в журнал, x=1 для «не интересно»
    assert.strictEqual(global.__manifest.length, 2, 'два пункта меню карточки');
    assert.ok(global.__manifest.every(m => m.type === 'video' && typeof m.onContextMenu === 'function' && typeof m.onContextLauch === 'function'));
    const skipEntry = global.__manifest.find(m => /не интересно/.test(m.name));
    const viewedEntry = global.__manifest.find(m => /уже смотрел/.test(m.name));
    const cardX = { id: 777, name: 'Тест', first_air_date: '2021-01-01', genre_ids: [18], original_language: 'en' };
    const postsBefore = posts.length;
    skipEntry.onContextLauch(cardX);
    viewedEntry.onContextLauch({ ...cardX, id: 778 });
    const marks = posts.slice(postsBefore).map(p => p.body[0]);
    assert.strictEqual(marks[0].x, 1, '«не интересно» помечено x=1');
    assert.ok(marks[1].x === 2 && marks[1].p === 100 && marks[1].id === 778, '«уже смотрел»: x=2, досмотрено 100%');
    assert.ok(/Уже смотрел/.test(global.__noty), 'уведомление показано');

    // отметка с сервера: «не интересно» исключает карточку, но не считается историей группы
    global.__seen = { anime: [{ id: 50, media: 'tv', cat: 'anime', t: 'Другое аниме', y: 2015, g: [16, 10759], l: 'ja', ts: Date.now(), x: 1, p: -1 }], cartoon: [], tv: [], movie: [] };
    window.aiadvisorReset();
    const skippedRow = (await run('aiadvisor_anime')).results.map(r => r.id);
    assert.ok(!skippedRow.includes(50), 'карточка «не интересно» исключена');
    global.__seen = null;
    window.aiadvisorReset();

    // закладки Lampa (например «Буду смотреть») исключаются из рядов
    global.__fav = { wath: [{ id: 50, name: 'Другое аниме', first_air_date: '2015-01-01' }] };
    window.aiadvisorReset();
    const fav = (await run('aiadvisor_anime')).results.map(r => r.id);
    assert.ok(!fav.includes(50), 'карточка из закладок исключена');
    global.__fav = {};
    window.aiadvisorReset();

    // выгрузка для эксперимента с внешним ИИ
    window.aiadvisorExport('anime');
    await new Promise(r => setTimeout(r, 300));
    const exp = JSON.parse(window.__aiadvisor_export);
    assert.strictEqual(exp.cat, 'anime');
    assert.ok(exp.history.length >= 1 && exp.candidates.length >= 1 && exp.local_top.length >= 1, 'выгрузка заполнена');
    assert.ok(!exp.candidates[0].o.startsWith('Потому что'), 'подпись «почему» из описания убрана');
    window.aiadvisorReset();

    // экран настроек: сводка по истории и текущие значения
    assert.strictEqual(openHandlers.length, 1, 'обработчик открытия настроек зарегистрирован');
    openHandlers[0]({ name: 'other', body: makeBody() });
    openHandlers[0]({ name: 'aiadvisor', body: makeBody() });
    await new Promise(r => setTimeout(r, 50));
    const info = rowsDom['Аниме: что видно в истории'].descr.textContent;
    const now = rowsDom['Аниме: сейчас применяется'].descr.textContent;
    console.log('info:', info);
    console.log('now: ', now);
    assert.ok(info.includes('Записей: 1'), 'число записей группы');
    assert.ok(info.includes('боевик и приключения 100%'), 'жанры из истории без служебного 16');
    assert.ok(!info.includes('мультфильм'), 'служебный жанр не показан');
    assert.ok(info.includes('ja 100%'), 'язык из истории');
    assert.ok(info.includes('2002'), 'год из истории');
    assert.ok(now.includes('любимые жанры: боевик и приключения (из истории)'), 'применяются жанры из истории');
    assert.ok(now.includes('языки подборки: ja, zh, ko'), 'языки по умолчанию для аниме');
    store['aiadvisor_anime_liked'] = 'драма';
    openHandlers[0]({ name: 'aiadvisor', body: makeBody() });
    await new Promise(r => setTimeout(r, 50));
    assert.ok(rowsDom['Аниме: сейчас применяется'].descr.textContent.includes('любимые жанры: драма (из настроек)'), 'настройки главнее истории');
    store['aiadvisor_anime_liked'] = '';

    // кэш: повторный вызов не ходит в TMDB
    await run('aiadvisor_anime');
    const before = tmdbCalls.length;
    await run('aiadvisor_anime');
    assert.strictEqual(tmdbCalls.length, before, 'повторный вызов берётся из кэша');

    // ряд «Новое у ваших сериалов»: у Наруто (id 1) пять дней назад вышла 1 серия 3 сезона
    const fresh = await run('aiadvisor_new');
    assert.ok(fresh.results.some(r => r.id === 1), 'сериал из истории с новой серией попал в ряд');
    assert.ok(/Новый сезон 3/.test(fresh.results.find(r => r.id === 1).overview), 'подпись про новый сезон');
    // серия уже просмотрена: в ряд не попадает
    store['aiadvisor_new_cache'] = '';
    global.Lampa.Timeline.watchedEpisode = () => 100;
    assert.strictEqual((await run('aiadvisor_new')).results.length, 0, 'просмотренная новая серия не показывается');
    delete global.Lampa.Timeline.watchedEpisode;
    store['aiadvisor_new_enabled'] = false;
    assert.strictEqual(rows.find(r => r.name === 'aiadvisor_new').call({}, 'main'), undefined, 'ряд выключается настройкой');
    store['aiadvisor_new_enabled'] = true;

    console.log('lampa-sim: все проверки прошли');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
