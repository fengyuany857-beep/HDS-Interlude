FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN groupadd --gid 10001 hdsi && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin hdsi
WORKDIR /opt/hdsi-discord
COPY requirements.lock ./requirements.lock
COPY requirements-build.lock ./requirements-build.lock
COPY wheelhouse ./wheelhouse
RUN python -m pip install --disable-pip-version-check --no-index --find-links=wheelhouse \
      --require-hashes -r requirements-build.lock && \
    python -m pip install --disable-pip-version-check --no-index --find-links=wheelhouse \
      --no-build-isolation --require-hashes -r requirements.lock && rm -r wheelhouse
COPY hdsi_discord_sidecar ./hdsi_discord_sidecar
COPY run.py ./run.py
RUN mkdir /var/lib/hdsi-discord && chown 10001:10001 /var/lib/hdsi-discord
USER 10001:10001
VOLUME ["/var/lib/hdsi-discord"]
EXPOSE 5140
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import socket;s=socket.create_connection(('127.0.0.1',5140),2);s.close()"]
ENTRYPOINT ["python", "run.py"]

