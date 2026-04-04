# Normalization — Design Decisions

## The Three Tiers

Data normalization is what justifies crm.cli over a spreadsheet. A CSV stores whatever you type. crm.cli normalizes on write so that lookups, deduplication, and display work regardless of how data was entered.

We landed on three normalization tiers with different strictness levels:

| Tier | Fields | On invalid input |
|------|--------|------------------|
| **Strict** | Phone numbers | Reject with error |
| **Permissive** | Websites | Store as-is |
| **Extract** | Social handles | Store as-is |

The reasoning behind each tier's strictness:

**Phones are strict** because a wrong E.164 value corrupts lookups permanently. If `+1234` gets stored instead of `+12125551234`, every future lookup for that contact by phone fails silently. The cost of a false rejection (user re-enters the number correctly) is low. The cost of a false acceptance (corrupted data) is high.

**Websites are permissive** because URL formats are surprisingly diverse. IP addresses, ports, unusual TLDs, IDN domains — rejecting anything `normalize-url` can't parse would block legitimate input. Storing a weird URL as-is is better than refusing it. The cost of false acceptance (a slightly non-canonical URL) is just a missed dedup opportunity. The cost of false rejection (user can't add their company) is losing data.

**Social handles are extract-best-effort** because users will paste LinkedIn URLs instead of typing handles. We should handle that gracefully. But if someone types something we don't recognize as a URL pattern, it's probably a handle — store it. The extraction is a convenience, not a gate.

## Why E.164, not "just store what they type"

We considered storing phone numbers as entered and normalizing at query time. Rejected because:

1. **Dedup breaks.** `+1-212-555-1234` and `(212) 555-1234` look different but are the same number. Without canonical storage, duplicate detection requires normalizing every phone on every comparison.
2. **Lookup breaks.** `crm contact show "212-555-1234"` needs to find a contact stored as `+1 (212) 555-1234`. Normalizing at query time means normalizing the query AND every stored value.
3. **Export breaks.** Exporting to CSV and re-importing would create duplicates if the formats don't match exactly.

E.164 (`+12125551234`) is the canonical format that every phone library can parse. We normalize once on write, and everything downstream — lookups, dedup, display, FUSE filenames — works from the canonical value.

**Library choice:** libphonenumber-js (Google's libphonenumber ported to JS). It's the industry standard, handles every country format, and provides `isValidNumber()` for strict validation. We considered `awesome-phonenumber` but it's a wrapper around the same Google library with extra weight.

## Why website normalization strips protocol but preserves path

The decision: `https://www.ACME.COM/Labs` → `acme.com/labs`. Protocol and `www.` are stripped; path is preserved.

**Why strip protocol:** `http://acme.com` and `https://acme.com` are the same company. Storing the protocol creates false negatives in dedup.

**Why strip www:** `www.acme.com` and `acme.com` are almost always the same site. Same reasoning as protocol.

**Why preserve path:** `globex.com/research` and `globex.com/consulting` could be different divisions of the same company — different enough to be separate company records. Path-based companies are real (especially in enterprise). Stripping paths would merge them incorrectly.

**Why lowercase host but not path:** Hosts are case-insensitive per RFC. Paths can be case-sensitive (some servers distinguish `/About` from `/about`). We lowercase the host for canonical comparison but preserve path case. In practice this rarely matters, but it's the correct behavior.

**Why permissive on failure:** `normalize-url` throws on truly bizarre input. Rather than rejecting, we store the raw input. The user presumably knows their company's URL better than our normalizer.

## Why four hard-coded social platforms, not an extensible `socials` JSON

We hard-code LinkedIn, X, Bluesky, and Telegram as dedicated columns. We considered a generic `socials JSON` field (key-value of platform → handle) and rejected it.

**The UNIQUE constraint argument:** SQLite enforces `UNIQUE` on columns, not on JSON keys. With a `socials JSON` field, two contacts could have the same LinkedIn handle and the DB wouldn't catch it. We'd need application-level uniqueness checks, which are race-condition-prone.

**The FUSE argument:** Each platform gets a `_by-linkedin/`, `_by-x/`, etc. directory in the FUSE mount. These are defined by the schema, not dynamically. A generic `socials` field would need a dynamic directory generator — more complex for marginal benefit.

**The URL extraction argument:** Each platform has a specific URL format (`linkedin.com/in/<handle>`, `x.com/<handle>`, `bsky.app/profile/<handle>`, `t.me/<handle>`). A generic system would need a config-driven pattern registry. For 4 platforms, that's over-engineering. For 40 platforms, it would be justified. We're at 4.

**The coverage argument:** These four cover professional networking. If someone needs GitHub or Mastodon, `--set github=octocat` works fine as a custom field. The only thing they lose is UNIQUE enforcement, URL extraction, and a FUSE index — which are "nice to have" for a fifth platform, not essential.

Adding a fifth platform is: schema migration + new URL extraction regex + new FUSE `_by-*` directory + update tests. Straightforward but deliberate — you don't accidentally add social platforms.

## Why handles are stored, not URLs

`https://linkedin.com/in/janedoe` is stored as `janedoe`.

The reasoning: handles are the canonical identifier. URLs vary (`linkedin.com/in/janedoe`, `www.linkedin.com/in/janedoe/`, `https://linkedin.com/in/janedoe?locale=en_US`). The handle `janedoe` is stable across all URL variants.

Storing the handle means: (a) UNIQUE constraint works on a single canonical value, (b) display is clean (`janedoe` not a full URL), (c) we can reconstruct the URL from the handle if needed (the URL pattern is known per platform), (d) lookup works regardless of input format — `crm contact show linkedin.com/in/janedoe` extracts the handle and matches against the stored value.

The extraction is best-effort: if we can't parse the input as a URL, we strip any leading `@` and store as-is. This handles edge cases like someone typing `@janedoe` or just `janedoe` directly.
