#!/usr/bin/env python3
"""Эксперимент: сравнить локальный топ плагина с подборкой GigaChat (режимы А и Б).

Не часть модуля: ничего не меняет, читает export.json (его даёт aiadvisorExport в консоли Lampa)
и печатает три списка. Ключ вводится скрыто и не сохраняется. Только стандартная библиотека.

Запуск:  python3 gigachat_experiment.py [export.json] [ca.pem]
"""
import getpass
import json
import re
import ssl
import sys
import urllib.parse
import urllib.request
import uuid

OAUTH = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
CHAT = "https://api.giga.chat/v1/chat/completions"
MODEL = "GigaChat-2"


def post(url, headers, data, ctx, timeout=90):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def get_token(key, ctx):
    body = urllib.parse.urlencode({"scope": "GIGACHAT_API_PERS"}).encode()
    resp = post(OAUTH, {
        "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
        "RqUID": str(uuid.uuid4()), "Authorization": "Basic " + key,
    }, body, ctx, 30)
    return resp["access_token"]


def ask(token, ctx, system, user, max_tokens=1500):
    resp = post(CHAT, {"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                json.dumps({"model": MODEL, "temperature": 0.3, "max_tokens": max_tokens,
                            "messages": [{"role": "system", "content": system},
                                         {"role": "user", "content": user}]}).encode(), ctx)
    return resp["choices"][0]["message"]["content"], resp.get("usage", {})


def first_json_array(text):
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def history_lines(data):
    out = []
    for h in data["history"]:
        pct = "" if h["p"] < 0 else ", досмотрено %d%%" % h["p"]
        out.append("- %s (%s)%s [%s]" % (h["t"], h["y"] or "?", pct, h["g"]))
    return "\n".join(out)


def mode_a(token, ctx, data):
    cands = "\n".join("%d | %s (%s) | %s | %s" % (c["id"], c["t"], c["y"] or "?", c["g"], c["o"])
                      for c in data["candidates"])
    system = "Ты помощник по подбору кино и сериалов. Отвечай только JSON-массивом чисел."
    user = ("История просмотров пользователя (категория: %s):\n%s\n\n"
            "Кандидаты (id | название | жанры | описание):\n%s\n\n"
            "Выбери из кандидатов 20 самых подходящих этому пользователю и расставь от лучшего к худшему. "
            "Используй только id из списка. Ответ: JSON-массив id, без пояснений.") % (
        data["cat"], history_lines(data), cands)
    text, usage = ask(token, ctx, system, user, 400)
    ids = first_json_array(text) or []
    by_id = {c["id"]: c for c in data["candidates"]}
    lines, bad = [], 0
    for i in ids:
        c = by_id.get(i)
        if c:
            lines.append("%s (%s)" % (c["t"], c["y"] or "?"))
        else:
            bad += 1
    return lines, bad, usage


def mode_b(token, ctx, data):
    system = "Ты эксперт по кино и сериалам. Отвечай только JSON-массивом строк."
    user = ("История просмотров пользователя (категория: %s):\n%s\n\n"
            "Опиши вкус одной строкой и предложи 20 названий, которые могут понравиться, "
            "включая малоизвестные, но не из истории выше. Формат: JSON-массив из 21 строки: "
            "первая строка — описание вкуса, дальше 20 строк вида «Название (год)». Названия на русском, "
            "если есть общеизвестный перевод.") % (data["cat"], history_lines(data))
    text, usage = ask(token, ctx, system, user, 1500)
    arr = first_json_array(text) or []
    return (arr[0] if arr else ""), [str(x) for x in arr[1:]], usage


def show(title, lines):
    print("\n=== %s ===" % title)
    for i, l in enumerate(lines, 1):
        print("%2d. %s" % (i, l))


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "export.json"
    ca = sys.argv[2] if len(sys.argv) > 2 else "ca.pem"
    data = json.load(open(path, encoding="utf-8"))
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(cafile=ca)
    key = getpass.getpass("GigaChat Authorization Key: ")
    token = get_token(key, ctx)
    del key

    a, bad, ua = mode_a(token, ctx, data)
    taste, b, ub = mode_b(token, ctx, data)

    print("Группа: %s; история: %d; кандидатов: %d; модель: %s" % (
        data["cat"], len(data["history"]), len(data["candidates"]), MODEL))
    show("ЛОКАЛЬНЫЙ ТОП плагина", data["local_top"])
    show("РЕЖИМ А: ИИ переупорядочил кандидатов (id вне списка: %d)" % bad, a)
    print("\n=== РЕЖИМ Б: вкус по версии ИИ ===\n" + taste)
    show("РЕЖИМ Б: названия от ИИ (в TMDB не проверены)", b)
    print("\nТокенов: режим А %s, режим Б %s" % (ua.get("total_tokens", "?"), ub.get("total_tokens", "?")))


if __name__ == "__main__":
    main()
