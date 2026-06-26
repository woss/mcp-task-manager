import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "./version.ts";
import { type BindValue, Database } from "@db/sqlite";
import { configure, getLogger, getStreamSink } from "@logtape/logtape";
import { getFileSink } from "@logtape/file";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

function stripJsonc(raw: string): string {
  return raw
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function loadConfig(): { dataDir: string; logDir: string } {
  const configPath = resolve(Deno.cwd(), "task-manager.jsonc");
  const configDir = dirname(configPath);
  const defaults = { dataDir: "data", logDir: "logs" };
  if (!existsSync(configPath)) {
    return {
      dataDir: resolve(configDir, defaults.dataDir),
      logDir: resolve(configDir, defaults.logDir),
    };
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const json = JSON.parse(stripJsonc(raw));
    return {
      dataDir: resolve(configDir, json.dataDir || defaults.dataDir),
      logDir: resolve(configDir, json.logDir || defaults.logDir),
    };
  } catch {
    return {
      dataDir: resolve(configDir, defaults.dataDir),
      logDir: resolve(configDir, defaults.logDir),
    };
  }
}

const { dataDir, logDir } = loadConfig();

// deno-lint-ignore prefer-const
let logger: ReturnType<typeof getLogger>;

await Deno.mkdir(dataDir, { recursive: true });
await Deno.mkdir(logDir, { recursive: true });

const db = new Database(`${dataDir}/tasks.db`, { parseJson: false });
db.exec("PRAGMA journal_mode=WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    description TEXT DEFAULT '',
    assignee TEXT DEFAULT '',
    labels TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'medium',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

type Task = {
  id: number;
  title: string;
  status: string;
  description: string;
  assignee: string;
  labels: string[];
  priority: string;
  created_at: string;
  updated_at: string;
};

function rowToTask(row: Record<string, unknown>): Task {
  let labels: string[] = [];
  try {
    labels = JSON.parse(row.labels as string || "[]");
  } catch {
    // rowToTask is called before logger is available, so no log here
    labels = [];
  }
  return {
    id: row.id as number,
    title: row.title as string,
    status: row.status as string,
    description: row.description as string,
    assignee: row.assignee as string,
    labels,
    priority: row.priority as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function now(): string {
  return new Date().toISOString();
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

const server = new McpServer({
  name: "task-manager",
  version: VERSION,
});

server.tool(
  "create_task",
  "Create a new task",
  {
    title: z.string().min(1).describe("Task title"),
    description: z.string().optional().describe("Detailed description"),
    assignee: z.string().optional().describe("Person assigned to the task"),
    labels: z.array(z.string()).optional().describe("List of labels/tags"),
    priority: z.enum(["low", "medium", "high", "critical"]).optional()
      .describe("Priority level"),
  },
  async ({ title, description, assignee, labels, priority }: {
    title: string;
    description?: string;
    assignee?: string;
    labels?: string[];
    priority?: "low" | "medium" | "high" | "critical";
  }) => {
    try {
      const ts = now();
      db.prepare(
        `INSERT INTO tasks (title, status, description, assignee, labels, priority, created_at, updated_at)
         VALUES (?, 'todo', ?, ?, ?, ?, ?, ?)`,
      ).run(
        title,
        description || "",
        assignee || "",
        JSON.stringify(labels || []),
        priority || "medium",
        ts,
        ts,
      );
      const newId = db.lastInsertRowId;
      const row = db.prepare("SELECT * FROM tasks WHERE rowid = ?").get(newId);
      if (!row) throw new Error("Row vanished after insert");
      logger.info`Created task ${newId}: ${title}`;
      return {
        content: [{
          type: "text",
          text: JSON.stringify(rowToTask(row), null, 2),
        }],
      };
    } catch (e: unknown) {
      logger.error`Failed to create task: ${getErrorMessage(e)}`;
      return {
        content: [{ type: "text", text: `Error: ${getErrorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "get_task",
  "Get a single task by ID",
  { id: z.string().describe("The ID of the task") },
  async ({ id }: { id: string }) => {
    try {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      if (!row) {
        logger.warn`Task not found: ${id}`;
        return {
          content: [{ type: "text", text: `Task not found: ${id}` }],
          isError: true,
        };
      }
      logger.debug`Fetched task ${id}`;
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            rowToTask(row as Record<string, unknown>),
            null,
            2,
          ),
        }],
      };
    } catch (e: unknown) {
      logger.error`Error fetching task ${id}: ${getErrorMessage(e)}`;
      return {
        content: [{ type: "text", text: `Error: ${getErrorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "list_tasks",
  "List tasks with optional filters. Ordered newest first.",
  {
    status: z.enum(["todo", "in_progress", "review", "done", "archived"])
      .optional()
      .describe("Filter by status"),
    priority: z.enum(["low", "medium", "high", "critical"]).optional()
      .describe("Filter by priority"),
    assignee: z.string().optional().describe(
      "Filter by assignee (exact match)",
    ),
    label: z.string().optional().describe("Filter by label (exact match)"),
  },
  async ({ status, priority, assignee, label }: {
    status?: "todo" | "in_progress" | "review" | "done" | "archived";
    priority?: "low" | "medium" | "high" | "critical";
    assignee?: string;
    label?: string;
  }) => {
    try {
      let sql = "SELECT * FROM tasks WHERE 1=1";
      const params: BindValue[] = [];
      if (status) {
        sql += " AND status = ?";
        params.push(status);
      }
      if (priority) {
        sql += " AND priority = ?";
        params.push(priority);
      }
      if (assignee) {
        sql += " AND assignee = ?";
        params.push(assignee);
      }
      if (label) {
        sql += " AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?)";
        params.push(label);
      }
      sql += " ORDER BY created_at DESC";
      const rows = db.prepare(sql).all(...params);
      const filters: Record<string, unknown> = {};
      if (status !== undefined) filters.status = status;
      if (priority !== undefined) filters.priority = priority;
      if (assignee !== undefined) filters.assignee = assignee;
      if (label !== undefined) filters.label = label;
      logger.debug`Listed tasks (filters: ${JSON.stringify(filters)})`;
      return {
        content: [{
          type: "text",
          text: JSON.stringify(rows.map(rowToTask), null, 2),
        }],
      };
    } catch (e: unknown) {
      logger.error`Error listing tasks: ${getErrorMessage(e)}`;
      return {
        content: [{ type: "text", text: `Error: ${getErrorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "update_task",
  "Update one or more fields of an existing task",
  {
    id: z.string().describe("The ID of the task to update"),
    title: z.string().optional().describe("New title"),
    status: z.enum(["todo", "in_progress", "review", "done", "archived"])
      .optional()
      .describe("New status"),
    description: z.string().optional().describe("New description"),
    assignee: z.string().optional().describe("New assignee"),
    labels: z.array(z.string()).optional().describe("New labels array"),
    priority: z.enum(["low", "medium", "high", "critical"]).optional()
      .describe("New priority"),
  },
  async ({ id, title, status, description, assignee, labels, priority }: {
    id: string;
    title?: string;
    status?: "todo" | "in_progress" | "review" | "done" | "archived";
    description?: string;
    assignee?: string;
    labels?: string[];
    priority?: "low" | "medium" | "high" | "critical";
  }) => {
    try {
      const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      if (!existing) {
        logger.warn`Task not found for update: ${id}`;
        return {
          content: [{ type: "text", text: `Task not found: ${id}` }],
          isError: true,
        };
      }
      const updates: string[] = [];
      const params: BindValue[] = [];
      if (title !== undefined) {
        updates.push("title = ?");
        params.push(title);
      }
      if (status !== undefined) {
        updates.push("status = ?");
        params.push(status);
      }
      if (description !== undefined) {
        updates.push("description = ?");
        params.push(description);
      }
      if (assignee !== undefined) {
        updates.push("assignee = ?");
        params.push(assignee);
      }
      if (labels !== undefined) {
        updates.push("labels = ?");
        params.push(JSON.stringify(labels));
      }
      if (priority !== undefined) {
        updates.push("priority = ?");
        params.push(priority);
      }
      if (updates.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              rowToTask(existing as Record<string, unknown>),
              null,
              2,
            ),
          }],
        };
      }
      const changes: Record<string, unknown> = {};
      if (title !== undefined) changes.title = title;
      if (status !== undefined) changes.status = status;
      if (description !== undefined) changes.description = description;
      if (assignee !== undefined) changes.assignee = assignee;
      if (labels !== undefined) changes.labels = labels;
      if (priority !== undefined) changes.priority = priority;
      logger.info`Updated task ${id}: ${JSON.stringify(changes)}`;
      updates.push("updated_at = ?");
      params.push(now());
      params.push(id);
      db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(
        ...params,
      );
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      if (!row) throw new Error("Row vanished after update");
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            rowToTask(row as Record<string, unknown>),
            null,
            2,
          ),
        }],
      };
    } catch (e: unknown) {
      logger.error`Error updating task ${id}: ${getErrorMessage(e)}`;
      return {
        content: [{ type: "text", text: `Error: ${getErrorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "delete_task",
  "Permanently delete a task by ID",
  { id: z.string().describe("The ID of the task to delete") },
  async ({ id }: { id: string }) => {
    try {
      const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      if (!existing) {
        logger.warn`Task not found for delete: ${id}`;
        return {
          content: [{ type: "text", text: `Task not found: ${id}` }],
          isError: true,
        };
      }
      const task = existing as Record<string, unknown>;
      logger.warn`Deleted task ${id}: ${task.title}`;
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      return { content: [{ type: "text", text: `Deleted task: ${id}` }] };
    } catch (e: unknown) {
      logger.error`Error deleting task ${id}: ${getErrorMessage(e)}`;
      return {
        content: [{ type: "text", text: `Error: ${getErrorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "archive_task",
  "Archive a task (sets status to 'archived')",
  { id: z.string().describe("The ID of the task to archive") },
  async ({ id }: { id: string }) => {
    try {
      const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      if (!existing) {
        logger.warn`Task not found for archive: ${id}`;
        return {
          content: [{ type: "text", text: `Task not found: ${id}` }],
          isError: true,
        };
      }
      const task = existing as Record<string, unknown>;
      logger.info`Archived task ${id}: ${task.title}`;
      db.prepare(
        "UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?",
      ).run(
        now(),
        id,
      );
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      if (!row) throw new Error("Row vanished after archive");
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            rowToTask(row as Record<string, unknown>),
            null,
            2,
          ),
        }],
      };
    } catch (e: unknown) {
      logger.error`Error archiving task ${id}: ${getErrorMessage(e)}`;
      return {
        content: [{ type: "text", text: `Error: ${getErrorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "search_tasks",
  "Full-text search across task titles and descriptions",
  { query: z.string().min(1).describe("Search term") },
  async ({ query }: { query: string }) => {
    try {
      const escaped = query.replace(/[%_]/g, "\\$&");
      const pattern = `%${escaped}%`;
      const rows = db.prepare(
        "SELECT * FROM tasks WHERE title LIKE ? OR description LIKE ? ORDER BY created_at DESC",
      ).all(pattern, pattern);
      logger.debug`Searched for "${query}" → ${rows.length} results`;
      return {
        content: [{
          type: "text",
          text: JSON.stringify(rows.map(rowToTask), null, 2),
        }],
      };
    } catch (e: unknown) {
      logger.error`Error searching tasks: ${getErrorMessage(e)}`;
      return {
        content: [{ type: "text", text: `Error: ${getErrorMessage(e)}` }],
        isError: true,
      };
    }
  },
);

await configure({
  sinks: {
    file: getFileSink(`${logDir}/task-manager.log`, { lazy: true }),
    stderr: getStreamSink(Deno.stderr.writable),
  },
  filters: {},
  loggers: [
    {
      category: "task-manager",
      lowestLevel: "debug",
      sinks: ["file", "stderr"],
    },
    { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: ["stderr"] },
  ],
});
logger = getLogger(["task-manager"]);

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown() {
  await (logger as unknown as { flush?: () => Promise<void> }).flush?.();
  db.close();
  Deno.exit(0);
}
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
