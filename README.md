# Scrab Convert

LibreOffice conversion worker. Office ↔ PDF, and everything LibreOffice can
read or write in between.

Separate from the main tools site on purpose — its own repo, its own deploys,
nothing shared. If this service is down, scrabtools.site is unaffected.

## Why it is a plain container

The hosting decision kept blocking the build, so the build stopped waiting for
it. There are no platform-specific files here — no `render.yaml`, no
`app.yaml`, no Procfile. Any host that can run a container and set `$PORT` can
run this, which means the choice of host is reversible and, more usefully,
does not have to be a single choice.

## Run it

```bash
docker build -t scrab-convert .
docker run -p 8080:8080 scrab-convert

curl localhost:8080/health
curl -X POST "localhost:8080/convert?to=pdf" -F "file=@report.docx" -o report.pdf
```

## API

| Route | Purpose |
|---|---|
| `GET /health` | Liveness **and** capacity — `busy`, `queued`, `active`. The pool router ranks instances with this. |
| `GET /capabilities` | Source and target formats, upload cap, timeout. Keeps the frontend from offering conversions this build cannot do. |
| `POST /convert?to=pdf` | Multipart, field name `file`. Returns the converted bytes, or JSON `{error}`. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Most platforms set this for you. |
| `MAX_CONCURRENT` | `2` | LibreOffice needs 250–400 MB per instance. **Set to `1` on a 512 MB host** or the container gets OOM-killed mid-job. |
| `CONVERT_TIMEOUT_MS` | `60000` | Hard kill. Nothing legitimate takes longer. |
| `QUEUE_TIMEOUT_MS` | `15000` | How long a request waits for a slot before returning 503. |
| `MAX_UPLOAD_BYTES` | `26214400` | 25 MB. |
| `CORS_ORIGINS` | *(open)* | Comma-separated. Unset means allow any origin — set it in production. |

## Running several of these

Deploy the same image to two or three different providers, then let the browser
pick between them with `client/pool.js`:

```js
import { convertWithFailover } from "./pool.js";

const POOL = [
  { name: "cloudrun", url: "https://convert-xxxx.run.app" },
  { name: "render",   url: "https://convert.onrender.com" },
  { name: "koyeb",    url: "https://convert.koyeb.app" },
];

const { blob, server } = await convertWithFailover(POOL, file, "pdf");
```

It health-checks all of them in parallel, prefers whichever is free over
whichever is merely up, and moves on when one returns 503.

**One account per provider.** Spreading across Cloud Run, Render and Koyeb is
ordinary redundancy. Opening several accounts on the *same* provider to stack
its free tier is against every one of their terms, and the accounts get
terminated together — usually the first time you actually need the capacity.

`MAX_CONCURRENT` is what makes the pool work: an instance that honestly reports
`busy: true` and returns 503 gets skipped in milliseconds, so a full box costs
the user nothing. An instance that silently queues instead would make the whole
pool as slow as its worst member.

## Three ways this hangs, and what stops each

The failure this service is built to avoid is the request that never returns.
`soffice` produces it in three different ways:

1. **Two jobs sharing a profile directory.** The second waits on a lock the
   first only releases at exit. → Every job gets its own
   `-env:UserInstallation` under a fresh temp dir.
2. **A modal dialog on a headless box.** Nobody will ever click it.
   → `--headless --norestore --nolockcheck --nodefault --nofirststartwizard`.
3. **A file that simply wedges the parser.** → A wall-clock deadline, SIGTERM
   then SIGKILL, and a 504 to the caller.

There is a fourth that is not LibreOffice's fault: `soffice` exits `0` having
written nothing at all. The only reliable check is whether an output file
appeared, so that is what the code checks rather than the exit code.
