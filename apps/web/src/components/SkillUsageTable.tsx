import type { SkillUsageStat } from "@heartwood/protocol";
import { pct } from "../format";
import { Badge, Empty, Table } from "./ui";

/**
 * Usage is "injected and settled": the skill was in the task spec and the task finished. That can
 * overcount skills that were injected but never used, so the unverified share is labelled.
 */
export function SkillUsageTable({ usage }: { usage: SkillUsageStat[] }) {
  if (usage.length === 0) return <Empty>No skill has been used yet.</Empty>;
  return (
    <Table head={["Skill", "Uses", "Success rate", "Failed", "Unknown", "Evidence"]}>
      {usage.map((u) => (
        <tr key={u.skill}>
          <td className="px-2 py-2 font-medium">{u.skill}</td>
          <td className="px-2 py-2">{u.uses}</td>
          <td className="px-2 py-2">
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-20 overflow-hidden rounded bg-bark-100" aria-hidden>
                <div
                  className="h-full bg-leaf-500"
                  style={{ width: `${Math.round((u.successRate ?? 0) * 100)}%` }}
                />
              </div>
              <span>{pct(u.successRate)}</span>
            </div>
          </td>
          <td className="px-2 py-2">{u.failed}</td>
          <td className="px-2 py-2">{u.unknown}</td>
          <td className="px-2 py-2">
            {u.injectedOnly > 0 ? (
              <Badge
                className="bg-amber-100 text-amber-800"
                title="Counted because the skill was injected into the task and the task settled; not verified from the transcript."
              >
                {u.injectedOnly === u.uses
                  ? "injected, not verified"
                  : `${u.injectedOnly} of ${u.uses} injected, not verified`}
              </Badge>
            ) : (
              <Badge className="bg-leaf-100 text-leaf-700">verified</Badge>
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}
