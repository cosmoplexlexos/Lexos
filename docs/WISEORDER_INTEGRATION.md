# Lexos — WiseOrder Integration Brief

Lexos is a vocabulary middleware layer. It sits between your voice UI and your LLM/ASR engines.
You call it on every utterance. It tells you what the user meant, with enough context to make
your LLM response accurate.

---

## Base URL

```
https://<lexos-production-url>
```

> URL will be provided once deployed. All examples below use this placeholder.

---

## Authentication

Every request to `/enrich` and `/retrieve` must include:

```
X-API-Key: <provided-secret>
```

Requests without this header return `401 Unauthorized`.

---

## The 3-call flow

### 1. Session start — load ASR vocabulary bias

Call this once when a new voice session begins (customer picks up, app opens, etc.).
Primes your ASR engine with relevant vocabulary so it transcribes domain words correctly.

```
GET /retrieve/asr-bias?lang=hi-IN&workflow=north-indian-restaurant&asr_engine=deepgram-nova3
```

**Headers:**
```
X-API-Key: <secret>
X-Tenant-ID: north-indian-restaurant
X-Product-ID: wiseorder
```

**Response (Deepgram Nova-3):**
```json
{
  "asr_engine": "deepgram-nova3",
  "keyterms": ["dosa", "idli", "cutting chai", "vada pav", "thali", "anna", "akka"],
  "count": 7
}
```

**Response (Whisper):**
```json
{
  "asr_engine": "whisper",
  "initial_prompt": "Customer is ordering at a South Indian restaurant. Common items: dosa, idli, filter kaapi, vada, sambar. Staff are addressed as anna or akka.",
  "token_count": 38
}
```

Pass `keyterms` to Deepgram's `keyterm` boosting parameter, or `initial_prompt` to Whisper's
`initial_prompt` field. This reduces ASR transcription errors on food/menu vocabulary.

**Supported `asr_engine` values:** `deepgram-nova3`, `whisper`, `sarvam`

---

### 2. Per-utterance — resolve intent and get LLM context

Call this for every utterance your ASR transcribes.

```
POST /enrich
```

**Headers:**
```
X-API-Key: <secret>
X-Tenant-ID: north-indian-restaurant
X-Product-ID: wiseorder
X-User-ID: <your-session-user-id>
```

**Body:**
```json
{
  "phrase": "bhai ek cutting dena",
  "lang": "hi-IN",
  "workflow": "north-indian-restaurant",
  "domain": "qsr",
  "include_context": true
}
```

**Response (resolved):**
```json
{
  "intent": "LEXOS_CART_ADD_ITEM",
  "confidence": 0.91,
  "matched_head": "ek cutting chahiye",
  "match_type": "exact",
  "latency_ms": 4,
  "call_id": "a1b2c3d4-...",
  "matched_item": "Masala Chai",
  "enriched_context": {
    "intent": "LEXOS_CART_ADD_ITEM",
    "variants": ["ek cutting dena", "cutting chahiye", "half chai dena", "cutting lao bhai"],
    "tier": "A",
    "domain": "qsr"
  }
}
```

> `matched_item` is the resolved menu item (slot), populated when the tenant has
> a menu on file (see **Menu provisioning** below) and the utterance names an
> item. Null otherwise. Menu grounding is what lets Lexos tell "bill dena"
> (→ CHECKOUT) from "ek samosa dena" (→ ADD, item "Samosa"), and reject
> off-menu requests ("I want a cab" → miss).

**Response (miss — intent not found):**
```json
{
  "intent": null,
  "confidence": 0,
  "matched_head": null,
  "match_type": "miss",
  "latency_ms": 12,
  "call_id": "a1b2c3d4-...",
  "enriched_context": null
}
```

**Using the response:**

- If `intent` is not null: inject into your LLM system prompt before calling Claude/GPT:
  ```
  Resolved intent: LEXOS_CART_ADD_ITEM (confidence: 0.91).
  Context phrases: ek cutting dena, cutting chahiye, half chai dena.
  The user said: "bhai ek cutting dena"
  ```
- If `intent` is null: fall back to your existing LLM flow. Lexos has already logged the miss
  and will generate a variant for it automatically.
- **Always save the `call_id`** — you need it for step 3.

**`match_type` values:**
| Value | Meaning |
|---|---|
| `exact` | Phrase matched a known variant directly |
| `semantic` | Phrase resolved by the intent classifier (over bge-m3 embeddings) |
| `miss` | No match found |

> For `semantic` results, `confidence` is the classifier's probability for the
> winning intent. These run lower than exact-match confidence (often 0.2–0.6)
> by design — the value is comparative, not an accuracy guarantee. Treat any
> non-null `intent` as resolved.

---

### 3. Outcome report — close the feedback loop

After your LLM responds and you know if the order was handled correctly, report the outcome.
This is what makes Lexos learn — incorrect outcomes re-enter the generation pipeline automatically.

```
PATCH /enrich/<call_id>/outcome
```

**Headers:**
```
X-API-Key: <secret>
```

**Body:**
```json
{
  "outcome": "correct"
}
```

**Outcome values:**
| Value | When to send |
|---|---|
| `correct` | LLM handled the intent correctly, user got what they wanted |
| `incorrect` | LLM mishandled it — wrong item added, wrong intent acted on |
| `abandoned` | User ended session without completing the action |

**Response:**
```json
{
  "call_id": "a1b2c3d4-...",
  "outcome": "correct",
  "updated": true
}
```

> Incorrect outcomes automatically log the phrase to the miss queue. Lexos will generate
> a better explicit variant for it within the next generation pass.

---

## Supported languages

**Always pass `lang` on every `/enrich` call.** Intent resolution uses a
per-language classifier — supplying the wrong language (or omitting it) degrades
accuracy. WiseOrder knows the session language, so send it explicitly; do not
rely on auto-detection.

Currently active:

| Code | Language |
|---|---|
| `hi-IN` | Hindi |
| `kn-IN` | Kannada |
| `mr-IN` | Marathi |
| `ta-IN` | Tamil |
| `te-IN` | Telugu |

Temporarily disabled (vocabulary retained, can be re-enabled): `bn-IN` Bengali,
`gu-IN` Gujarati, `es-ES` Spanish, `ar-AE` Arabic Gulf. Phrases in these
languages currently return a miss.

---

## Menu provisioning (per tenant)

Upload each tenant's menu via the admin dashboard (or `POST /admin/tenants/:id/menu`).
Lexos embeds every form so it can tell real items from generic words ("vada" is
on the menu, "bill" is not), pick the action from cues, and return the resolved
item as a slot. Re-upload when the menu changes.

For best multilingual/colloquial matching, send the canonical name plus its
forms in each language and any colloquial/romanized aliases — all resolve to the
one canonical `name`:

```json
{
  "items": [
    {
      "name": "Masala Dosa",
      "category": "BREAKFAST",
      "names": ["मसाला डोसा", "ಮಸಾಲ ದೋಸೆ", "மசாலா தோசை", "మసాలా దోస", "मसाला डोसा"],
      "aliases": ["masala dose", "masle dose", "masala dosai"]
    }
  ]
}
```

`name` is required; `category`, `names[]`, and `aliases[]` are optional but
recommended. Matching is similarity-based, so a spoken form resolves to the
canonical name ("benne masale dose" → "Masala Dosa", "filter kaapi" → "Filter
Coffee"). Tenants without a menu still work — they fall back to intent
classification without item grounding.

## API key resolves the tenant

Each tenant has its own `X-API-Key` (generate in the dashboard). The key
identifies the tenant, so `/enrich` does **not** require `tenant_id` in the body
or `X-Tenant-ID` — just send the key. (Passing `X-Tenant-ID` still works and
overrides.)

---

## Supported workflows (tenants)

| `workflow` / `X-Tenant-ID` | Primary language | Coverage |
|---|---|---|
| `south-indian-restaurant` | `ta-IN` | Also covers kn-IN, te-IN speakers |
| `north-indian-restaurant` | `hi-IN` | Also covers mr-IN speakers |
| `generic` | None | No language preference, global corpus only |

> The `international` tenant (es-ES / ar-AE) is inactive while those languages
> are disabled.

---

## Performance targets

| Metric | Target |
|---|---|
| `/enrich` exact match p99 | < 10ms |
| `/enrich` semantic match p99 | < 100ms |
| `/retrieve/asr-bias` | < 50ms |

---

## Error responses

| Status | Meaning |
|---|---|
| `401` | Missing or invalid `X-API-Key` |
| `400` | Missing required fields (`phrase`, `lang`) |
| `500` | Internal error — retry once, then contact Lexos |

---

## Minimal integration checklist

- [ ] Store `X-API-Key` as a secret in your environment (never hardcode)
- [ ] Call `GET /retrieve/asr-bias` at session start, pass result to your ASR engine
- [ ] Call `POST /enrich` on every utterance
- [ ] When `intent` is not null, inject `intent` + `enriched_context.variants` into LLM system prompt
- [ ] Save `call_id` from every enrich response
- [ ] Call `PATCH /enrich/:call_id/outcome` after each interaction resolves
