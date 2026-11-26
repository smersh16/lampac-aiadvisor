using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Concurrent;
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

    // null — запрос не состоялся (ошибка сети, 429): в кэш не кладём
    public static async Task<ShikiResult> Lookup(string title, int year)
    {
        string norm = Norm(title);
        if (norm.Length == 0)
            return new ShikiResult();

        string key = norm + "|" + year;
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

            lastRequest = DateTime.UtcNow;

            string query = "{ animes(search: " + JsonConvert.SerializeObject(title) + ", limit: 5) { name russian kind score airedOn { year } } }";
            using var req = new HttpRequestMessage(HttpMethod.Post, Url);
            req.Headers.TryAddWithoutValidation("User-Agent", "lampac-aiadvisor/0.22");
            req.Content = new StringContent(new JObject { ["query"] = query }.ToString(Formatting.None), Encoding.UTF8, "application/json");

            using var resp = await http.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
                return null;

            var json = JObject.Parse(await resp.Content.ReadAsStringAsync());
            var result = Match(json["data"]?["animes"] as JArray, norm, year);
            cache[key] = (DateTime.UtcNow, result);
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

    // совпадение названия (оригинальное или русское) и года (±1)
    public static ShikiResult Match(JArray list, string norm, int year)
    {
        foreach (var a in list ?? new JArray())
        {
            if (Norm(a.Value<string>("name")) != norm && Norm(a.Value<string>("russian")) != norm)
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
