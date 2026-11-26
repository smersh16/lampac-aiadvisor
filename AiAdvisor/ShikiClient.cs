using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace AiAdvisor;

public class ShikiResult
{
    public bool Found;
    public string Kind = string.Empty;
    public double Score;
}

/// <summary>
/// Справочник Shikimori (GraphQL, только чтение): «это аниме?» по названию и году.
/// Правила сайта: только HTTPS, не больше 5 запросов в секунду и 90 в минуту, в User-Agent имя приложения.
/// Запросы идут по одному с паузой, результаты (и «не найдено») хранятся в памяти 30 суток.
/// </summary>
public static class ShikiClient
{
    const string Url = "https://shikimori.io/api/graphql";
    const int SpacingMs = 750; // ~80 запросов в минуту, с запасом до лимита 90

    static readonly TimeSpan Ttl = TimeSpan.FromDays(30);
    static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(20) };
    static readonly SemaphoreSlim gate = new(1, 1);
    static readonly ConcurrentDictionary<string, (DateTime at, ShikiResult result)> cache = new();
    static DateTime lastRequest = DateTime.MinValue;

    // кэш переживает перезапуск контейнера: database/aiadvisor/shiki.json
    static readonly string cachePath = Path.Combine("database", "aiadvisor", "shiki.json");
    static bool loaded;

    static void LoadCache()
    {
        if (loaded)
            return;

        loaded = true;
        try
        {
            if (!File.Exists(cachePath))
                return;

            var data = JObject.Parse(File.ReadAllText(cachePath, Encoding.UTF8));
            foreach (var p in data.Properties())
            {
                var v = p.Value as JObject;
                if (v == null)
                    continue;

                cache[p.Name] = (DateTimeOffset.FromUnixTimeSeconds(v.Value<long?>("t") ?? 0).UtcDateTime,
                    new ShikiResult { Found = v.Value<bool?>("f") ?? false, Kind = v.Value<string>("k") ?? string.Empty, Score = v.Value<double?>("s") ?? 0 });
            }
        }
        catch
        {
            // повреждённый кэш не страшен: заполнится заново
        }
    }

    static void SaveCache()
    {
        try
        {
            var data = new JObject();
            foreach (var pair in cache)
            {
                if (DateTime.UtcNow - pair.Value.at >= Ttl)
                    continue;

                data[pair.Key] = new JObject
                {
                    ["t"] = new DateTimeOffset(pair.Value.at, TimeSpan.Zero).ToUnixTimeSeconds(),
                    ["f"] = pair.Value.result.Found,
                    ["k"] = pair.Value.result.Kind,
                    ["s"] = pair.Value.result.Score
                };
            }

            Directory.CreateDirectory(Path.GetDirectoryName(cachePath));
            string tmp = cachePath + ".tmp";
            File.WriteAllText(tmp, data.ToString(Formatting.None), new UTF8Encoding(false));
            File.Move(tmp, cachePath, true);
        }
        catch
        {
            // без файла кэш остаётся в памяти
        }
    }

    // null — запрос не состоялся (ошибка сети, 429): в кэш не кладём
    public static async Task<ShikiResult> Lookup(string title, string original, int year)
    {
        string norm = Norm(title);
        if (norm.Length == 0)
            return new ShikiResult();

        string normOriginal = Norm(original);
        string key = norm + "|" + normOriginal + "|" + year;
        lock (cache) LoadCache();
        if (cache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.at < Ttl)
            return hit.result;

        await gate.WaitAsync();
        try
        {
            if (cache.TryGetValue(key, out hit) && DateTime.UtcNow - hit.at < Ttl)
                return hit.result;

            var wait = TimeSpan.FromMilliseconds(SpacingMs) - (DateTime.UtcNow - lastRequest);
            if (wait > TimeSpan.Zero)
                await Task.Delay(wait);

            // сначала ищем по названию из Lampa, затем (если не нашли) по оригинальному
            var names = new[] { norm, normOriginal }.Where(n => n.Length > 0).ToArray();
            var result = new ShikiResult();

            for (int i = 0; i < names.Length && !result.Found; i++)
            {
                if (i > 0)
                {
                    var pause = TimeSpan.FromMilliseconds(SpacingMs) - (DateTime.UtcNow - lastRequest);
                    if (pause > TimeSpan.Zero)
                        await Task.Delay(pause);
                }

                lastRequest = DateTime.UtcNow;

                string text = i == 0 ? title : original;
                var list = await Search(text);
                if (list == null)
                    return null;

                result = Match(list, names, year);
            }

            cache[key] = (DateTime.UtcNow, result);
            SaveCache();
            return result;
        }
        catch
        {
            return null;
        }
        finally
        {
            gate.Release();
        }
    }

    static async Task<JArray> Search(string text)
    {
        string query = "{ animes(search: " + JsonConvert.SerializeObject(text) + ", limit: 5) { name russian english japanese synonyms licenseNameRu kind score airedOn { year } } }";
        using var req = new HttpRequestMessage(HttpMethod.Post, Url);
        req.Headers.TryAddWithoutValidation("User-Agent", "lampac-aiadvisor/0.23");
        req.Content = new StringContent(new JObject { ["query"] = query }.ToString(Formatting.None), Encoding.UTF8, "application/json");

        using var resp = await http.SendAsync(req);
        if (!resp.IsSuccessStatusCode)
            return null;

        var json = JObject.Parse(await resp.Content.ReadAsStringAsync());
        return json["data"]?["animes"] as JArray ?? new JArray();
    }

    // совпадение названия с любым из имён записи (оригинальное, русское, английское, японское, синонимы, лицензионное) и года (±1)
    public static ShikiResult Match(JArray list, string[] norms, int year)
    {
        foreach (var a in list ?? new JArray())
        {
            var all = new[] { a.Value<string>("name"), a.Value<string>("russian"), a.Value<string>("english"), a.Value<string>("japanese"), a.Value<string>("licenseNameRu") }
                .Concat((a["synonyms"] as JArray ?? new JArray()).Select(x => x.ToString()))
                .Select(Norm)
                .Where(n => n.Length > 0);

            if (!all.Any(n => norms.Contains(n)))
                continue;

            int y = a["airedOn"]?.Value<int?>("year") ?? 0;
            if (year > 0 && y > 0 && Math.Abs(y - year) > 1)
                continue;

            return new ShikiResult { Found = true, Kind = a.Value<string>("kind") ?? string.Empty, Score = a.Value<double?>("score") ?? 0 };
        }

        return new ShikiResult();
    }

    static string Norm(string value)
    {
        if (string.IsNullOrEmpty(value))
            return string.Empty;

        return Regex.Replace(value.ToLowerInvariant().Replace('ё', 'е'), "[^\\p{L}\\p{N}]+", string.Empty);
    }
}
