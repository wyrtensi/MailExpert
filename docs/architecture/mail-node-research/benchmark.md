# MailExpert + Dovecot: память на один always-on почтовый ящик (бенчмарк для сайзинга на 500 ящиков)

Дата: 2026-09-21. Все измерения — на Windows-хосте с Docker Desktop (WSL2-бэкенд, 16 CPU /
25.1 GB выделено Docker VM), Node внутри `node:22-bookworm-slim`, Dovecot — официальный
`dovecot/dovecot:2.3.21`, всё на одной Docker-сети `me-bench-net`, все контейнеры с префиксом
`me-bench-`.

## TL;DR

| Компонент | Результат |
|---|---|
| Node (ImapFlow-клиент MailExpert) на 1 IDLE-соединение | ≈ 77–144 КиБ RSS/соединение, в среднем ≈ **100 КиБ** |
| Dovecot (imap + imap-login TLS-proxy) на 1 IDLE-соединение | стабильно ≈ **1.97 МиБ** (≈2.07 МБ) на подключение, линейно от 0 до 500 |
| Dovecot по умолчанию на 500 ящиков | все 500 держат IDLE — **демоушен в poll-only по умолчанию выключен** (`IMAP_MAX_PERSISTENT_PER_HOST` не задан) |
| CPU в простое (IDLE) | ≈ 0% и у Node, и у Dovecot — это память-bound задача, не CPU-bound |
| PostgreSQL, 10 000 синтетических сообщений | 103 МБ всего (65 МБ heap+TOAST + 38 МБ индексы) ≈ **10.8 КБ/сообщение** |
| Оценка на 500 ящиков (Dovecot) | ≈ 4.7 МиБ + 500×1.97 МиБ ≈ **~1 ГБ** |
| Оценка на 500 ящиков (Node/MailExpert, только слой IMAP-клиентов) | ≈ 70 МиБ + 500×100 КиБ ≈ **~120 МБ** (это НЕ полный footprint процесса backend, см. оговорки) |

---

## 1. Что делает MailExpert (по коду, `backend/src/services/imapManager.js`)

- ImapFlow: **2.0.3** (зафиксировано в `backend/package.json` и `package-lock.json`, точная
  залоченная версия — та же, `imapflow@2.0.3`).
- На каждый включённый (enabled) почтовый ящик создаётся один долгоживущий `ImapFlow`-клиент
  (`makeClientCfg`, строки ~1328–1377), который делает `connect()` → `mailboxOpen('INBOX')` и
  дальше сидит в auto-IDLE. Ключевые опции клиента:
  ```js
  {
    host, port, secure: account.imap_tls,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: !skipTls, /* + servername/lookup/autoSelectFamily когда resolved.lookup задан */ },
    commandTimeout: 30000,
    maxIdleTime: idleKeepaliveMs || 25 * 60 * 1000, // только когда enableIdle
    autoIdleDelay: AUTO_IDLE_DELAY_MS, // = 3000 мс, только когда enableIdle
  }
  ```
  `autoIdleDelay = 3000` — это не опечатка теста, это реальная константа из кода (комментарий
  в коде объясняет: должна быть меньше минимального интервала синхронизации 15000 мс, иначе
  IDLE вообще не запускается — исторический баг, уже пофикшен).
- **Per-host cap на персистентные IDLE-соединения** (комментарии на строках 293–328, 2226–2412):
  есть механизм `IMAP_MAX_PERSISTENT_PER_HOST` + per-provider `maxPersistentPerHost`, который
  выше некоторого числа аккаунтов на одном IMAP-хосте переводит "лишние" ящики в poll-only
  (без IDLE, просто периодический open→sync→close). **По умолчанию `PERSISTENT_CAP_ENV` парсится
  из несуществующей переменной окружения и равен `Infinity`, и ни один встроенный provider-профиль
  `maxPersistentPerHost` не задаёт** (`parsePersistentCap` возвращает `Infinity`, если строка не
  положительное целое). То есть **без явной настройки оператором все 500 ящиков на одном IMAP-хосте
  будут держать персистентный IDLE одновременно** — ровно то, что мы и воспроизвели в бенчмарке.
  Единственное встроенное ограничение — `mail_max_userip_connections` на стороне Dovecot (по
  умолчанию 10), но оно про несколько *соединений одного пользователя*, а не про число разных
  ящиков на хосте, так что 500 разных пользователей на 993/TLS его не задевают.

## 2. Dovecot + ImapFlow: методика

### 2.1 Dovecot-контейнер

`me-bench-dovecot`, Dockerfile от `dovecot/dovecot:2.3.21`, добавляет свой `dovecot.conf`,
passwd-file на 500 пользователей (`user001`…`user500`, все с паролем `benchpass1`,
`scheme=PLAIN`) и сидит 3 маленьких письма в maildir `INBOX` каждого пользователя
(`cur/new/tmp`, ~500 байт на письмо) — чтобы `SELECT`/IDLE смотрели на реальный, а не пустой,
ящик.

`dovecot/dovecot.conf` (полностью, как использовалось в тесте):

```
protocols = imap

mail_location = maildir:~/Maildir
mail_uid = 1000
mail_gid = 1000
first_valid_uid = 1000
last_valid_uid = 1000

disable_plaintext_auth = no
auth_mechanisms = plain login

passdb {
  driver = passwd-file
  args = scheme=PLAIN username_format=%u /etc/dovecot/users
}
userdb {
  driver = static
  args = uid=1000 gid=1000 home=/srv/mail/%u
}

ssl = yes
ssl_cert = </etc/ssl/certs/ssl-cert-snakeoil.pem
ssl_key = </etc/ssl/private/ssl-cert-snakeoil.key

namespace inbox {
  inbox = yes
  separator = /
}

mail_max_userip_connections = 20

service imap-login {
  process_limit = 700
}
service imap {
  process_limit = 700
}
service auth {
  client_limit = 1200
}
service anvil {
  client_limit = 1200
}

listen = *
log_path = /dev/stdout
info_log_path = /dev/stdout
debug_log_path = /dev/stdout
verbose_proctitle = yes
```

**Важная находка по ходу теста** (не была очевидна заранее): при TLS/993 `imap-login` — это
не только "процесс на логин", он **остаётся жить на всё время сессии как TLS-proxy**
(`docker top` показывает `dovecot/imap-login [172.20.0.3 TLS proxy]` рядом с
`dovecot/imap [userNNN … IDLE]` для *каждого* подключения). Значит для 500 IDLE-сессий это
**два процесса на ящик**, а не один — `service imap-login { process_limit }` надо поднимать
до того же порядка, что и `service imap`, а не только под всплеск логинов. Первая версия
конфига (`process_limit = 300` для imap-login) была рассчитана на "логин — это всплеск", это
оказалось неверной моделью именно для TLS.

Порт 993 проброшен наружу (`-p 19930:993`) только для первого ручного smoke-теста; в основном
прогоне контейнеры Node и Dovecot общаются по внутреннему Docker DNS `me-bench-dovecot:993`
без публикации портов.

### 2.2 Node-бенчмарк (`node/bench.js`)

Образ `me-bench-node`: `node:22-bookworm-slim` + `npm install imapflow@2.0.3` (точная
залоченная версия MailExpert) + `bench.js`, запуск `node --expose-gc bench.js <N> <holdSeconds>`.

Полный файл `node/bench.js`:

```js
// me-bench: opens N ImapFlow clients against the me-bench-dovecot server, one per
// mailbox (userNNN), each doing connect -> mailboxOpen('INBOX') and then relying on
// ImapFlow's built-in auto-IDLE (armed after autoIdleDelay of quiet) — exactly the
// steady state MailExpert's persistent sync connections sit in.
//
// Client options are copied from backend/src/services/imapManager.js makeClientCfg()
// (enableIdle branch), MailExpert's imapflow@2.0.3:
//   logger: false, tls: { rejectUnauthorized }, commandTimeout: 30000,
//   maxIdleTime: 25*60*1000 (default, no idleKeepaliveMs override),
//   autoIdleDelay: AUTO_IDLE_DELAY_MS = 3000.
// The `resolved.lookup`/`autoSelectFamily` branch is skipped: that only fires when
// hostValidation pins resolved addresses, which doesn't apply to a single-address
// container hostname.
//
// Usage: node --expose-gc bench.js <N> [holdSeconds]
// Env: BENCH_HOST (default me-bench-dovecot), BENCH_PORT (default 993),
//      BENCH_CONCURRENCY (default 20)

import { ImapFlow } from 'imapflow';

const N = Number.parseInt(process.argv[2] ?? '0', 10);
const HOLD_SECONDS = Number.parseInt(process.argv[3] ?? '60', 10);
const HOST = process.env.BENCH_HOST || 'me-bench-dovecot';
const PORT = Number.parseInt(process.env.BENCH_PORT || '993', 10);
const CONCURRENCY = Number.parseInt(process.env.BENCH_CONCURRENCY || '20', 10);

function makeClientCfg(user, pass) {
  return {
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: false },
    commandTimeout: 30000,
    maxIdleTime: 25 * 60 * 1000,
    autoIdleDelay: 3000,
  };
}

function userFor(i) {
  return `user${String(i).padStart(3, '0')}`;
}

async function connectOne(i) {
  const user = userFor(i);
  const client = new ImapFlow(makeClientCfg(user, 'benchpass1'));
  client.on('error', (err) => {
    console.error(`[client ${i}] error: ${err.message}`);
  });
  await client.connect();
  await client.mailboxOpen('INBOX');
  return client;
}

// Small fixed-concurrency ramp, mirroring MailExpert's DEFAULT_CONNECT_CONCURRENCY (3)
// but a bit higher so N=500 doesn't take forever to ramp up in a benchmark run.
async function connectAll(n, concurrency) {
  const clients = [];
  let next = 1;
  let failures = 0;
  async function worker() {
    while (next <= n) {
      const i = next++;
      try {
        clients.push(await connectOne(i));
      } catch (err) {
        failures++;
        console.error(`[client ${i}] connect failed: ${err.message}`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, Math.max(n, 1)) }, worker);
  await Promise.all(workers);
  return { clients, failures };
}

function snapshotMemory(label) {
  if (global.gc) {
    global.gc();
    global.gc();
  }
  const mem = process.memoryUsage();
  console.log(`MEM ${label} ${JSON.stringify(mem)}`);
  return mem;
}

async function main() {
  console.log(`BENCH_START N=${N} host=${HOST}:${PORT} concurrency=${CONCURRENCY} pid=${process.pid}`);
  snapshotMemory('baseline_before_connect');

  const t0 = Date.now();
  const { clients, failures } = await connectAll(N, CONCURRENCY);
  const connectMs = Date.now() - t0;
  console.log(`CONNECTED count=${clients.length} failures=${failures} connectMs=${connectMs}`);

  // Let auto-IDLE arm (autoIdleDelay=3000ms) and let the process settle before the first
  // measurement; then hold per the task's "after 60 seconds have passed" requirement.
  await new Promise((r) => setTimeout(r, HOLD_SECONDS * 1000));

  snapshotMemory(`after_hold_${HOLD_SECONDS}s`);
  console.log(`READY_FOR_EXTERNAL_SAMPLING pid=${process.pid} count=${clients.length}`);

  // Hold well past any external sampling window (run-one.sh force-removes the container
  // once it has what it needs, rather than racing this timer) so `docker stats`/`docker
  // top` never sample mid-teardown.
  await new Promise((r) => setTimeout(r, 180 * 1000));

  snapshotMemory('final');
  console.log('BENCH_DONE');

  // Best-effort graceful logout; do not let a slow/hung logout block process exit.
  await Promise.race([
    Promise.allSettled(clients.map((c) => c.logout().catch(() => {}))),
    new Promise((r) => setTimeout(r, 10000)),
  ]);
  process.exit(0);
}

main().catch((err) => {
  console.error('BENCH_FATAL', err);
  process.exit(1);
});
```

### 2.3 Оркестрация одного прогона (`run-one.sh`)

Для каждого N: свежий контейнер Dovecot → свежий контейнер Node (`me-bench-node:latest N 60`)
→ ждём в логах `READY_FOR_EXTERNAL_SAMPLING` (печатается после 60-секундной выдержки) → 3×
`docker stats --no-stream` с интервалом 5 с + `docker top me-bench-dovecot -eo pid,rss,args`
(считаем `dovecot/imap [...]`, `dovecot/imap-login`, `... IDLE]`) → `docker rm -f` обоих
контейнеров. Скрипт пишет полный лог каждого прогона в `bench/results/N<число>.log` (логи в репозиторий не входят).

**Грабля по дороге**: первая версия скрипта делала выборку статистики через ~84 с после
детекта `READY`, а `bench.js` в той версии держался всего 30 с после `READY` перед graceful
logout — то есть `docker top` иногда попадал точно в момент разлогинивания и показывал 0
IMAP-процессов при живом Node-клиенте. Исправлено увеличением окна до 180 с и переносом
семплирования сразу после `READY` (см. `bench/node/bench.js`, `bench/run-one.sh`).

## 3. Сырые результаты, N = 0, 1, 100, 250, 500

Оба контейнера свежие на каждый N (без остаточного состояния от предыдущего прогона). 0
ошибок подключения на всех N (`failures=0`).

| N | connectMs | Node RSS после 60с | Node heapUsed | Dovecot mem (docker stats, ×3 сэмпла) | Dovecot PIDs | imap procs | imap-login procs | все в IDLE? | CPU (idle) |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 1 | 72 474 624 B (69.13 МиБ) | 9.81 МБ | 4.74 МиБ | 5 | 0 | 0 | — | 0% |
| 1 | 55 | 69 840 896 B (66.60 МиБ) | 10.63 МБ | 7.15 МиБ (7.203/7.203/7.102) | 9 | 1 | 1 | да | 0% |
| 100 | 583 | 81 772 544 B (77.98 МиБ) | 13.49 МБ | 202.90 МиБ (202.9×3) | 207 | 100 | 100 | да | 0% (единичный всплеск 0.55%) |
| 250 | 1 268 | 103 899 136 B (99.09 МиБ) | 16.98 МБ | 498.63 МиБ (499.0/498.5/498.4) | 507 | 250 | 250 | да | 0% (0.35%) |
| 500 | 7 429 | 123 715 584 B (117.98 МиБ) | 21.00 МБ | 989.87 МиБ (988.7/990.9/990.4) | 1 007 | 500 | 500 | да | 0% (0.98% на Node, единичный сэмпл) |

Примечания:
- N=1 Node RSS *ниже*, чем N=0 — это шум V8/аллокатора на маленьких числах (разное время сборки
  мусора относительно момента снапшота), не отрицательная стоимость соединения. Для оценки
  цены соединения надёжнее наклон между N=100 и N=500, где тренд куда чище.
- `connectMs` растёт нелинейно (7.4 с на 500 при concurrency=20) — это время установления TLS-хендшейков
  пачками, не имеет отношения к установившемуся расходу памяти.
- Dovecot PIDs = 7 общих сервисных процессов (tini, master, anvil, log, config, stats, auth) + 2×N
  (imap + imap-login на каждое соединение); формула точно подтверждается на всех N (напр. 1007 = 7 + 2×500).

## 4. Дельты на одно соединение

**Dovecot (по `docker stats`, cgroup-память контейнера — корректная метрика, без задвоения
разделяемых страниц библиотек):**

| Интервал | ΔМиБ / Δсоединений | МиБ/соединение |
|---|---|---|
| 0 → 100 | 198.16 / 100 | 1.982 |
| 100 → 250 | 295.73 / 150 | 1.972 |
| 250 → 500 | 491.24 / 250 | 1.965 |
| 0 → 500 (в целом) | 985.13 / 500 | 1.970 |

Очень линейно — Dovecot стабильно стоит **≈1.97 МиБ (≈2.07 МБ) на IDLE-соединение** (сумма
`imap`-процесса ~5.3–5.6 МБ RSS и `imap-login`-TLS-proxy ~6.6–6.9 МБ RSS *индивидуально* по
`docker top`, но это наивная сумма RSS переоценивает реальную стоимость в ~5–6 раз — процессы
Dovecot после `fork()` делят страницы разделяемых библиотек (libssl, libc, код Dovecot), и
`docker top`/`ps` считает эти страницы в RSS каждого процесса отдельно. Реальная добавочная
(unique) память на подключение — это дельта cgroup-памяти контейнера, то есть 1.97 МиБ, а не
~12 МБ наивной суммы).

**Node.js / ImapFlow-клиент MailExpert (RSS процесса):**

| Интервал | ΔКиБ / Δсоединений | КиБ/соединение |
|---|---|---|
| 0 → 100 | 9 082.03 / 100 | 90.82 |
| 100 → 250 | 21 607.03 / 150 | 144.05 |
| 250 → 500 | 19 352.00 / 250 | 77.41 |
| 0 → 500 (в целом) | 50 040.00 / 500 | 100.08 |

Разброс между интервалами (77–144 КиБ) — это шум GC/V8 heap-роста скачками (heapTotal растёт
не гладко), не стабильно линейный процесс, как у Dovecot. Берём **≈100 КиБ на IDLE-соединение**
как рабочую оценку для MailExpert-backend со стороны Node.

## 5. Экстраполяция на 500 ящиков на одном хосте

- **Dovecot**: 4.74 МиБ (база) + 500 × 1.97 МиБ ≈ **989.7 МиБ** — совпадает с прямо измеренным
  значением на N=500 (989.87 МиБ), это самосогласованная проверка модели.
- **Node/MailExpert (только слой IMAP-клиентов)**: ≈70 МиБ (база) + 500 × 100 КиБ ≈ **≈120 МБ**
  — тоже совпадает с прямым измерением (117.98 МиБ). **Это НЕ полный footprint процесса
  backend** — реальный MailExpert-процесс дополнительно держит пул соединений к Postgres/Redis,
  Express/WS-сервер для UI-клиентов, кэши категоризации, indexing snippet-очередь и т.д.; тест
  измеряет только вклад слоя "500 висящих ImapFlow-клиентов в IDLE", а не весь процесс.
- Поскольку по умолчанию демоушен в poll-only выключен (раздел 1), **все 500 ящиков на одном
  IMAP-хосте будут держать IDLE одновременно** — сценарий "500 mailboxes on one host" из
  задания реалистичен только если у оператора именно так настроено (единый self-hosted
  Dovecot/IMAP-хост на 500 ящиков), либо это верно per-host для тех пользователей, что физически
  сидят на одном провайдере (напр. один корпоративный IMAP-сервер с 500 аккаунтами).

## 6. PostgreSQL: синтетическая оценка на сообщение

**Важно: это полностью синтетический тест на одноразовом `postgres:16-alpine` (`me-bench-pg`),
без обращения к реальной базе MailExpert.** Схема `messages` восстановлена вручную чтением
`backend/migrations/0001_baseline.sql` + всех последующих миграций, трогающих `messages`
(0002, 0006–0009, 0011, 0016, 0021, 0023–0025, 0037, 0044, 0048, 0050, 0058, 0060–0061, 0063,
0065–0066); итоговая таблица — 38 колонок (включая 2 generated/stored: `thread_key`,
`search_vector`) и **20 индексов** (полный SQL — `bench/pg/schema.sql`). Тела писем
хранятся в `body_text` (TEXT), `body_html` (TEXT), плюс `snippet` (TEXT) — все TOAST-опираемые.

По коду (`imapManager.js`, INSERT/UPSERT в `messages`): при полном бэкафилле для не-Gmail
провайдеров `body_html`/`body_text` пишутся сразу при синке; отдельно есть ленивый путь
(`WHERE body_html IS NULL AND body_text IS NULL` — строки ~5305–5369), который дозаполняет тело
для строк, где его ещё нет. То есть для части сообщений (в первую очередь — Gmail/CONDSTORE-only
дельта-синки) тело может отсутствовать до отдельного ленивого фетча; ниже дана оценка и "с
телом", и "только метаданные".

### 6.1 Генерация данных

10 000 строк, 10 синтетических `account_id`. Тела строятся не через `repeat('x', n)` и не через
случайные байты (это дало бы нереалистичное сжатие в любую сторону), а сэмплированием из пула
из 30 фиксированных предложений — так TOAST-сжатие ведёт себя как на реальной прозе/HTML:
`body_text` — конкатенация ~30–45 предложений (~3.5–5 КБ), `body_html` — те же предложения,
обёрнутые в `<p style="...">` с повторяющимся inline-CSS (~65–90 параграфов, ~18–23 КБ) — именно
так выглядит реальная разметка email-рассылок, с большим количеством повторяющегося boilerplate.

Полный `bench/pg/seed.sql` — рядом с этим отчётом; ключевой фрагмент (PL/pgSQL-цикл на 10 000 итераций,
выполнился за ~44 с вместе с `VACUUM ANALYZE`):

```sql
FOR i IN 1..10000 LOOP
  n_sent := 30 + floor(random() * 15)::int;
  body_txt := '';
  FOR j IN 1..n_sent LOOP
    body_txt := body_txt || sentences[1 + floor(random() * pool_len)::int] || ' ';
  END LOOP;

  n_html := 65 + floor(random() * 25)::int;
  body_htm := '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;">';
  FOR j IN 1..n_html LOOP
    body_htm := body_htm || '<p style="' || html_style || '">' ||
      sentences[1 + floor(random() * pool_len)::int] || '</p>';
  END LOOP;
  body_htm := body_htm || '</div>';

  INSERT INTO messages (account_id, uid, folder, message_id, subject, from_name, from_email,
    to_addresses, cc_addresses, date, snippet, body_text, body_html,
    is_read, is_starred, has_attachments, sender_email, sender_name)
  VALUES ( ... );
END LOOP;
```

### 6.2 Результаты (`pg/measure.sql`, после `VACUUM ANALYZE`)

| Метрика | Значение | На строку |
|---|---|---|
| Всего строк | 10 000 | — |
| **Итого (heap + TOAST + все индексы)** | **103 МБ** | **10 818 байт (≈10.8 КБ)** |
| heap + TOAST (без индексов) | 65 МБ | 6 804 байт (≈6.8 КБ) |
| Все индексы вместе | 38 МБ | 4 014 байт (≈4.0 КБ) |

`body_text`: сырой размер в среднем 3 825 байт → после сжатия в TOAST **1 638 байт** (~57%
сжатия). `body_html`: сырой размер в среднем 17 815 байт → после сжатия **3 652 байт** (~79%
сжатия, ожидаемо — много повторяющегося inline-CSS). Метаданные (id/account_id/uid/folder/
message_id/subject/from_name/from_email/snippet вместе) — в среднем ~294 байт хранимого
размера.

Топ-5 самых тяжёлых индексов (из 38 МБ индексов, вместе — ~71%):

| Индекс | Размер | Что индексирует |
|---|---|---|
| `idx_messages_body` | 8 440 КБ | GIN по `to_tsvector(body_text)` — полнотекстовый поиск по телу |
| `idx_messages_subject_trgm` | 5 768 КБ | GIN trgm по `subject` (ILIKE-поиск) |
| `idx_messages_from_email_trgm` | 4 736 КБ | GIN trgm по `from_email` |
| `idx_messages_search_vector` | 4 392 КБ | GIN по сохранённому `search_vector` (subject+from+snippet) |
| `idx_messages_from_name_trgm` | 3 640 КБ | GIN trgm по `from_name` |

Остальные 15 индексов (B-tree по thread/account/date-комбинациям, partial-индексы) суммарно —
около 11 МБ. GIN-индексы полнотекстового/триграммного поиска — основной вклад в стоимость
индексов, а не threading/pagination-индексы.

### 6.3 Оценка "только метаданные" (тело ещё не закэшировано)

Грубая оценка: heap+TOAST на строку с телом (6 804 Б) минус среднее TOAST-сжатое тело
(1 638 + 3 652 = 5 290 Б) ≈ **~1 514 байт (~1.5 КБ) на строку без тел**. Индексы почти не
меняются в размере (кроме `idx_messages_body`, который для NULL-body практически пустой) —
то есть основная экономия именно на heap/TOAST-стороне, а не на индексах.

### 6.4 Экстраполяция на 500 ящиков

Линейная модель (только таблица `messages`, без учёта `contacts`, `folders`, `categories`,
`plugin_data` и т.д.):

| Сообщений на ящик (в среднем) | Всего сообщений (500 ящиков) | Оценка размера `messages` |
|---|---|---|
| 1 000 | 500 000 | ≈ 5.4 ГБ |
| 2 000 | 1 000 000 | ≈ 10.8 ГБ |
| 5 000 | 2 500 000 | ≈ 27 ГБ |
| 10 000 | 5 000 000 | ≈ 54 ГБ |

## 7. Оговорки (caveats)

1. **Синтетическая нагрузка, не боевая.** Реальные ящики дают всплески (initial backfill
   тысяч писем разом, синхронизация после reconnect, EXISTS-уведомления с последующим fetch) —
   пиковое потребление памяти/CPU при синке будет заметно выше, чем в состоянии чистого простоя
   IDLE, которое мы измеряли. Этот тест даёт "пол" (нижнюю границу, стационарный расход), а не
   пиковую нагрузку.
2. **Вложения не учтены.** `attachments` — JSONB-метаданные в самой строке `messages`; сами
   файлы вложений MailExpert хранит не в этой таблице (это не проверялось в рамках задания —
   куда именно, нужно смотреть отдельно), так что их стоимость в PostgreSQL-оценку не входит.
3. **Gmail/другие провайдеры ≠ Dovecot.** Тест эмулирует generic IMAP/Dovecot с TLS. У Gmail и
   других провайдеров может отличаться: XOAUTH2 вместо PLAIN (другой путь аутентификации, но
   TCP/TLS-соединение то же самое), собственные лимиты на конкурентные IDLE-соединения,
   собственная серверная реализация (не Dovecot) — цифры по Dovecot-памяти неприменимы к
   провайдер-стороне для Gmail/Yahoo/Outlook (там стоимость несёт сам провайдер, не оператор
   MailExpert), но Node-сторона (~100 КиБ/соединение) актуальна для любого провайдера одинаково.
4. **Dovecot service-модель — не единственно возможная.** Использована стандартная схема
   "процесс на соединение" (`service_count` по умолчанию для `imap`, `process_limit` только
   поднят); альтернативная модель `service_count = 0` с мультиплексированием многих клиентов в
   одном login-процессе дала бы меньше процессов (и, вероятно, меньше памяти на серверных
   структурах на процесс), но за счёт другого профиля CPU/изоляции отказов. Не тестировалось.
5. **На Node-стороне бо́льшая часть цены соединения — не в V8-heap, а в нативной памяти,
   невидимой `process.memoryUsage().external`.** Раскладка дельты 0→500 (100.08 КиБ/соединение
   по RSS): `heapUsed` растёт с ~9.8 МБ (N=0) до ~21.0 МБ (N=500), то есть ~21.9 КиБ/соединение
   в heap (объект `ImapFlow`, парсер IMAP-протокола, слушатели событий). Оставшиеся ~78
   КиБ/соединение (три четверти всей стоимости) — это **не heap и не `external`/
   `arrayBuffers`** (эти поля у нас держались почти константными, ~2.2 МБ, на всех N): `external`
   отражает только то, что знает сам V8 (буферы, созданные через известные V8/Node API), а
   TLS-состояние OpenSSL (SSL-структуры, BIO-буферы) и хендл сокета libuv аллоцируются в C++ в
   обход этого счётчика и в `process.memoryUsage()` не видны напрямую — они и есть основной
   источник тех ~78 КиБ. Практический вывод: цифра ~100 КиБ/соединение — это в основном стоимость
   именно TLS-сессии на клиенте, а не JS-объектов; на голом (не-TLS) IMAP она была бы заметно
   ниже.
6. **Постгрес-схема реконструирована руками**, а не выгружена `pg_dump` с боевой базы — при
   несовпадении с реальной схемой (например, если в проде есть незакоммиченные локально
   миграции) цифры сместятся. Список миграций, из которых собрана схема, — в разделе 6.
7. **"0% CPU в простое" — это между тиками keepalive, не буквально ноль всегда.** Dovecot по
   умолчанию (`imap_idle_notify_interval`, 2 минуты) рассылает untagged `* OK Still here` во все
   500 TLS-соединений каждые 120 с, а ImapFlow переустанавливает IDLE-команду каждые
   `maxIdleTime` = 25 минут на каждом из 500 клиентов. Наше окно измерения (60 с выдержки +
   ~15 с семплирования) захватывает от силы один такой тик, поэтому CPU в установившемся режиме
   действительно маленький, но не буквально нулевой на длинных интервалах — корректная
   формулировка: "CPU-стоимость простаивающих IDLE-соединений на два порядка меньше, чем
   память-стоимость", а не "равна нулю".
8. **Тест на Windows-хосте / Docker Desktop VM**, не на bare-metal Linux — абсолютные числа
   памяти ОС (ядро, страничный кэш и т.д.) на реальном сервере будут отличаться, но
   относительная стоимость на процесс (RSS Node, cgroup-память Dovecot-контейнера) — это уже
   числа реального Linux-контейнера (задание специально требовало запускать Node в
   `node:22-bookworm-slim` на той же сети, что и IMAP-сервер, для честности Linux-цифр — это
   выполнено).

## 8. Файлы теста

Всё лежит в каталоге `bench/` рядом с этим отчётом:
- `dovecot/Dockerfile`, `dovecot/dovecot.conf`, `dovecot/seed-mail.sh`, `dovecot/users` — тестовый Dovecot 2.3.21 с 500 пользователями (пароли тестовые);
- `node/Dockerfile`, `node/package.json`, `node/bench.js` — клиент на ImapFlow с теми же опциями, что в MailExpert;
- `pg/schema.sql`, `pg/seed.sql`, `pg/measure.sql` — синтетический замер таблицы `messages`;
- `run-one.sh` — один прогон для заданного числа ящиков.

Как повторить: создать сеть `docker network create me-bench-net`, собрать образы `me-bench-dovecot` и `me-bench-node` из `bench/dovecot` и `bench/node`, затем запустить `bash run-one.sh 500` (и 0, 100, 250 для наклона). Скрипт сам удаляет свои контейнеры; сеть после замеров удалить вручную. Все контейнеры замера имеют префикс `me-bench-` и не пересекаются с рабочими.
