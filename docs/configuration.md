# Graph Explorer configuration

This page is for operators deploying Graph Explorer. It lists every setting the service reads and
the fixed entry points it exposes.

Deployment owns runtime composition. Graph Explorer reads only the service settings below; it
does not read datastore or catalog credentials.

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_BASE_URL` | `http://api:8004` | Base URL for the separately deployed `catalog-api`. Browser `/api/*` requests are forwarded under this base. |
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:8003` | Comma-separated browser origin allowlist. Empty or unset uses the two development origins shown. |
| `LOG_LEVEL` | `INFO` | Log level for Uvicorn and for `groovemap-runtime`'s structured logger. |
| `ENVIRONMENT` | `development` | Deployment name written as the `environment` field of every structured log record. It does not change verbosity. |
| `LOG_FILE` | `/logs/graph-explorer.log` | Log file path, read by `groovemap-runtime`'s `setup_logging`; overrides the path the service passes. Empty disables the file sink. If the file cannot be opened, the service logs to the console and emits one warning instead of failing. |
| `LOG_FILE_MAX_BYTES` | `104857600` (100 MiB) | Rollover threshold for the log file sink, read by `groovemap-runtime`'s `setup_logging` at handler-construction time. A non-numeric or non-positive override falls back to this default. |
| `LOG_FILE_BACKUP_COUNT` | `5` | Number of rotated log-file backups retained alongside the active file. A non-numeric or non-positive override falls back to this default. |

The main application port (`8006`), process-health port (`8007`), and proxy timeout (150 seconds) are
code-owned constants, not environment variables.

The container image creates `/logs`, so the default file sink works there. Elsewhere, if `/logs` is not
writable the service falls back to console logging; set `LOG_FILE` to a writable path to keep a file.

The service exposes these entry points:

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
