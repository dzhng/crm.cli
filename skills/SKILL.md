---
name: crm-cli
description: Manage contacts, companies, deals, and pipeline with crm.cli — a headless CLI-first CRM backed by SQLite with a virtual filesystem interface
install: curl -fsSL https://raw.githubusercontent.com/dzhng/crm.cli/main/install.sh | sh
---

# crm.cli

A headless, CLI-first CRM. Contacts, deals, and pipeline in a single SQLite file — queryable from your terminal, composable with Unix tools, and mountable as a virtual filesystem.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/dzhng/crm.cli/main/install.sh | sh
```

This downloads the precompiled binary to `~/.local/bin` and installs mount dependencies (FUSE on Linux, Rust toolchain on macOS for NFS).

After install, make sure `~/.local/bin` is in your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify:

```bash
crm --version
```

## Configuration

Optional. Create `crm.toml` in your project root or `~/.crm/config.toml`:

```toml
[database]
path = "~/.crm/crm.db"

[pipeline]
stages = ["lead", "qualified", "proposal", "negotiation", "closed-won", "closed-lost"]
won_stage = "closed-won"
lost_stage = "closed-lost"

[defaults]
format = "table"

[phone]
default_country = "US"
display = "international"

[mount]
default_path = "~/crm"
```

Config is auto-discovered by walking up from the current directory. Override with `--config <path>` or `CRM_CONFIG` env var.

## Global Flags

Every command accepts:

- `--db <path>` — SQLite database path (default: `~/.crm/crm.db`, env: `CRM_DB`)
- `--format <fmt>` — Output format: `table`, `json`, `csv`, `tsv`, `ids`
- `--config <path>` — TOML config file path
- `--no-color` — Disable colored output

## Contacts

### Create a contact

```bash
crm contact add --name "Jane Doe" \
  --email jane@acme.com \
  --phone "+1-212-555-1234" \
  --linkedin linkedin.com/in/janedoe \
  --company "Acme Corp" \
  --tag hot-lead \
  --set title=CTO
```

All flags are optional except `--name`. Phones are normalized to E.164, LinkedIn URLs are extracted to handles, companies are auto-created if they don't exist. `--email`, `--phone`, `--company`, `--tag`, and `--set` are all repeatable.

Social handle flags: `--linkedin`, `--x`, `--bluesky`, `--telegram`. All accept raw handles or full URLs.

### List contacts

```bash
crm contact list
crm contact list --tag hot-lead --company "Acme Corp"
crm contact list --filter "title~=CTO AND company=Acme" --sort name --limit 20
crm contact list --format json | jq '.[].name'
```

Filter operators: `=`, `!=`, `~=` (contains), `>`, `<`. Combine with `AND` / `OR`.

### Show a contact

Look up by ID, email, phone, or social handle:

```bash
crm contact show ct_01J8ZVXB3K...
crm contact show jane@acme.com
crm contact show "+12125551234"
crm contact show janedoe          # LinkedIn handle
```

### Edit a contact

```bash
crm contact edit jane@acme.com --name "Jane Smith"
crm contact edit "+12125551234" --add-email jane2@acme.com --rm-tag old-tag
crm contact edit janedoe --add-company "New Corp" --set title=CEO --unset source
```

Add/remove flags: `--add-email`, `--rm-email`, `--add-phone`, `--rm-phone`, `--add-company`, `--rm-company`, `--add-tag`, `--rm-tag`. Social handles set directly: `--linkedin`, `--x`, `--bluesky`, `--telegram`.

### Delete a contact

```bash
crm contact rm jane@acme.com
crm contact rm "+12125551234" --force    # skip confirmation
crm contact rm janedoe                   # by social handle
```

### Merge contacts

Merge two contacts into one. First contact survives, second is absorbed and deleted. Accepts any reference type:

```bash
crm contact merge ct_01A... ct_01B...
crm contact merge jane@acme.com jane.doe@acme.com
crm contact merge "+12125551234" "+14155559876"
crm contact merge janedoe jane-doe-linkedin
```

Combines emails, phones, companies, tags, custom fields, and relinks all deals and activity.

## Companies

### Create a company

```bash
crm company add --name "Acme Corp" \
  --website acme.com \
  --phone "+1-800-555-0000" \
  --tag enterprise \
  --set industry=SaaS
```

`--website`, `--phone`, `--tag`, `--set` are repeatable.

### List / show / edit / delete

```bash
crm company list --tag enterprise
crm company show acme.com                        # by website
crm company show "+18005550000"                  # by phone
crm company edit acme.com --name "Acme Inc" --add-website acme.io
crm company rm acme.com --force
```

### Merge companies

```bash
crm company merge co_01A... co_01B...
crm company merge acme.com acme.io
crm company merge "+18005550000" "+18005550001"
```

Relinks all contacts and deals from second to first.

## Deals

### Create a deal

```bash
crm deal add --title "Acme Enterprise" \
  --value 50000 \
  --stage qualified \
  --contact jane@acme.com \
  --company acme.com \
  --expected-close 2026-06-15 \
  --probability 60 \
  --tag enterprise
```

Contacts and companies are auto-created if they don't exist. `--contact` and `--tag` are repeatable.

### List deals

```bash
crm deal list --stage qualified --min-value 10000
crm deal list --contact jane@acme.com --sort value --reverse
crm deal list --format ids | wc -l    # count deals
```

### Move a deal through the pipeline

```bash
crm deal move dl_01... --stage proposal --note "Sent pricing deck"
crm deal move dl_01... --stage closed-won --note "Signed 2-year contract"
```

Stage transitions are recorded as activity with timestamps. Use `deal move`, not `deal edit --stage`.

### Edit / delete

```bash
crm deal edit dl_01... --value 75000 --add-contact bob@acme.com --probability 80
crm deal rm dl_01... --force
```

### Pipeline overview

```bash
crm pipeline
```

Shows count, total value, and weighted value per stage.

## Activity Logging

### Log an activity

```bash
crm log note "Had coffee with Jane, discussed Q3 expansion" --contact jane@acme.com
crm log call "Demoed product, she wants a proposal" --contact jane@acme.com --deal dl_01...
crm log meeting "Quarterly review" --company acme.com --at 2026-04-01
crm log email "Sent follow-up pricing" --contact jane@acme.com --set channel=outbound
```

Types: `note`, `call`, `meeting`, `email`. Contacts and companies are auto-created. `--contact` is repeatable. `--at` overrides the timestamp.

### List activities

```bash
crm activity list --contact jane@acme.com --since 2026-01-01
crm activity list --type call --limit 10
crm activity list --deal dl_01... --format json
```

## Tags

```bash
crm tag jane@acme.com hot-lead enterprise      # add tags
crm untag jane@acme.com old-tag                 # remove tags
crm tag list                                     # all tags with counts
crm tag list --type contact                      # contact tags only
```

Tags work on contacts, companies, and deals.

## Search

### Exact keyword search (FTS5)

```bash
crm search "acme CTO"
crm search "jane" --type contact
```

### Fuzzy / semantic search

```bash
crm find "fintech startup London"
crm find "that CTO I met at the conference" --limit 5 --threshold 0.3
```

### Rebuild search index

```bash
crm index rebuild
crm index status
```

Index updates automatically on writes. Manual rebuild only needed after corruption.

## Duplicate Detection

```bash
crm dupes
crm dupes --type contact --threshold 0.5
crm dupes --type company --limit 20
```

Uses combined Levenshtein + Dice coefficient similarity. Detects: similar names, shared emails, shared phones, shared websites, shared social handles. Review then merge:

```bash
crm dupes --type contact
# → Jane Doe ↔ J. Doe: similar name, shared email
crm contact merge ct_01A... ct_01B...
```

## Reports

```bash
crm report pipeline                                  # stage counts & values
crm report activity --period 30d --by type           # activity volume
crm report stale --days 14 --type contact            # no recent activity
crm report conversion --since 2026-01-01             # stage-to-stage rates
crm report velocity --won-only                       # time per stage
crm report forecast --period 2026-Q2                 # weighted forecast
crm report won --period 90d                          # closed-won summary
crm report lost --period 90d                         # closed-lost summary
```

## Import / Export

### Import from CSV or JSON

```bash
crm import contacts leads.csv
crm import contacts leads.json --update     # update existing by email match
crm import companies companies.csv --dry-run
crm import deals deals.csv --skip-errors
cat data.json | crm import contacts -        # import from stdin
```

CSV headers: `name`, `email`/`emails`, `phone`/`phones`, `company`/`companies`, `tags`, `linkedin`, `x`, `bluesky`, `telegram`. Unrecognized columns become custom fields.

### Export

```bash
crm export contacts --format csv > contacts.csv
crm export companies --format json > companies.json
crm export deals --format tsv
crm export all --format json > full-backup.json
```

## Virtual Filesystem (Mount)

Mount the CRM as a live read/write filesystem. Any tool that reads files gets full CRM access — AI agents, grep, jq, vim, scripts.

### Mount

```bash
crm mount ~/crm
crm mount ~/crm --readonly
```

On Linux this uses FUSE. On macOS this uses an NFS v3 server (no kernel extensions needed).

### Filesystem layout

```
~/crm/
├── llm.txt                           # Instructions for AI agents
├── contacts/
│   ├── ct_01...jane-doe.json         # Contact JSON files
│   ├── _by-email/                    # Lookup by email
│   ├── _by-phone/                    # Lookup by E.164 phone
│   ├── _by-linkedin/                 # Lookup by LinkedIn handle
│   ├── _by-x/                        # Lookup by X handle
│   ├── _by-company/                  # Grouped by company
│   └── _by-tag/                      # Grouped by tag
├── companies/
│   ├── co_01...acme-corp.json
│   ├── _by-website/
│   ├── _by-phone/
│   └── _by-tag/
├── deals/
│   ├── dl_01...acme-enterprise.json
│   ├── _by-stage/
│   ├── _by-company/
│   └── _by-tag/
├── activities/
│   ├── _by-contact/
│   ├── _by-company/
│   ├── _by-deal/
│   └── _by-type/
├── reports/                          # Pre-computed analytics
│   ├── pipeline.json
│   ├── forecast.json
│   ├── stale.json
│   ├── conversion.json
│   ├── velocity.json
│   ├── won.json
│   └── lost.json
├── pipeline.json                     # Quick pipeline overview
├── tags.json                         # All tags with counts
└── search/                           # Search by reading files
    └── <query>.json                  # cat search/"acme CTO".json
```

### Read via filesystem

```bash
ls ~/crm/contacts/
cat ~/crm/contacts/ct_01...jane-doe.json | jq .
cat ~/crm/contacts/_by-email/jane@acme.com.json
cat ~/crm/deals/_by-stage/qualified/
cat ~/crm/reports/forecast.json
cat ~/crm/search/"enterprise deals".json
```

### Write via filesystem

```bash
# Create a contact
echo '{"name":"Bob Smith","emails":["bob@globex.com"]}' > ~/crm/contacts/new.json

# Update (read → modify → write back)
cat ~/crm/contacts/ct_01...jane-doe.json | jq '.tags += ["vip"]' > ~/crm/contacts/ct_01...jane-doe.json

# Delete
rm ~/crm/contacts/ct_01...jane-doe.json
```

### Unmount

```bash
crm unmount ~/crm
```

### Static export (no mount needed)

```bash
crm export-fs ./crm-snapshot
```

Exports the same directory structure as a static copy — useful in containers or sandboxes where FUSE isn't available.

## Bulk Operations

Use `--format ids` to pipe into other commands:

```bash
# Tag all contacts from Acme as enterprise
crm contact list --company "Acme Corp" --format ids | xargs -I{} crm tag {} enterprise

# Move all qualified deals over $50k to proposal
crm deal list --stage qualified --min-value 50000 --format ids | \
  xargs -I{} crm deal move {} --stage proposal

# Delete all stale contacts
crm report stale --days 90 --type contact --format ids | xargs -I{} crm contact rm {} --force
```

## Custom Fields

All entities support arbitrary key-value fields:

```bash
crm contact add --name "Jane" --set title=CTO --set source=conference
crm contact edit jane@acme.com --set "json:score=85" --set "json:verified=true"
crm contact edit jane@acme.com --unset source
crm contact list --filter "title~=CTO"
```

Prefix with `json:` for typed values (numbers, booleans, arrays).

## Hooks

Configure shell hooks in `crm.toml` that fire on mutations:

```toml
[hooks]
post-contact-add = "~/.crm/hooks/notify-slack.sh"
post-deal-stage-change = "~/.crm/hooks/deal-moved.sh"
pre-contact-rm = "~/.crm/hooks/confirm-delete.sh"
```

Entity data is passed as JSON on stdin. Pre-hooks abort on non-zero exit.

Available hooks: `{pre,post}-{contact,company,deal}-{add,edit,rm}`, `{pre,post}-deal-stage-change`, `{pre,post}-activity-add`.

## Tips for AI Agents

- **Mount first:** `crm mount ~/crm` gives you filesystem access — read JSON files directly instead of running CLI commands
- **Read `llm.txt`:** The mount point contains `llm.txt` with structure docs and tips
- **Use `_by-*` directories** for fast lookups: `_by-email`, `_by-phone`, `_by-linkedin`, `_by-tag`, `_by-stage`
- **Use `--format json`** for all CLI output when processing programmatically
- **Use `--format ids`** + `xargs` for bulk operations
- **Read `reports/`** for pre-computed analytics — don't recompute from raw data
- **Search via filesystem:** `cat ~/crm/search/"your query".json`
- **Write via filesystem:** Create/update entities by writing JSON files
- **All JSON files are self-contained** — no need to join across files
- **Phone numbers** accept any format on input; stored as E.164 internally
- **Social handles** accept full URLs; stored as clean handles
