// One corpus for every loop denylist gate — the loop-iteration diff gate, trace-bench's mirror of it
// and `loop-setup denylist-check --patch` — so they are held to the same answer (parity). Each patch
// lies under src/, which the path rules leave open: only what it writes (a symlink, a gitlink or a
// mode change) can make it a hit. `hits` lists the paths a gate must escalate for their mode, in
// order; an empty list means the patch must pass. Every patch here is one `git apply` accepts.
const link = (header) => `diff --git a/src/link b/src/link\n${header}\nindex 0000000..3594e94\n--- /dev/null\n+++ b/src/link\n@@ -0,0 +1 @@\n+../kit/loop.md\n\\ No newline at end of file\n`;

export const MODE_PATCHES = [
  { name: "a new symlink (new file mode 120000)", patch: link("new file mode 120000"), hits: ["src/link"] },
  {
    name: "a new gitlink (new file mode 160000)",
    patch: "diff --git a/src/vendor b/src/vendor\nnew file mode 160000\nindex 0000000..1234567\n--- /dev/null\n+++ b/src/vendor\n@@ -0,0 +1 @@\n+Subproject commit 1234567890123456789012345678901234567890\n",
    hits: ["src/vendor"],
  },
  { name: "an executable bit added (a mode change)", patch: "diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n", hits: ["src/a.ts"] },
  { name: "an executable bit removed (a mode change)", patch: "diff --git a/src/run.sh b/src/run.sh\nold mode 100755\nnew mode 100644\n", hits: ["src/run.sh"] },
  {
    name: "a rename that also changes the mode",
    patch: "diff --git a/src/a.ts b/src/b.ts\nold mode 100644\nnew mode 100755\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n",
    hits: ["src/b.ts"],
  },
  {
    name: "a regular file replaced by a symlink (a type change: delete, then create)",
    patch:
      "diff --git a/src/a.ts b/src/a.ts\ndeleted file mode 100644\nindex 7898192..0000000\n--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n" +
      "diff --git a/src/a.ts b/src/a.ts\nnew file mode 120000\nindex 0000000..3594e94\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+../kit/loop.md\n\\ No newline at end of file\n",
    hits: ["src/a.ts"],
  },
  {
    name: "an edit that retargets an existing symlink (its index line names mode 120000)",
    patch: "diff --git a/src/link b/src/link\nindex 1111111..2222222 120000\n--- a/src/link\n+++ b/src/link\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+../kit/loop.md\n\\ No newline at end of file\n",
    hits: ["src/link"],
  },
  { name: "a symlink mode with a leading zero (git reads 0120000 as 120000)", patch: link("new file mode 0120000"), hits: ["src/link"] },
  { name: "a symlink mode after two spaces (git skips the extra space)", patch: link("new file mode  120000"), hits: ["src/link"] },
  { name: "a new symlink in a CRLF patch", patch: link("new file mode 120000").replace(/\n/g, "\r\n"), hits: ["src/link"] },
  { name: "a new regular file", patch: "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\nindex 0000000..7898192\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+a\n", hits: [] },
  { name: "a new executable file (a create, not a mode change)", patch: "diff --git a/src/run.sh b/src/run.sh\nnew file mode 100755\nindex 0000000..7898192\n--- /dev/null\n+++ b/src/run.sh\n@@ -0,0 +1 @@\n+a\n", hits: [] },
  { name: "an edit whose index line names a regular mode", patch: "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n", hits: [] },
  { name: "a deleted symlink", patch: "diff --git a/src/old b/src/old\ndeleted file mode 120000\nindex 3594e94..0000000\n--- a/src/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-../kit/loop.md\n\\ No newline at end of file\n", hits: [] },
  {
    name: "hunk content that spells mode headers",
    patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old mode 100644\n+new file mode 120000\n index 1111111..2222222 160000\n",
    hits: [],
  },
];
