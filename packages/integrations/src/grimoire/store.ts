import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedSkill } from "@grimoire/core";
import { loadSkill, type Skill, type SkillListing, type SkillSource } from "@grimoire/core";

const SUITE_FILE = "grimoire.bench.yaml";
const FIXTURES_DIR = "fixtures";
const CURRENT = "CURRENT";

const hex = (digest: string) => digest.replace(/^sha256:/, "");

/**
 * Heartwood's own content-addressed skill store: `root/<name>/<sha256-hex>/` plus a `CURRENT`
 * pointer per skill. A soul's pin is durable here even if the catalog (a directory, a git repo)
 * later changes or loses that content, and a promoted version becomes `current` only through
 * `add(..., { current: true })`. Implements grimoire-lab's `SkillSource`, so it plugs into
 * `resolveSkill` / `loadSkillByDigest` like any other source.
 */
export class SkillStore implements SkillSource {
  readonly id: string;
  /** Content is immutable once stored, so a loaded skill never needs re-hashing. */
  private cache = new Map<string, Skill>();

  constructor(
    readonly root: string,
    id = "heartwood-store",
  ) {
    this.id = id;
  }

  private dirOf(name: string, digest: string) {
    return join(this.root, name, hex(digest));
  }

  private async skillAt(dir: string): Promise<Skill | undefined> {
    const hit = this.cache.get(dir);
    if (hit) return hit;
    try {
      const skill = await loadSkill(dir);
      this.cache.set(dir, skill);
      return skill;
    } catch {
      return undefined; // a partial or foreign directory is not a stored skill
    }
  }

  private async names(): Promise<string[]> {
    try {
      return (await readdir(this.root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** The digest `name` was last promoted to, if any. */
  async currentDigest(name: string): Promise<string | undefined> {
    try {
      return (await readFile(join(this.root, name, CURRENT), "utf8")).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<SkillListing[]> {
    const out: SkillListing[] = [];
    for (const name of await this.names()) {
      const current = await this.currentDigest(name);
      for (const e of await readdir(join(this.root, name), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const skill = await this.skillAt(join(this.root, name, e.name));
        if (!skill) continue;
        out.push({
          name: skill.name,
          description: skill.description,
          version: skill.version,
          digest: skill.digest,
          source: this.id,
          current: current === skill.digest,
        });
      }
    }
    return out;
  }

  async load(digest: string): Promise<LoadedSkill | undefined> {
    for (const name of await this.names()) {
      const skill = await this.skillAt(this.dirOf(name, digest));
      if (skill) return { skill, dispose: async () => {} };
    }
    return undefined;
  }

  /**
   * Copy a skill into the store (no-op if its content is already there). `suiteFrom` is a skill
   * directory whose benchmark suite and fixtures are copied alongside, because a candidate version
   * is staged without them and is benchmarked on the suite of the version it replaces.
   */
  async add(skill: Skill, o: { current: boolean; suiteFrom?: string }): Promise<void> {
    const dest = this.dirOf(skill.name, skill.digest);
    if (!(await this.skillAt(dest))) {
      await rm(dest, { recursive: true, force: true });
      await mkdir(join(this.root, skill.name), { recursive: true });
      await cp(skill.dir, dest, {
        recursive: true,
        filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src),
      });
      const stored = await loadSkill(dest);
      if (stored.digest !== skill.digest) {
        await rm(dest, { recursive: true, force: true });
        throw new Error(`stored copy of ${skill.name} does not match digest ${skill.digest}`);
      }
    }
    if (o.suiteFrom) await this.copySuite(o.suiteFrom, dest);
    if (o.current) await writeFile(join(this.root, skill.name, CURRENT), `${skill.digest}\n`);
  }

  private async copySuite(from: string, dest: string): Promise<void> {
    const suite = join(from, SUITE_FILE);
    const have = await readdir(dest).catch(() => [] as string[]);
    if (!have.includes(SUITE_FILE)) await cp(suite, join(dest, SUITE_FILE)).catch(() => undefined);
    if (!have.includes(FIXTURES_DIR))
      await cp(join(from, FIXTURES_DIR), join(dest, FIXTURES_DIR), { recursive: true }).catch(
        () => undefined,
      );
  }
}
