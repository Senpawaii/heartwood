import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useClient, useSouls, useWarband, useWarbands } from "../api/provider";
import {
  Async,
  Badge,
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Select,
  Table,
  Textarea,
} from "../components/ui";

const stateStyle: Record<string, string> = {
  created: "bg-bark-100 text-bark-700",
  running: "bg-amber-100 text-amber-800",
  settled: "bg-leaf-100 text-leaf-700",
};

function FormWarband() {
  const client = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const souls = useSouls();
  const [objective, setObjective] = useState("");
  const [foreman, setForeman] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const m = useMutation({
    mutationFn: () =>
      client.formWarband({ objective, foremanSoulId: foreman, memberSoulIds: members }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["warbands"] });
      navigate("/warbands");
      setObjective("");
      setMembers([]);
    },
  });
  return (
    <Async q={souls}>
      {({ souls: all }) =>
        all.length === 0 ? (
          <Empty>Name some souls before forming a warband.</Empty>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate();
            }}
          >
            <Field label="Objective">
              <Textarea
                rows={2}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                required
              />
            </Field>
            <Field label="Foreman (a member soul holds the role; the daemon makes the decisions)">
              <Select value={foreman} onChange={(e) => setForeman(e.target.value)} required>
                <option value="">Choose…</option>
                {all.map((s) => (
                  <option key={s.soulId} value={s.soulId}>
                    {s.name} (Lv {s.level})
                  </option>
                ))}
              </Select>
            </Field>
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-bark-700">Members</legend>
              <div className="flex flex-wrap gap-3">
                {all
                  .filter((s) => s.soulId !== foreman)
                  .map((s) => (
                    <label key={s.soulId} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={members.includes(s.soulId)}
                        onChange={(e) =>
                          setMembers((cur) =>
                            e.target.checked
                              ? [...cur, s.soulId]
                              : cur.filter((x) => x !== s.soulId),
                          )
                        }
                      />
                      {s.name}
                    </label>
                  ))}
              </div>
            </fieldset>
            <ErrorNote error={m.error} />
            <Button type="submit" disabled={m.isPending || !objective.trim() || !foreman}>
              Form warband
            </Button>
          </form>
        )
      }
    </Async>
  );
}

export function Warbands() {
  const warbands = useWarbands();
  const souls = useSouls();
  const name = (id: string) => souls.data?.souls.find((s) => s.soulId === id)?.name ?? id;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <Card title="Warbands">
        <Async q={warbands}>
          {(w) =>
            w.warbands.length === 0 ? (
              <Empty>
                No warband has been formed. A warband is one team, one Orca Run, assembled per
                project.
              </Empty>
            ) : (
              <ul className="divide-y divide-bark-100">
                {[...w.warbands].reverse().map((x) => (
                  <li key={x.warbandId}>
                    <Link
                      to={`/warbands/${x.warbandId}`}
                      className="block px-1 py-3 hover:bg-bark-50"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{x.objective}</span>
                        <Badge
                          className={
                            x.status === "active" ? "bg-leaf-100 text-leaf-700" : undefined
                          }
                        >
                          {x.status}
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-bark-500">
                        foreman {name(x.foremanSoulId)} · {x.members.length} members
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
      </Card>
      <Card title="Form a warband">
        <FormWarband />
      </Card>
    </div>
  );
}

function Dispatch({
  warbandId,
  members,
}: {
  warbandId: string;
  members: { soulId: string; name: string }[];
}) {
  const client = useClient();
  const qc = useQueryClient();
  const [f, setF] = useState({
    soulId: members[0]?.soulId ?? "",
    target: "",
    change: "",
    constraints: "",
    ownership: "",
    acceptance: "",
    agent: "",
    model: "",
    placement: "new-child",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () =>
      client.dispatch(warbandId, {
        soulId: f.soulId,
        brief: {
          target: f.target,
          change: f.change,
          constraints: f.constraints,
          ownership: f.ownership,
          acceptance: f.acceptance,
        },
        agent: f.agent.trim() || undefined,
        model: f.model || undefined,
        placement: f.placement,
      }),
    onSuccess: () => {
      setF((cur) => ({
        ...cur,
        target: "",
        change: "",
        constraints: "",
        ownership: "",
        acceptance: "",
      }));
      void qc.invalidateQueries({ queryKey: ["warband", warbandId] });
    },
  });
  const complete = f.soulId && f.target && f.change && f.constraints && f.ownership && f.acceptance;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <p className="text-xs text-bark-500">
        A body is created fresh for each dispatch. The soul's persona, relevant memories and skills
        are injected into the spec.
      </p>
      <Field label="Soul">
        <Select value={f.soulId} onChange={set("soulId")}>
          {members.map((x) => (
            <option key={x.soulId} value={x.soulId}>
              {x.name}
            </option>
          ))}
        </Select>
      </Field>
      {(["target", "change", "constraints", "ownership", "acceptance"] as const).map((k) => (
        <Field key={k} label={`${k[0]?.toUpperCase()}${k.slice(1)}`}>
          <Textarea rows={2} value={f[k]} onChange={set(k)} />
        </Field>
      ))}
      <div className="grid grid-cols-3 gap-3">
        <Field label="Agent (blank: daemon default, omp)">
          <Input value={f.agent} onChange={set("agent")} placeholder="omp" />
        </Field>
        <Field label="Model (leave blank for omp)">
          <Input value={f.model} onChange={set("model")} placeholder="omp's own model" />
        </Field>
        <Field label="Placement">
          <Input value={f.placement} onChange={set("placement")} />
        </Field>
      </div>
      <ErrorNote error={m.error} />
      <Button type="submit" disabled={m.isPending || !complete}>
        Dispatch
      </Button>
    </form>
  );
}

export function WarbandPage() {
  const { id = "" } = useParams();
  const wb = useWarband(id);
  const souls = useSouls();
  const client = useClient();
  const qc = useQueryClient();
  const disband = useMutation({
    mutationFn: () => client.disband(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["warband", id] }),
  });
  const name = (sid: string) => souls.data?.souls.find((s) => s.soulId === sid)?.name ?? sid;

  return (
    <Async q={wb}>
      {({ warband, dispatches }) => {
        const active = warband.status === "active";
        const unsettled = dispatches.filter((d) => d.state !== "settled").length;
        return (
          <div className="space-y-6">
            <header className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold">{warband.objective}</h1>
              <Badge className={active ? "bg-leaf-100 text-leaf-700" : undefined}>
                {warband.status}
              </Badge>
              {active && (
                <Button
                  variant="danger"
                  className="ml-auto"
                  onClick={() => disband.mutate()}
                  disabled={disband.isPending || unsettled > 0}
                  title={unsettled > 0 ? `${unsettled} dispatch(es) still unsettled` : undefined}
                >
                  Disband
                </Button>
              )}
            </header>
            <ErrorNote error={disband.error} />
            <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
              <div className="space-y-6">
                <Card title="Members">
                  <ul className="flex flex-wrap gap-2">
                    {warband.members.map((m) => (
                      <li key={m.soulId}>
                        <Link
                          to={`/souls/${m.soulId}`}
                          className="rounded border border-bark-200 px-2 py-1 text-sm hover:bg-bark-50"
                        >
                          {name(m.soulId)}{" "}
                          {m.role === "foreman" && (
                            <Badge className="ml-1 bg-bark-700 text-bark-50">foreman</Badge>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
                <Card title="Dispatches">
                  {dispatches.length === 0 ? (
                    <Empty>Nothing has been dispatched yet.</Empty>
                  ) : (
                    <Table head={["Dispatch", "Soul", "State", "Outcome"]}>
                      {dispatches.map((d) => (
                        <tr key={d.dispatchId}>
                          <td className="px-2 py-2 font-mono text-xs">{d.dispatchId.slice(-8)}</td>
                          <td className="px-2 py-2">{name(d.soulId)}</td>
                          <td className="px-2 py-2">
                            <Badge className={stateStyle[d.state]}>{d.state}</Badge>
                          </td>
                          <td className="px-2 py-2">{d.outcome ?? "—"}</td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </Card>
              </div>
              {active && (
                <Card title="Dispatch a task">
                  <Dispatch
                    warbandId={warband.warbandId}
                    members={warband.members.map((m) => ({
                      soulId: m.soulId,
                      name: name(m.soulId),
                    }))}
                  />
                </Card>
              )}
            </div>
          </div>
        );
      }}
    </Async>
  );
}
