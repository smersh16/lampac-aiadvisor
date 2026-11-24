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
    'tv/1': { id: 1, genres: [{ id: 16 }, { id: 10759 }], original_language: 'ja', origin_country: ['JP'], first_air_date: '2002-10-03' },
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
    'discover/movie': [
        { id: 60, title: 'Аниме-фильм', release_date: '2016-01-01', genre_ids: [16, 10749], original_language: 'ja', vote_average: 8.5, vote_count: 2000 },
        { id: 61, title: 'Обычный фильм', release_date: '2016-01-01', genre_ids: [28], original_language: 'en', vote_average: 8.5, vote_count: 2000 },
        { id: 62, title: 'Мультфильм из подборки', release_date: '2016-01-01', genre_ids: [16, 35], original_language: 'en', vote_average: 8, vote_count: 2000 }
    ]
};

global.window = { appready: true };
global.Lampa = {
    Storage: {
        get: (k, d) => (k in store ? store[k] : (d === undefined ? '' : d)),
        set: (k, v) => { store[k] = v; }
    },
    Utils: { addUrlComponent: (u, c) => u + (u.includes('?') ? '&' : '?') + c },
    Reguest: function () {
        this.timeout = () => { };
        this.silent = (url, ok, fail, body) => {
            if (body) { posts.push({ url, body: JSON.parse(body) }); return ok({ success: true }); }
            if (url.includes('/aiadvisor/data')) return ok({ seen: { anime: [], cartoon: [], tv: [], movie: [] }, prefs: {} });
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
        get: () => [
            { id: 1, name: 'Наруто', first_air_date: '2002-10-03', original_language: 'ja' },
            { id: 2, title: 'Начало', release_date: '2010-07-15', original_language: 'en' }
        ]
    },
    Timeline: { watched: (c) => (global.__watchedIds || []).includes(c.id) ? 100 : 0 },
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
    assert.strictEqual(rows.length, 4, 'четыре ряда');
    assert.deepStrictEqual(rows.map(r => r.name), ['aiadvisor_anime', 'aiadvisor_cartoon', 'aiadvisor_tv', 'aiadvisor_movie']);
    assert.ok(rows.every(r => r.screen.includes('main')));
    assert.ok(settings.length > 20, 'настройки зарегистрированы');
    const ver = settings.find(p => p.param.name === 'aiadvisor_version');
    assert.ok(ver && ver.field.description === '0.8', 'версия показана в настройках');

    // повторная загрузка плагина не дублирует ряды и настройки
    const settingsBefore = settings.length;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'AiAdvisor', 'plugin.js'))];
    require(path.join(__dirname, '..', 'AiAdvisor', 'plugin.js'));
    assert.strictEqual(rows.length, 4, 'после второй загрузки рядов по-прежнему четыре');
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

    console.log('lampa-sim: все проверки прошли');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
