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
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-impress \
      libreoffice-core \
      default-jre-headless \
      fonts-dejavu-core \
      fonts-liberation2 \
      curl \
      ca-certificates \
      nodejs \
      npm \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# LibreOffice writes a user profile on first run and refuses to start without a
# writable HOME. Hosts that run the container as a non-root user (Cloud Run
# does) leave / read-only, so point everything at /tmp.
ENV HOME=/tmp
ENV PORT=8080

# Warm the profile at build time so the first real request doesn't pay for it.
# Without this the first conversion after a cold start takes several seconds
# longer than every one after it, which reads as "the site is broken".
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
