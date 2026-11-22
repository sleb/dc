import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { checkSkills, claudeSkillsDir, parseFrontmatter, readSkills, skillTable, skillsDir } from "./skills";

// The Agent Skills plumbing AGENTS.md describes, plus the batch-ship contract it now names. Each invariant is asserted
// against the real tree, and the checker itself is proven against planted breakage so a green run means something.
// Prose compliance (does an agent follow the skill?) is proven by the pilot run, not here.

const ROOT = join(import.meta.dir, "..");
const skill = (name: string) => {
  const found = readSkills(ROOT).find((s) => s.name === name);
  if (!found) throw new Error(`no skill ${name}`);
  return found;
};
const codes = (root: string) => checkSkills(root).map((violation) => violation.code).sort();

/** A throwaway root: a skill dir with frontmatter, an AGENTS.md table row and a .claude symlink, all individually breakable. */
function planted(files: { skill?: string; agents?: string; link?: boolean } = {}): string {
  const root = join(mkdtempSync(join(tmpdir(), "dc-skills-")), "repo");
  mkdirSync(join(skillsDir(root), "dc-test"), { recursive: true });
  writeFileSync(join(skillsDir(root), "dc-test", "SKILL.md"), files.skill ?? "---\nname: dc-test\ndescription: a test skill\n---\n\nBody that reads `../dc-test/SKILL.md`.\n");
  mkdirSync(join(claudeSkillsDir(root)), { recursive: true });
  if (files.link !== false) symlinkSync(join(skillsDir(root), "dc-test"), join(claudeSkillsDir(root), "dc-test"), "dir");
  writeFileSync(join(root, "AGENTS.md"), `# Notes\n\n## Skills\n\n${files.agents ?? "| Skill | Use it to |\n|---|---|\n| `dc-test` | prove things |"}\n\n## Conventions\n\n- one step, one PR\n`);
  return root;
}

test("S1 the real tree passes every check", () => {
  expect(checkSkills(ROOT)).toEqual([]);
});

test("S2 host-repo sanity: the checker sees the real skills and their frontmatter", () => {
  const names = readSkills(ROOT).map((s) => s.name);
  expect(names).toContain("dc-plan");
  expect(names).toContain("dc-implement");
  expect(names).toContain("dc-ship");
  expect(skill("dc-ship").description.length).toBeGreaterThan(20);
  expect([...skillTable(ROOT)].sort()).toEqual(names);
});

test("S3 batch shipping is a first-class skill: present, documented, symlinked", () => {
  const names = readSkills(ROOT).map((s) => s.name);
  expect(names).toContain("dc-ship-milestone");
  expect(skillTable(ROOT)).toContain("dc-ship-milestone");
  const link = join(claudeSkillsDir(ROOT), "dc-ship-milestone");
  expect(existsSync(link)).toBe(true);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(checkSkills(ROOT).filter((v) => v.message.includes("dc-ship-milestone"))).toEqual([]);
});

test("S4 AGENTS.md states the batch exception to one step, one PR", () => {
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const conventions = agents.split(/^## Conventions$/m)[1] ?? "";
  expect(conventions).toMatch(/batch\/M<n>/);
  expect(conventions).toMatch(/dc-ship-milestone/);
});

test("S5 a skill with no SKILL.md, no name, or no description is reported", () => {
  const noFile = planted();
  Bun.spawnSync(["rm", join(skillsDir(noFile), "dc-test", "SKILL.md")]);
  expect(codes(noFile)).toContain("SK01");

  expect(codes(planted({ skill: "---\ndescription: d\n---\n" }))).toEqual(["SK02"]);
  expect(codes(planted({ skill: "---\nname: dc-other\ndescription: d\n---\n" }))).toEqual(["SK02"]);
  expect(codes(planted({ skill: "---\nname: dc-test\ndescription:\n---\n" }))).toEqual(["SK03"]);
});

test("S6 a missing or foreign .claude symlink is reported", () => {
  expect(codes(planted({ link: false }))).toEqual(["SYM01"]);
  const wrong = planted();
  Bun.spawnSync(["rm", join(claudeSkillsDir(wrong), "dc-test")]);
  mkdirSync(join(claudeSkillsDir(wrong), "dc-test"));
  expect(codes(wrong)).toEqual(["SYM01"]);
});

test("S7 the AGENTS.md table must list every skill and nothing else", () => {
  expect(codes(planted({ agents: "| Skill | Use it to |\n|---|---|\n| `dc-gone` | nothing |" }))).toEqual(["DOC01", "DOC02"]);
  expect(codes(planted({ agents: "" }))).toEqual(["DOC01"]);
});

test("S8 a relative reference that does not resolve is reported", () => {
  const broken = planted({ skill: "---\nname: dc-test\ndescription: d\n---\n\nRead `../dc-missing/SKILL.md`.\n" });
  expect(checkSkills(broken).map((v) => v.message)).toEqual(["dc-test: ../dc-missing/SKILL.md does not exist"]);
});

test("S9 frontmatter parsing keeps a body and rejects a file without fences", () => {
  expect(parseFrontmatter("no fences") ?? null).toBeNull();
  expect(parseFrontmatter("---\nname: a\ndescription: b: c\n---\nbody\n")).toEqual({ fields: { name: "a", description: "b: c" }, body: "body\n" });
});
