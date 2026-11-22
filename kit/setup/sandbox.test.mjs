// L3 requires the sandbox: the pure posture decision (kit/setup/sandbox.mjs) over every case, the
// settings adapter (kit/setup/settings.mjs) on real files, and `loop-setup doctor`'s report.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxPosture, withSandbox } from "./sandbox.mjs";
import { readSettingsFile, settingsSources } from "./settings.mjs";
import { doctor } from "./commands.mjs";

const ON_HELD = { sandbox: { enabled: true, allowUnsandboxedCommands: false } };
/** The four settings scopes in Claude Code's precedence order (managed > local > project > user). */
const sources = ({ managed = null, local = null, project = null, user = null } = {}) => [
  { scope: "managed", path: "/etc/claude-code/managed-settings.json", settings: managed },
  { scope: "local", path: "/p/.claude/settings.local.json", settings: local },
  { scope: "project", path: "/p/.claude/settings.json", settings: project },
  { scope: "user", path: "/h/.claude/settings.json", settings: user },
];
const OFF = /^the sandbox is off/;
const NOT_HELD = /^sandbox\.allowUnsandboxedCommands is not held false at user scope/;

describe("sandboxPosture — L3 needs the sandbox on and the unsandboxed fallback held closed at user scope", () => {
  it("met: sandbox on and allowUnsandboxedCommands false in the user settings", () => {
    expect(sandboxPosture(sources({ user: ON_HELD }))).toEqual({ ok: true, enabled: true, enabledBy: "user", heldBy: "user", problems: [] });
  });

  it("met: managed policy holds the fallback closed; the sandbox may be switched on at any scope (effective value)", () => {
    expect(sandboxPosture(sources({ managed: { sandbox: { allowUnsandboxedCommands: false } }, project: { sandbox: { enabled: true } } }))).toEqual({ ok: true, enabled: true, enabledBy: "project", heldBy: "managed", problems: [] });
  });

  it("met: a project cannot reopen a fallback the user settings hold closed", () => {
    expect(sandboxPosture(sources({ user: ON_HELD, project: { sandbox: { allowUnsandboxedCommands: true } } }))).toMatchObject({ ok: true, heldBy: "user" });
  });

  it.each([
    ["no setting in any scope (the sandbox is off by default)", {}, /not set in any settings scope/],
    ["sandbox.enabled false in the user settings", { user: { sandbox: { enabled: false, allowUnsandboxedCommands: false } } }, /false \(user: \/h\/\.claude\/settings\.json\)/],
    ["the project settings switch it off over the user's on (project overrides user)", { user: ON_HELD, project: { sandbox: { enabled: false } } }, /false \(project: /],
    ["the local project settings switch it off", { user: ON_HELD, local: { sandbox: { enabled: false } } }, /false \(local: /],
    ["managed policy switches it off", { user: ON_HELD, managed: { sandbox: { enabled: false } } }, /false \(managed: /],
    ["a non-boolean value", { user: { sandbox: { enabled: "yes", allowUnsandboxedCommands: false } } }, /not set in any settings scope/],
  ])("not met — the sandbox is off: %s", (_what, over, re) => {
    const p = sandboxPosture(sources(over));
    expect(p.ok).toBe(false);
    expect(p.enabled).toBe(false);
    const off = p.problems.filter((x) => OFF.test(x));
    expect(off).toHaveLength(1);
    expect(off[0]).toMatch(re);
  });

  it.each([
    ["allowUnsandboxedCommands not set (Claude Code allows the fallback by default)", { user: { sandbox: { enabled: true } } }],
    ["allowUnsandboxedCommands true in the user settings", { user: { sandbox: { enabled: true, allowUnsandboxedCommands: true } } }],
    ["false only in the project settings (a repository can flip it back)", { user: { sandbox: { enabled: true } }, project: { sandbox: { allowUnsandboxedCommands: false } } }],
    ["false only in the local project settings", { user: { sandbox: { enabled: true } }, local: { sandbox: { allowUnsandboxedCommands: false } } }],
  ])("not met — the fallback is not held closed: %s", (_what, over) => {
    const p = sandboxPosture(sources(over));
    expect(p).toMatchObject({ ok: false, enabled: true, heldBy: null });
    expect(p.problems).toEqual([expect.stringMatching(NOT_HELD)]);
  });

  it("names both conditions at once when neither holds", () => {
    expect(sandboxPosture(sources()).problems).toEqual([expect.stringMatching(OFF), expect.stringMatching(NOT_HELD)]);
  });

  it("fails closed on a settings file that does not parse, naming it", () => {
    const p = sandboxPosture(sources({ user: { error: "Unexpected token }" }, project: { sandbox: { enabled: true } }, managed: { sandbox: { allowUnsandboxedCommands: false } } }));
    expect(p.ok).toBe(false);
    expect(p.problems).toEqual(["/h/.claude/settings.json does not parse (Unexpected token }) — the sandbox posture cannot be read"]);
  });
});

describe("withSandbox — the L3 verdict is the bench verdict AND the sandbox posture", () => {
  const met = { ok: true, unmet: [], record_id: "TR-000000000000" };
  const on = sandboxPosture(sources({ user: ON_HELD }));
  const off = sandboxPosture(sources());
  it("keeps a met bench verdict met only when the sandbox holds, appending the sandbox problems after the bench's", () => {
    expect(withSandbox(met, on)).toEqual({ ...met, sandbox: on });
    expect(withSandbox(met, off)).toEqual({ ...met, ok: false, unmet: off.problems, sandbox: off });
    expect(withSandbox({ ...met, ok: false, unmet: ["bench"] }, off)).toMatchObject({ ok: false, unmet: ["bench", ...off.problems] });
    expect(withSandbox({ ...met, ok: false, unmet: ["bench"] }, on)).toMatchObject({ ok: false, unmet: ["bench"] });
  });
});

describe("the settings adapter and doctor, on real files", () => {
  let T;
  const write = (p, text) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  };
  beforeAll(() => {
    T = realpathSync(mkdtempSync(join(tmpdir(), "ls-sandbox-")));
  });
  afterAll(() => rmSync(T, { recursive: true, force: true }));

  it("readSettingsFile: null when absent, the object when it parses, { error } when it does not", () => {
    write(join(T, "ok.json"), JSON.stringify(ON_HELD));
    write(join(T, "bad.json"), "{ // comment\n}");
    expect(readSettingsFile(join(T, "missing.json"))).toBe(null);
    expect(readSettingsFile(join(T, "ok.json"))).toEqual(ON_HELD);
    expect(readSettingsFile(join(T, "bad.json"))).toEqual({ error: expect.any(String) });
    // Fail closed: only a missing file is absent. A path that cannot be read (here a directory: EISDIR)
    // and JSON that is not an object carry no readable policy, so they are errors, never "no settings".
    mkdirSync(join(T, "dir.json"));
    expect(readSettingsFile(join(T, "dir.json"))).toEqual({ error: expect.stringMatching(/cannot be read/) });
    for (const text of ["null", "[]", '"x"', "42"]) {
      write(join(T, "scalar.json"), text);
      expect(readSettingsFile(join(T, "scalar.json")), text).toEqual({ error: expect.stringMatching(/not a JSON object/) });
    }
  });

  it("settingsSources reads every scope in precedence order: managed drop-ins (last name first), managed-settings.json, local, project, user", () => {
    const home = join(T, "h1", ".claude");
    const proj = join(T, "p1");
    const managed = join(T, "m1");
    write(join(home, "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
    write(join(proj, ".claude/settings.json"), JSON.stringify({ model: "x" }));
    write(join(proj, ".claude/settings.local.json"), "not json");
    write(join(managed, "managed-settings.json"), JSON.stringify({ sandbox: { allowUnsandboxedCommands: false } }));
    write(join(managed, "managed-settings.d/10-a.json"), JSON.stringify({ a: 1 }));
    write(join(managed, "managed-settings.d/20-b.json"), JSON.stringify({ b: 1 }));
    write(join(managed, "managed-settings.d/notes.txt"), "ignored");
    const got = settingsSources({ claudeHome: home, projectRoot: proj, managedDir: managed });
    expect(got.map((s) => [s.scope, s.path])).toEqual([
      ["managed", join(managed, "managed-settings.d/20-b.json")],
      ["managed", join(managed, "managed-settings.d/10-a.json")],
      ["managed", join(managed, "managed-settings.json")],
      ["local", join(proj, ".claude/settings.local.json")],
      ["project", join(proj, ".claude/settings.json")],
      ["user", join(home, "settings.json")],
    ]);
    expect(got.find((s) => s.scope === "local").settings).toEqual({ error: expect.any(String) });
    expect(got.at(-1).settings).toEqual({ sandbox: { enabled: true } });
    // No project, no managed directory: only the user scope (and absent files are null).
    expect(settingsSources({ claudeHome: join(T, "nohome"), projectRoot: null, managedDir: join(T, "nomanaged") })).toEqual([{ scope: "user", path: join(T, "nohome", "settings.json"), settings: null }]);
  });

  it("doctor reports the sandbox state: ok when L3's sandbox posture holds, a warning naming why otherwise", () => {
    const proj = join(T, "p2");
    mkdirSync(proj, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: proj });
    const check = (settings) => {
      const home = join(T, `h-${Math.random().toString(16).slice(2)}`, ".claude");
      if (settings) write(join(home, "settings.json"), JSON.stringify(settings));
      const env = { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: join(home, "..") };
      delete env.LOOP_SETUP_WORKSPACE;
      return doctor({ cwd: proj, env }).find((c) => c.check === "sandbox (L3 requires it)");
    };
    expect(check(ON_HELD)).toMatchObject({ ok: true, level: "ok", detail: expect.stringMatching(/^on \(user\); unsandboxed fallback held closed \(user\)$/) });
    const off = check(null);
    expect(off).toMatchObject({ ok: true, level: "warn" });
    expect(off.detail).toMatch(/the sandbox is off/);
    expect(off.detail).toMatch(/L3 is unavailable; sandbox-off L2 has no local tamper resistance/);
  });
});
