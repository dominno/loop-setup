// The state-repo guard is pure: it decides from facts (the work tree's attribute and module files,
// the state repo's own config entries, the git dir entries that exist) whether a git call may run.
// No fs, git or env here.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ROOT } from "./facts.mjs";
import { ALLOWED_CONFIG, GITDIR_ENTRIES, TEMPLATE_ATTRIBUTES_SHA256, allowedConfigKey, incomingTreeRefusal, stateRepoRefusal } from "./stateguard.mjs";

const template = readFileSync(join(KIT_ROOT, "templates/workspace/.gitattributes"), "utf8");
// What git init + remote add (init) and git clone --single-branch (restore) write.
const cleanConfig = [
  ["core.repositoryformatversion", "0"],
  ["core.filemode", "true"],
  ["core.bare", "false"],
  ["core.logallrefupdates", "true"],
  ["remote.origin.url", "https://example.com/o/r.git"],
  ["remote.origin.fetch", "+refs/heads/claude/loop-state:refs/remotes/origin/claude/loop-state"],
  ["branch.claude/loop-state.remote", "origin"],
  ["branch.claude/loop-state.merge", "refs/heads/claude/loop-state"],
];
const clean = { attributes: [{ path: ".gitattributes", content: template }], gitmodules: [], config: cleanConfig, gitDirEntries: [] };

describe("stateRepoRefusal (pure)", () => {
  it("a work tree with only the kit template's .gitattributes and a config git itself writes passes", () => {
    expect(stateRepoRefusal(clean)).toBe(null);
    // platform keys git init writes on some file systems pass too
    expect(stateRepoRefusal({ ...clean, config: [...cleanConfig, ["core.ignorecase", "true"], ["core.precomposeunicode", "true"], ["core.symlinks", "false"], ["extensions.objectformat", "sha256"]] })).toBe(null);
  });

  it("the current template's digest is a released one (a template edit must add its digest, never drop one)", () => {
    expect(TEMPLATE_ATTRIBUTES_SHA256).toContain(createHash("sha256").update(template).digest("hex"));
  });

  it("refuses a root .gitattributes that is missing or is not a released template, naming it and the fix", () => {
    expect(stateRepoRefusal({ ...clean, attributes: [] })?.cause).toMatch(/^\.gitattributes is missing/);
    const planted = stateRepoRefusal({ ...clean, attributes: [{ path: ".gitattributes", content: `${template}* filter=evil\n` }] });
    expect(planted?.cause).toMatch(/^\.gitattributes differs from the kit template .*templates\/workspace\/\.gitattributes/);
    // One byte is enough: a BOM or CRLF line ends are refused.
    expect(stateRepoRefusal({ ...clean, attributes: [{ path: ".gitattributes", content: `﻿${template}` }] })).not.toBe(null);
    expect(stateRepoRefusal({ ...clean, attributes: [{ path: ".gitattributes", content: template.replace(/\n/g, "\r\n") }] })).not.toBe(null);
  });

  it("refuses any other .gitattributes in the work tree (attributes apply per directory)", () => {
    const r = stateRepoRefusal({ ...clean, attributes: [...clean.attributes, { path: "topics/.gitattributes", content: "* filter=evil\n" }] });
    expect(r?.cause).toMatch(/^topics\/\.gitattributes: /);
  });

  it("refuses any .gitmodules", () => {
    expect(stateRepoRefusal({ ...clean, gitmodules: [".gitmodules"] })?.cause).toMatch(/^\.gitmodules: /);
    expect(stateRepoRefusal({ ...clean, gitmodules: ["trace/.gitmodules"] })?.cause).toMatch(/^trace\/\.gitmodules: /);
  });

  it.each(GITDIR_ENTRIES)("refuses the git dir entry %s (the kit never writes one)", (entry) => {
    expect(stateRepoRefusal({ ...clean, gitDirEntries: [entry] })?.cause).toMatch(new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} in the state git dir`));
  });

  it("the git dir entries cover every file git follows to more config, attributes or objects", () => {
    for (const e of ["commondir", "gitdir", "config.worktree", "info/attributes", "objects/info/alternates", "objects/info/http-alternates", "worktrees", "modules"]) expect(GITDIR_ENTRIES).toContain(e);
  });

  const outside = [
    // the spec's list: filter.*, diff.*.textconv, merge.*.driver, the core hook settings
    ["filter.evil.clean", "sh -c x"],
    ["filter.EVIL.process", "x"], // git keeps the subsection's case; section and key are lowercased
    ["filter.lfs.required", "true"],
    ["diff.evil.textconv", "x"],
    ["merge.union.driver", "x"], // a user-defined driver named like a built-in one wins over it
    ["core.hookspath", "/tmp/h"],
    ["core.fsmonitor", "x"],
    ["core.sshcommand", "x"],
    ["core.gitproxy", "x"],
    ["core.askpass", "x"],
    ["core.editor", "x"],
    ["core.pager", "x"],
    // and every other key that names a command or pulls in more config
    ["diff.external", "x"],
    ["diff.evil.command", "x"],
    ["gpg.program", "x"],
    ["gpg.ssh.program", "x"],
    ["include.path", "/tmp/c"],
    ["includeif.gitdir:/x/.path", "/tmp/c"],
    ["credential.helper", "!x"],
    ["remote.origin.uploadpack", "x"],
    ["remote.origin.receivepack", "x"],
    ["protocol.ext.allow", "always"],
    ["extensions.worktreeconfig", "true"],
    ["core.worktree", "/elsewhere"],
    ["remote.evil.url", "x"],
    ["branch.main.merge", "refs/heads/main"],
  ];
  it.each(outside)("refuses the config key %s (outside the allowlist), naming it", (key, value) => {
    expect(allowedConfigKey(key)).toBe(false);
    expect(stateRepoRefusal({ ...clean, config: [...cleanConfig, [key, value]] })?.cause).toContain(`config sets ${key}`);
  });

  it("the allowlist is exactly what git writes for the state repo", () => {
    for (const [key] of cleanConfig) expect(allowedConfigKey(key), key).toBe(true);
    expect([...ALLOWED_CONFIG].sort()).toEqual(
      [
        "branch.claude/loop-state.merge",
        "branch.claude/loop-state.remote",
        "core.bare",
        "core.filemode",
        "core.ignorecase",
        "core.logallrefupdates",
        "core.precomposeunicode",
        "core.repositoryformatversion",
        "core.symlinks",
        "extensions.objectformat",
        "remote.origin.fetch",
        "remote.origin.url",
      ].sort(),
    );
  });

  it("reports the first refusal in a fixed order: attributes, modules, git dir entries, config", () => {
    const all = { attributes: [], gitmodules: [".gitmodules"], config: [["filter.x.clean", "x"]], gitDirEntries: ["commondir"] };
    expect(stateRepoRefusal(all).cause).toMatch(/^\.gitattributes is missing/);
    expect(stateRepoRefusal({ ...all, attributes: clean.attributes }).cause).toMatch(/^\.gitmodules/);
    expect(stateRepoRefusal({ ...all, attributes: clean.attributes, gitmodules: [] }).cause).toMatch(/^commondir/);
    expect(stateRepoRefusal({ ...all, attributes: clean.attributes, gitmodules: [], gitDirEntries: [] }).cause).toMatch(/config sets filter\.x\.clean/);
  });
});

describe("incomingTreeRefusal (pure): a commit's tree before it reaches the work tree", () => {
  const paths = [".gitattributes", "index.md", "trace/records.jsonl", "workspace.json"];
  it("a tree with only the template .gitattributes passes", () => {
    expect(incomingTreeRefusal({ paths, rootAttributes: template })).toBe(null);
  });
  it("refuses a root .gitattributes that is missing or differs, a nested one, or a .gitmodules", () => {
    expect(incomingTreeRefusal({ paths: paths.slice(1), rootAttributes: null })?.cause).toMatch(/^\.gitattributes is missing/);
    expect(incomingTreeRefusal({ paths, rootAttributes: `${template}* filter=x\n` })?.cause).toMatch(/^\.gitattributes differs/);
    expect(incomingTreeRefusal({ paths: [...paths, "topics/.gitattributes"], rootAttributes: template })?.cause).toMatch(/^topics\/\.gitattributes/);
    expect(incomingTreeRefusal({ paths: [...paths, ".gitmodules"], rootAttributes: template })?.cause).toMatch(/^\.gitmodules/);
  });
});
