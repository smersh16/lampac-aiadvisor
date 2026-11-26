using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace AiAdvisor;

public class AiOutcome
{
    public bool Ok;
    public string Error;
    public string Taste = string.Empty;
    public string[] Titles = Array.Empty<string>();
}

/// <summary>
/// Запросы к GigaChat (Сбер) для необязательного ИИ-подбора. Настройки лежат на сервере:
///   database/aiadvisor/ai.json  — { "auth_key": "...", "model": "GigaChat-3-Ultra", "scope": "GIGACHAT_API_PERS", "enabled": true }
///   database/aiadvisor/ca.pem   — корневой и промежуточный сертификаты НУЦ Минцифры (PEM)
/// Проверка TLS не отключается: цепочка сервера проверяется по сертификатам из ca.pem.
/// Ключ и токен нигде не логируются и в браузер не передаются.
/// </summary>
public static class AiClient
{
    const string OAuthUrl = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
    const string ChatUrl = "https://api.giga.chat/v1/chat/completions";

    static readonly string confPath = Path.Combine("database", "aiadvisor", "ai.json");
    static readonly string caPath = Path.Combine("database", "aiadvisor", "ca.pem");

    static readonly TimeSpan CacheTtl = TimeSpan.FromHours(24);
    static readonly TimeSpan ErrorBackoff = TimeSpan.FromMinutes(10);

    // тариф Freemium: генерация в один поток
    static readonly SemaphoreSlim gate = new(1, 1);

    static readonly ConcurrentDictionary<string, (string hash, DateTime at, AiOutcome result)> cache = new();
    static readonly ConcurrentDictionary<string, DateTime> failures = new();

    static HttpClient http;
    static DateTime httpStamp;
    static string token;
    static DateTime tokenUntil;

    public static async Task<AiOutcome> Recommend(string key, string cat, List<string> historyLines, List<string> skipLines)
    {
        string hash = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(cat + "\n" + string.Join("\n", historyLines) + "\n--\n" + string.Join("\n", skipLines))));

        if (cache.TryGetValue(key, out var hit) && hit.hash == hash && DateTime.UtcNow - hit.at < CacheTtl)
            return hit.result;

        if (failures.TryGetValue(key, out var failedAt) && DateTime.UtcNow - failedAt < ErrorBackoff)
            return Fail("backoff");

        var conf = LoadConf();
        if (conf == null)
            return Fail("not_configured");

        if (conf.Value<bool?>("enabled") == false)
            return Fail("disabled");

        await gate.WaitAsync();
        try
        {
            // пока ждали очередь, другой запрос мог уже посчитать то же самое
            if (cache.TryGetValue(key, out hit) && hit.hash == hash && DateTime.UtcNow - hit.at < CacheTtl)
                return hit.result;

            var client = GetClient();
            if (client == null)
                return Remember(key, Fail("no_certificates"));

            string answer = await Ask(client, conf, Prompt(cat, historyLines, skipLines));
            var result = Parse(answer);

            if (!result.Ok)
                return Remember(key, result);

            cache[key] = (hash, DateTime.UtcNow, result);
            failures.TryRemove(key, out _);
            return result;
        }
        catch (AiException e)
        {
            return Remember(key, Fail(e.Code));
        }
        catch
        {
            return Remember(key, Fail("network"));
        }
        finally
        {
            gate.Release();
        }
    }

    static AiOutcome Remember(string key, AiOutcome result)
    {
        failures[key] = DateTime.UtcNow;
        return result;
    }

    static AiOutcome Fail(string code) => new AiOutcome { Ok = false, Error = code };

    class AiException : Exception
    {
        public string Code;
        public AiException(string code) : base(code) { Code = code; }
    }

    static JObject LoadConf()
    {
        try
        {
            if (!System.IO.File.Exists(confPath))
                return null;

            var conf = JObject.Parse(System.IO.File.ReadAllText(confPath, Encoding.UTF8));
            return string.IsNullOrWhiteSpace(conf.Value<string>("auth_key")) ? null : conf;
        }
        catch
        {
            return null;
        }
    }

    static string Prompt(string cat, List<string> historyLines, List<string> skipLines)
    {
        string skip = skipLines.Count == 0 ? string.Empty
            : "Пользователю не интересно или он бросил (учти это при определении вкуса и не предлагай такое и похожее):\n"
              + string.Join("\n", skipLines) + "\n\n";

        return "История просмотров пользователя (категория: " + cat + "):\n" + string.Join("\n", historyLines) + "\n\n"
            + skip
            + "Учитывай жанры, режиссёров, актёров, страну и студию, рейтинг, ключевые слова и сюжет: "
            + "найди общее среди понравившегося и среди того, что не зашло. "
            + "Сначала в 2-3 предложениях, начиная со слова ВКУС:, опиши вкус пользователя (одной строкой). "
            + "Затем предложи 20 названий, которые могут понравиться, включая малоизвестные, "
            + "но не из истории выше. Каждое название с новой строки в формате: Название (год). "
            + "Названия на русском, если есть общеизвестный перевод.";
    }

    static async Task<string> Ask(HttpClient client, JObject conf, string prompt)
    {
        for (int attempt = 0; attempt < 2; attempt++)
        {
            string bearer = await GetToken(client, conf);

            var payload = new JObject
            {
                ["model"] = conf.Value<string>("model") ?? "GigaChat-3-Ultra",
                ["temperature"] = 0.3,
                ["max_tokens"] = 1500,
                ["messages"] = new JArray
                {
                    new JObject { ["role"] = "system", ["content"] = "Ты эксперт по кино и сериалам. Отвечай обычным текстом по строкам, без JSON и без вступлений." },
                    new JObject { ["role"] = "user", ["content"] = prompt }
                }
            };

            using var req = new HttpRequestMessage(HttpMethod.Post, ChatUrl);
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + bearer);
            req.Content = new StringContent(payload.ToString(Formatting.None), Encoding.UTF8, "application/json");

            using var resp = await client.SendAsync(req);
            string body = await resp.Content.ReadAsStringAsync();

            if ((int)resp.StatusCode == 401 && attempt == 0)
            {
                token = null;
                continue;
            }

            if (!resp.IsSuccessStatusCode)
                throw new AiException("http_" + (int)resp.StatusCode);

            var json = JObject.Parse(body);
            string text = json["choices"]?[0]?["message"]?.Value<string>("content");
            if (string.IsNullOrWhiteSpace(text))
                throw new AiException("empty");

            return text;
        }

        throw new AiException("auth");
    }

    static async Task<string> GetToken(HttpClient client, JObject conf)
    {
        if (token != null && DateTime.UtcNow < tokenUntil)
            return token;

        using var req = new HttpRequestMessage(HttpMethod.Post, OAuthUrl);
        req.Headers.TryAddWithoutValidation("Authorization", "Basic " + conf.Value<string>("auth_key"));
        req.Headers.TryAddWithoutValidation("RqUID", Guid.NewGuid().ToString());
        req.Headers.Accept.ParseAdd("application/json");
        req.Content = new StringContent("scope=" + (conf.Value<string>("scope") ?? "GIGACHAT_API_PERS"), Encoding.UTF8);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/x-www-form-urlencoded");

        using var resp = await client.SendAsync(req);
        string body = await resp.Content.ReadAsStringAsync();

        if (!resp.IsSuccessStatusCode)
            throw new AiException("oauth_" + (int)resp.StatusCode);

        var json = JObject.Parse(body);
        string value = json.Value<string>("access_token");
        if (string.IsNullOrEmpty(value))
            throw new AiException("oauth_empty");

        long expires = json.Value<long?>("expires_at") ?? 0;
        DateTime until = expires > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(expires).UtcDateTime.AddMinutes(-3) : DateTime.UtcNow.AddMinutes(25);
        if (until < DateTime.UtcNow.AddMinutes(1))
            until = DateTime.UtcNow.AddMinutes(25);

        token = value;
        tokenUntil = until;
        return token;
    }

    // Клиент с проверкой цепочки по сертификатам Минцифры из ca.pem; пересоздаётся при смене файла
    static HttpClient GetClient()
    {
        if (!System.IO.File.Exists(caPath))
            return null;

        DateTime stamp = System.IO.File.GetLastWriteTimeUtc(caPath);
        if (http != null && stamp == httpStamp)
            return http;

        var certs = new X509Certificate2Collection();
        certs.ImportFromPemFile(caPath);
        if (certs.Count == 0)
            return null;

        var roots = new X509Certificate2Collection();
        var others = new X509Certificate2Collection();
        foreach (var c in certs)
        {
            if (c.Subject == c.Issuer) roots.Add(c);
            else others.Add(c);
        }

        var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (message, cert, chain, errors) =>
            {
                if (errors == SslPolicyErrors.None)
                    return true;

                // имя узла должно совпадать; допускаем только недоверенную цепочку
                if (cert == null || (errors & ~SslPolicyErrors.RemoteCertificateChainErrors) != 0)
                    return false;

                using var custom = new X509Chain();
                custom.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
                custom.ChainPolicy.CustomTrustStore.AddRange(roots);
                custom.ChainPolicy.ExtraStore.AddRange(others);
                custom.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;

                if (chain != null)
                {
                    foreach (var element in chain.ChainElements)
                        custom.ChainPolicy.ExtraStore.Add(element.Certificate);
                }

                return custom.Build(cert);
            }
        };

        http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(90) };
        httpStamp = stamp;
        token = null;
        return http;
    }

    static AiOutcome Parse(string text)
    {
        string taste = string.Empty;
        var titles = new List<string>();

        foreach (var raw in text.Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0)
                continue;

            if (line.StartsWith("ВКУС", StringComparison.OrdinalIgnoreCase))
            {
                int colon = line.IndexOf(':');
                taste = (colon >= 0 ? line.Substring(colon + 1) : line).Trim();
                continue;
            }

            line = Regex.Replace(line, @"^\s*(\d+[.)]|[-*•])\s*", string.Empty);
            if (Regex.IsMatch(line, @"\(\d{4}\)") && line.Length <= 150)
                titles.Add(line);
        }

        if (titles.Count == 0)
            return Fail("parse");

        if (taste.Length > 600)
            taste = taste.Substring(0, 600);

        return new AiOutcome { Ok = true, Taste = taste, Titles = titles.Take(25).ToArray() };
    }
}
