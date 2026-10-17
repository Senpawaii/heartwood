import { Link } from "react-router-dom";
import { describeEvent } from "../api/live";
import { useHealth, useLive, useMinistries, useSouls, useTown } from "../api/provider";
import { Async, Badge, Card, Empty, Stat } from "../components/ui";
import { plural, timeAgo } from "../format";

export function Overview() {
  const town = useTown();
  const health = useHealth();
  const ministries = useMinistries();
  const { events } = useLive();
  const souls = useSouls();
  const nameOf = (id: string) => souls.data?.souls.find((s) => s.soulId === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <Async q={town}>
        {(t) => (
          <>
            <h1 className="text-2xl font-semibold">{t.name}</h1>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Souls" value={t.counts.souls} />
              <Stat
                label="Warbands"
                value={t.counts.activeWarbands}
                hint={`${t.counts.warbands} formed in total`}
              />
              <Stat
                label="Waiting on you"
                value={t.counts.openQuestions + t.counts.openEscalations}
                hint={`${plural(t.counts.openQuestions, "question")} · ${plural(t.counts.openEscalations, "escalation")}`}
              />
              <Stat
                label="Magicules"
                value={t.budget ? `${t.budget.tokens.toLocaleString()} tok` : t.magiculesSpent}
                hint={
                  t.budget
                    ? `${t.budget.computeSeconds}s compute (display only)`
                    : "spent naming souls (display only)"
                }
              />
            </div>
          </>
        )}
      </Async>

      <Async q={health}>
        {(h) =>
          h.backend.status !== "ready" && (
            <div
              role="status"
              className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              The worker backend is <strong>{h.backend.status}</strong>
              {h.backend.status === "degraded" && `: ${h.backend.problems.join("; ")}`}. Warbands
              and dispatches are unavailable until it is connected.
            </div>
          )
        }
      </Async>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Ministries">
          <Async q={ministries}>
            {(m) =>
              m.ministries.length === 0 ? (
                <Empty>
                  No ministries yet. Found one on the{" "}
                  <Link className="underline" to="/souls">
                    Souls
                  </Link>{" "}
                  page.
                </Empty>
              ) : (
                <ul className="space-y-2">
                  {m.ministries.map((x) => (
                    <li key={x.ministryId} className="flex items-center justify-between">
                      <span className="font-medium">{x.name}</span>
                      <Badge>{x.kind.replace("_", " & ")}</Badge>
                    </li>
                  ))}
                </ul>
              )
            }
          </Async>
        </Card>

        <Card
          title="Latest events"
          action={
            <Link className="text-xs underline" to="/events">
              all events
            </Link>
          }
        >
          {events.length === 0 ? (
            <Empty>Nothing has happened yet.</Empty>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {events.slice(0, 8).map((e) => (
                <li key={e.seq} className="flex gap-2">
                  <span className="w-16 shrink-0 text-xs text-bark-500">{timeAgo(e.at)}</span>
                  <span className="font-mono text-xs text-bark-700">{e.type}</span>
                  <span className="truncate text-bark-500">{describeEvent(e, nameOf)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
