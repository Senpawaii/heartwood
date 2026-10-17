import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useClient, useHealth } from "../api/provider";
import { auth } from "../auth";
import { Async, Badge, Button, Card, ErrorNote, Field, Input } from "../components/ui";

export function SettingsPage() {
  const qc = useQueryClient();
  const client = useClient();
  const health = useHealth();
  const [token, setToken] = useState(auth.get() ?? "");
  const connect = useMutation({
    mutationFn: () => client.connectBackend(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["health"] }),
  });
  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card title="Daemon access">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            auth.set(token.trim() || undefined);
            window.location.reload(); // restart the event stream with the new token
          }}
        >
          <Field label="Access token (HEARTWOOD_TOKEN on the daemon)">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <p className="text-xs text-bark-500">Stored in this browser only.</p>
          <Button type="submit">Save</Button>
        </form>
      </Card>
      <Card title="Worker backend">
        <Async q={health}>
          {(h) => (
            <div className="space-y-3 text-sm">
              <p>
                <Badge
                  className={
                    h.backend.status === "ready"
                      ? "bg-leaf-100 text-leaf-700"
                      : "bg-amber-100 text-amber-800"
                  }
                >
                  {h.backend.status}
                </Badge>{" "}
                {"info" in h.backend &&
                  h.backend.info &&
                  `${h.backend.info.name} ${h.backend.info.version ?? ""}`}
              </p>
              {h.backend.status === "degraded" && (
                <ul className="list-disc pl-5 text-bark-700">
                  {h.backend.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-bark-500">
                Watching {h.watching.length} warband(s) · event log at #{h.lastSeq}
              </p>
              {h.backend.status !== "ready" && (
                <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                  Retry connection
                </Button>
              )}
              <ErrorNote error={connect.error} />
            </div>
          )}
        </Async>
      </Card>
    </div>
  );
}
