import type { MemoryItem, SoulSkill } from "@heartwood/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  useClient,
  useMemoryMarkdown,
  useProficiency,
  useSoul,
  useSoulMemory,
} from "../api/provider";
import { SkillUsageTable } from "../components/SkillUsageTable";
import { Sparkline } from "../components/Sparkline";
import {
  Async,
  Badge,
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Stat,
  Table,
  Textarea,
} from "../components/ui";
import { pct, species } from "../format";
import { SpeciesBadge } from "./Souls";

function SkillRow({ soulId, skill }: { soulId: string; skill: SoulSkill }) {
  const series = useProficiency(soulId, skill.name);
  const values = series.data?.series.map((p) => p.score) ?? [];
  return (
    <tr>
      <td className="px-2 py-2 font-medium">{skill.name}</td>
      <td className="px-2 py-2">
        {skill.rank ? (
          <Badge>{skill.rank}</Badge>
        ) : (
          <span className="text-xs text-bark-500">unranked</span>
        )}
      </td>
      <td className="px-2 py-2">{pct(skill.proficiency)}</td>
      <td className="px-2 py-2">
        <Sparkline values={values} label={`${skill.name} proficiency over time`} />
      </td>
      <td className="px-2 py-2 font-mono text-xs text-bark-500" title={skill.digest}>
        {skill.digest.slice(0, 15)}…
      </td>
    </tr>
  );
}

function Absorb({ soulId }: { soulId: string }) {
  const client = useClient();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const m = useMutation({
    mutationFn: () => client.absorb(soulId, name),
    onSuccess: () => {
      setName("");
      void qc.invalidateQueries({ queryKey: ["soul", soulId] });
    },
  });
  return (
    <form
      className="mt-4 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label="Absorb a skill from the Lab (pinned by digest)">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="skill name"
            />
          </Field>
        </div>
        <Button type="submit" disabled={m.isPending || !name.trim()}>
          Absorb
        </Button>
      </div>
      <ErrorNote error={m.error} />
    </form>
  );
}

function MemoryRow({ m, soulId }: { m: MemoryItem; soulId: string }) {
  const client = useClient();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["memory", soulId] });
    void qc.invalidateQueries({ queryKey: ["memory"] });
  };
  const prune = useMutation({
    mutationFn: () => client.pruneMemory(m.memoryId, "pruned from the UI"),
    onSuccess: refresh,
  });
  const promote = useMutation({
    mutationFn: () => client.promoteMemory(m.memoryId),
    onSuccess: refresh,
  });
  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        <Badge>{m.layer}</Badge>
        <span className="text-xs text-bark-500">
          {m.provenance.author} · {m.provenance.source}
        </span>
        {m.layer !== "persona" && (
          <span className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              className="!px-2 !py-0.5 text-xs"
              onClick={() => promote.mutate()}
              disabled={promote.isPending}
            >
              Share to town
            </Button>
            <Button
              variant="ghost"
              className="!px-2 !py-0.5 text-xs"
              onClick={() => prune.mutate()}
              disabled={prune.isPending}
            >
              Prune
            </Button>
          </span>
        )}
      </div>
      <p className="mt-1 text-sm whitespace-pre-wrap">{m.text}</p>
      <ErrorNote error={prune.error ?? promote.error} />
    </li>
  );
}

/** The human-editable Markdown view of this soul's private memory. Delete a block to prune it. */
function MemoryEditor({ soulId }: { soulId: string }) {
  const client = useClient();
  const qc = useQueryClient();
  const md = useMemoryMarkdown(soulId);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    if (md.data !== undefined) setText(md.data);
  }, [md.data]);
  const save = useMutation({
    mutationFn: () => client.saveMemoryMarkdown(soulId, text),
    onSuccess: (r) => {
      setSaved(`${r.edited} edited, ${r.pruned} pruned`);
      void qc.invalidateQueries({ queryKey: ["memory"] });
    },
  });
  return (
    <div className="space-y-2">
      <p className="text-xs text-bark-500">
        Edit the text under a marker to change a memory; delete a whole block to prune it. Leave the
        markers alone.
      </p>
      <Textarea
        aria-label="Memory markdown"
        rows={14}
        className="font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending || md.data === text}>
          Save changes
        </Button>
        {saved && <span className="text-sm text-leaf-700">{saved}</span>}
      </div>
      <ErrorNote error={save.error ?? md.error} />
    </div>
  );
}

export function SoulPage() {
  const { id = "" } = useParams();
  const soul = useSoul(id);
  const memory = useSoulMemory(id);
  const client = useClient();
  const qc = useQueryClient();
  const evolve = useMutation({
    mutationFn: () => client.evolve(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["soul", id] }),
  });
  const [tab, setTab] = useState<"memories" | "markdown">("memories");

  return (
    <Async q={soul}>
      {({ soul: s, skills, skillUsage }) => (
        <div className="space-y-6">
          <header className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{s.name}</h1>
            <SpeciesBadge s={s.species} />
            {s.form !== s.species && <Badge className="bg-heart-500 text-white">{s.form}</Badge>}
            {s.office && <Badge>{s.office}</Badge>}
            {s.titles.map((t) => (
              <Badge key={t} className="bg-amber-100 text-amber-800">
                {t}
              </Badge>
            ))}
            <span className="text-sm text-bark-500">{species[s.species].realm}</span>
            <Button
              variant="ghost"
              className="ml-auto"
              onClick={() => evolve.mutate()}
              disabled={evolve.isPending}
            >
              Evolve
            </Button>
          </header>
          <ErrorNote error={evolve.error} />

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Level" value={s.level} hint={`rank: ${s.rank}`} />
            <Stat label="XP" value={s.xp} />
            <Stat
              label="Status"
              value={s.status}
              hint={s.currentBodyId ? "has a body" : "no body right now"}
            />
            <Stat label="Magicules" value={s.magiculesSpent} hint="spent naming (display only)" />
          </div>

          <Card title="Skills">
            {skills.length === 0 ? (
              <Empty>This soul has not absorbed any skill.</Empty>
            ) : (
              <Table head={["Skill", "Rank", "Proficiency", "Over time", "Pinned digest"]}>
                {skills.map((k) => (
                  <SkillRow key={k.name} soulId={s.soulId} skill={k} />
                ))}
              </Table>
            )}
            <Absorb soulId={s.soulId} />
          </Card>

          <Card title="Skill usage">
            <SkillUsageTable usage={skillUsage} />
          </Card>

          <Card
            title="Stomach (memory)"
            action={
              <div className="flex gap-1 text-xs">
                {(["memories", "markdown"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`rounded px-2 py-1 ${tab === t ? "bg-bark-700 text-bark-50" : "text-bark-700 hover:bg-bark-100"}`}
                  >
                    {t === "memories" ? "Memories" : "Edit as Markdown"}
                  </button>
                ))}
              </div>
            }
          >
            {tab === "markdown" ? (
              <MemoryEditor soulId={s.soulId} />
            ) : (
              <Async q={memory}>
                {(m) =>
                  m.memories.length === 0 ? (
                    <Empty>No memories yet.</Empty>
                  ) : (
                    <ul className="divide-y divide-bark-100">
                      {m.memories.map((x) => (
                        <MemoryRow key={x.memoryId} m={x} soulId={s.soulId} />
                      ))}
                    </ul>
                  )
                }
              </Async>
            )}
          </Card>
        </div>
      )}
    </Async>
  );
}
