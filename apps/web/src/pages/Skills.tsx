import { useSkillRanks, useSkillUsage } from "../api/provider";
import { SkillUsageTable } from "../components/SkillUsageTable";
import { Async, Badge, Card, Empty, Table } from "../components/ui";

const rankStyle: Record<string, string> = {
  common: "bg-bark-100 text-bark-700",
  extra: "bg-leaf-100 text-leaf-700",
  unique: "bg-amber-100 text-amber-800",
  ultimate: "bg-heart-500 text-white",
};

export function Skills() {
  const usage = useSkillUsage();
  const ranks = useSkillRanks();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Skills</h1>
      <Card title="Town-wide usage">
        <Async q={usage}>{(u) => <SkillUsageTable usage={u.usage} />}</Async>
      </Card>
      <Card title="Ranks from benchmarks">
        <Async q={ranks}>
          {(r) =>
            r.ranks.length === 0 ? (
              <Empty>No skill has been benchmarked yet.</Empty>
            ) : (
              <Table head={["Skill", "Rank", "Score", "Digest", "Thresholds"]}>
                {r.ranks.map((k) => (
                  <tr key={`${k.name}@${k.digest}`}>
                    <td className="px-2 py-2 font-medium">{k.name}</td>
                    <td className="px-2 py-2">
                      <Badge className={rankStyle[k.rank]}>{k.rank}</Badge>
                    </td>
                    <td className="px-2 py-2">{k.score.toFixed(2)}</td>
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
