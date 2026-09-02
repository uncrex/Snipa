import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const dashboardCommandEntrySchema = z.object({
  schemaVersion: z.literal(1),
  commandId: z.string().uuid(),
  createdAt: z.string().datetime(),
  timestamp: z.string().datetime(),
  mint: z.string().min(1),
  amountSol: z.number().positive(),
  mode: z.enum(["paper", "live"]),
  status: z.enum(["accepted", "paper", "confirmed", "rejected"]),
  signature: z.string().min(1).nullable(),
  error: z.string().min(1).nullable(),
});

export type DashboardCommandEntry = z.infer<typeof dashboardCommandEntrySchema>;

export interface DashboardCommandAudit {
  get(commandId: string): Promise<DashboardCommandEntry | undefined>;
  append(entry: DashboardCommandEntry): Promise<void>;
}

function sameCommand(left: DashboardCommandEntry, right: DashboardCommandEntry): boolean {
  return left.createdAt === right.createdAt
    && left.mint === right.mint
    && left.amountSol === right.amountSol
    && left.mode === right.mode;
}

export function createDashboardCommandAudit(path: string): DashboardCommandAudit {
  return {
    async get(commandId) {
      let contents: string;
      try {
        contents = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      let match: DashboardCommandEntry | undefined;
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error("Dashboard command audit contains invalid JSON.");
        }
        const result = dashboardCommandEntrySchema.safeParse(parsed);
        if (!result.success) throw new Error("Dashboard command audit contains an invalid entry.");
        if (result.data.commandId !== commandId) continue;
        if (match && !sameCommand(match, result.data)) {
          throw new Error(`Dashboard command ${commandId} has conflicting audit entries.`);
        }
        if (!match && result.data.status !== "accepted") {
          throw new Error(`Dashboard command ${commandId} is missing its accepted audit entry.`);
        }
        match = result.data;
      }
      return match;
    },
    async append(entry) {
      const validated = dashboardCommandEntrySchema.parse(entry);
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "a");
      try {
        await handle.writeFile(`${JSON.stringify(validated)}\n`, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}
