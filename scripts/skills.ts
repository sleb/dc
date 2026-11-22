import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

// The Agent Skills layout AGENTS.md describes: every skill is a directory under .agents/skills with a SKILL.md whose
// frontmatter `name` is the directory name, `.claude/skills/<name>` is a symlink to it, and AGENTS.md's table lists
// exactly the same set. A skill that no agent can find is silently useless, which is the kind of rot this guards.
// What a skill's prose makes an agent do is proven by running it on a step, never here.

export interface Skill {
  name: string;
  dir: string;
  description: string;
  body: string;
}

export interface Violation {
  /** Stable code so the test can assert the reason, not the wording. */
  code: "SK01" | "SK02" | "SK03" | "SYM01" | "DOC01" | "DOC02" | "REF01";
  message: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

export const skillsDir = (root: string): string => join(root, ".agents", "skills");
export const claudeSkillsDir = (root: string): string => join(root, ".claude", "skills");

/** Parse the small YAML subset the skills use: single-line `key: value` pairs between `---` fences. */
export function parseFrontmatter(source: string): { fields: Record<string, string>; body: string } | null {
  const match = FRONTMATTER.exec(source);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    const key = pair?.[1];
    if (key !== undefined) fields[key] = (pair?.[2] ?? "").trim();
  }
  return { fields, body: source.slice((match[0] ?? "").length) };
}

export function readSkills(root: string): Skill[] {
  const dir = skillsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const path = join(dir, name, "SKILL.md");
      const source = existsSync(path) ? readFileSync(path, "utf8") : "";
      const parsed = parseFrontmatter(source);
      return { name, dir: join(dir, name), description: parsed?.fields["description"] ?? "", body: parsed?.body ?? source };
    });
}

/** The skill names AGENTS.md's "## Skills" table lists, in order. */
export function skillTable(root: string): string[] {
  const agents = join(root, "AGENTS.md");
  if (!existsSync(agents)) return [];
  const section = readFileSync(agents, "utf8").split(/^## Skills$/m)[1]?.split(/^## /m)[0] ?? "";
  return matchAll(section, /^\|\s*`([^`]+)`\s*\|/gm);
}

/** Skill names referenced by a relative path (`../<skill>/...`) in a skill's body. */
export function relativeReferences(body: string): string[] {
  return matchAll(body, /`(\.\.\/[^`\s]+)`/g);
}

/** First capture of every match, with the holes dropped so the result is `string[]` under noUncheckedIndexedAccess. */
function matchAll(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

export function checkSkills(root: string): Violation[] {
  const violations: Violation[] = [];
  const skills = readSkills(root);
  const names = skills.map((skill) => skill.name);

  for (const skill of skills) {
    const path = join(skill.dir, "SKILL.md");
    if (!existsSync(path)) {
      violations.push({ code: "SK01", message: `${skill.name}: no SKILL.md` });
      continue;
    }
    const parsed = parseFrontmatter(readFileSync(path, "utf8"));
    if (!parsed) violations.push({ code: "SK02", message: `${skill.name}: SKILL.md has no frontmatter` });
    else if (parsed.fields["name"] !== skill.name) {
      violations.push({ code: "SK02", message: `${skill.name}: frontmatter name is ${JSON.stringify(parsed.fields["name"] ?? null)}` });
    }
    if (!skill.description) violations.push({ code: "SK03", message: `${skill.name}: frontmatter description is empty` });

    const link = join(claudeSkillsDir(root), skill.name);
    const linked = linkStat(link);
    if (linked === null) {
      violations.push({ code: "SYM01", message: `${skill.name}: .claude/skills/${skill.name} is missing` });
    } else if (!linked) {
      violations.push({ code: "SYM01", message: `${skill.name}: .claude/skills/${skill.name} is not a symlink` });
    } else if (realpathSync(link) !== realpathSync(skill.dir)) {
      violations.push({ code: "SYM01", message: `${skill.name}: .claude/skills/${skill.name} does not resolve to ${skill.dir}` });
    }

    for (const reference of relativeReferences(skill.body)) {
      if (!existsSync(join(skill.dir, reference))) {
        violations.push({ code: "REF01", message: `${skill.name}: ${reference} does not exist` });
      }
    }
  }

  const table = skillTable(root);
  for (const name of names) {
    if (!table.includes(name)) violations.push({ code: "DOC01", message: `AGENTS.md skills table is missing ${name}` });
  }
  for (const listed of table) {
    if (!names.includes(listed)) violations.push({ code: "DOC02", message: `AGENTS.md skills table names ${listed}, which is not a skill` });
  }
  if (new Set(table).size !== table.length) violations.push({ code: "DOC02", message: "AGENTS.md skills table repeats a skill" });

  return violations;
}

/** `null` when nothing is there, `true` when the entry is a symlink, `false` when it is something else. */
const linkStat = (path: string): boolean | null => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return null;
  }
};
