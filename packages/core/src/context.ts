import type { Db } from "./db.js";
import type { EventLog } from "./eventLog.js";
import type { LabPort } from "./lab.js";
import type { Rules } from "./rules.js";

/** Dependencies shared by the domain services. */
export interface Ctx {
  db: Db;
  log: EventLog;
  rules: Rules;
}

export interface LabCtx extends Ctx {
  lab: LabPort;
}
