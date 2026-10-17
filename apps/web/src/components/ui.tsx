import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { ApiError } from "../api/client";

export function Card({
  title,
  action,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-bark-200 bg-white shadow-sm">
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-bark-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold tracking-wide text-bark-700 uppercase">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-bark-200 bg-white px-4 py-3">
      <div className="text-xs tracking-wide text-bark-500 uppercase">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-bark-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-bark-500">{hint}</div>}
    </div>
  );
}

export function Badge({
  children,
  className = "bg-bark-100 text-bark-700",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-bark-700 text-bark-50 hover:bg-bark-800",
    ghost: "border border-bark-300 text-bark-700 hover:bg-bark-100",
    danger: "bg-heart-500 text-white hover:opacity-90",
  }[variant];
  return (
    <button
      type="button"
      {...p}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

const field =
  "w-full rounded border border-bark-300 bg-white px-2 py-1.5 text-sm focus:border-bark-500 focus:outline-none";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-bark-700">{label}</span>
      {children}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={`${field} ${p.className ?? ""}`} />
);
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...p} className={`${field} ${p.className ?? ""}`} />
);
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={`${field} ${p.className ?? ""}`} />
);

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg =
    error instanceof ApiError
      ? `${error.message} (${error.code})`
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <p
      role="alert"
      className="rounded border border-heart-500/40 bg-heart-500/10 px-3 py-2 text-sm text-heart-500"
    >
      {msg}
    </p>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="py-6 text-center text-sm text-bark-500">{children}</p>
);
export const Loading = () => <p className="py-6 text-center text-sm text-bark-500">Loading…</p>;

/** Shared loading/error handling for a query result. */
export function Async<T>({
  q,
  children,
}: {
  q: { data?: T; error: unknown; isPending: boolean };
  children: (data: T) => ReactNode;
}) {
  if (q.error) return <ErrorNote error={q.error} />;
  if (q.isPending || q.data === undefined) return <Loading />;
  return <>{children(q.data)}</>;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-bark-200 text-xs tracking-wide text-bark-500 uppercase">
            {head.map((h) => (
              <th key={h} className="px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-bark-100">{children}</tbody>
      </table>
    </div>
  );
}
