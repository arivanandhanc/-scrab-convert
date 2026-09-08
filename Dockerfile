# Scrab Convert — LibreOffice conversion worker.
#
# Deliberately a plain Dockerfile with no platform-specific hooks, because the
# hosting decision kept blocking the build. This same image runs unchanged on
# Cloud Run, Render, Fly, a VPS or a laptop; the only thing any of them needs to
# know is that the service listens on $PORT.

FROM debian:bookworm-slim

# --no-install-recommends matters more than usual here: the full libreoffice
# metapackage pulls in Java and a desktop stack we never touch, roughly
# tripling the image. A bigger image is a slower cold start, and on a
# scale-to-zero host cold start is the number the user actually feels.
#
# No Java. `default-jre-headless` is ~180 MB and LibreOffice only needs it for
# Base, the wizards and a few exotic filters — none of which are on any path
# through this service. Document and spreadsheet conversion to PDF works
# without it. If a filter ever complains about a missing JRE, add it back here
# rather than working around it in code.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui \
      libreoffice-calc-nogui \
      libreoffice-impress-nogui \
      libreoffice-core-nogui \
      fonts-dejavu-core \
      fonts-liberation2 \
      curl \
      ca-certificates \
      nodejs \
      npm \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /var/cache/apt/*

# AWS Lambda Web Adapter.
#
# Lambda normally requires the app to implement its Runtime API — a rewrite of
# the whole HTTP layer. The adapter is a Lambda extension that speaks the
# Runtime API on the app's behalf and forwards each invocation to the ordinary
# web server already listening on $PORT. So the same image runs unmodified on
# Lambda, Render, Cloud Run or a laptop.
#
# Outside Lambda this is an unused file: /opt/extensions is only read by the
# Lambda runtime, so it costs a few megabytes and changes nothing.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 \
     /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app

# The lockfile comes too, so `npm ci` can install the exact tree that was
# tested rather than whatever `install` resolves on the day of the build.
# --omit=dev skips the AWS SDK packages, which only the bootstrap script uses.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# LibreOffice writes a user profile on first run and refuses to start without a
# writable HOME. Hosts that run the container as a non-root user (Cloud Run
# does) leave / read-only, so point everything at /tmp.
ENV HOME=/tmp
ENV PORT=8080

# The adapter polls this before forwarding the first invocation. It defaults to
# "/", which this service does not serve — the container would be judged
# unhealthy and every cold start would fail. Point it at the route that exists.
ENV AWS_LWA_READINESS_CHECK_PATH=/health

# Warm the profile at build time so the first real request doesn't pay for it.
# Without this the first conversion after a cold start takes several seconds
# longer than every one after it, which reads as "the site is broken".
#
# It doubles as a smoke test: if the -nogui packages ever stop providing
# `soffice` on PATH, this fails the build with an obvious error instead of
# shipping an image that 500s on its first real conversion.
RUN mkdir -p /tmp/lo-warm \
 && printf 'warmup' > /tmp/warm.txt \
 && soffice --headless --norestore \
      -env:UserInstallation=file:///tmp/lo-warm \
      --convert-to pdf --outdir /tmp /tmp/warm.txt \
 && rm -f /tmp/warm.txt /tmp/warm.pdf

EXPOSE 8080

# No process manager. If the worker dies the platform should restart the
# container — a supervisor inside would only hide the failure from the host's
# health checks.
CMD ["node", "src/index.js"]
