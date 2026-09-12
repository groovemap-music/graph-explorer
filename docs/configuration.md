# Graph Explorer configuration

Deployment owns runtime composition. Graph Explorer reads only the service settings below; it
does not read datastore or catalog credentials.

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_BASE_URL` | `http://api:8004` | Base URL for the separately deployed `catalog-api`. Browser `/api/*` requests are forwarded under this base. |
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:8003` | Comma-separated browser origin allowlist. Empty or unset uses the two development origins shown. |
| `LOG_LEVEL` | `INFO` | Uvicorn log level. |

The main application port (`8006`), process-health port (`8007`), and proxy timeout (150 seconds)
are code-owned constants, not environment variables. The service exposes these entry points:

| Entry point | Contract |
| --- | --- |
| `graph-explorer` | Installed console command resolving to `explore.explore:main`. |
| `GET /` | Static browser application and versioned assets. |
| `GET /health` | Main-process health response. |
| `/api/{path:path}` | Same-origin proxy supporting `GET`, `POST`, `PUT`, `DELETE`, and `PATCH`. |
| `GET :8007/health` | Dedicated process-health server used by the image health check. |

`nlq/query` is the only streaming upstream path. It has no body read deadline so a valid SSE
answer may pause between events, while its response-header phase and every buffered request remain
bounded to 150 seconds.

Telemetry uses the standard OpenTelemetry environment variables listed in the
[README](../README.md#configuration). With no OTLP endpoint configured, telemetry is a no-op and
does not change the proxy or browser contracts.
