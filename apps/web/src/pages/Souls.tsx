import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useClient, useMinistries, useSouls } from "../api/provider";
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
  Textarea,
} from "../components/ui";
import { species } from "../format";

export function SpeciesBadge({ s }: { s: keyof typeof species }) {
  return <Badge className={species[s].cls}>{species[s].label}</Badge>;
}

function FoundMinistry() {
  const client = useClient();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("construction");
  const m = useMutation({
    mutationFn: () => client.createMinistry({ name, kind }),
    onSuccess: () => {
      setName("");
      void qc.invalidateQueries({ queryKey: ["ministries"] });
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Ministry name">
        <Input value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="Kind (one per species)">
        <Select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="construction">Construction (dwarves)</option>
          <option value="planning">Planning (elves)</option>
          <option value="forest_healing">Forest &amp; Healing (dryads)</option>
        </Select>
      </Field>
      <ErrorNote error={m.error} />
      <Button type="submit" disabled={m.isPending || !name.trim()}>
        Found ministry
      </Button>
    </form>
  );
}

function NameSoul({ ministries }: { ministries: { ministryId: string; name: string }[] }) {
  const client = useClient();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    species: "dwarf",
    ministryId: ministries[0]?.ministryId ?? "",
    persona: "",
    cost: 5,
  });
  const m = useMutation({
    mutationFn: () =>
      client.createSoul({
        name: form.name,
        species: form.species,
        ministryId: form.ministryId,
        persona: form.persona,
        magiculesSpent: form.cost,
      }),
    onSuccess: () => {
      setForm((f) => ({ ...f, name: "", persona: "" }));
      void qc.invalidateQueries({ queryKey: ["souls"] });
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: k === "cost" ? Number(e.target.value) : e.target.value }));
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <p className="text-xs text-bark-500">
        Naming is a deliberate act: it creates the character and spends magicules.
      </p>
      <Field label="Name">
        <Input value={form.name} onChange={set("name")} required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Species">
          <Select value={form.species} onChange={set("species")}>
            <option value="dwarf">Dwarf — coder, smith</option>
            <option value="elf">Elf — architect, planner</option>
            <option value="dryad">Dryad — ops, healing</option>
          </Select>
        </Field>
        <Field label="Ministry">
          <Select value={form.ministryId} onChange={set("ministryId")} required>
            {ministries.map((x) => (
              <option key={x.ministryId} value={x.ministryId}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Persona">
        <Textarea
          rows={3}
          value={form.persona}
          onChange={set("persona")}
          required
          placeholder="How this soul thinks and works"
        />
      </Field>
      <Field label="Magicules spent">
        <Input type="number" min={0} value={form.cost} onChange={set("cost")} />
      </Field>
      <ErrorNote error={m.error} />
      <Button
        type="submit"
        disabled={m.isPending || !form.name.trim() || !form.persona.trim() || !form.ministryId}
      >
        Name soul
      </Button>
    </form>
  );
}

export function Souls() {
  const souls = useSouls();
  const ministries = useMinistries();
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <Card title="Souls">
        <Async q={souls}>
          {(s) =>
            s.souls.length === 0 ? (
              <Empty>No souls have been named yet.</Empty>
            ) : (
              <ul className="divide-y divide-bark-100">
                {s.souls.map((x) => (
                  <li key={x.soulId}>
                    <Link
                      to={`/souls/${x.soulId}`}
                      className="flex items-center gap-3 px-1 py-3 hover:bg-bark-50"
                    >
                      <SpeciesBadge s={x.species} />
                      <span className="font-medium">{x.name}</span>
                      <span className="text-xs text-bark-500">
                        {x.form !== x.species ? x.form : ""}
                      </span>
                      <span className="ml-auto flex items-center gap-2 text-sm text-bark-700">
                        <Badge>{x.rank}</Badge>
                        <span>Lv {x.level}</span>
                        <span className="w-16 text-right text-xs text-bark-500">{x.xp} xp</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
      </Card>
      <div className="space-y-6">
        <Async q={ministries}>
          {(m) =>
            m.ministries.length === 0 ? (
              <Card title="Found a ministry first">
                <FoundMinistry />
              </Card>
            ) : (
              <>
                <Card title="Name a soul">
                  <NameSoul ministries={m.ministries} />
                </Card>
                <Card title="Found another ministry">
                  <FoundMinistry />
                </Card>
              </>
            )
          }
        </Async>
      </div>
    </div>
  );
}
