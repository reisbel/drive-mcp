/**
 * Reject arguments the tool does not declare, instead of silently dropping them.
 *
 * Without this, a call using the wrong spelling for a parameter (snake_case for a
 * camelCase name, say) succeeds against the defaults and returns plausible data for
 * something the caller never asked for. Silent wrong data is worse than an error.
 *
 * Kept apart from server.js so it can be imported and tested without starting the
 * server or reading credentials.
 */
export function validateArgs(tool, args) {
  const allowed = Object.keys(tool.inputSchema?.properties ?? {});
  const canon = (k) => k.toLowerCase().replace(/[_-]/g, '');
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    const detail = unknown.map((k) => {
      const hit = allowed.find((a) => canon(a) === canon(k));
      return hit ? `${k} (did you mean ${hit}?)` : k;
    });
    throw new Error(
      `Unknown parameter${unknown.length > 1 ? 's' : ''}: ${detail.join(', ')}. ` +
      `${tool.name} accepts: ${allowed.join(', ') || '(none)'}.`
    );
  }
  const missing = (tool.inputSchema?.required ?? []).filter((k) => args[k] === undefined);
  if (missing.length) {
    throw new Error(`Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  }
}
