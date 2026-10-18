import { eventTypes, type HeartwoodEvent } from "@heartwood/protocol";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { auth } from "../auth";
import { ApiError, type Client, createClient } from "./client";
import { parseLiveEvent, queryKeysFor } from "./live";

const ClientContext = createContext<Client | undefined>(undefined);

export function useClient(): Client {
  const c = useContext(ClientContext);
  if (!c) throw new Error("ClientProvider is missing");
  return c;
}

export type LiveStatus = "connecting" | "live" | "offline";
interface LiveState {
  status: LiveStatus;
  /** Newest first. */
  events: HeartwoodEvent[];
}
const LiveContext = createContext<LiveState>({ status: "offline", events: [] });
export const useLive = () => useContext(LiveContext);

const MAX_EVENTS = 300;
const INVALIDATE_DEBOUNCE_MS = 150;

/** Holds the SSE connection; every event refreshes the queries it affects (debounced). */
function LiveProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const qc = useQueryClient();
  const client = useClient();
  const [state, setState] = useState<LiveState>({ status: "connecting", events: [] });
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    const flush = () => {
      timer.current = undefined;
      for (const key of pending.current) void qc.invalidateQueries({ queryKey: [key] });
      pending.current.clear();
    };

    client
      .recentEvents(100)
      .then((history) => !closed && setState((s) => ({ ...s, events: [...history].reverse() })))
      .catch(() => undefined); // the feed just starts empty; the stream below still works

    const token = auth.get();
    const url = `/api/events/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    es.onopen = () => setState((s) => ({ ...s, status: "live" }));
    // The browser reconnects by itself, resuming from the last event id.
    es.onerror = () =>
      setState((s) => ({
        ...s,
        status: es.readyState === EventSource.CLOSED ? "offline" : "connecting",
      }));
    const handle = (msg: MessageEvent<string>) => {
      const e = parseLiveEvent(msg.data);
      if (!e) return;
      setState((s) => ({ ...s, events: [e, ...s.events].slice(0, MAX_EVENTS) }));
      for (const k of queryKeysFor(e.type)) pending.current.add(k);
      timer.current ??= setTimeout(flush, INVALIDATE_DEBOUNCE_MS);
    };
    // SSE frames carry a named `event:` (the event type), so subscribe to each known type.
    for (const t of eventTypes) es.addEventListener(t, handle as EventListener);
    return () => {
      closed = true;
      es.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [client, qc, enabled]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

/** Wires the daemon client, query cache and live updates. */
export function AppProviders({
  children,
  client,
  live = true,
}: {
  children: ReactNode;
  client?: Client;
  live?: boolean;
}) {
  const qc = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // a 4xx will not change by asking again (e.g. 401 needs a token); only retry server/network failures
            retry: (count, err) => count < 1 && !(err instanceof ApiError && err.status < 500),
            refetchOnWindowFocus: false,
            staleTime: 5_000,
          },
        },
      }),
    [],
  );
  const c = useMemo(() => client ?? createClient({ getToken: auth.get }), [client]);
  return (
    <QueryClientProvider client={qc}>
      <ClientContext.Provider value={c}>
        <LiveProvider enabled={live}>{children}</LiveProvider>
      </ClientContext.Provider>
    </QueryClientProvider>
  );
}

// ---- query hooks -------------------------------------------------------------------------------

export const useHealth = () => {
  const c = useClient();
  return useQuery({ queryKey: ["health"], queryFn: () => c.health(), refetchInterval: 30_000 });
};
export const useTown = () => {
  const c = useClient();
  return useQuery({ queryKey: ["town"], queryFn: () => c.town() });
};
export const useInbox = () => {
  const c = useClient();
  return useQuery({ queryKey: ["inbox"], queryFn: () => c.inbox() });
};
export const useMinistries = () => {
  const c = useClient();
  return useQuery({ queryKey: ["ministries"], queryFn: () => c.ministries() });
};
export const useSouls = () => {
  const c = useClient();
  return useQuery({ queryKey: ["souls"], queryFn: () => c.souls() });
};
export const useSoul = (id: string) => {
  const c = useClient();
  return useQuery({ queryKey: ["soul", id], queryFn: () => c.soul(id) });
};
export const useSoulMemory = (id: string) => {
  const c = useClient();
  return useQuery({ queryKey: ["memory", id], queryFn: () => c.soulMemory(id) });
};
export const useMemoryMarkdown = (id: string) => {
  const c = useClient();
  return useQuery({
    queryKey: ["memory", id, "md"],
    queryFn: () => c.memoryMarkdown(id),
    staleTime: 0,
  });
};
export const useProficiency = (id: string, skill: string) => {
  const c = useClient();
  return useQuery({
    queryKey: ["proficiency", id, skill],
    queryFn: () => c.proficiency(id, skill),
  });
};
export const useSkillCatalog = () => {
  const c = useClient();
  return useQuery({ queryKey: ["skillCatalog"], queryFn: () => c.skillCatalog() });
};
export const useSkillUsage = () => {
  const c = useClient();
  return useQuery({ queryKey: ["skillUsage"], queryFn: () => c.skillUsage() });
};
export const useSkillRanks = () => {
  const c = useClient();
  return useQuery({ queryKey: ["skillRanks"], queryFn: () => c.skillRanks() });
};
export const useWarbands = () => {
  const c = useClient();
  return useQuery({ queryKey: ["warbands"], queryFn: () => c.warbands() });
};
export const useWarband = (id: string) => {
  const c = useClient();
  return useQuery({ queryKey: ["warband", id], queryFn: () => c.warband(id) });
};
