import { useMemo, useState } from "react";
import { describeEvent } from "../api/live";
import { useLive, useSouls } from "../api/provider";
import { Card, Empty, Input } from "../components/ui";
import { timeAgo } from "../format";

export function EventsPage() {
  const { events, status } = useLive();
  const souls = useSouls();
  const nameOf = (id: string) => souls.data?.souls.find((s) => s.soulId === id)?.name ?? id;
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? events.filter((e) => e.type.includes(f)) : events;
  }, [events, filter]);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Events</h1>
        <span className="text-xs text-bark-500">
          stream: {status}. The event log is the source of truth.
        </span>
        <div className="ml-auto w-56">
          <Input
            aria-label="Filter events"
            placeholder="filter by type, e.g. skill."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <Card>
        {shown.length === 0 ? (
          <Empty>No matching events.</Empty>
        ) : (
          <ul className="divide-y divide-bark-100 font-mono text-xs">
            {shown.map((e) => (
              <li key={e.seq} className="flex gap-3 py-1.5">
                <span className="w-12 shrink-0 text-right text-bark-500">#{e.seq}</span>
                <span className="w-16 shrink-0 font-sans text-bark-500">{timeAgo(e.at)}</span>
                <span className="w-52 shrink-0 text-bark-700">{e.type}</span>
                <span className="min-w-0 break-words font-sans text-bark-900">
                  {describeEvent(e, nameOf)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
