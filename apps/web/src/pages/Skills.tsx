import type { SkillRef } from "@heartwood/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useClient, useSkillCatalog, useSkillRanks, useSkillUsage } from "../api/provider";
import { ModelPicker, selectorOf, usePersistedChoice } from "../components/ModelPicker";
import { SkillUsageTable } from "../components/SkillUsageTable";
import { Async, Badge, Button, Card, Empty, ErrorNote, Table } from "../components/ui";
import { describeAnalysis, describeEvolution } from "../format";

const rankStyle: Record<string, string> = {
  common: "bg-bark-100 text-bark-700",
  extra: "bg-leaf-100 text-leaf-700",
  unique: "bg-amber-100 text-amber-800",
  ultimate: "bg-heart-500 text-white",
};

/** One catalog skill with its benchmark actions. Both take minutes with a real agent, so each shows progress and keeps its result. */
function CatalogRow({
  skill,
  model,
  rewriterModel,
}: {
  skill: SkillRef;
  /** What to measure with and what writes the new version; unset means the server's settings. */
  model?: string;
  rewriterModel?: string;
}) {
  const c = useClient();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["skillRanks"] });
  const analyze = useMutation({
    mutationFn: () => c.analyzeSkill(skill.name, skill.digest, { model }),
    onSuccess: refresh,
  });
  const evolve = useMutation({
    mutationFn: () => c.evolveSkill(skill.name, skill.digest, { model, rewriterModel }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["skillCatalog"] }).then(refresh),
  });
  const busy = analyze.isPending || evolve.isPending;
  return (
    <tr>
      <td className="px-2 py-2 align-top">
        <div className="font-medium">{skill.name}</div>
        <div className="max-w-md text-xs text-bark-500">{skill.description}</div>
      </td>
      <td className="px-2 py-2 align-top">{skill.version ?? "—"}</td>
      <td className="px-2 py-2 align-top font-mono text-xs text-bark-500" title={skill.digest}>
        {skill.digest.slice(0, 15)}…
      </td>
      <td
        className="max-w-48 truncate px-2 py-2 align-top text-xs text-bark-500"
        title={skill.source}
      >
        {skill.source}
      </td>
      <td className="space-y-2 px-2 py-2 align-top">
        <div className="flex gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => analyze.mutate()}>
            {analyze.isPending ? "Benchmarking…" : "Analyze"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => evolve.mutate()}>
            {evolve.isPending ? "Evolving…" : "Evolve"}
          </Button>
        </div>
        {analyze.data && !busy && (
          <p className="text-xs text-bark-700">{describeAnalysis(analyze.data)}</p>
        )}
        {evolve.data && !busy && (
          <p className="text-xs text-bark-700">{describeEvolution(evolve.data)}</p>
        )}
        <ErrorNote error={analyze.error ?? evolve.error} />
      </td>
    </tr>
  );
}

export function Skills() {
  const catalog = useSkillCatalog();
  const [measure, setMeasure] = usePersistedChoice("measure");
  const [rewrite, setRewrite] = usePersistedChoice("rewrite");
  const measureWith = selectorOf(measure);
  const rewriteWith = selectorOf(rewrite);
  const usage = useSkillUsage();
  const ranks = useSkillRanks();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Skills</h1>
      <Card title="Catalog">
        <Async q={catalog}>
          {(k) => (
            <div className="space-y-3">
              <div className="grid gap-4 sm:grid-cols-2">
                <ModelPicker
                  label="Measure with"
                  hint="The model a skill is tested with. A rank is a fact about skill and model together."
                  value={measure}
                  onChange={setMeasure}
                />
                <ModelPicker
                  label="Rewrite with (Evolve)"
                  hint="The model that writes the new version. Independent of the one it is measured with."
                  value={rewrite}
                  onChange={setRewrite}
                />
              </div>
              {k.problems.map((p) => (
                <p
                  key={p.source}
                  role="alert"
                  className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                >
                  Source {p.source} is unavailable ({p.message}); its skills are not listed.
                </p>
              ))}
              {k.skills.length === 0 ? (
                <Empty>No skills in the catalog.</Empty>
              ) : (
                <Table head={["Skill", "Version", "Digest", "Source", "Benchmark"]}>
                  {/* keyed by name: a promotion changes the digest, and the row must keep showing its result */}
                  {k.skills.map((sk) => (
                    <CatalogRow
                      key={sk.name}
                      skill={sk}
                      model={measureWith}
                      rewriterModel={rewriteWith}
                    />
                  ))}
                </Table>
              )}
            </div>
          )}
        </Async>
      </Card>
      <Card title="Town-wide usage">
        <Async q={usage}>{(u) => <SkillUsageTable usage={u.usage} />}</Async>
      </Card>
      <Card title="Ranks from benchmarks">
        <Async q={ranks}>
          {(r) =>
            r.ranks.length === 0 ? (
              <Empty>No skill has been benchmarked yet.</Empty>
            ) : (
              <Table head={["Skill", "Rank", "Score", "Measured with", "Digest", "Thresholds"]}>
                {r.ranks.map((k) => (
                  <tr key={`${k.name}@${k.digest}|${k.suiteDigest}|${k.agent}`}>
                    <td className="px-2 py-2 font-medium">{k.name}</td>
                    <td className="px-2 py-2">
                      <Badge className={rankStyle[k.rank]}>{k.rank}</Badge>
                    </td>
                    <td className="px-2 py-2">{k.score.toFixed(2)}</td>
                    <td
                      className="px-2 py-2 text-xs text-bark-700"
                      title={
                        k.suiteDigest
                          ? `suite ${k.suiteDigest}`
                          : "recorded before suites were tracked"
                      }
                    >
                      <div>{k.agent || "unknown"}</div>
                      {/* the same skill under another suite is another measurement; say which */}
                      <div className="text-bark-500">
                        {k.suiteDigest
                          ? `suite ${k.suiteDigest.slice(7, 15)}`
                          : "suite not recorded"}
                      </div>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs text-bark-500" title={k.digest}>
                      {k.digest.slice(0, 15)}…
                    </td>
                    <td className="px-2 py-2 text-xs text-bark-500">{k.thresholdsVersion}</td>
                  </tr>
                ))}
              </Table>
            )
          }
        </Async>
      </Card>
    </div>
  );
}
