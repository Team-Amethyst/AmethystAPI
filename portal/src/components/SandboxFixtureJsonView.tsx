import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function parseObject(raw: string): object | undefined {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v !== null && typeof v === "object") return v as object;
  } catch {
    /* invalid JSON */
  }
  return undefined;
}

type SandboxFixtureJsonViewProps = {
  raw: string | undefined;
  loadingFixtures: boolean;
};

/**
 * Interactive tree view for league/fixture JSON (collapse/expand, copy nodes).
 * Falls back to a plain pre when the body is not a JSON object/array.
 */
export function SandboxFixtureJsonView({ raw, loadingFixtures }: SandboxFixtureJsonViewProps) {
  if (loadingFixtures && !raw) {
    return (
      <pre className="sandbox-context-pre sandbox-context-pre--collapsed sandbox-json-view-fallback">
        Loading…
      </pre>
    );
  }
  if (!raw) {
    return (
      <pre className="sandbox-context-pre sandbox-context-pre--collapsed sandbox-json-view-fallback">
        —
      </pre>
    );
  }

  const parsed = parseObject(raw);
  if (!parsed) {
    return (
      <pre className="sandbox-context-pre sandbox-context-pre--collapsed sandbox-json-view-fallback">
        {prettyJson(raw)}
      </pre>
    );
  }

  return (
    <div className="sandbox-json-view-root">
      <JsonView
        value={parsed}
        style={{
          ...darkTheme,
          "--w-rjv-background-color": "transparent",
        }}
        collapsed={2}
        displayDataTypes={false}
        shortenTextAfterLength={0}
        indentWidth={14}
        className="sandbox-json-view-inner"
      />
    </div>
  );
}
