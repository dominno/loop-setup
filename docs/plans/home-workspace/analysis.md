# Loop-setup poza repozytorium projektu: kit w `~/.claude`, workspace per projekt, symlink w `.gitignore`

> **Status:** analiza, bez implementacji. Data: 2026-11-21.
> **Pytanie:** jak przerobić loop-setup, żeby nie był częścią kodu źródłowego budowanego projektu, tylko był instalowany w katalogu domowym użytkownika (`~/.claude`)? Każdy projekt ma tam mieć swój workspace, a w katalogu projektu ma być symlink do tego workspace'u, dodany do `.gitignore`.

## Spis treści

0. [Jak powstała ta analiza](#0-jak-powstała-ta-analiza)
1. [Najkrócej](#1-najkrócej)
2. [Bloker nadrzędny: sesje w chmurze (decyzja #0)](#2-bloker-nadrzędny-sesje-w-chmurze-decyzja-0)
3. [Rekomendowana architektura](#3-rekomendowana-architektura)
4. [Odstępstwa od dosłownej prośby](#4-odstępstwa-od-dosłownej-prośby)
5. [Jak to działa: kluczowe mechanizmy](#5-jak-to-działa-kluczowe-mechanizmy)
6. [Decyzje do podjęcia](#6-decyzje-do-podjęcia)
7. [Plan migracji](#7-plan-migracji)
8. [Uwagi red-teamu (macierz)](#8-uwagi-red-teamu-macierz)
9. [Ryzyka i spike'i](#9-ryzyka-i-spikei)
10. [Odrzucone alternatywy](#10-odrzucone-alternatywy)
11. [Macierz ocen krytyków](#11-macierz-ocen-krytyków)
12. [Co dalej](#12-co-dalej)

---

## 0. Jak powstała ta analiza

Pracowały dwa workflowy wieloagentowe (Workflow tool). Każdy agent miał własny kontekst.

### Workflow 1: baza faktów (6 agentów badawczych)

| Obszar | Co ustalono |
|---|---|
| Inwentarz | Wszystkie pliki maszynerii: 14 komend, 7 workflowów, loop.md, CLI `scripts/trace`, wiki pamięci, mapa historii. |
| Sprzężenia | 45 punktów, w których kod zakłada, że maszyneria leży w repo (C01–C45). Centralny jest `ROOT` w `scripts/trace/lib.mjs:23`. |
| Fakty platformy | 14 faktów (P1–P14) o Claude Code 2.1.330. Sprawdzone w binarce i w oficjalnej dokumentacji: chronione ścieżki, symlinki, sandbox, worktree, importy CLAUDE.md, hooki, chmura. |
| Trwałość i git | Eksperymenty na repozytoriach-zabawkach. |
| Prior art | Narzędzia, które trzymają stan per projekt w katalogu domowym. |

### Workflow 2: projekt i krytyka

| Etap | Wynik |
|---|---|
| 5 architektów | Pięć niezależnych propozycji: dosłowna, plugin, trwałość/zespół, heksagonalna, zero-footprint. |
| 8 krytyków | Ocena każdej propozycji (sekcja 11). |
| 41 sceptyków | Każdy bloker i 24 ważne uwagi dostały osobnego sceptyka. Werdykty: **5 accept, 16 qualify, 19 revise, 1 reject**. |
| Sędzia | Synteza: projekt **V1** (sekcje 3–7, 9–10). |
| Red-team | 3 krytyków ataku: scenariusze (15 uwag), bezpieczeństwo (18), kompletność (12). |
| Weryfikacja red-teamu | **Przerwana na prośbę użytkownika.** Zweryfikowano 6 z około 22 uwag: 4 × revise i 2 × qualify. Wszystkie 6 potwierdzają defekt, ale korygują proponowaną poprawkę. |
| Rewizja projektu po red-teamie | **Nie została wykonana.** |

**Co z tego wynika dla czytelnika:**

- Sekcje 3–7 opisują projekt V1. Został przefiltrowany przez krytyków i sceptyków.
- Sekcje 2 i 8 dodają uwagi red-teamu. Każda ma oznaczony status weryfikacji.
- Tam, gdzie red-team pokazuje, że V1 się myli, piszę to wprost przy danym punkcie.
- Nie zapisano żadnych rekordów TRACE. To analiza, która nie zmienia trwałego stanu projektu.

---

## 1. Najkrócej

1. **Twój projekt jest wykonalny na maszynie lokalnej**, z kilkoma uzasadnionymi odstępstwami (sekcja 4).
   - Kit jest instalowany raz, jako przypięty klon gita w `~/.claude/loop-setup/`.
   - Każdy projekt ma swój workspace w `~/.claude/loop-setup/workspaces/<slug>-<hash8>/`.
   - W projekcie jest jeden symlink `.claude/loop-workspace`, ignorowany przez `.gitignore`.
   - Kod maszynerii i stan pętli znikają z repozytorium projektu.

2. **Jest bloker nadrzędny, którego V1 nie wziął pod uwagę.** Ten projekt prowadzisz głównie w **Claude Code na webie**, gdzie `~/.claude` jest tworzony od nowa w każdej sesji (P11). Dowody są w sekcji 2.
   - W czystym wariancie domowym kit i workspace w chmurze **nie istnieją**.
   - Po kroku T5 sesje webowe tracą wszystkie komendy, workflowy i pętlę.
   - Dlatego **decyzja #0, czyli gdzie uruchamiasz Claude Code, musi zapaść przed wszystkim innym.**

3. **Rekomendacja, jeśli web jest Twoim głównym środowiskiem:**
   - Kit trafia do `~/.claude` także w chmurze, przez setup script środowiska przypięty do SHA.
   - Workspace jest checkoutem **osobnego, prywatnego repozytorium stanu**. W chmurze klonuje go setup script. Lokalnie po prostu leży w `~/.claude`. Wysyłasz go jawnie poleceniem `loop-setup sync`.
   - Tylko ten wariant spełnia wszystkie 4 intencje Twojej prośby w obu środowiskach i nie gubi stanu.
   - Warunek: spike S10 musi przejść przed T5.

4. **Najważniejsze odstępstwa od dosłownej prośby:**
   - Symlink leży *wewnątrz* prawdziwego katalogu `.claude/`, nie jako `.claude`. Inaczej Claude Code odmawia tworzenia worktree.
   - Symlink jest tylko wygodą. Źródłem prawdy jest marker w `.git/config` plus ścieżka do wspólnego katalogu gita (common dir).
   - Reguły kitu docierają do sesji przez hook SessionStart, a nie przez `@import` w CLAUDE.md. Import z `~/.claude` wymagałby szerokiej zgody, która wpuszcza do kontekstu dowolny plik z katalogu domowego.
   - Mały, celowy ślad zostaje w repo: reguły repo w CLAUDE.md, zakazy w `.claude/settings.json` i budżet w `package.json`.

5. **Do naprawienia przed implementacją**, wykryte przez red-team (część niezweryfikowana):
   - Przy wyłączonym sandboksie, czyli domyślnie, agenci pętli mogą przepisać kotwicę zaufania kitu.
   - Strażnik zapisu z worktree nie jest mechaniczny.
   - Plik dziennika historii, `workspace.json` i stub `.claude/loop.md` są podatne.
   - Kod wyjścia 2 koliduje z semantyką hooków.
   - Mapa starych referencji (`LEGACY_REF_MAP`) jest niekompletna.
   - Nie ma ścieżki „nowy projekt z szablonu”.

   Szczegóły w sekcji 8.

---

## 2. Bloker nadrzędny: sesje w chmurze (decyzja #0)

### 2.1 Dowody

Zebrał je red-team, a sceptyk zweryfikował je werdyktem **revise**: defekt jest prawdziwy, poprawka wymaga korekty.

| Dowód | Wartość |
|---|---|
| Commity z przypisem `Claude-Session` | 118 ze 140 |
| Commity, które dotknęły `.claude/memory` | 59 z 59 ma przypis |
| Rekordy TRACE z `provenance.branch` = `claude/*` | 133 ze 133 |
| Merge commity | 18; 17 z gałęzi sesji `claude/*`, 1 z PR #18. PR #16 zmergowano przez squash. |
| Wiki | Osobna strona o środowisku webowym: `.claude/memory/topics/remote-env.md` (4 CPU, Chromium w `/opt/pw-browsers`, „headless web sessions”). |
| Ta sesja | `CLAUDE_CODE_REMOTE=true`. `~/.claude` powstał przy starcie kontenera i **nie ma w nim `settings.json`**. Runtime używa własnego `launcher-settings.json`; sprawdzone w tej sesji. |

Korekta sceptyka: same przypisy `Claude-Session` nie dowodzą chmury, bo dodaje je też Remote Control na Twojej maszynie. Chmurę dowodzi dopiero strona wiki `remote-env.md`, którą pisały te sesje.

### 2.2 Dlaczego to bloker

- **P11:** sesja webowa startuje na świeżej maszynie wirtualnej, ze świeżym klonem repo i świeżym `~/.claude`. Komendy, hooki i ustawienia użytkownika nie przechodzą między sesjami. Przechodzi tylko to, co zrobi setup script środowiska.
- Po T5 maszyneria opuszcza `.claude/commands` i `.claude/workflows`. Sesja webowa nie ma wtedy żadnej komendy kitu, nawet zanim przyjdzie T7.
- T5 („człowiek w terminalu uruchamia install”) i T7 (`migrate`, blokowane przez strażnika EPHEMERAL) nie dają się trwale wykonać w chmurze. Plan nie zakłada nigdzie „trwałej maszyny lokalnej”.

### 2.3 Warianty

| Wariant | Kit | Stan (workspace) | Spełnia intencje 1–4? | Uwagi |
|---|---|---|---|---|
| **0a Tylko lokalnie** (CLI lub desktop na Twojej maszynie) | Instalator w `~/.claude/loop-setup` | Katalog w `~/.claude/loop-setup/workspaces/<id>` z lokalnym dziennikiem `.history` | Tak | To projekt V1 w obecnym kształcie. Chmura nieobsługiwana. |
| **0b Chmura główna / 0c Hybryda** (rekomendowane, jeśli web jest główny) | Setup script środowiska klonuje kit z osiągalnego repo, sprawdza SHA i uruchamia instalator absolutną ścieżką | Workspace = checkout **osobnego prywatnego repo stanu**. W chmurze klonuje go setup script, lokalnie leży w `~/.claude`. Wysyłany jawnie przez `loop-setup sync`, nigdy z hooka. | Tak, w obu środowiskach | To opcjonalny „adapter zespołowy” z decyzji #1(b), zbudowany od razu. Kontrakt jest już opisany w V1 (sekcja 5.10). Wymaga spike'a S10. |
| ~~Stan w repo dla chmury, workspace domowy lokalnie~~ | — | — | — | **Odrzucone przez sceptyka.** Jeden projekt miałby dwa żywe źródła prawdy, które się rozjadą. Nie przywraca też nośnika reguł w chmurze. |

### 2.4 Co musi rozstrzygnąć spike S10

Robimy go przed T5, w jednorazowym środowisku i tylko za Twoją zgodą.

1. **Hooki z setup scriptu.** Czy hooki i ustawienia użytkownika zapisane przez setup script w `~/.claude/settings.json` działają, skoro runtime ma własny `launcher-settings.json`?
   - Jeśli nie, potrzebny jest inny nośnik reguł w chmurze. Na przykład `CLAUDE.local.md` zapisany przez setup script, który importuje KIT.md po absolutnej ścieżce. Trzeba wtedy sprawdzić, jak w chmurze działa zgoda na zewnętrzny import.
2. **Dostęp do repo stanu.** Czy sesja może sklonować i wysłać zmiany do prywatnego repo stanu? Zgodnie z dokumentacją środowiska repo musi być dodane do listy Repositories środowiska. Zapisany token nie pobierze prywatnego repo.
3. **Dostęp do repo kitu.** Czy repo kitu jest osiągalne: publiczne albo dołączone do środowiska?

Jeśli S10 nie przejdzie, kit poza repo nadal jest możliwy. Wtedy jednak:

- albo stan dla chmury zostaje w repo, co jest jawnym odstępstwem od intencji 2–3;
- albo **nie migrujemy**, dopóki nie zmienią się możliwości platformy.

---

## 3. Rekomendowana architektura

Baza to propozycja **„Literal-faithful”**:

- najwyższa średnia ocen krytyków: 6,13;
- jedyna bez stojącego blokera po weryfikacji;
- najbliższa dosłownej prośbie.

Sędzia dołożył do niej najlepsze elementy pozostałych propozycji:

- z heksagonalnej: czysty rdzeń `resolveLayout()` i tabele jako jedno źródło prawdy;
- z zero-footprint: blok w `.git/info/exclude` i uprawnienie per projekt;
- z trwałość/zespół: predykat „wylądowało” (landed);
- z pluginowej: matcher SessionStart i katalog wiki jako dane referencyjne.

### 3.1 Katalog domowy

```
~/.claude/                                   ($CLAUDE_CONFIG_DIR, jeśli ustawione: P13)
├── settings.json        wpisy dopisane przez instalator, każdy zapisany w installed.json (do odinstalowania):
│     hooks.SessionStart [startup|resume|clear|compact] → loop-setup hook session-start
│     hooks.PreToolUse   [Edit|Write|MultiEdit|NotebookEdit] → loop-setup hook pre-tool
│     hooks.Stop         tylko z `install --with-stop-gate`
│     permissions.allow  Read(~/.claude/loop-setup/src/kit/**) + podkomendy CLI tylko do odczytu
│     permissions.deny   Edit(src/**, bin/**, installed.json, anchors/**)  (scalane też do sandbox denyWrite)
│     (BEZ additionalDirectories na poziomie użytkownika; uprawnienie jest per projekt)
├── commands/            15 kopii, nazwy bez prefiksu, chmod 444, sha256 w installed.json
│                        (14 dzisiejszych + /loop-tick = dzisiejszy loop.md)
└── loop-setup/          LOOP_SETUP_HOME; retencja Claude Code tego nie czyści
    ├── installed.json   {kitVersion, source:{url, ref, commit}, registered:{plik: sha256}, settingsEntries, legacyOk}
    ├── bin/loop-setup   shim z wbudowanymi absolutnymi ścieżkami do node i kitu (poprawka red-teamu; V1 miał $LOOP_SETUP_HOME)
    ├── src/             klon kitu (blob:none), odpięty na source.commit; Edit-deny; poza katalogami zapisu
    │   └── kit/         KIT_ROOT: bin/ core/ adapters/ commands/ workflows/ rules/KIT.md policy/ schema/ docs/ hooks/ templates/ bench/ test/
    ├── anchors/<id>.jsonl   punkty kontrolne (n, sha256 linii n); zapisuje je tylko hook SessionStart działający poza sandboksem
    └── workspaces/<slug>-<hash8>/   jeden na projekt (klon)
```

### 3.2 Workspace projektu

Workspace ma te same nazwy względne co dzisiejsze `.claude/memory`.

```
~/.claude/loop-setup/workspaces/loop-setup-3f9a1c2e/
├── workspace.json      tożsamość i konfiguracja, lokalne dla maszyny; nigdy nie synchronizowane
│                       (red-team: przenieść config wykonywalny i wiązanie poza katalog zapisu, sekcja 8)
├── index.md  topics/*.md  log.md  log/<YYYY>.md  quarantine.md     wiki: tylko fakty o projekcie
├── loop-plan.md        sama tabela „## Plan” (schemat przeniesiony do kitu)
├── loop-plan.prev.md   migawka do wykrywania zmian poza CLI (out-of-band)
├── loop-run-log.md
├── trace/records.jsonl schemat trace-lite/1.1; stare linie 1.0 to niełańcuchowany prefiks
├── patches/<node>.patch    patch zapisany przy CLEAR (wejście dla predykatu „landed”)
├── proposals/          propozycje /improve-skills i /dream, gdy to nie jest repo źródłowe kitu
└── .history/           GIT_DIR lokalnego dziennika (red-team: przenieść poza katalog zapisu, sekcja 8)
Niezmiennik: tylko pliki .md/.json/.jsonl/.bundle/.patch. Przez symlink nie da się dojść do kodu.
```

### 3.3 Projekt po migracji

```
<projekt>/
├── .claude/                    PRAWDZIWY katalog (C05: Claude Code odmawia worktree, gdy .claude jest symlinkiem)
│   ├── settings.json           ŚLEDZONY: zezwolenia produktowe, zakazy force-push i hard-reset, worktree.baseRef
│   ├── settings.local.json     NIEŚLEDZONY: additionalDirectories = [realpath TEGO workspace'u]
│   ├── loop-workspace → ~/.claude/loop-setup/workspaces/<id>   absolutny symlink (junction na Windows), ignorowany
│   └── worktrees/              worktree izolacji; celowo bez symlinku w środku
├── .gitignore                  + '/.claude/loop-workspace'  (zakotwiczony, BEZ końcowego ukośnika)
├── .git/info/exclude           zarządzany blok zapasowy (dla gałęzi starszych niż linia w .gitignore)
├── .git/config                 [loop-setup] workspace = <id>   (marker klonu; dzielony przez worktree)
├── CLAUDE.md                   reguły projektu + „Repo rules” (bez kitu), BEZ @import
├── package.json                bez skryptu „trace”; + "qualityBar": {"perfBudgetKbGzip": 155, "wcag": "AA"}
└── docs/                       dokumentacja produktu + mapa historii (zostaje w repo)
USUNIĘTE ze śledzenia: .claude/{commands,workflows,hooks,trace,memory}, loop.md, loop-checklist.md,
skills-index.md, scripts/trace/**, scripts/hooks/**, linie union w .gitattributes.
```

Tylko w tym repo-szablonie źródło kitu zostaje śledzone w `kit/`. Jest wydawane tagami `kit-vX.Y.Z` i chronione regułą denylisty `^kit(/|$)`.

---

## 4. Odstępstwa od dosłownej prośby

| # | Odstępstwo | Dlaczego | Najbliższy zgodny wariant |
|---|---|---|---|
| D1 | Kit to nie jeden folder. 15 komend jest skopiowanych do `~/.claude/commands`, hooki i uprawnienia dopisane do `~/.claude/settings.json`. | Claude Code szuka komend użytkownika tylko w `~/.claude/commands` (P1), a hooków tylko w plikach settings. | Cała reszta leży w `~/.claude/loop-setup`. `installed.json` zna hash każdego zarejestrowanego pliku, więc odinstalowanie usuwa dokładnie te pliki. |
| D2 | Symlink to `<projekt>/.claude/loop-workspace`, wewnątrz prawdziwego `.claude/`. Nie jest to `.claude` ani stara nazwa `.claude/memory`. | Claude Code odmawia tworzenia worktree, gdy `.claude` jest symlinkiem (C05, P5). Starą nazwę git nadpisuje przy checkout, merge i bisect starych commitów (zweryfikowane). | Dokładnie jeden symlink, ignorowany. Wariant `/.loop` w katalogu głównym to decyzja #2. |
| D3 | Symlink jest wygodą, a nie źródłem prawdy. Wiązanie daje marker w `.git/config` plus realpath common dir. Agenci piszą po realpath. | Symlinku nie ma w świeżych worktree, w CI, w chmurze ani w świeżych klonach. Grep go ignoruje (P7). | Symlink jest zawsze tworzony i sam się naprawia w każdym głównym checkoucie. Ludzie i edytory mogą przez niego czytać. |
| D4 | Wskaźniki per klon leżą poza drzewem roboczym: marker w `.git/config`, blok w `.git/info/exclude`, uprawnienie w `.claude/settings.local.json`. | Wiązanie działa bez symlinku i wykrywa kopie, przeniesienia i ponowne użycie ścieżki. | Żaden z tych plików nie jest śledzony. **Korekta red-teamu:** `settings.local.json` *był* śledzony w 99 ze 140 commitów, więc checkout starego commitu może go nadpisać i usunąć. |
| D5 | Brak symlinku w worktree. | Implementer nie może mieć ścieżki zapisu do żywego stanu (maker/checker). | Z worktree CLI rozwiązuje ten sam workspace przez wspólny marker, tylko do odczytu. |
| D6 | Mały ślad w repo zostaje: CLAUDE.md z regułami projektu i repo, `.claude/settings.json`, `qualityBar` w `package.json`, `docs/`. | To kontrakt projektu, nie kit. Ich usunięcie było zweryfikowanym blokerem: koledzy bez kitu i chmura traciliby zakaz przepisywania wysłanej historii. | Żaden plik, ścieżka ani `@import` kitu nie jest śledzony w projekcie-adopterze. |
| D7 | Reguły kitu docierają przez digest z hooka SessionStart (≤ 9 000 znaków), a nie przez CLAUDE.md. | Zewnętrzny `@import` przez symlink wymaga jednorazowej, szerokiej zgody, która potem wpuszcza do kontekstu **dowolny** plik z katalogu domowego (np. `~/.ssh`). Domyślnie zaznaczone jest „No”, a w worktree import ginie. | Opcja `init --claude-local`: nieśledzony `CLAUDE.local.md` importuje pełny KIT.md po **absolutnej** ścieżce. Poprawka red-teamu: nigdy przez symlink. |
| D8 | Pliki mieszane zostają podzielone, więc część dzisiejszego „stanu” staje się kitem: polityka TRACE, schemat planu, tematy wiki o maszynerii, `skills-index`. | CLI czyta wersję polityki i schemat planu jako maszynerię. | Część projektowa zostaje w workspace: 18 faktów cytowanych w rekordach (`topics/trace-notes.md`) i tabela planu. |
| D9 | Domyślnie oddajemy: współdzielenie stanu w zespole, review stanu w PR, bramki stanu w CI, job provenance, wersjonowanie per gałąź i chmurę. | Workspace w katalogu domowym nie jest ani transportem zespołowym, ani wejściem dla CI. | Częściowe zamienniki: dziennik historii, łańcuch per autor, lock i lease, predykat „landed”, reaudit w `doctor`. **Patrz sekcja 2: dla Ciebie chmura prawdopodobnie zmienia „domyślnie”.** |
| D10 | Repo-szablon trzyma źródło kitu w `kit/`. | Tu kit jest rozwijany i wydawany. | Repo konsumuje zainstalowaną kopię jak każdy adopter, zawsze z commitu, nigdy z drzewa roboczego. **Red-team:** brak ścieżki „nowy projekt z szablonu”, bo kit trafiłby do jego źródeł (sekcja 8). |
| D11 | Stały prompt pętli staje się komendą `/loop-tick`, uruchamianą jako `/loop 30m /loop-tick`. Nie instalujemy `~/.claude/loop.md`. | `~/.claude/loop.md` przejmuje gołe `/loop` we **wszystkich** projektach. Do tego loop.md jest obcinany na 25 000 znakach, a dzisiejszy plik ma 25 307. | Opcjonalny nieśledzony stub `.claude/loop.md`. **Red-team, zweryfikowane (qualify):** checkout starego commitu go nadpisuje, a powrót na main usuwa. |
| D12 | Workspace to małe repo git (dziennik `.history/`), a nie zwykły folder. | Daje cofanie złych edycji, blame z historii i dowody manipulacji. | `init --no-history` daje dosłowny zwykły folder. |
| D13 (red-team) | „Projekt” to jeden klon, a nie repozytorium. Do tego `--link-bin` dodaje plik poza `~/.claude`. | Nieoznaczone w V1. | Oznaczyć jako odstępstwa. Drugi klon dołącza się jawnie przez `--attach`. |

---

## 5. Jak to działa: kluczowe mechanizmy

### 5.1 Dystrybucja kitu

**Instalacja** odbywa się raz na maszynę, z terminala:

```
loop-setup install --from <url|ścieżka> --ref <tag|sha>
```

Instalator po kolei:

1. robi `git clone --filter=blob:none` do `~/.claude/loop-setup/src` i odpina HEAD na podanym commicie;
2. kopiuje 15 komend do `~/.claude/commands`;
3. zapisuje shim;
4. dopisuje swoje wpisy do `settings.json`, wcześniej robiąc kopię zapasową;
5. zapisuje `installed.json`.

**Dlaczego workflowy nie są kopiowane.** Komendy wołają Workflow absolutnym `scriptPath`, wziętym z `loop-setup where --json`, prosto do przypiętego klonu. Dzięki temu:

- projektowy workflow o tej samej nazwie nie przesłoni kitu (rozwiązywanie nazw idzie projekt > użytkownik);
- częściowa aktualizacja nie zostawi pomieszanych wersji;
- wykonywany weryfikator to dokładnie ten plik, który hashują kotwica denylisty i `l3-check`.

**Dlaczego nie plugin:**

- komendy dostają przestrzeń nazw (`/loopkit:critic-round`), a binarka odrzuca gołe nazwy;
- katalog `bin/` pluginu zmienia się z każdą wersją i nie jest w PATH terminala;
- marketplace z lokalnego katalogu ładuje drzewo robocze w miejscu, co dało zweryfikowany bloker samomodyfikacji w trzech propozycjach.

**Aktualizacja** (`upgrade`) jest atomowa:

- odmawia, gdy zarejestrowany plik został zmieniony;
- pokazuje diff;
- uruchamia migracje workspace'ów tylko do przodu;
- unieważnia L3, gdy zmienił się weryfikator lub denylista.

**Poprawki red-teamu (niezweryfikowane):**

- pełny diff dla katalogów wykonywalnych (hooks, bin, core, adapters, workflows, commands), nie tylko `--stat`;
- `--ref` musi być pełnym 40-znakowym SHA albo podpisanym tagiem;
- `mktemp -d` zamiast `/tmp/ls`;
- bez `--filter` przy źródle lokalnym, bo klon z płytkiego (shallow) repo wisi w nieskończoność. To pokazał eksperyment: `timeout 45` → exit 124.

### 5.2 Klucz workspace'u i wiązanie

**Identyfikator** ma postać `<slug>-<hash8>`:

- slug to nazwa katalogu checkoutu;
- hash8 to 8 losowych znaków hex;
- id jest zapisywane raz i nigdy nie przeliczane.

**Wiązanie** wymaga dwóch warunków jednocześnie:

1. `git config --local loop-setup.workspace` jest równe id;
2. realpath `git rev-parse --git-common-dir` jest na liście `commonDirs`.

**Zweryfikowane eksperymentem:**

| Przypadek | Wynik |
|---|---|
| Worktree | Widzi marker, odczyt dozwolony. |
| Kopia `cp -a` | COPY |
| Tar z worktree | Odczyt tak, zapis nie. |
| Ponowny klon w tej samej ścieżce | Brak markera, więc NEEDS_ATTACH. |

**Odcisk palca** repo jest sprawdzany tylko bez markera. Składa się z commitu HEAD przy init, merge-base i, wyłącznie dla płytkich klonów, znormalizowanego URL zdalnego repo. Odcisk daje NEEDS_ATTACH albo PATH_REUSED. Nigdy nie wiąże automatycznie.

**Nigdy nie używamy jako klucza:**

- sanitizera ścieżek projektów Claude Code;
- root commitu;
- `~/.claude/projects/<key>` (P10).

**Red-team, zweryfikowane (revise).** Jeden klucz markera nie wystarcza, gdy dwa katalogi domowe dzielą jeden klon: devcontainer, WSL albo dwa `CLAUDE_CONFIG_DIR`. Każdy nadpisuje wiązanie drugiego.

Sceptyk sprawdził proponowaną poprawkę i dwie jej wersje nie działają:

- `loop-setup.workspace.<sha8>` jest **niepoprawnym** kluczem gita, gdy sha zaczyna się cyfrą. Dotyczy to około 63% hashy.
- Hash realpath katalogu domowego koliduje, gdy host i kontener mają tę samą ścieżkę (`/root/.claude`).

Moja synteza, niezweryfikowana: losowy `homeId` w `installed.json` jako podsekcja, czyli `git config loop-setup.<homeId>.workspace <id>`, plus nowy kod `FOREIGN_HOME`, który nigdy nie nadpisuje cudzego markera.

### 5.3 Symlink i ignorowanie

- **Nazwa:** ścieżka, której żaden commit nigdy nie śledził, bo tylko taką git zostawia w spokoju przy starych commitach.
- **`.gitignore`:** linia `/.claude/loop-workspace`, zakotwiczona i **bez końcowego ukośnika**. Wzorzec z ukośnikiem nie ignoruje symlinku (C08). Zweryfikowane `git check-ignore -v`.
- **Zapas:** blok w `$GIT_COMMON_DIR/info/exclude`. Dzielą go worktree i działa na gałęziach starszych niż linia w `.gitignore`.
- **`git clean -fdX`:** usuwa tylko symlink, cel zostaje (zweryfikowane na Linuksie). Hook go odtwarza.
- **`init` i `doctor` odmawiają**, gdy ścieżka symlinku jest śledzona albo nie jest ignorowana.

**Red-team (niezweryfikowane).** Świeża nazwa chroni tylko przed *starymi* commitami.

- *Nowy* commit z upstreamu, który doda pliki pod `.claude/loop-workspace`, po cichu zastąpi symlink katalogiem. Eksperyment: `git pull` bez błędu, a potem `cat .claude/loop-workspace/index.md` → tekst atakującego.
- Poprawka:
  - `CLAUDE.local.md` importuje realpath, nigdy symlink;
  - hook i `where` zatrzymują pracę (HOLD), gdy pod tą ścieżką jest cokolwiek innego niż symlink do tego workspace'u;
  - do denylisty dochodzą `.gitignore`, `.gitattributes`, `.worktreeinclude` i `.mcp.json`;
  - `denylist-check` eskaluje patche z trybem `120000` (symlink) lub `160000` (gitlink).

### 5.4 Rozwiązywanie ścieżek: trzy korzenie z jednej czystej funkcji

Funkcja `kit/core/layout.mjs → resolveLayout(facts)` jest czystym rdzeniem. Fakty dostarczają porty `GitPort`, `FsPort` i `EnvPort`. CLI i hooki to adaptery sterujące.

| Korzeń | Skąd | Do czego |
|---|---|---|
| `KIT_ROOT` | realpath kitu | Tylko zasoby kitu. Nigdy nie jest katalogiem roboczym gita dla provenance. |
| `PROJECT_ROOT` | `git -C <cwd> rev-parse --show-toplevel` | Wszystkie wywołania gita dla provenance, tree-id, reaudit i denylist-check (C01–C03, C09, C24). |
| `WORKSPACE` | Marker plus common dir | Stan. |

**Kolejność:**

1. strażniki: NO_REPO, HOME_REPO (dotfiles), CROSS_REPO;
2. zmienna środowiskowa `LOOP_SETUP_WORKSPACE`, tylko gdy nieśledzona i związana;
3. marker: BOUND, COPY, MOVED albo NEWER_SCHEMA;
4. brak markera: NEEDS_ATTACH albo PATH_REUSED;
5. tryb legacy tylko za zgodą zapisaną po stronie użytkownika;
6. strażniki mutacji: WORKTREE_WRITE, EPHEMERAL, KIT_DIRTY.

Nic nie jest tworzone niejawnie (C07). Każdy błąd daje exit 2 z prefiksem `[layout:KOD]`, a `loop.md` już traktuje 2 jako STOP.

**Red-team:**

- **Zweryfikowane (revise):** `MAIN_ROOT = checkouts[0]` jest błędne po `--attach` i po przeniesieniu. Strażnik i samonaprawa symlinku celują wtedy w cudzy albo nieistniejący katalog. Poprawka: `MAIN_ROOT` liczony per klon, z zachowaniem układu bare. Do tego przeniesiony klon z istniejącym rodzeństwem dostaje dziś COPY zamiast MOVED.
- **Niezweryfikowane, ale poważne:** zasada „błąd = exit 2” koliduje z hookami. Dla PreToolUse exit 2 **blokuje** narzędzie, więc błąd w `hook pre-tool` zablokowałby każdą edycję we wszystkich projektach na maszynie. Dla Stop exit 2 wymusza kontynuację. Poprawka:
  - `hook *` ma własny kontrakt: przy błędzie przepuszcza (exit 0);
  - odmowa tylko jawnie, przez JSON `permissionDecision`;
  - shim ma wbudowany `process.execPath`, bo przy sesji uruchomionej z desktopu `node` z nvm może nie być w PATH.

### 5.5 Reguły i kontekst

CLAUDE.md dzielimy na trzy części (C30):

1. **CLAUDE.md projektu** (śledzony): typ projektu, menedżer pakietów, komendy, localhost, zasady projektowe, plus sekcja „Repo rules” bez kitu:
   - commit przez pathspec;
   - nigdy nie przepisuj wysłanej historii;
   - nie osłabiaj testów;
   - ograniczona liczba prób naprawy;
   - mocki nie dowodzą integracji;
   - merge commity.

   Bez `@import`.
2. **`kit/rules/KIT.md`**: maszyneria, czyli wiki, /dream, krytycy, pętla rozwoju, kryteria ukończenia, kontrola zakresu i formaty wyjścia.
3. **Region digestu w KIT.md**: generowany mechanicznie, test pilnuje limitu ≤ 5 500 znaków.

**Nośnik:** hook SessionStart na poziomie użytkownika, z matcherem `startup|resume|clear|compact`. Wstrzykuje do 9 000 znaków; twardy limit binarki to 10 000. W środku są:

- nagłówek: workspace, wersja kitu, ostrzeżenia;
- digest;
- katalog wiki.

**Ryzyko S8:** kontekst z hooka ma mniejszy autorytet niż CLAUDE.md.

- **Red-team (niezweryfikowane):** S8 nie ma progu zaliczenia, jest zaplanowany przed tym, co mierzy, i nic nie uzależnia od niego T7.
- Poprawka:
  - S8 po T4, z liczbowym kryterium względem bazy z T0;
  - „S8 zaliczony albo wybrane `--claude-local`” jako warunek T7;
  - katalog wiki wstrzykiwany jako same tytuły, escapowane i oznaczone jako niezaufane dane. Wiki jest edytowalne przez agentów i nikt go już nie przegląda w PR.

### 5.6 Komendy, workflowy, CLI

- 15 komend użytkownika z gołymi nazwami. W wersji 2.1.330 komenda użytkownika wygrywa z projektową o tej samej nazwie (eksperyment 3/3), ale **projektowy skill wygrywa z komendą użytkownika**. Takie przesłonięcia sygnalizują `doctor`, hook i `where`.
- Krok 0 każdej komendy to `loop-setup where --json`. Komenda kończy się czysto w projekcie bez workspace'u.
- Workflowy dostają wszystko przez `args.ctx` (schemat `loop-ctx/1`). Blok walidatora zatrzymuje workflow, zanim wystartuje agent, gdy ctx jest niepoprawny.
- Fakty projektu (pnpm, port 3000, `next-env.d.ts`) przychodzą z `ctx.config` zamiast być zakodowane (C37). `<loop-verifier>` zostaje bajt w bajt taki sam; pilnuje tego asercja sha.
- CLI `loop-setup` zastępuje 385 wystąpień `pnpm trace`. Zachowuje wszystkie nazwy podkomend i kontrakt kodów wyjścia 0/1/2.
- **Zapisy:** rekordy, akcje i logi idą przez CLI, pod lockiem, z wpisem do dziennika. Strony wiki i tabela planu idą przez narzędzia plikowe po realpath.

### 5.7 Uprawnienia i chronione ścieżki

- **Uprawnienie per projekt:** `additionalDirectories = [realpath tego workspace'u]` w `.claude/settings.local.json`. Sesja w projekcie A nie czyta ani nie pisze stanu projektu B bez pytania.
- **Chronione ścieżki (P4):** każda ścieżka workspace'u zawiera segment `.claude`, więc Edit i Write zawsze pytają:
  - w trybie default i acceptEdits jest pytanie;
  - w trybie auto decyduje klasyfikator;
  - w trybie dontAsk jest odmowa.

  To **to samo co dzisiaj** z `.claude/memory`, więc nie ma regresji. Gdyby S1 lub S2 nie przeszły, wariantem zapasowym jest decyzja #12: workspace poza `~/.claude`.
- **Hook PreToolUse:** odmawia ręcznych edycji plików dopisywanych (`trace/*.jsonl`, `loop-run-log.md`, `log.md`) i zapisów do workspace'u z subagentów w worktree.
  - **Red-team (niezweryfikowane):** dodać `MultiEdit` do matchera i kanonizować ścieżkę przed szybką ścieżką.
- **Red-team (niezweryfikowane), ważne:**
  - Podkomendy cyklu życia (install, upgrade, attach, relink, migrate, remote, backup) agent może uruchomić przez Bash.
  - Repo z podrobionym `kit/kit.json` mogłoby przez `upgrade --from .` zainstalować własne hooki w `~/.claude/settings.json`, czyli zyskać trwałość na całej maszynie.
  - Poprawka:
    - CLI odmawia tych podkomend, gdy ustawione jest `CLAUDECODE` albo nie ma TTY;
    - instalator dopisuje do zakazów użytkownika `Bash(loop-setup install:*)` itd. Zakazy użytkownika wygrywają z zezwoleniami projektu;
    - zamiast `doctor:*` dopuszczamy tylko dokładne formy tylko do odczytu, bo `doctor --fix` zapisuje pliki.

### 5.8 Worktree

- `.claude/` zostaje prawdziwym katalogiem. Worktree izolacji leżą w `<repo>/.claude/worktrees/`, więc `repoRelative()` się nie zmienia.
- Świeże worktree nie ma symlinku, bo git pomija pliki ignorowane, a `.worktreeinclude` pomija symlinki. **Nie ustawiamy** `worktree.symlinkDirectories`. `doctor` zatrzymuje pracę, gdy ustawienia zaczną tworzyć symlink w worktree.
- Provenance, tree-id i reaudit liczą się w toplevel samego worktree, więc rekordy cytują kod, który naprawdę był przeglądany.
- **Red-team, zweryfikowane (revise):** strażnik WORKTREE_WRITE nie powstrzyma implementera. Flagę `--from-worktree` agent przypisuje sobie sam, a `cd ../../..` z worktree trafia do głównego checkoutu i przechodzi strażnika **bez flagi**.
  - Korekta sceptyka: to nie regresja, bo dziś implementer też może pisać do żywego magazynu przez `--store` albo `TRACE_STORE`, i nikt tego nie wykrywa.
  - Proponowane poprawki (hook Bash, `--project`, `agent_id`) też nie są mechaniczne.
  - **Właściwa naprawa leży po stronie weryfikatora:** stan nie może się zmienić w trakcie przebiegu workflowu. Hash magazynu, planu i wiki jest liczony przed wysłaniem zadania i porównywany po nim. Każda różnica oznacza HOLD.

### 5.9 CI i testy

- **W szablonie:** vitest włącza `src/**` i `kit/test/**`. Testy obejmują:
  - czysty rdzeń z atrapami w pamięci;
  - adaptery na prawdziwym gicie i symlinkach w `tempRepo()`, z tymczasowym `CLAUDE_CONFIG_DIR`;
  - snapshoty golden i test parytetu `legacyLayout()`;
  - test importów heksagonu;
  - testy parytetu bloków;
  - `selftest --symlinked-install`.
- **Bramki żywego stanu** idą do `loop-setup lint --all`, wołanego na końcu każdej iteracji pętli i każdego /dream. W CI zostaje zamrożony korpus `kit/test/fixtures/legacy-v1`. To ćwiczy ścieżki kodu, ale nie przywraca bramkowania stanu.
- **`verify.yml`:** znika job provenance. Dochodzi `story-lint --no-workspace`, który sprawdza strukturę i oznacza `Record: TR-…` jako „nieweryfikowalne tutaj”.
- **`pnpm build`** przestaje czytać wiki: `check-bundle-size` czyta `package.json` → `qualityBar` (C12).
- **Red-team (niezweryfikowane):**
  - nowy include vitest gubi `scripts/**`, więc `template-docs.test` po cichu przestałby działać;
  - test ma 10 kotwic, nie 6, i 3 z nich przechodzą do KIT.md;
  - README i adoption guide trzeba przepisać z modelu „skopiuj pliki” na install/init;
  - 246 wystąpień `.claude/memory` poza magazynem, a V1 przepisuje tylko 71.

### 5.10 Trwałość i zespół

**Drabina trwałości:**

| Poziom | Co to jest | Szczegóły |
|---|---|---|
| L0 | Pliki workspace'u | Przetrwają sesje, restart, `git clean`, ponowny klon projektu i retencję Claude Code. |
| L1 | Dziennik `.history` | Włączony domyślnie: commit po każdej mutacji CLI. Import 59-commitowej historii `.claude/memory` przez subtree split. |
| L2 | Kopia poza maszyną | `remote add` plus jawne `backup`, albo `export` na inne urządzenie. **Wymagana dla L3.** |

**Współbieżność:** lock `O_EXCL` i lease na zadania pętli (claim). Przed każdą mutacją CLI weryfikuje łańcuch i odtwarza magazyn.

**Gałęzie:** jeden workspace obejmuje wszystkie gałęzie. Węzeł jest „done” dla krawędzi `after` tylko wtedy, gdy jego patch wylądował.

- **Red-team (niezweryfikowane):** `git apply --reverse --check` zawodzi, gdy późniejsza zmiana dotknie 3 linii kontekstu, mimo że poprawka jest na miejscu. Eksperyment to pokazał.
- Poprawka: zapisać SHA z CLEAR i sprawdzać `merge-base --is-ancestor` albo patch-id (`git cherry`, co obejmuje squash). Dopiero potem `apply -C0`. Błąd kontekstu traktować jako „nieznane”, a nie „nie”.

**Adapter zespołowy (opcja; dla wariantu 0b/0c staje się konieczny):**

- prywatne zdalne repo dla stanu, jako osobny klon jednej gałęzi, a nie worktree projektu;
- `loop-setup sync` robi fetch i merge; union tylko dla `trace/*.jsonl`, `loop-run-log.md` i `log.md`;
- `claim` to commit planu plus push, a odrzucony push oznacza utratę lease;
- łańcuch per autor przetrwa union merge i rebase (zweryfikowane);
- `workspace.json` nigdy nie jest współdzielony;
- zmiany, które przyszły przez sync, zatrzymują L2/L3 do potwierdzenia przez człowieka;
- żaden hook nie robi pull ani push.

**Red-team (niezweryfikowane):** commity dziennika dziedziczą globalny config gita. Globalny `core.hooksPath`, `commit.gpgsign=true` albo brak tożsamości łamią lub zawieszają każdy `loop-setup write`; eksperyment potwierdził wszystkie trzy przypadki. Poprawka: każde wywołanie z

```
-c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=loop-setup -c user.email=loop-setup@localhost --no-verify
```

oraz `git init --template=`.

### 5.11 Provenance i zaufanie

- **Rekordy trace-lite/1.1**, zmiana addytywna:
  - nowe pola: `provenance.kit {version, commit}`, `provenance.workspace`, `cwd_kind`, `chain {w, prev}`;
  - `commit` i `branch` zawsze pochodzą z `PROJECT_ROOT`;
  - polityka TRACE przechodzi z v3 na v4.
- **Referencje dowodów:**
  - zwykła ścieżka to plik projektu, porównywany przez git;
  - `ws:` to plik workspace'u z sha256;
  - `kit:` to plik porównywany na zainstalowanym commicie;
  - stare referencje przechodzą przez `LEGACY_REF_MAP`.
- **Kotwica zaufania denylisty:** `git -C <src> --no-replace-objects show <zainstalowany commit>:kit/workflows/loop-iteration.js`. Workflow, który ocenia, i workflow, który się wykonuje, to jeden plik.
- **Integralność kitu** jest sprawdzana przed każdym L2/L3. To tylko wykrywanie dryfu; prawdziwa ochrona to „src/ poza katalogami zapisu i Edit-deny”.
- **Red-team (niezweryfikowane), BLOKER:**
  - Przy wyłączonym sandboksie, czyli domyślnie (P6), Bash tego samego użytkownika może przepisać `installed.json`, `src/`, kopie komend i hooki w `settings.json`.
  - `KIT_DIRTY` porównuje klon z `installed.json`, który leży w tej samej zapisywalnej domenie.
  - `l3-check` przypina tylko hash `<loop-verifier>`, więc edycja denylisty zachowuje L3.
  - Poprawka:
    - (a) włączony sandbox jako twardy warunek L3, liczony z efektywnych ustawień;
    - (b) hook zakotwicza `installed.json` i hashe wpisów w `anchors/`, a każde wysłanie L2/L3 je sprawdza;
    - (c) rekord benchmarku i `l3-check` przypinają też hash `<loop-denylist>`.
- **Red-team (niezweryfikowane):**
  - Jedno `loop-setup write` może samo poświadczyć L3. Eksperyment: podrobiony rekord bench → `l3-check: met`.
  - Poprawka: `write` odrzuca zarezerwowany prefiks `bench:`, a L3 wymaga ludzkiego ATTEST z terminala, zapisanego w `anchors/`.
- **`LEGACY_REF_MAP` jest niekompletna** (red-team, niezweryfikowane):
  - mapuje 3 prefiksy, a magazyn cytuje co najmniej 8 innych rodzin ścieżek (`scripts/trace` 227 razy, `.claude/workflows` 97, `.claude/commands` 23, `.claude/loop.md` 16, absolutne 10…);
  - prefiks nie rozwiąże też plików, które T5 dzieli;
  - poprawka: mapa na poziomie plików generowana z `git diff -M --name-status` commitu przeniesienia, pliki dzielone porównywane przez `git show <commit>:<stara ścieżka>`, oraz test golden „zero niezmapowanych referencji”.

### 5.12 Bezpieczeństwo w skrócie

1. Kod kitu to przypięty commit poza katalogami zapisu, z Edit-deny. Instaluje i aktualizuje go tylko człowiek.
   - Red-team: wymusić to mechanicznie: odmowa przy `CLAUDECODE` lub braku TTY, plus zakazy użytkownika.
2. Repo nie może wybrać workspace'u. Wiązanie wymaga markera, który zapisuje tylko `init` użytkownika.
3. Config wykonywalny jest lokalny dla maszyny.
   - Red-team: `workspace.json` leży w katalogu zapisu sandboksu i nie jest zakotwiczony. Przenieść config wykonywalny i dane wiązania do `~/.claude/loop-setup/bindings/<id>.json` (Edit-deny, zakotwiczone). Polecenia wstawiane do promptów sprawdzać ścisłym wzorcem. Nie uzależniać L3 od bramki Stop działającej poza sandboksem.
4. Dziennik `.history/` wewnątrz katalogu zapisu to wektor ataku (red-team, eksperyment):
   - podrzucone hooki, `core.fsmonitor` i `filter.*.clean` wykonały się przy commicie;
   - utwardzenie flagami `-c` nie zatrzymało filtra z `.gitattributes`;
   - poprawka: GIT_DIR dziennika przenieść do `~/.claude/loop-setup/history/<id>.git` (Edit-deny, poza katalogami zapisu), a URL backupu trzymać w zakotwiczonym configu użytkownika.
5. Jeśli `~/.claude` jest repo dotfiles, `git add -A` złapie workspace'y razem z `.history/objects` (red-team, eksperyment). Poprawka: `~/.claude/loop-setup/.gitignore` zawierający `*`.
6. Domyślnie nie ma zewnętrznego importu CLAUDE.md, a hook ostrzega przed każdym, który znajdzie.

---

## 6. Decyzje do podjęcia

„V1” to rekomendacja projektu V1, „RT” to dopisek red-teamu.

| # | Pytanie | Opcje | Rekomendacja | Dlaczego |
|---|---|---|---|---|
| **0 (RT, nowa)** | **Gdzie uruchamiasz Claude Code dla tego repo: lokalnie, na webie czy jedno i drugie?** | 0a lokalnie / 0b web / 0c oba | **0b/0c**, jeśli web jest główny (dowody w sekcji 2) | Decyduje o wszystkim innym. T5 mergować dopiero po odpowiedzi. Dla 0b/0c najpierw S10. |
| 1 | Stan solo czy zespołowy? | (a) solo plus kopia poza maszyną / (b) prywatne repo stanu i `sync` / (c) osierocona gałąź `loop-state` w repo projektu | V1: (a). **Przy 0b/0c: (b)** | (c) wystawia stan na zdalne repo projektu, które w tym szablonie jest publiczne. |
| 2 | Nazwa i miejsce symlinku | `.claude/loop-workspace` / `/.loop` / `.claude/memory` | `.claude/loop-workspace` | Nigdy nie był śledzony, a istniejąca reguła denylisty `.claude/` już go obejmuje. `.claude/memory` git nadpisuje (zweryfikowane). |
| 3 | Jak ignorować symlink | Linia w `.gitignore` plus `info/exclude` / tylko `info/exclude` / globalne excludes | Linia w `.gitignore` plus zapas w `info/exclude` | To dosłowna prośba i działa też dla kolegów. |
| 4 | Pakowanie kitu | Komendy użytkownika plus `scriptPath` / plugin z marketplace / plugin lokalny | Komendy użytkownika | Gołe nazwy, brak samomodyfikacji, a chmura i tak nie instaluje pluginów użytkownika. |
| 5 | Nośnik reguł | Digest z hooka / digest plus opcjonalny `CLAUDE.local.md` / zewnętrzny `@import` | Hook, a decyzja o `--claude-local` po S8 | Import wymaga szerokiej zgody. RT: dla chmury zależy od S10. |
| 6 | Sesje w chmurze | Nieobsługiwane / setup script, tylko L1 / setup script plus repo stanu | V1: nieobsługiwane. **RT: wchłonięte przez decyzję #0** | Patrz sekcja 2. |
| 7 | Historia szablonu (133 rekordy, 181 akcji) | Workspace maintainera plus zamrożony korpus / archiwum w repo / tylko workspace | Workspace plus korpus | Korpus utrzymuje testy ścieżek legacy w CI. |
| 8 | Dowody historii dla kolegów i CI | Per użytkownik / `export --stories` do `docs/` | Per użytkownik | Obie historie cytują dziś `(pre-TRACE)`. |
| 9 | Drugi klon tego samego repo | Osobne workspace'y plus jawne `--attach` / automatyczne współdzielenie | Osobne | Fork lub kopia nie mogą po cichu dzielić stanu. RT: `--attach` psuje reaudit między klonami (osobne bazy obiektów). |
| 10 | Gdzie hostować kit | `kit/` w tym repo / osobne repo | `kit/` w tym repo | Fixture'y benchmarku łatają demo-aplikację tego repo. RT: dodać ścieżkę A0 „nowy projekt z szablonu”. |
| 11 | Gołe `/loop` | Stub `.claude/loop.md` / zawsze `/loop 30m /loop-tick` | V1: stub. **RT: stub jest nadpisywany przy checkout (qualify)** | Albo hook odtwarza stub, albo tylko `/loop-tick` plus kontrola w `doctor`. |
| 12 | Workspace poza `~/.claude` | Zostaje w `~/.claude` / `~/.local/share/loop-setup` | Zostaje, chyba że S1 lub S2 nie przejdą | Pytania o chronione ścieżki są takie same jak dziś. |
| **13 (RT)** | Czy projekt może nadpisać komendę kitu? | Tak, przez jawny punkt rozszerzeń / nie, jako oznaczona utrata | Do decyzji | Komenda użytkownika wygrywa z projektową, więc nadpisanie po cichu nie działa dla użytkowników kitu. |
| **14 (RT)** | Zakres rollbacku | Pełny rollback przetestowany / rollback poza T3 nieobsługiwany | Do decyzji | `migrate --to-legacy` cofa tylko stan. Linie 1.1 łamią stary schemat 1.0. |

---

## 7. Plan migracji

Kolumna „Zmiana po red-teamie” zawiera poprawki, które musi uwzględnić rewizja. W większości są niezweryfikowane.

| Krok | Co | Weryfikacja | Zmiana po red-teamie |
|---|---|---|---|
| **P (nowy)** | **Decyzja #0 i spike S10** | Zapisany wynik S10 | Warunek wstępny T5. T5–T8 wymagają trwałej maszyny lokalnej albo gotowego wariantu 0b. |
| T0 | Baza: snapshoty golden (133/181, wiki-check, plan-lint, story-lint, bloki promptów, sha `<loop-verifier>`), spike'i S1–S7 i S9 | `pnpm test` exit 0, snapshoty powtarzalne | S8 przenieść za T4. Dodać spike limitu rozmiaru treści komendy i fallback dla braku `git subtree`. |
| T1 | Trzykorzeniowy resolver w obecnym układzie, test-first (porty, adaptery, punkt kompozycji, exit 0/1/2 z `[layout:KOD]`, brak niejawnego `mkdir`) | Test na każdą gałąź resolvera; snapshoty bez zmian; brak magazynu → exit 2 i żaden plik nie powstaje | Przypadki `FOREIGN_HOME`, `MAIN_ROOT` per klon, rodzeństwo po przeniesieniu. Osobny kontrakt `hook *`, który przy błędzie przepuszcza. |
| T2 | Podział plików mieszanych: `qualityBar` → `package.json`, `trace.md` → polityka plus notatki, schemat planu → kit, CLAUDE.md → projekt, repo rules i KIT.md; tymczasowy `@kit/rules/KIT.md` | `pnpm build` bez `.claude/memory`, parytet, budżet digestu | **Krok księgi wiki:** nowe akcje COMMIT dla 18 faktów z `trace-notes` i 13 z `workflow.md`, bo inaczej `wiki-check` jest czerwony. Import indeksu zostaje do T7. |
| T3 | Rekordy 1.1, łańcuch, przestrzenie nazw referencji, tree-id, „landed”, `^kit` w denyliście | Odtworzenie starego magazynu, test union i rebase na dwóch klonach, sha weryfikatora bez zmian | „Landed” przez SHA lub patch-id. Pełna mapa referencji z `git diff -M` i test „zero niezmapowanych”. Hash denylisty w `l3-check`. Prefiks `bench:` zarezerwowany. Denylista: `.gitignore`, `.gitattributes`, `.worktreeinclude`, `.mcp.json`, tryby `120000/160000`. |
| T4 | CLI cyklu życia, hooki, współbieżność, kotwice, dziennik, `selftest` | Testy integracyjne w tymczasowym `CLAUDE_CONFIG_DIR` | Dziennik poza katalogiem zapisu, z utwardzeniem `-c`. `bindings/<id>.json`. Odmowa podkomend cyklu życia przy `CLAUDECODE`. Shim z absolutnymi ścieżkami. `deinit`. `import --from-ref`. `.gitignore` z `*` w `LOOP_SETUP_HOME`. Instalator bez `--filter` przy źródle lokalnym. |
| T5 | `git mv` maszynerii do `kit/`, przepisanie promptów (385 × `pnpm trace`, 12 × `scriptPath`, `.claude/memory` → `ctx.paths`), instalacja z commitu T5, `/bench-checkers` | `pnpm verify`, grep na stare pisownie, `doctor --install`, brak flag falsyfikacji | **Warunek:** P zaliczone. Przepisać README i adoption guide. `template-docs.test` w ścieżce objętej includem, 10 kotwic. Grep obejmuje też 246 wystąpień `.claude/memory`. |
| T6 | CI: usunąć job provenance, dodać `story-lint --no-workspace`, wydać tag `kit-v2.0.0` | CI zielone, `doctor` zielony | Linie union w `.gitattributes` usunąć dopiero w T7. Dodać krok `selftest` do `verify.yml`. Podzielić `config.test` na część kitu i część projektu. |
| T7 | `loop-setup migrate`: kopia stanu, import historii, marker, symlink, uprawnienie, exclude, linia w `.gitignore`; `git rm -r .claude/memory` | `check-ignore`, `lint --all`, ≥ 59 commitów w `.history`, `pnpm verify` w świeżym worktree | **Warunek:** S8 zaliczony albo wybrane `--claude-local`. Poprawić oczekiwaną liczbę akcji. Najpierw `import --from-ref` dla gałęzi sprzed migracji. |
| T8 | Akceptacja pierwszej sesji i przywrócenie L3 | Rekordy w workspace, `l3-check`, czysty `git status` | L3 wymaga sandboksu (bloker red-teamu) i ludzkiego ATTEST. |
| T9 | Wycofanie trybu legacy po dwóch wydaniach minor | Testy kitu | — |
| **A0 (RT)** | Nowy projekt z szablonu: kit-free starter albo `init --from-template` | Nowe repo nie zawiera `kit/` | Brakowało w V1. |
| A1–A5 | Adopter: instalacja, `init`, migracja legacy, koledzy i drugie klony, próba rollbacku | `doctor`, zgodność liczby i id rekordów | Tryb legacy: zapis **tylko w kształcie 1.0** albo tylko odczyt. Instalator wcześniej listuje repo legacy, których komendy przesłoni. |

---

## 8. Uwagi red-teamu (macierz)

Werdykt to typowany werdykt TRACE sceptyka. **„—”** oznacza uwagę niezweryfikowaną, bo weryfikacja została przerwana. Traktuj ją jako hipotezę z dowodem, nie jako ustalenie.

| Krytyk | Waga | Werdykt | Uwaga | Dowód | Zalecane działanie |
|---|---|---|---|---|---|
| Scenariusze + Kompletność | bloker | **revise** (defekt prawdziwy, poprawka do korekty) | Domyślne „chmura nieobsługiwana” wyłącza pętlę w środowisku, w którym ten projekt faktycznie jest prowadzony | 133/133 rekordy z gałęzi `claude/*`, `remote-env.md`, `CLAUDE_CODE_REMOTE=true`; sceptyk: same przypisy nie dowodzą chmury | Decyzja #0 przed T5. Dla web: kit przez setup script i repo stanu (S10). Nie dzielić stanu na repo i dom. |
| Bezpieczeństwo | bloker | — | Przy wyłączonym sandboksie agenci mogą przepisać `installed.json`, `src/`, komendy i hooki; `l3-check` przypina tylko weryfikator | `lib.mjs:1633-1678` porównuje tylko `currentVerifierHash()`; P6: sandbox domyślnie wyłączony | Sandbox jako warunek L3. Kotwice dla `installed.json` i wpisów settings. Hash denylisty w `l3-check`. |
| Scenariusze | ważne | **revise** | Strażnik WORKTREE_WRITE nie jest mechaniczny | Worktree są w `git worktree list`; sceptyk: `cd ../../..` omija strażnika bez flagi; dziś `TRACE_STORE` daje to samo | Sprawdzenie po stronie weryfikatora: hash stanu przed i po wysłaniu zadania → HOLD |
| Scenariusze | ważne | **revise** | `MAIN_ROOT = checkouts[0]` jest błędne po `--attach` i po przeniesieniu | Symulacja sceptyka: strażnik nieaktywny w B, samonaprawa pisze do A; rodzeństwo daje COPY zamiast MOVED | `MAIN_ROOT` per klon, z zachowaniem układu bare; strażnik używa sprawdzenia z CLI |
| Scenariusze | ważne | **revise** | Jeden klucz markera, więc dwa katalogi domowe na jednym klonie nadpisują się nawzajem | Eksperyment: `--get` zwraca tylko ostatnią wartość; `loop-setup.workspace.3f9a…` to niepoprawny klucz (627/1000 hashy zaczyna się cyfrą) | `homeId` jako podsekcja, kod `FOREIGN_HOME`, nigdy nie nadpisywać cudzego markera |
| Scenariusze | ważne | **qualify** (stub: potwierdzone; uprawnienie: przesadzone) | Stub `.claude/loop.md` i `settings.local.json` leżą w ścieżkach kiedyś śledzonych | loop.md śledzony w 139/140 commitów; `settings.local.json` w 99/140, ale tylko commity starsze niż 4d90444 go nadpisują | Hook lub `doctor`: sprawdź i odtwórz. Test migracji tam i z powrotem. „Nigdy nieśledzona ścieżka” dla tych plików jest niewykonalna. |
| Scenariusze | ważne | **qualify** | Stan z gałęzi sprzed migracji nie ma drogi do workspace'u (konflikty modify/delete) | Eksperyment: DU na 4 plikach stanu, w tym `loop-plan.md`; sceptyk: dane da się odzyskać przez `HEAD^2` | `import --from-ref <gałąź>`; przepis merge; `doctor` listuje takie gałęzie |
| Scenariusze | ważne | — | „Landed” przez `apply --reverse --check` psuje się po zmianach w kontekście | Eksperyment: `patch does not apply`, choć poprawka jest obecna | SHA lub patch-id, potem `-C0`, „nieznane” zamiast „nie” |
| Scenariusze | ważne | — | Dziennik `.history` dziedziczy globalny config gita (hooki, gpgsign, tożsamość) | Eksperymenty: exit 1 i exit 128 ×2 | Flagi `-c …`, `--no-verify`, `init --template=` |
| Scenariusze | ważne | — | `~/.claude` jako repo dotfiles łapie workspace'y razem z `.history` | Eksperyment: `git add -A` dodał 52 pliki z `.history` | `LOOP_SETUP_HOME/.gitignore` = `*`; ostrzeżenie w `doctor` i instalatorze |
| Scenariusze + Bezpieczeństwo | ważne | — | Exit 2 koliduje z hookami: PreToolUse blokuje, Stop wymusza kontynuację | Tekst pomocy hooków w binarce | `hook *` przy błędzie przepuszcza; odmowa przez JSON; `process.execPath` w shimie |
| Scenariusze + Kompletność | ważne | — | Repo legacy: komendy kitu przesłaniają projektowe; linie 1.1 łamią schemat 1.0 adoptera | `schema-v1.json`: `const 'trace-lite/1.0'`, `additionalProperties:false` | Tryb legacy tylko w kształcie 1.0 albo tylko do odczytu; instalator listuje przesłaniane repo |
| Scenariusze | ważne | — | `clone --filter=blob:none` z płytkiego lokalnego repo wisi | Eksperyment: `timeout 45` → exit 124 | Bez `--filter` przy źródle lokalnym; timeouty; `selftest` z pełnego repo |
| Bezpieczeństwo | ważne | — | `loop-setup write` może sam poświadczyć L3 | Eksperyment: podrobiony rekord → `l3-check: met` | Zarezerwowany prefiks `bench:`; ludzki ATTEST z terminala w `anchors/` |
| Bezpieczeństwo | ważne | — | GIT_DIR `.history` w katalogu zapisu: podrzucone hooki, fsmonitor i filtr wykonują się | Eksperyment: `PLANTED-FILTER-RAN` mimo utwardzenia `-c` | Dziennik w `~/.claude/loop-setup/history/<id>.git`, Edit-deny; URL backupu w zakotwiczonym configu |
| Bezpieczeństwo | ważne | — | `workspace.json` (config wykonywalny i wiązanie) to najsłabiej chroniony plik | Bramka Stop działa poza sandboksem i odpala testy, które pętla zmieniła | `bindings/<id>.json` Edit-deny i zakotwiczony; walidacja poleceń wzorcem; bramka Stop nie jest wymogiem L3 |
| Bezpieczeństwo | ważne | — | Dane stają się instrukcjami: katalog wiki wstrzykiwany do każdej sesji, nikt go nie przegląda | Dziś `index.md` jest śledzony i widoczny w PR | Porównanie z zakotwiczonym HEAD dziennika; same tytuły, escapowane, jako dane niezaufane |
| Bezpieczeństwo | ważne | — | Nowy commit upstream pod `.claude/loop-workspace` zastępuje symlink katalogiem | Eksperyment: `git pull` → katalog z tekstem atakującego | HOLD, gdy ścieżka nie jest symlinkiem do tego workspace'u; `CLAUDE.local.md` importuje realpath |
| Bezpieczeństwo | ważne | — | Podkomendy cyklu życia może uruchomić agent; podrobiony `kit.json` daje trwałość przez hooki użytkownika | `CLAUDECODE` jest ustawione w Bash sesji | Odmowa przy `CLAUDECODE` lub braku TTY; zakazy użytkownika na te podkomendy |
| Bezpieczeństwo | ważne | — | `--project` w podkomendach do odczytu łamie zasadę najmniejszych uprawnień; `doctor:*` dopuszcza `--fix` | Lista zezwoleń w V1 | Odmowa obcego `--project` przy `CLAUDECODE`; dokładne formy `doctor` |
| Bezpieczeństwo | ważne | — | Łańcuch dostaw kitu: diff tylko `--stat`, zmienny tag, TOCTOU, `/tmp/ls` | Tekst kroków A1 i UPGRADE w V1 | Pełny diff kodu wykonywalnego; SHA lub podpisany tag; `mktemp -d` |
| Bezpieczeństwo | ważne | — | Shim rozwiązuje kit ze zmiennej środowiskowej, a `env` z ustawień repo dociera do procesów potomnych | Binarka: `settingsEnvForChildrenFromRepository` | Absolutne ścieżki wbudowane w shim; ignorować `LOOP_SETUP_*` |
| Bezpieczeństwo | ważne | — | Luki w denyliście: `.gitignore` (negacja), `.worktreeinclude`, `.mcp.json`, tryby plików | Eksperyment: `!/.claude/loop-workspace` w `.gitignore` przebija exclude | Dodać te ścieżki; eskalować tryby `120000/160000` |
| Kompletność | ważne | — | Podział `trace.md` i `workflow.md` czerwieni `wiki-check` (brak migracji księgi) | `lib.mjs:736-752`; 18 i 13 akcji COMMIT | Krok księgi w T2/T7; test „`lint --all` zielony po podziale” |
| Kompletność | ważne | — | `LEGACY_REF_MAP` pokrywa 3 z co najmniej 11 rodzin ścieżek | Liczenie referencji w magazynie | Mapa na poziomie plików z `git diff -M`, pliki dzielone zamrożone, test golden |
| Kompletność | ważne | — | Dokumentacja i bramki dokumentacji poza zakresem; `template-docs.test` przestaje działać | `vitest.config.ts:8`; 10 kotwic, 3 w zakresie KIT.md | Krok docs/testy w T5/T6 |
| Kompletność | ważne | — | Brak ścieżki „nowy projekt z szablonu”, więc kit trafia do jego źródeł (łamie intencję 1) | `adoption-guide.md:9-10` | Krok A0 albo osobny starter |
| Kompletność | ważne | — | Brak `deinit`; pełny rollback jest w praktyce jednokierunkowy | Cykl życia w V1 | `deinit`; zdefiniować i przetestować rollback albo uczynić go decyzją #14 |
| Kompletność | ważne | — | S8 bez progu, za wcześnie w planie, nie blokuje T7 | Kroki T0 i T7 w V1 | S8 po T4, z liczbowym progiem, jako warunek T7 |
| Różni krytycy | drobne | — | `--attach` psuje reaudit między klonami; snippet CI dla adoptera trafia na HOME_REPO; junction a `git clean` na Windows; MultiEdit; zgoda legacy po ścieżce; przesłonięcie przez skill; brak ignorowania `CLAUDE.local.md`; luki w kolejności kroków | Szczegóły w surowym wyniku workflowu | Do rewizji |

---

## 9. Ryzyka i spike'i

### Najważniejsze ryzyka

Pomijam te już opisane w sekcji 8.

| Ryzyko | Waga | Mitygacja |
|---|---|---|
| Reguły z hooka mają mniejszy autorytet niż CLAUDE.md | ważne | Digest generowany z KIT.md, komendy samowystarczalne, S8 z progiem, opcja `--claude-local` |
| Zapisy narzędzi plikowych do `~/.claude` zawsze pytają, a w trybie dontAsk są odrzucane | ważne | Tak samo jak dziś. Częste zapisy idą przez CLI. S2. Decyzja #12. |
| Solo: brak wspólnego planu i bramek stanu w CI | ważne | Decyzja #1. Kontrakt adaptera zespołowego gotowy. |
| Zapisy w sandboksie przez `additionalDirectories` per projekt są wywnioskowane z binarki, nie przetestowane | ważne | S1 przed T5 |
| `scriptPath` do `~/.claude` może pytać o zgodę na niektórych powierzchniach, co zablokowałoby pętlę bez nadzoru | ważne | S5. Fallback: workflowy użytkownika po `meta.name` ze sprawdzeniem przesłonięć. |
| Rozmiar refaktoru: 385 wystąpień CLI, 12 `scriptPath`, 5 bloków AGENT_SAFETY, schemat, polityka, ponowny benchmark | ważne | Kroki T0–T6, test-first, snapshoty golden, grep, asercja sha weryfikatora |
| Każda aktualizacja kitu, która zmienia weryfikator lub denylistę, unieważnia L3 | ważne | Wymuszane przez `l3-check` |
| Squash-merge osieroca commity provenance: 73 rekordy już są nieosiągalne | drobne (istniało wcześniej) | Tylko merge commity; opcjonalnie `refs/pull/*/head` |

### Spike'i

| # | Niewiadoma | Decyduje o |
|---|---|---|
| **S10** | **Chmura:** czy hooki z setup scriptu działają (runtime ma `launcher-settings.json`)? Czy repo stanu da się sklonować i wysłać? Czy repo kitu jest osiągalne? | **Decyzja #0. Warunek T5.** |
| S1 | Sandbox: czy `loop-setup write` przez uprawnienie per projekt działa, a Edit-deny chroni `src/`? | Czy potrzebny jest `LOOP_SETUP_HOME` poza `~/.claude` |
| S2 | Edit i Write do realpath i przez symlink w każdym trybie uprawnień | Czy /dream używa narzędzi plikowych, czy `wiki apply` |
| S3 | Limit 10 000 znaków: per hook czy łącznie? Czy kontekst wraca po compact i clear? Czy zostaje po EnterWorktree? | Budżet digestu |
| S4 | Czy eksport PATH przez `CLAUDE_ENV_FILE` dociera do agentów workflowu? Jak dopasowują się reguły zezwoleń Bash? | Instalowane reguły zezwoleń; potwierdza `ctx.cli` |
| S5 | `scriptPath` do `~/.claude` bez pytania (CLI, desktop, SDK, wznowienie) | Workflowy niezarejestrowane czy po `meta.name` |
| S6 | Pierwszeństwo komenda / skill przy każdej aktualizacji Claude Code | Reguły przesłonięć w `doctor` |
| S7 | Czy w PreToolUse dla agentów workflowu jest `agent_id`? | Zasięg strażnika subagentów |
| S8 | Przestrzeganie reguł: digest kontra pełny CLAUDE.md. **RT: po T4, z liczbowym progiem.** | Domyślne `--claude-local`; warunek T7 |
| S9 | Opóźnienie hooków | Czy potrzebny jest cache indeksu workspace'ów |
| S11 | Windows: junction, `check-ignore`. **RT: także `git clean -fdX`, `stash -a`, rekurencyjne `fs.rm`.** | Wsparcie Windows |
| S12 (RT) | Limit rozmiaru treści komendy (loop-tick = około 25 tys. znaków) | Czy `/loop-tick` trzeba dzielić |

---

## 10. Odrzucone alternatywy

| Opcja | Dlaczego odrzucona |
|---|---|
| Kit jako plugin Claude Code | Przestrzeń nazw (bez gołych nazw), `bin/` poza PATH terminala, samomodyfikacja w trybie dev, chmura nie instaluje pluginów użytkownika. Zostaje jako możliwość na później. |
| Plugin włączany lokalnie per projekt | Niesprawdzony w sesjach `--worktree`. Ginie przy `git clean -fdx` i wtedy po cichu wyłącza hooki. |
| Kopie workflowów w `~/.claude/workflows`, wywoływane po nazwie | Rozwiązywanie projekt > użytkownik pozwala projektowi przesłonić weryfikator kitu. Ryzyko pomieszanych wersji. |
| Nazwa symlinku `.claude/memory` | Git podmienia ją przy checkout, merge i bisect starych commitów (zweryfikowane). |
| `.claude` jako symlink albo symlinkowane `.claude/worktrees` | Claude Code odmawia worktree i zapisu workflowów (C05, P5). |
| `worktree.symlinkDirectories` | Daje implementerom ścieżkę zapisu do żywego stanu. |
| Zewnętrzny `@import` w CLAUDE.md albo `~/.claude/CLAUDE.md` | Szeroka zgoda wpuszcza do kontekstu każdy plik z katalogu domowego. `~/.claude/CLAUDE.md` ładuje się w każdym projekcie. |
| Stan w `~/.claude/projects/<key>` albo `${CLAUDE_PLUGIN_DATA}` | Retencja, `claude purge`, sandbox. Dane pluginu są per plugin i giną przy odinstalowaniu. |
| Stan jako worktree osieroconej gałęzi w klonie projektu | Hooki gita projektu działają na commitach stanu. `git worktree prune` może go zniszczyć. |
| Współdzielona gałąź `loop-state` albo wysyłany workspace jako **domyślne** | Przypięcie kitu i polecenie bramki Stop czytane z nieprzeglądanego stanu, automatyczny push, publiczność stanu. Zostaje tylko jako opcja ze stałym kontraktem. **Uwaga: dla wariantu 0b chodzi o osobne, *prywatne* repo stanu, nie o gałąź publicznego repo projektu.** |
| Dystrybucja przez npm (`npx`) | Specyfikacja odczytana z danych może być aliasem, gitem albo tarballem. `npx` uruchamia kod przed jakąkolwiek weryfikacją. |
| Liniowy łańcuch hashy razem z union merge | Pierwsze współbieżne dopisanie trwale czerwieni `lint`. Łańcuch per autor przetrwa merge (zweryfikowane). |
| Zero śladu w repo (usunąć `settings.json`, linie ignorowania i reguły repo) | Zweryfikowany bloker: koledzy bez kitu i chmura tracą zakazy force-push i hard-reset. |
| Przeniesienie demo-aplikacji do `examples/` | 28 z 29 fixture'ów benchmarku się dezaktualizuje. Duży, niezwiązany refaktor. |
| Domyślna instalacja `~/.claude/loop.md` | Przejmuje gołe `/loop` we wszystkich projektach. Obcięcie na 25 000 znakach. |
| Tryb embedded (śledzony `workspace.json` w repo) | Pozwala repo wybrać własny workspace i config. |
| Jedno globalne `additionalDirectories` na wszystkie workspace'y | Odczyty i zapisy między projektami. |
| Budżet w `docs/quality-bar.md` | Ścieżka nie jest objęta denylistą, więc patch L2/L3 mógłby podnieść budżet. `package.json` jest już chroniony. |
| (RT) Stan w repo dla chmury, workspace domowy lokalnie | Dwa żywe źródła prawdy. |

---

## 11. Macierz ocen krytyków

Etap Critique; skala 0–10.

| Propozycja | Git | Platforma | Trwałość | Bezpieczeństwo | Migracja | DX | Architektura | Bezpieczeństwo pętli | **Średnia** | Stojące blokery po weryfikacji |
|---|---|---|---|---|---|---|---|---|---|---|
| **Literal-faithful** (baza) | 5 | 7 | 4,5 | 6 | 6,5 | 6 | 7 | 7 | **6,13** | **0** |
| Plugin-native | 6,5 | 7,5 | 6 | 4 | 6 | 6,5 | 4 | 4 | 5,56 | 2 (łańcuch kontra union; wspólny `workspace.json` jako kanał wykonania) |
| Zero-footprint | 6 | 7 | 4 | 6 | 4,5 | 6,5 | 6 | 4 | 5,50 | 2+ (usunięte zakazy i linie ignorowania; `packages/loopkit` poza denylistą) |
| Hexagonal code-shape first | 5 | 6 | 5 | 3 | 7,5 | 5 | 7 | 5 | 5,44 | 3 (łańcuch kontra union; cały `LOOP_HOME` jako katalog zapisu; kit w katalogu głównym poza denylistą) |
| Durability & team first | 7 | 5 | 8 | 2 | 7 | 5 | 5 | 3,5 | 5,31 | 3 (przypięcie kitu z nieprzeglądanej gałęzi; polecenie bramki Stop ze wspólnego stanu; `kit/` poza denylistą) |

**Weryfikacja uwag krytyków**, 41 sceptyków:

| Werdykt | Liczba |
|---|---|
| accept | 5 |
| qualify | 16 |
| revise | 19 |
| reject | 1 |

Każdy bloker przeszedł przez osobnego sceptyka. Uwagi powyżej limitu 24 ważnych zostały odłożone (defer) i są wymienione w V1 jako DEFERRED. To:

- brak CLI w PATH;
- brak odzyskiwania dla nowej maszyny i drugiego klonu;
- mieszane wersje promptów;
- kit starszy niż dane;
- dwie pisownie ścieżek;
- kody wyjścia 3–7.

Wszystkie mają odpowiedź w V1.

---

## 12. Co dalej

1. **Odpowiedz na decyzję #0:** gdzie pracujesz z tym repo: web, lokalnie czy oba.
2. Jeśli web lub oba: **spike S10** w jednorazowym środowisku, za Twoją zgodą. Sprawdzamy hooki z setup scriptu, prywatne repo stanu z prawem push i osiągalność repo kitu.
3. **Rewizja projektu** z uwagami z sekcji 8 (krok „Revise”, którego workflow nie zdążył wykonać):
   - najpierw bloker sandboksu i kotwicy zaufania;
   - potem dziennik i `workspace.json` poza katalogiem zapisu;
   - kontrakt kodów wyjścia hooków;
   - pełna mapa starych referencji;
   - ścieżka A0.

   Można to zrobić mniejszym workflowem albo ręcznie.
4. Decyzje #1–#14 z sekcji 6.
5. Dopiero potem `/goal` na T0–T1: baza, snapshoty golden i resolver test-first. To zmiany odwracalne, które nie ruszają układu repo.
