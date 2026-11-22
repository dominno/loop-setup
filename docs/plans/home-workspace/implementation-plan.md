# Plan implementacji — faza A (MVP end-to-end, sesje zdalne)

> Podstawa: [analysis.md](./analysis.md), decyzja #0 = **sesje zdalne (Claude Code na webie)**.
>
> Decyzje użytkownika (2026-11-21):
> - stan pętli trzymamy na osieroconej gałęzi **`claude/loop-state`**;
> - commit i push po każdej fazie, na gałąź sesji i na gałąź stanu;
> - zakres: **faza A**; utwardzenia z red-teamu idą do fazy B.

## Cel fazy A

Loop-setup przestaje być częścią źródeł budowanego projektu i działa z `~/.claude`:

1. **Kit.**
   - Cała maszyneria trafia do `kit/`: komendy, workflowy, loop, CLI TRACE, hooki, schemat, bench, reguły.
   - To repo jest repozytorium źródłowym kitu.
   - Aplikacja (`src/`, `e2e/`) nie zależy od `kit/`.
   - Instalator kopiuje kit z zacommitowanego HEAD do `~/.claude/loop-setup/kit`.
   - Rejestruje 15 komend w `~/.claude/commands`, z wyrenderowaną absolutną ścieżką do workflowów.
   - Zapisuje shim `loop-setup` i dopisuje hooki oraz uprawnienia do `~/.claude/settings.json`.
2. **Workspace.**
   - Każdy projekt ma workspace w `~/.claude/loop-setup/workspaces/<id>/`.
   - Workspace to repozytorium git: klon gałęzi `claude/loop-state` z `origin` projektu.
3. **Symlink.** W projekcie jest `.claude/loop-workspace` → workspace. Przypisanie projektu do workspace'u zapisuje marker `loop-setup.workspace=<id>` w `.git/config`.
4. **`.gitignore`.**
   - Linia `/.claude/loop-workspace`.
   - Zapasowy blok w `.git/info/exclude`.
5. **Sesja zdalna.**
   - Setup script środowiska instaluje kit przy budowie kontenera.
   - Hook SessionStart odtwarza workspace z `claude/loop-state` (`restore`), naprawia symlink i wstrzykuje reguły kitu.
   - Hook Stop upomina o `loop-setup sync`, gdy stan ma niewysłane zmiany.

## Architektura kodu (heksagonalna, KISS)

```
kit/
├── kit.json                 {name, version}
├── bin/loop-setup.mjs       punkt kompozycji: podkomendy cyklu życia + podkomendy TRACE (dawne `pnpm trace`)
├── setup/
│   ├── layout.mjs           CZYSTY rdzeń: resolveLayout(facts) → {mode, kitRoot, projectRoot, workspace, …}
│   ├── facts.mjs            adapter: git/fs/env → facts (jedyne miejsce, które czyta cwd/env/home)
│   ├── install.mjs          install/uninstall (pliki w ~/.claude, merge settings.json)
│   ├── workspace.mjs        init (z szablonu lub z legacy .claude/memory), restore, sync, where, doctor
│   └── hooks.mjs            hook session-start / stop (nigdy nie blokują przez błąd: fail open)
├── trace/                   dawne scripts/trace (lib, cli, plan, story-map, bench-judge + testy)
├── commands/*.md            14 komend + loop-tick.md
├── workflows/*.js           7 workflowów
├── hooks/stop-gate.mjs      opcjonalna bramka testów (jak dziś)
├── rules/KIT.md             reguły maszynerii wydzielone z CLAUDE.md (z regionem digestu)
├── loop.md, loop-checklist.md, skills-index.md
├── schema/schema-v1.json, bench/{README.md, fixtures.bundle}
├── docs/                    planning-guide, workflow-graphs, adoption-guide, loop-integration-guide
├── templates/workspace/     szkielet nowego workspace'u
└── test/fixtures/legacy-v1/ zamrożona kopia dzisiejszego stanu (dla testów kontraktów w CI)
```

### Rozwiązywanie workspace'u (`resolveLayout`)

Wygrywa pierwsze dopasowanie:

1. `LOOP_SETUP_WORKSPACE` (testy, kopie robocze).
2. Marker `git config loop-setup.workspace` → `<home>/loop-setup/workspaces/<id>`.
   - Gdy katalogu brak: błąd `MISSING_WORKSPACE`, z podpowiedzią „uruchom `loop-setup restore`”.
3. Symlink `.claude/loop-workspace`, ale **tylko** jeśli jest symlinkiem do katalogu pod `<home>/loop-setup/workspaces/`.
4. Legacy `<projekt>/.claude/memory`. To tryb dla nie zmigrowanych adopterów.
5. Brak: `NO_WORKSPACE`, z podpowiedzią „`loop-setup init` / `restore`”.

**Gdzie jest katalog domowy:** `CLAUDE_CONFIG_DIR || ~/.claude`.

**Strażnik worktree:** `write`/`act` odmawiają w linked worktree, chyba że podano `--from-worktree`. Domyślna ścieżka implementera nie trafi wtedy do żywego stanu.

### Odwołania i kotwice

- `VERIFIER_REF` = `kit:workflows/loop-iteration.js`.
  - `l3-check` akceptuje także starą referencję `.claude/workflows/loop-iteration.js`.
- Kotwica denylisty:
  - w repo źródłowym kitu: `git show HEAD:kit/workflows/loop-iteration.js`;
  - w zainstalowanym kicie: plik z `KIT_ROOT` zweryfikowany po sha256 z `installed.json`.
- `reaudit`:
  - `kit:X` → `kit/X` w repo źródłowym kitu, poza nim „nieweryfikowalne tutaj”;
  - stare `.claude/workflows/`, `scripts/trace/`, `.claude/commands/` … → mapowane na `kit/…` (prosta mapa prefiksów; pełna mapa plików w fazie B).
- Budżet wydajności przenosimy do `package.json` → `qualityBar`, żeby `pnpm build` w CI nie czytał workspace'u.

## Kroki

Każdy krok to jeden commit przez pathspec, po zielonym `pnpm verify`.

| # | Krok | Weryfikacja |
|---|---|---|
| A1 | `git mv` maszynerii do `kit/`, przepisanie ścieżek w kodzie i testach, `vitest` z `kit/**`, `qualityBar` w `package.json` | `pnpm verify` zielone, liczby rekordów bez zmian (`loop-setup lint`) |
| A2 | `kit/setup/layout.mjs` i `facts.mjs`, napisane test-first; lib/cli/plan używają trzech korzeni; strażnik worktree | Testy jednostkowe rdzenia (tabela decyzji) i integracyjne na prawdziwym gicie (`tempRepo`) |
| A3 | `install` / `uninstall` / `where` / `doctor`; renderowanie komend; shim; merge `settings.json` | Testy integracyjne z tymczasowym `CLAUDE_CONFIG_DIR` |
| A4 | `init` (szablon lub legacy) / `restore` / `sync` z gałęzią stanu | Testy z dwoma klonami i bare remote: init → sync → restore w drugim klonie → union merge współbieżnych dopisań |
| A5 | Hooki `session-start` (restore, symlink, PATH, digest, katalog wiki) i `stop` (przypomnienie o sync) | Testy hooków: JSON, ≤ 9 000 znaków, exit 0 przy błędzie |
| A6 | Podział CLAUDE.md: projekt + reguły repo zostają, maszyneria → `kit/rules/KIT.md`; przepisanie `pnpm trace` → `loop-setup`, `.claude/memory/` → `.claude/loop-workspace/`, `scriptPath` → `{{KIT}}/workflows/…`; aktualizacja dokumentacji | `template-docs` i `workflows.test` zielone; grep bez starych pisowni poza historią |
| A7 | CI: job provenance na nowej ścieżce CLI; testy kontraktów na zamrożonym fixture | CI zielone |
| A8 | Migracja tego repo: `install` → `init --from-legacy` → `sync` (tworzy `claude/loop-state`) → `git rm -r --cached .claude/memory` + `.gitignore` | `loop-setup lint` = te same liczby; `git ls-files .claude/memory` puste; gałąź stanu na `origin` |
| A9 | Setup script środowiska: chroniony blok instalujący kit przy budowie kontenera (zmiana wymaga Twojej akceptacji) | Akceptacja w następnej świeżej sesji (S10) |
| A10 | Runda krytyków po implementacji (`critic-panel`, code-only), raport | Brak blokerów |

## Poza zakresem fazy A (faza B, z analizy)

- kotwice sum kontrolnych, łańcuch per autor, predykat „landed” po SHA lub patch-id;
- `bindings/<id>.json` poza katalogiem zapisu;
- dziennik poza workspace'em;
- odmowa podkomend cyklu życia przy `CLAUDECODE`;
- pełna mapa starych referencji;
- dodatki do denylisty;
- import historii `.claude/memory` do workspace'u;
- ścieżka A0 „nowy projekt z szablonu”;
- Windows.

## Status (2026-11-21)

Faza A jest zrobiona na gałęzi `claude/blissful-galileo-akxz8w`.

**Commity:**

| Commit | Zakres |
|---|---|
| ec6d24b | A1/A2: przeniesienie do `kit/`, trzy korzenie |
| 9654bfb | A3–A5: install / init / restore / sync / hooki |
| 4ccf257 | A6/A7: podział CLAUDE.md / KIT.md, dokumentacja, CI |
| 7617b61 | A8: stan przeniesiony do workspace'u `loop-setup-e3ed255a` na `claude/loop-state` |
| 5af23ca | poprawka po rundzie krytyków (TR-4fe142478925, CLEAR po osobnej rundzie sprawdzającej) |

**Środowisko:** setup script środowiska „Full access cloud” instaluje kit przy budowie kontenera (A9).

**Weryfikacja:**

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (742/742) i `pnpm build` (143,2 KB ≤ 155) — exit 0;
- `pnpm test:e2e` (16/16) — exit 0, ze scratchpadowym shimem przeglądarki (obraz ma Chromium 1243, Playwright jest przypięty do 1194);
- `loop-setup doctor` — wszystko ok;
- symulacja świeżej sesji (pusty `~/.claude` i świeży klon z GitHub) — auto-restore działa.

**Otwarte, faza B / do potwierdzenia:**

- **S10.** Czy instalacja z setup scriptu ładuje się w świeżej sesji w chmurze. Fakt czeka w kwarantannie wiki: TR-325b6a5ea4fb.
- **Drobne uwagi krytyków (nie naprawione, kontrola zakresu):**
  - `settings.json`, który jest poprawnym JSON-em, ale nie obiektem, daje częściową instalację;
  - ścieżki w poleceniach hooków nie są escapowane;
  - `ensureLink` rozpoznaje „swój” link wyrażeniem regularnym zamiast przez `workspacesRoot`.
- Infografiki SVG/PNG w `docs/` pokazują stary model kopiowania.
- Pozycje fazy B z tabeli powyżej.

## Status fazy B (2026-11-22)

Część fazy B jest zrobiona na gałęzi `claude/stoic-keller-rq8sn7` (od `main` = `2dd64dd`). Każdy cel
ma własny plan z rundami krytyków w `docs/plans/<cel>/steps.md`.

**Zrobione (pozycje z listy „Poza zakresem fazy A” i z analizy §8):**

| Cel | Commity | Co daje |
|---|---|---|
| verify-kit (kotwice sum kontrolnych) | 84f6395, 49aaf74, 4668f0c, d013a00, d9220f8 | `loop-setup verify-kit` odtwarza zainstalowane drzewo z `git show <commit>:kit/…` z chronionej referencji zdalnego repo kitu (`main` lub tag `kit-v*`) i sprawdza każdy plik, komendę i własny wpis `settings.json` — nigdy samo `installed.json`. `denylist-check` i `plan-items` odmawiają na L2/L3, gdy weryfikacja nie przechodzi; L1 tylko ostrzega; offline zamyka się na L2/L3. |
| L3 wymaga sandboxa | d4832c1, 3e1f0ee, cdabdda, f541ae2 | Rekord benchmarku przypina hashe bloków `<loop-verifier>` i `<loop-denylist>`; `l3-check` nie jest spełnione po zmianie denylisty, bez sandboxa, bez `allowUnsandboxedCommands: false` trzymanego w zakresie użytkownika albo z niepustym `sandbox.excludedCommands`. `doctor` raportuje stan sandboxa. |
| Utwardzenie instalatora (odmowa przy `CLAUDECODE`) | b7e805e, f77d59f, ceeabc6 | `install`/`uninstall` do katalogu Claude tej sesji odmawiają przy `CLAUDECODE`; reguły deny dla podkomend cyklu życia i `node *loop-setup.mjs*`; `settings.json`, który nie jest obiektem albo ma złe typy `hooks`/`permissions`, jest odrzucany przed jakąkolwiek zmianą; ścieżki w hookach są bezpieczne dla powłoki; `ensureLink` naprawia tylko linki pod `workspacesRoot`. Zamyka trzy drobne uwagi krytyków z fazy A. |
| Dodatki do denylisty | 467c178, d044c0e, 539256f | Główne `.gitignore`, `.gitattributes`, `.worktreeinclude`, `.mcp.json`; patche zapisujące symlink (`120000`), gitlink (`160000`) albo zmianę trybu eskalują w bramce workflow i w `denylist-check` (wspólny korpus testów); `denylist-check` czyta też tryby z HEAD (rename/copy/retarget istniejącego symlinku). |

**Dowód, że runtime uruchamia hook Stop kitu:** z celowo niezsynchronizowanym workspace'em (zaraz po
zapisie rekordu krytyka) zakończona tura dostała „Stop hook feedback: The loop workspace
loop-setup-e3ed255a has unsynced state (1 changed file(s), 0 unpushed commit(s)). Run `loop-setup
sync` …” (transkrypt sesji, 2026-11-22T08:31:59Z, załącznik `hook_blocking_error`, hookEvent Stop).
Fakt w wiki: `topics/remote-env.md`, TR-6eab59a1408c (qualify: sesja w chmurze z kitem z setup
scriptu; najwyżej raz na turę przez `stop_hook_active`). Domyka lukę, którą zawęził TR-1a9be639eba8.

**Runda zamykająca (code-only, `git diff main...HEAD`):** completion `accept`, bez blokerów, jedno
ważne ustalenie — TR-191b1092a326 (verify-kit dawał fałszywe TAMPERED, gdy w ścieżce katalogu
Claude jest symlink) — naprawione w d9220f8 i CLEAR po osobnej rundzie sprawdzającej. Ta runda
(z krytykiem kompletności) znalazła TR-ad9963cddd6e (qualify: postawa sandboxa ignorowała
`sandbox.excludedCommands`) — naprawione w f541ae2 i CLEAR po drugiej osobnej rundzie sprawdzającej
(drzewo f571a624ff67fb54: completion `accept`, zero ustaleń, `notRechecked` puste). W całym magazynie
nie ma otwartego blokera (`loop-setup query --latest --writer critic-panel --severity blocker` → `[]`).

**Otwarte po fazie B:**

- L3 wymaga ponownego benchmarku (`/bench-checkers`): hash bloku `<loop-denylist>` się zmienił.
- Żywy kit w `~/.claude` (2dd64dd) zaktualizuje się przy świeżym kontenerze po merge'u (setup
  script); ta sesja go nie reinstaluje (nowa odmowa przy `CLAUDECODE`).
- Decyzja człowieka: zagnieżdżone `.gitignore`/`.gitattributes` pod `src/`, `e2e/` (TR-7ceffeec49a1,
  HOLD); `next.config.*`, `pnpm-workspace.yaml` poza denylistą.
- `sandbox.filesystem.allowWrite` nie jest sprawdzane przez `l3-check` (reguły deny Edit kitu i
  chronione ścieżki Claude Code nadal działają).
- `denylist-check` czyta tryby z HEAD, nie z indeksu ani drzewa roboczego.
- Wrapper `env -u CLAUDECODE` omija strażnika instalatora (strażnik polityki; granicą jest sandbox).
- Z listy fazy B nadal: łańcuch per autor i predykat „landed” po SHA lub patch-id, `bindings/<id>.json`
  poza katalogiem zapisu, dziennik poza workspace'em, pełna mapa starych referencji, import historii
  `.claude/memory`, ścieżka A0, Windows; infografiki w `docs/`.
