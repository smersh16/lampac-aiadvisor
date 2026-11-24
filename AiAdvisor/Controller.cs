using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Shared;
using Shared.Attributes;
using Shared.Services;
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web;

namespace AiAdvisor;

/// <summary>
/// Хранилище для плагина рекомендаций: журнал просмотренного по категориям и настройки.
/// Подбор делает плагин в браузере (TMDB Lampa), сервер ничего никуда не отправляет.
/// Файл на пользователя: database/aiadvisor/{пользователь}.json
/// </summary>
public class AiAdvisorController : BaseController
{
    static readonly string[] cats = { "anime", "cartoon", "tv", "movie" };
    static readonly string[] prefFields = { "liked", "disliked", "stop", "langs", "min_rating", "year_from" };

    const int MaxPerCat = 500;
    const int MaxItemsPerRequest = 300;
    const int MaxBody = 262144;
    const int MaxPrefLength = 500;

    static readonly ConcurrentDictionary<string, object> locks = new();

    #region aiadvisor.js
    [HttpGet, AllowAnonymous]
    [Staticache(cacheMinutes: 10, always: true, setHeadersNoCache: true)]
    [Route("aiadvisor.js")]
    [Route("aiadvisor/js/{token}")]
    public ActionResult Plugin(string token)
    {
        string plugin = FileCache.ReadAllText($"{ModInit.modpath}/plugin.js", "aiadvisor.js")
            .Replace("{localhost}", host)
            .Replace("{token}", HttpUtility.UrlEncode(token));

        return ContentTo(plugin, "application/javascript; charset=utf-8");
    }
    #endregion

    #region /aiadvisor/data
    /// <summary>
    /// { seen: { anime: [], cartoon: [], tv: [], movie: [] }, prefs: { anime: {...}, ... } }
    /// </summary>
    [HttpGet]
    [Route("/aiadvisor/data")]
    public ActionResult Data()
    {
        string area = UserArea();

        var seen = new JObject();
        foreach (var cat in cats)
            seen[cat] = new JArray();

        var prefs = new JObject();

        if (area != null)
        {
            JObject data;
            lock (locks.GetOrAdd(area, _ => new object()))
                data = Load(area);

            foreach (var cat in cats)
            {
                if (data["seen"]?[cat] is JObject list)
                {
                    var arr = new JArray();
                    foreach (var p in list.Properties())
                        arr.Add(p.Value);
                    seen[cat] = arr;
                }
            }

            if (data["prefs"] is JObject saved)
                prefs = saved;
        }

        return ContentTo(new JObject { ["seen"] = seen, ["prefs"] = prefs }.ToString(Formatting.None), "application/json; charset=utf-8");
    }
    #endregion

    #region /aiadvisor/seen
    /// <summary>
    /// Тело: массив { id, media, cat, t, y, g[], l, ts }. Запись с тем же media:id обновляется,
    /// если её ts больше; категория хранится в одном месте, при смене старая запись удаляется.
    /// </summary>
    [HttpPost]
    [Route("/aiadvisor/seen")]
    async public Task<ActionResult> Seen()
    {
        string area = UserArea();
        if (area == null)
            return Fail();

        var body = await ReadBody();
        if (body is not JArray items)
            return Fail();

        int accepted = 0;

        lock (locks.GetOrAdd(area, _ => new object()))
        {
            var data = Load(area);
            var seen = data["seen"] as JObject ?? new JObject();

            foreach (var token in items.Take(MaxItemsPerRequest))
            {
                var item = Clean(token as JObject);
                if (item == null)
                    continue;

                string key = item.Value<string>("media") + ":" + item.Value<long>("id");
                long ts = item.Value<long>("ts");

                // прежняя запись ищется во всех категориях: при обогащении категория меняется
                JObject old = null;
                foreach (var c in cats)
                {
                    if (seen[c] is JObject oldList && oldList[key] is JObject found)
                    {
                        old = found;
                        break;
                    }
                }

                if (old != null)
                {
                    bool oldHasGenres = old["g"] is JArray oldGenres && oldGenres.Count > 0;
                    bool newHasGenres = item["g"] is JArray newGenres && newGenres.Count > 0;
                    long oldTs = old.Value<long?>("ts") ?? 0;

                    if (oldHasGenres && !newHasGenres)
                    {
                        // урезанная карточка истории (без жанров) не затирает обогащённую запись:
                        // сохраняем жанры, язык и категорию, обновляем только время
                        item["g"] = old["g"].DeepClone();
                        item["l"] = old["l"]?.DeepClone() ?? item["l"];
                        item["cat"] = old["cat"]?.DeepClone() ?? item["cat"];
                        item["ts"] = Math.Max(oldTs, ts);
                    }
                    else if (oldTs >= ts && !(newHasGenres && !oldHasGenres))
                    {
                        continue;
                    }
                }

                string cat = item.Value<string>("cat");
                var list = seen[cat] as JObject ?? new JObject();
                list[key] = item;
                seen[cat] = list;

                foreach (var other in cats)
                {
                    if (other != cat && seen[other] is JObject otherList)
                        otherList.Remove(key);
                }

                accepted++;
            }

            foreach (var cat in cats)
            {
                if (seen[cat] is JObject list && list.Count > MaxPerCat)
                {
                    var oldest = list.Properties()
                        .OrderBy(p => (p.Value as JObject)?.Value<long?>("ts") ?? 0)
                        .Take(list.Count - MaxPerCat)
                        .Select(p => p.Name)
                        .ToList();

                    foreach (var name in oldest)
                        list.Remove(name);
                }
            }

            data["seen"] = seen;
            Save(area, data);
        }

        return ContentTo(JsonConvert.SerializeObject(new { success = true, accepted }), "application/json; charset=utf-8");
    }
    #endregion

    #region /aiadvisor/prefs
    /// <summary>
    /// Тело: { anime: { enabled, liked, disliked, stop, langs, min_rating, year_from }, cartoon: ..., tv: ..., movie: ... }
    /// </summary>
    [HttpPost]
    [Route("/aiadvisor/prefs")]
    async public Task<ActionResult> Prefs()
    {
        string area = UserArea();
        if (area == null)
            return Fail();

        var body = await ReadBody();
        if (body is not JObject src)
            return Fail();

        var prefs = new JObject();

        foreach (var cat in cats)
        {
            if (src[cat] is not JObject p)
                continue;

            var clean = new JObject
            {
                ["enabled"] = p["enabled"]?.Type == JTokenType.Boolean ? p.Value<bool>("enabled") : true
            };

            foreach (var field in prefFields)
            {
                string value = p[field]?.ToString() ?? string.Empty;
                if (value.Length > MaxPrefLength)
                    value = value.Substring(0, MaxPrefLength);

                clean[field] = value;
            }

            prefs[cat] = clean;
        }

        lock (locks.GetOrAdd(area, _ => new object()))
        {
            var data = Load(area);
            data["prefs"] = prefs;
            Save(area, data);
        }

        return ContentTo("{\"success\":true}", "application/json; charset=utf-8");
    }
    #endregion

    #region Utilities
    string UserArea()
    {
        if (string.IsNullOrEmpty(requestInfo.user_uid))
            return null;

        HttpContext.Request.Query.TryGetValue("profile_id", out var profile_id);
        string area = DataArea.Compose(requestInfo.user_uid, profile_id);

        // двоеточие (разделитель профиля) в имени файла нежелательно
        return string.IsNullOrEmpty(area) ? null : area.Replace(':', '~');
    }

    static string PathOf(string area) => Path.Combine("database", "aiadvisor", area + ".json");

    static JObject Load(string area)
    {
        string path = PathOf(area);

        if (!System.IO.File.Exists(path))
            return new JObject();

        try
        {
            return JObject.Parse(System.IO.File.ReadAllText(path, Encoding.UTF8));
        }
        catch
        {
            // повреждённый файл не затираем: откладываем в сторону и начинаем с чистого
            try { System.IO.File.Move(path, path + ".bad-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss"), true); } catch { }
            return new JObject();
        }
    }

    static void Save(string area, JObject data)
    {
        string path = PathOf(area);
        Directory.CreateDirectory(Path.GetDirectoryName(path));

        string tmp = path + ".tmp";
        System.IO.File.WriteAllText(tmp, data.ToString(Formatting.None), new UTF8Encoding(false));
        System.IO.File.Move(tmp, path, true);
    }

    async Task<JToken> ReadBody()
    {
        if (Request.ContentLength > MaxBody)
            return null;

        using var reader = new StreamReader(Request.Body, Encoding.UTF8, false, 4096, leaveOpen: true);
        string body = await reader.ReadToEndAsync();

        if (string.IsNullOrWhiteSpace(body) || body.Length > MaxBody)
            return null;

        try { return JToken.Parse(body); }
        catch { return null; }
    }

    static JObject Clean(JObject src)
    {
        if (src == null)
            return null;

        try
        {
            long id = src.Value<long?>("id") ?? 0;
            string media = src.Value<string>("media");
            string cat = src.Value<string>("cat");

            if (id <= 0 || (media != "tv" && media != "movie") || Array.IndexOf(cats, cat) < 0)
                return null;

            var genres = new JArray();
            if (src["g"] is JArray ga)
            {
                foreach (var x in ga.Take(10))
                {
                    long g = x.Type == JTokenType.Integer ? x.Value<long>() : 0;
                    if (g > 0)
                        genres.Add(g);
                }
            }

            string title = src.Value<string>("t") ?? string.Empty;
            if (title.Length > 200)
                title = title.Substring(0, 200);

            string lang = src.Value<string>("l") ?? string.Empty;
            if (lang.Length > 8)
                lang = lang.Substring(0, 8);

            return new JObject
            {
                ["id"] = id,
                ["media"] = media,
                ["cat"] = cat,
                ["t"] = title,
                ["y"] = src.Value<int?>("y") ?? 0,
                ["g"] = genres,
                ["l"] = lang,
                ["ts"] = src.Value<long?>("ts") ?? 0,
                ["p"] = Math.Clamp(src.Value<int?>("p") ?? -1, -1, 100)
            };
        }
        catch
        {
            return null;
        }
    }

    ActionResult Fail() => ContentTo("{\"success\":false}", "application/json; charset=utf-8");
    #endregion
}
