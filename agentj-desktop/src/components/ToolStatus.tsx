import { useEffect, useState } from "react";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { toolStatus } from "../session";
import type { McpServerStatus, ToolStatus as ToolStatusData } from "../types";

const STATE_LABEL: Record<McpServerStatus["state"], string> = {
  ok: "ok",
  needs_auth: "needs auth",
  error: "error",
};

interface ToolRow {
  name: string;
  description: string;
}

const SERVER_COLUMNS: ColumnDef<McpServerStatus>[] = [
  {
    id: "status",
    header: "Status",
    accessorFn: (r) => STATE_LABEL[r.state],
    cell: ({ row }) => (
      <span className={"ts-" + row.original.state}>
        {STATE_LABEL[row.original.state]}
      </span>
    ),
  },
  {
    accessorKey: "name",
    header: "Server",
    cell: (info) => <span className="ts-mono">{info.getValue<string>()}</span>,
  },
  {
    accessorKey: "tools",
    header: "Tools",
    cell: (info) => <span className="ts-num">{info.getValue<number>()}</span>,
  },
  {
    id: "detail",
    header: "Detail",
    accessorFn: (r) => r.detail ?? "",
  },
];

const TOOL_COLUMNS: ColumnDef<ToolRow>[] = [
  {
    accessorKey: "name",
    header: "Tool",
    cell: (info) => <span className="ts-mono">{info.getValue<string>()}</span>,
  },
  {
    accessorKey: "description",
    header: "Description",
  },
];

function ServersTable({ servers }: { servers: McpServerStatus[] }) {
  const [filter, setFilter] = useState("");
  const table = useReactTable({
    data: servers,
    columns: SERVER_COLUMNS,
    state: { globalFilter: filter },
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="ts-panel">
      <input
        className="ts-filter"
        placeholder="Filter servers…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        spellCheck={false}
      />
      <div className="ts-well">
        {servers.length === 0 ? (
          <div className="ts-empty">
            No MCP servers. Add a .mcp.json to this repo.
          </div>
        ) : (
          <table className="ts-table">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th key={h.id}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ToolsTable({
  builtins,
  mcpToolCount,
}: {
  builtins: ToolRow[];
  mcpToolCount: number;
}) {
  const [filter, setFilter] = useState("");
  const table = useReactTable({
    data: builtins,
    columns: TOOL_COLUMNS,
    state: { globalFilter: filter },
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="ts-panel">
      <input
        className="ts-filter"
        placeholder="Filter tools…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        spellCheck={false}
      />
      <div className="ts-well">
        <table className="ts-table">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {mcpToolCount > 0 && (
          <div className="ts-note">
            + {mcpToolCount} MCP tools — see Servers
          </div>
        )}
      </div>
    </div>
  );
}

export function ToolStatus({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<ToolStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"servers" | "tools">("servers");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    if (!sessionId) {
      setLoading(false);
      setError("No active session.");
      return;
    }
    setLoading(true);
    toolStatus(sessionId)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const servers = data?.mcp ?? [];
  const toolCount = data ? data.builtins.length + data.mcpToolCount : 0;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal modal-tools" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">Tool &amp; MCP status</h2>
          <button className="modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="ts-tabstrip">
          <button
            className={tab === "servers" ? "ts-tab active" : "ts-tab"}
            onClick={() => setTab("servers")}
          >
            Servers{data ? ` · ${servers.length}` : ""}
          </button>
          <button
            className={tab === "tools" ? "ts-tab active" : "ts-tab"}
            onClick={() => setTab("tools")}
          >
            Tools{data ? ` · ${toolCount}` : ""}
          </button>
        </div>

        {loading ? (
          <div className="ts-panel">
            <div className="ts-empty">loading…</div>
          </div>
        ) : error ? (
          <div className="ts-panel">
            <div className="ts-empty">{error}</div>
          </div>
        ) : tab === "servers" ? (
          <ServersTable servers={servers} />
        ) : (
          <ToolsTable
            builtins={data?.builtins ?? []}
            mcpToolCount={data?.mcpToolCount ?? 0}
          />
        )}
      </div>
    </div>
  );
}
