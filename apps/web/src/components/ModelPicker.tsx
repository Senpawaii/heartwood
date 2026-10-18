import { useState } from "react";
import { z } from "zod";
import { Field, Input, Select } from "./ui";

/** A model the person typed and, separately, an effort level to append to it. Both may be empty. */
export interface ModelChoice {
  model: string;
  effort: string;
}
export const NO_CHOICE: ModelChoice = { model: "", effort: "" };

/** Effort levels omp understands, lowest first. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * What to send to the daemon: the model with its effort suffix, or `undefined` for "use the server's
 * setting". An effort needs a model to attach to, and a model that already names its own `:level` wins.
 */
export function selectorOf(c: ModelChoice): string | undefined {
  const model = c.model.trim();
  if (!model) return undefined;
  return c.effort && !model.includes(":") ? `${model}:${c.effort}` : model;
}

const Stored = z.object({ model: z.string(), effort: z.string() });

/** A choice that survives reloads, kept per browser. A damaged or missing entry means no choice. */
export function usePersistedChoice(key: string): [ModelChoice, (c: ModelChoice) => void] {
  const storageKey = `heartwood.model.${key}`;
  const [choice, setChoice] = useState<ModelChoice>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? Stored.parse(JSON.parse(raw)) : NO_CHOICE;
    } catch {
      return NO_CHOICE;
    }
  });
  const update = (c: ModelChoice) => {
    setChoice(c);
    try {
      localStorage.setItem(storageKey, JSON.stringify(c));
    } catch {
      // storage may be unavailable (private mode, quota); the choice still applies for this page
    }
  };
  return [choice, update];
}

/** A model field with an effort menu. Empty means "use the server's setting". */
export function ModelPicker({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: ModelChoice;
  onChange: (c: ModelChoice) => void;
}) {
  const typedOwnLevel = value.model.includes(":");
  return (
    <div className="space-y-1">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label={label}>
            <Input
              value={value.model}
              placeholder="server default"
              spellCheck={false}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-28 shrink-0">
          <Field label="Effort">
            <Select
              aria-label={`${label} effort`}
              value={typedOwnLevel ? "" : value.effort}
              disabled={!value.model.trim() || typedOwnLevel}
              onChange={(e) => onChange({ ...value, effort: e.target.value })}
            >
              <option value="">default</option>
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <p className="text-xs text-bark-500">{hint}</p>
    </div>
  );
}
