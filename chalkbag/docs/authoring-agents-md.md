# Authoring AGENTS.md files

This doc is the doctrine for writing the `AGENTS.md` files chalkbag tracks. It is
not about the build pipeline — for that see [agents-spec.md](./agents-spec.md) —
it is about what to put inside an `AGENTS.md` so agents work well and the file
stays cheap to keep loaded.

An `AGENTS.md` is the instruction file every agent reads before it touches the
repo. Claude reads it through a committed `CLAUDE.md -> AGENTS.md` symlink; Codex
and the broader AGENTS.md-spec ecosystem read `AGENTS.md` directly. Because it is
loaded into the context of every session, its cost is paid on every turn, whether
or not the file is relevant to the task at hand. That single fact drives the two
rules below.

Two pillars:

1. **Map, not README.** An `AGENTS.md` is a navigation map plus working rules — not
   documentation.
2. **Scoped files close to the code.** Put knowledge in the deepest directory that
   contains everything it applies to, not in one giant root file.

---

## 1. Map, not README

An `AGENTS.md` orients an agent: it says what lives where, points at the real docs,
lists the exact commands, and states the rules an agent cannot infer from reading
the code. It is a map of the territory, not a description of it.

### What belongs

- **One-line repo purpose.** What this repository is and does, in a sentence.
- **A directory / domain map.** A table of `path -> what lives there -> when to read
  it`. This is the core of the file.
- **Pointers to the real docs.** A short table linking the design docs, specs, and
  runbooks that already exist. Link them; do not restate them.
- **The exact build / test / lint commands.** The literal command lines, including
  how to run a single test. Agents should never have to guess these.
- **Working rules and constraints.** The things an agent cannot infer from the code:
  invariants, "never do X", the one audited path for a sensitive operation, house
  conventions, known gotchas.

### What does NOT belong

- **Prose architecture essays.** If the request lifecycle needs three paragraphs,
  those paragraphs belong in `docs/architecture.md` with a one-line pointer here.
- **API reference.** Signatures and parameters live next to the code or in generated
  reference docs.
- **Duplicated README content.** The human-facing README has a different audience.
  Do not fork it into `AGENTS.md`.
- **Anything already explained elsewhere.** If a doc covers it, link the doc. Every
  sentence you copy is a sentence you now have to keep in sync in two places.

### Size budget

A root `AGENTS.md` should be roughly **60-120 lines**. Scoped files are smaller.
If you are past the budget, you are almost certainly writing prose that belongs in
a linked doc.

The budget is not cosmetic. Instruction files load into every session's context, so
their length is a fixed tax on every task. A map keeps that always-loaded cost flat:
the map stays small, and the details it points to load on demand only when a task
actually needs them. A README-style file inverts this — every agent pays to load an
architecture essay it will not use.

### GOOD — map style

```markdown
# acme-api

Payment orchestration service: accepts charge requests, calls processors, and
writes ledger events.

## Directory map

| Path | What lives there | When to read it |
|---|---|---|
| `src/http/` | Route handlers, request validation | Adding or changing an endpoint |
| `src/processors/` | Processor adapters (Stripe, Adyen) | Touching a payment integration |
| `src/ledger/` | Double-entry ledger writes | Changing money movement |
| `migrations/` | SQL migrations | Altering the schema |

## Documentation map

| Doc | Read it when |
|---|---|
| `docs/architecture.md` | You need the request lifecycle and service boundaries |
| `docs/ledger-invariants.md` | You touch anything under `src/ledger/` |
| `.chalk/README.md` | Editing chalkbag source (skills, permissions) |

## Commands

- Install: `pnpm install`
- Build: `pnpm build`
- Test: `pnpm test` — single file: `pnpm test src/ledger/apply.test.ts`
- Lint: `pnpm lint`

## Working rules

- Never write to the ledger outside `src/ledger/apply.ts`; it is the only audited path.
- Processor adapters must be idempotent on the processor's charge id.
- All money amounts are integer minor units. Never use floats.

## Scoped guides

| Path | Covers |
|---|---|
| `src/processors/AGENTS.md` | Adapter contract, retry rules, sandbox credentials |
| `migrations/AGENTS.md` | Migration naming, review gate, rollback policy |
```

An agent can read that in seconds and know where to go, what to run, and what not
to break. The details live behind the links.

### BAD — README style

```markdown
# acme-api

acme-api is a modern, robust payment orchestration service built with Node.js and
TypeScript. It was originally created in 2021 to replace a legacy PHP system, and
has since grown to handle millions of transactions per day across several regions.

The architecture follows a clean layered design. When a request arrives, it first
hits the HTTP layer, which is implemented using Express. The Express router parses
the request body, runs it through a series of validation middlewares, and then
dispatches to the appropriate controller. Each controller is responsible for a
single resource and delegates to a service class...

The Stripe adapter works by calling the Stripe SDK's `charges.create` method with
an amount, a currency, a source token, and an idempotency key. The amount must be
supplied in minor units. The method returns a charge object with an `id`, a
`status`, and a `balance_transaction`...
```

This is documentation. It reproduces history, walks every layer in prose, and
inlines an API reference — all of it loaded into every session whether or not the
task involves Stripe. Delete it and replace it with a map plus links to
`docs/architecture.md`.

---

## 2. Scoped AGENTS.md close to the code

A single root `AGENTS.md` cannot describe a large repo without becoming the essay
above. The fix is nesting: put an `AGENTS.md` inside each self-contained domain
(`packages/*`, `services/*`, or a major `src/` area) so the context lives next to
the files it describes.

### Rules

- **Context locality.** Knowledge belongs in the deepest directory that contains all
  the files it applies to. A rule about payment adapters lives in
  `src/processors/AGENTS.md`, not the root — the agent that opens that directory is
  the one that needs it.
- **Scoped files cover local concerns only.** Local conventions, gotchas, the
  commands specific to that area, and a small local file map. Never repeat the root.
  If a rule applies repo-wide, it belongs in the root, once.
- **The root lists every scoped guide.** Keep a "Scoped guides" table in the root
  `AGENTS.md` so an agent starting at the top can see which subtrees have their own
  instructions.
- **Every scoped `AGENTS.md` gets a sibling `CLAUDE.md` symlink** when Claude is
  enabled: `cd <dir> && ln -sf AGENTS.md CLAUDE.md`, committed alongside it.

### Why this pays off for both providers

Both provider ecosystems resolve the *nearest* instruction file to the code an agent
is working on:

- **Codex** performs a hierarchical `AGENTS.md` scan, walking up from the working
  directory and merging the files it finds. A scoped `AGENTS.md` is picked up
  automatically when an agent operates inside that subtree.
- **Claude** loads directory-level `CLAUDE.md` files, so the committed
  `CLAUDE.md -> AGENTS.md` symlink in a subdirectory surfaces exactly when work
  moves into that directory.

The payoff is the same on both sides: an agent working in one subtree gets the
context relevant to that subtree without paying to load the whole repo's
instructions. The root map stays small; scoped detail is loaded only when the work
reaches it.

### Worked example

A repo with two self-contained domains:

```text
acme-api/
├── AGENTS.md                       # root map (see the GOOD example above)
├── CLAUDE.md -> AGENTS.md          # committed symlink
├── src/
│   └── processors/
│       ├── AGENTS.md               # scoped: payment adapters
│       └── CLAUDE.md -> AGENTS.md  # committed symlink
└── migrations/
    ├── AGENTS.md                   # scoped: schema migrations
    └── CLAUDE.md -> AGENTS.md      # committed symlink
```

`src/processors/AGENTS.md` — local rules only, no repeat of the root:

```markdown
# src/processors

Adapters that turn an internal charge into a processor API call. One file per
processor; each implements the `ProcessorAdapter` interface in `contract.ts`.

## Local map

| Path | What lives there |
|---|---|
| `contract.ts` | The `ProcessorAdapter` interface every adapter implements |
| `stripe.ts` | Stripe adapter |
| `adyen.ts` | Adyen adapter |
| `__fixtures__/` | Recorded processor responses for tests |

## Rules

- Every adapter must be idempotent on the processor's charge id — retries must not
  double-charge.
- Never log the raw card token. Redact through `redact()` in `contract.ts`.
- Sandbox credentials come from `PROCESSOR_ENV=sandbox`; never hardcode keys.

## Tests

- `pnpm test src/processors` — uses recorded fixtures, no network.
```

`migrations/AGENTS.md` — a different set of local rules:

```markdown
# migrations

Forward-only SQL migrations applied in filename order.

## Rules

- Name files `NNNN_snake_case.sql`, zero-padded, strictly increasing.
- Never edit a migration that has shipped; add a new one.
- Every migration must be reversible or paired with a documented backfill.

## Commands

- Apply locally: `pnpm migrate:up`
- Check drift: `pnpm migrate:status`
```

Each scoped file is short, specific to its directory, and free of anything the root
already says. Together they give an agent working anywhere in the tree the exact
context it needs — and nothing it does not.

---

## Checklist

- [ ] Root `AGENTS.md` is a map: purpose line, directory map, doc pointers, commands,
      working rules. No prose essays, no API reference, no duplicated README.
- [ ] Root file is within ~60-120 lines.
- [ ] Self-contained domains have their own scoped `AGENTS.md`, covering local
      concerns only.
- [ ] The root lists every scoped guide in a table.
- [ ] Every `AGENTS.md` that Claude should see has a committed sibling
      `CLAUDE.md -> AGENTS.md` symlink.

For where these files sit in the source-of-truth layout and how the build treats
them, see [agents-spec.md](./agents-spec.md). For the end-to-end repo setup flow,
see [onboarding.md](./onboarding.md).
