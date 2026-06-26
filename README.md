# MCP Task Manager

A Kanban-style task management system implemented as a single-file MCP stdio
server. Provides create, read, update, delete, archive, and search operations
for tasks backed by SQLite with auto-increment integer IDs.

## Requirements

- [Deno](https://deno.com/) 2.8.1+

## Quick Start

```bash
deno run --allow-read --allow-write --allow-env --allow-ffi main.ts
```

The server speaks the MCP stdio protocol. Connect it to your MCP host (Claude
Desktop, OpenCode, etc.) to start using it.

## Configuration

Optional: `task-manager.jsonc` at project root.

```jsonc
{
  // Paths are relative to project root
  "dataDir": "data",
  "logDir": "logs"
}
```

Both fields are optional. Defaults to `./data` and `./logs` if the file is
absent or a field is missing.

## Integration

Add to your MCP host config like any stdio MCP server. Either run directly with Deno or use the compiled binary:

```bash
deno task compile
```

```json
{
  "mcpServers": {
    "task-manager": {
      "command": "/path/to/task-manager",
      "args": []
    }
  }
}
```

If you prefer to use `deno run` directly instead:

```json
{
  "mcpServers": {
    "task-manager": {
      "command": "deno",
      "args": [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        "/path/to/project/main.ts"
      ]
    }
  }
}
```

## Tools

### `create_task`

Create a new task with status `todo` and priority `medium` by default.

| Parameter     | Type                                        | Required | Description          |
| ------------- | ------------------------------------------- | -------- | -------------------- |
| `title`       | `string`                                    | yes      | Task title           |
| `description` | `string`                                    | no       | Detailed description |
| `assignee`    | `string`                                    | no       | Person assigned      |
| `labels`      | `string[]`                                  | no       | List of labels/tags  |
| `priority`    | `"low" \| "medium" \| "high" \| "critical"` | no       | Priority level       |

Returns the created task object.

### `get_task`

Get a single task by ID.

| Parameter | Type     | Required | Description    |
| --------- | -------- | -------- | -------------- |
| `id`      | `string` | yes      | ID of the task |

Returns the task object, or an error if not found.

### `list_tasks`

List tasks with optional filters. Results ordered newest first.

| Parameter  | Type                                                          | Required | Description                |
| ---------- | ------------------------------------------------------------- | -------- | -------------------------- |
| `status`   | `"todo" \| "in_progress" \| "review" \| "done" \| "archived"` | no       | Filter by status           |
| `priority` | `"low" \| "medium" \| "high" \| "critical"`                   | no       | Filter by priority         |
| `assignee` | `string`                                                      | no       | Filter by assignee (exact) |
| `label`    | `string`                                                      | no       | Filter by label (exact)    |

Returns an array of task objects.

### `update_task`

Update one or more fields of an existing task. Only provided fields are changed.
`updated_at` is set automatically.

| Parameter     | Type                                                          | Required | Description      |
| ------------- | ------------------------------------------------------------- | -------- | ---------------- |
| `id`          | `string`                                                      | yes      | ID of the task   |
| `title`       | `string`                                                      | no       | New title        |
| `status`      | `"todo" \| "in_progress" \| "review" \| "done" \| "archived"` | no       | New status       |
| `description` | `string`                                                      | no       | New description  |
| `assignee`    | `string`                                                      | no       | New assignee     |
| `labels`      | `string[]`                                                    | no       | New labels array |
| `priority`    | `"low" \| "medium" \| "high" \| "critical"`                   | no       | New priority     |

Returns the updated task object.

### `delete_task`

Permanently delete a task by ID.

| Parameter | Type     | Required | Description    |
| --------- | -------- | -------- | -------------- |
| `id`      | `string` | yes      | ID of the task |

Returns a confirmation message.

### `archive_task`

Set a task's status to `archived`. Shorthand for `update_task` with
`status: "archived"`.

| Parameter | Type     | Required | Description    |
| --------- | -------- | -------- | -------------- |
| `id`      | `string` | yes      | ID of the task |

Returns the archived task object.

### `search_tasks`

Full-text search across task titles and descriptions using LIKE-based matching
(special SQL chars `%` and `_` are escaped). Results ordered newest first.

| Parameter | Type     | Required | Description |
| --------- | -------- | -------- | ----------- |
| `query`   | `string` | yes      | Search term |

Returns an array of matching task objects.

## Architecture

- **Single file** — `main.ts` with no external project dependencies beyond Deno
  standard library
- **SQLite** — WAL mode journaling for concurrent read performance
- **Auto-increment IDs** — Integer primary keys assigned automatically by SQLite
- **Labels** — Stored as JSON array of strings in a TEXT column, filtered via
  SQLite's `json_each`
- **Validation** — Zod schemas on all tool inputs
- **Logging** — LogTape writes to both `logs/task-manager.log` (file sink) and
  stderr

## Task Schema

| Field         | Type       | Default        | Notes                                             |
| ------------- | ---------- | -------------- | ------------------------------------------------- |
| `id`          | `number`   | Auto-increment | Primary key, assigned by SQLite                   |
| `title`       | `string`   | —              | Required                                          |
| `status`      | `string`   | `"todo"`       | One of: todo, in_progress, review, done, archived |
| `description` | `string`   | `""`           |                                                   |
| `assignee`    | `string`   | `""`           |                                                   |
| `labels`      | `string[]` | `[]`           | JSON array stored in TEXT column                  |
| `priority`    | `string`   | `"medium"`     | One of: low, medium, high, critical               |
| `created_at`  | `string`   | ISO 8601       | Set on creation                                   |
| `updated_at`  | `string`   | ISO 8601       | Updated on modification                           |

## Database

SQLite database file stored at `{dataDir}/tasks.db` (default: `data/tasks.db`).
Created automatically on first run. WAL mode is enabled for concurrent reads
without blocking writes.
