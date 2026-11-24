'use strict';

// Запуск: node tests/core.test.js
const assert = require('assert');
const Core = require('../AiAdvisor/plugin.js');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('ok   ' + name); }
    catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

// ---- категории ----
test('аниме: анимация + ja', () => {
    assert.strictEqual(Core.categoryOf({ id: 1, name: 'Naruto', first_air_date: '2002-10-03', genre_ids: [16, 10759], original_language: 'ja' }), 'anime');
});
test('аниме: анимация + origin_country CN (донхуа)', () => {
    assert.strictEqual(Core.categoryOf({ id: 2, name: 'X', first_air_date: '2020-01-01', genres: [{ id: 16 }], original_language: 'zh', origin_country: ['CN'] }), 'anime');
});
test('мультфильм: анимация, en, US', () => {
    assert.strictEqual(Core.categoryOf({ id: 3, title: 'Toy Story', release_date: '1995-11-22', genre_ids: [16, 35, 10751], original_language: 'en' }), 'cartoon');
});
test('мультфильм: взрослый мультсериал South Park', () => {
    assert.strictEqual(Core.categoryOf({ id: 4, name: 'South Park', first_air_date: '1997-08-13', genre_ids: [16, 35], original_language: 'en', origin_country: ['US'] }), 'cartoon');
});
test('сериал: без анимации', () => {
    assert.strictEqual(Core.categoryOf({ id: 5, name: 'Breaking Bad', first_air_date: '2008-01-20', genre_ids: [18, 80], original_language: 'en' }), 'tv');
});
test('сериал: корейская драма не аниме', () => {
    assert.strictEqual(Core.categoryOf({ id: 6, name: 'Squid Game', first_air_date: '2021-09-17', genre_ids: [18, 9648], original_language: 'ko', origin_country: ['KR'] }), 'tv');
});
test('фильм: без анимации', () => {
    assert.strictEqual(Core.categoryOf({ id: 7, title: 'Inception', release_date: '2010-07-15', genre_ids: [28, 878], original_language: 'en' }), 'movie');
});
test('аниме-фильм считается аниме', () => {
    assert.strictEqual(Core.categoryOf({ id: 8, title: 'Your Name', release_date: '2016-08-26', genre_ids: [16, 10749], original_language: 'ja' }), 'anime');
});
test('media_type из рекомендаций TMDB главнее признаков', () => {
    assert.strictEqual(Core.mediaOf({ id: 9, media_type: 'tv', title: 'x' }), 'tv');
});
test('карточка без id не попадает в журнал', () => {
    assert.strictEqual(Core.toSeen({ title: 'x' }, 1), null);
});
test('toSeen кладёт категорию, год, жанры', () => {
    const s = Core.toSeen({ id: 1, name: 'Naruto', first_air_date: '2002-10-03', genre_ids: [16], original_language: 'ja' }, 5);
    assert.deepStrictEqual(s, { id: 1, media: 'tv', cat: 'anime', t: 'Naruto', y: 2002, g: [16], l: 'ja', ts: 5 });
});

// ---- обогащение урезанных карточек истории ----
test('enrich: запись без жанров становится аниме после ответа TMDB', () => {
    const item = { id: 1, media: 'tv', cat: 'tv', t: 'Наруто', y: 0, g: [], l: 'ja', ts: 7 };
    const out = Core.enrich(item, { genres: [{ id: 16 }, { id: 10759 }], original_language: 'ja', origin_country: ['JP'], first_air_date: '2002-10-03' });
    assert.strictEqual(out.cat, 'anime');
    assert.deepStrictEqual(out.g, [16, 10759]);
    assert.strictEqual(out.y, 2002);
    assert.strictEqual(out.ts, 7);
    assert.strictEqual(item.cat, 'tv', 'исходная запись не изменена');
});
test('enrich: мультфильм на английском остаётся мультфильмом', () => {
    const out = Core.enrich({ id: 2, media: 'movie', cat: 'movie', t: 'Коко', y: 0, g: [], l: 'en', ts: 1 },
        { genres: [{ id: 16 }, { id: 10751 }], original_language: 'en', release_date: '2017-10-27' });
    assert.strictEqual(out.cat, 'cartoon');
});
test('enrich: без жанров в ответе возвращает null', () => {
    assert.strictEqual(Core.enrich({ id: 3, media: 'tv', g: [], l: 'en', ts: 1 }, { genres: [] }), null);
});

// ---- сводка по истории для настроек ----
test('describe: доли жанров считаются среди записей с жанрами, годы и языки', () => {
    const items = [
        { g: [16, 35], l: 'ja', y: 2010, ts: 3 },
        { g: [16, 18], l: 'ja', y: 2020, ts: 2 },
        { g: [], l: 'ko', y: 2022, ts: 1 }
    ];
    const d = Core.describe(items);
    assert.strictEqual(d.count, 3);
    assert.strictEqual(d.withGenres, 2);
    assert.strictEqual(d.genres[0].id, 16);
    assert.strictEqual(d.genres[0].share, 1);
    assert.deepStrictEqual(d.langs[0], { code: 'ja', share: 2 / 3 });
    assert.deepStrictEqual(d.years, { from: 2010, to: 2022, median: 2020 });
});
test('describe: пустая история', () => {
    const d = Core.describe([]);
    assert.strictEqual(d.count, 0);
    assert.strictEqual(d.years, null);
});
test('topGenres: без служебного жанра 16, по убыванию веса', () => {
    const p = Core.buildProfile([{ g: [16, 35, 18], ts: 3 }, { g: [16, 35], ts: 2 }]);
    assert.deepStrictEqual(Core.topGenres(p, 3), [35, 18]);
});

// ---- русская локализация ----
test('без перевода: японское название совпадает с оригиналом — исключается', () => {
    const c = { id: 40, name: '悪の波動', original_name: '悪の波動', original_language: 'ja', genre_ids: [18], vote_average: 7, vote_count: 500, first_air_date: '2020-01-01' };
    assert.strictEqual(Core.untranslated(c), true);
    assert.strictEqual(Core.score(c, { prefs: Core.normalizePrefs({}), profile: Core.buildProfile([]), watched: {}, currentYear: 2026 }), null);
});
test('с русским названием проходит', () => {
    assert.strictEqual(Core.untranslated({ name: 'Страйк', original_name: 'Strike', original_language: 'en' }), false);
    assert.strictEqual(Core.untranslated({ name: 'Игра в кальмара', original_name: '오징어 게임', original_language: 'ko' }), false);
});
test('английское название без перевода допустимо', () => {
    assert.strictEqual(Core.untranslated({ name: 'Dexter', original_name: 'Dexter', original_language: 'en' }), false);
});
test('французское название без перевода исключается', () => {
    assert.strictEqual(Core.untranslated({ title: 'Les Intouchables', original_title: 'Les Intouchables', original_language: 'fr' }), true);
});

// ---- вес по проценту досмотра ----
test('completionWeight: таблица весов и неизвестный прогресс', () => {
    assert.strictEqual(Core.completionWeight(100), 1);
    assert.strictEqual(Core.completionWeight(75), 0.8);
    assert.strictEqual(Core.completionWeight(50), 0.45);
    assert.strictEqual(Core.completionWeight(20), 0.15);
    assert.strictEqual(Core.completionWeight(5), 0.05);
    assert.strictEqual(Core.completionWeight(-1), 1);
    assert.strictEqual(Core.completionWeight(undefined), 1);
});
test('профиль: недосмотренное влияет слабее досмотренного', () => {
    const p = Core.buildProfile([
        { g: [18], l: 'en', ts: 2, p: 100 },
        { g: [35], l: 'en', ts: 2, p: 10 }
    ]);
    assert.ok(p.genres[18] > p.genres[35] * 5);
});

// ---- предпочтения ----
test('жанры из текста: точное совпадение', () => {
    assert.deepStrictEqual(Core.genreIdsFromText('драма, ужасы'), [18, 27]);
});
test('жанры из текста: «фэнтези» даёт оба id', () => {
    const ids = Core.genreIdsFromText('фэнтези');
    assert.ok(ids.includes(14) && ids.includes(10765));
});
test('боевик и фантастика захватывают жанры сериалов', () => {
    assert.deepStrictEqual(Core.genreIdsFromText('боевик'), [28, 10759]);
    assert.deepStrictEqual(Core.genreIdsFromText('фантастика'), [878, 10765]);
});
test('неизвестный жанр игнорируется', () => {
    assert.deepStrictEqual(Core.genreIdsFromText('абракадабра'), []);
});
test('normalizePrefs разбирает поля', () => {
    const p = Core.normalizePrefs({ liked: 'драма', disliked: 'ужасы', stop: 'Реалити, Шоу', langs: 'JA, ko', min_rating: '6,5', year_from: '2000' });
    assert.deepStrictEqual(p.liked, [18]);
    assert.deepStrictEqual(p.disliked, [27]);
    assert.deepStrictEqual(p.stop, ['реалити', 'шоу']);
    assert.deepStrictEqual(p.langs, ['ja', 'ko']);
    assert.strictEqual(p.min_rating, 6.5);
    assert.strictEqual(p.year_from, 2000);
});
test('пустые предпочтения: ряд включён', () => {
    assert.strictEqual(Core.normalizePrefs({}).enabled, true);
    assert.strictEqual(Core.normalizePrefs({ enabled: false }).enabled, false);
});

// ---- ранжирование ----
const YEAR = 2026;
function ctx(prefsRaw, items, watched) {
    return {
        prefs: Core.normalizePrefs(prefsRaw),
        profile: Core.buildProfile(items || []),
        watched: watched || {},
        currentYear: YEAR
    };
}
const base = { vote_average: 7, vote_count: 500, original_language: 'en', release_date: '2020-01-01' };

test('уже просмотренное исключается', () => {
    const c = { id: 10, title: 'A', genre_ids: [18], ...base };
    assert.strictEqual(Core.score(c, ctx({}, [], { 'movie:10': true })), null);
});
test('нелюбимый жанр исключает', () => {
    const c = { id: 11, title: 'A', genre_ids: [27], ...base };
    assert.strictEqual(Core.score(c, ctx({ disliked: 'ужасы' })), null);
});
test('стоп-слово в описании исключает', () => {
    const c = { id: 12, title: 'A', overview: 'Реалити про жизнь', genre_ids: [18], ...base };
    assert.strictEqual(Core.score(c, ctx({ stop: 'реалити' })), null);
});
test('год ниже порога исключает', () => {
    const c = { id: 13, title: 'A', genre_ids: [18], ...base, release_date: '1990-01-01' };
    assert.strictEqual(Core.score(c, ctx({ year_from: '2000' })), null);
});
test('низкий рейтинг при достаточных голосах исключает', () => {
    const c = { id: 14, title: 'A', genre_ids: [18], ...base, vote_average: 4 };
    assert.strictEqual(Core.score(c, ctx({ min_rating: '6' })), null);
});
test('низкий рейтинг при малом числе голосов не исключает', () => {
    const c = { id: 15, title: 'A', genre_ids: [18], ...base, vote_average: 4, vote_count: 3 };
    assert.notStrictEqual(Core.score(c, ctx({ min_rating: '6' })), null);
});
test('жанр из истории повышает оценку', () => {
    const items = [{ g: [18], l: 'en', ts: 10 }, { g: [18], l: 'en', ts: 9 }];
    const drama = { id: 16, title: 'D', genre_ids: [18], ...base };
    const comedy = { id: 17, title: 'C', genre_ids: [35], ...base };
    const x = ctx({}, items);
    assert.ok(Core.score(drama, x) > Core.score(comedy, x));
});
test('повторное попадание в рекомендации повышает оценку', () => {
    const a = { id: 18, title: 'A', genre_ids: [18], hits: 4, ...base };
    const b = { id: 19, title: 'B', genre_ids: [18], hits: 1, ...base };
    const x = ctx({});
    assert.ok(Core.score(a, x) > Core.score(b, x));
});
test('рекомендация от просмотренного обгоняет популярное из общей подборки', () => {
    const fromHistory = { id: 30, title: 'A', genre_ids: [18], ...base, hits: 1, vote_average: 7, vote_count: 500 };
    const popular = { id: 31, title: 'B', genre_ids: [18], ...base, hits: 0.2, vote_average: 8.7, vote_count: 30000 };
    const x = ctx({}, [{ g: [18], l: 'en', ts: 5 }]);
    assert.ok(Core.score(fromHistory, x) > Core.score(popular, x));
});
test('любимый жанр из настроек повышает оценку', () => {
    const a = { id: 20, title: 'A', genre_ids: [9648], ...base };
    const b = { id: 21, title: 'B', genre_ids: [35], ...base };
    const x = ctx({ liked: 'детектив' });
    assert.ok(Core.score(a, x) > Core.score(b, x));
});
test('rank отсекает исключённых и ограничивает длину', () => {
    const cands = [];
    for (let i = 0; i < 30; i++) cands.push({ id: 100 + i, title: 'T' + i, genre_ids: [18], ...base, hits: i % 5 });
    cands.push({ id: 999, title: 'Bad', genre_ids: [27], ...base });
    const out = Core.rank(cands, ctx({ disliked: 'ужасы' }), 20);
    assert.strictEqual(out.length, 20);
    assert.ok(!out.some(c => c.id === 999));
});
test('профили категорий не смешиваются: аниме не влияет на сериалы', () => {
    const anime = [{ g: [16, 10759], l: 'ja', ts: 5 }];
    const tvProfile = Core.buildProfile([]);
    assert.deepStrictEqual(tvProfile.genres, {});
    const animeProfile = Core.buildProfile(anime);
    assert.ok(animeProfile.genres[16] === 1);
});

console.log('\n' + passed + ' тестов прошло');
