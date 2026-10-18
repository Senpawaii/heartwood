import { NavLink, Outlet, Route, Routes } from "react-router-dom";
import { ApiError } from "./api/client";
import { useHealth, useInbox, useLive } from "./api/provider";
import { ErrorNote } from "./components/ui";
import { EventsPage } from "./pages/Events";
import { InboxPage } from "./pages/Inbox";
import { Overview } from "./pages/Overview";
import { SettingsPage } from "./pages/Settings";
import { Skills } from "./pages/Skills";
import { SoulPage } from "./pages/Soul";
import { Souls } from "./pages/Souls";
import { WarbandPage, Warbands } from "./pages/Warbands";

const dot = { live: "bg-leaf-500", connecting: "bg-amber-400", offline: "bg-heart-500" } as const;

function Layout() {
  const health = useHealth();
  const inbox = useInbox();
  const { status } = useLive();
  const waiting = (inbox.data?.questions.length ?? 0) + (inbox.data?.escalations.length ?? 0);
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center justify-between rounded px-3 py-1.5 text-sm ${isActive ? "bg-bark-700 text-bark-50" : "text-bark-700 hover:bg-bark-100"}`;
  const unauthorized = [health.error, inbox.error].find(
    (e) => e instanceof ApiError && e.status === 401,
  );
  const backend = health.data?.backend.status;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-bark-200 bg-bark-100/60 p-4">
        <div className="mb-6">
          <div className="text-lg font-semibold tracking-tight text-bark-800">Heartwood</div>
          <div className="text-xs text-bark-500">the world-tree tower</div>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          <NavLink to="/" end className={link}>
            Overview
          </NavLink>
          <NavLink to="/souls" className={link}>
            Souls
          </NavLink>
          <NavLink to="/warbands" className={link}>
            Warbands
          </NavLink>
          <NavLink to="/skills" className={link}>
            Skills
          </NavLink>
          <NavLink to="/inbox" className={link}>
            <span>Waiting on you</span>
            {waiting > 0 && (
              <span className="rounded-full bg-heart-500 px-1.5 text-xs text-white">{waiting}</span>
            )}
          </NavLink>
          <NavLink to="/events" className={link}>
            Events
          </NavLink>
          <NavLink to="/settings" className={`${link({ isActive: false })} mt-auto`}>
            Settings
          </NavLink>
        </nav>
        <div className="mt-4 space-y-1 text-xs text-bark-500">
          <div className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${dot[status]}`} /> stream {status}
          </div>
          <div>backend: {backend ?? "…"}</div>
          {health.data?.demo && (
            <div className="rounded bg-amber-100 px-1.5 py-1 text-amber-800">
              demo data: nothing here is real
            </div>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-8">
        {unauthorized && (
          <div className="mb-4">
            <ErrorNote
              error={new Error("The daemon requires an access token. Add it under Settings.")}
            />
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="souls" element={<Souls />} />
        <Route path="souls/:id" element={<SoulPage />} />
        <Route path="warbands" element={<Warbands />} />
        <Route path="warbands/:id" element={<WarbandPage />} />
        <Route path="skills" element={<Skills />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<p className="text-bark-500">Nothing here.</p>} />
      </Route>
    </Routes>
  );
}
