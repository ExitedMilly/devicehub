FROM node:18-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        pulseaudio-utils \
        adb \
        curl \
        libatomic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json /app/
RUN npm install --production

COPY manager.js /app/
COPY camera-writer.js /app/
COPY emulator_controller.proto /app/
COPY healthcheck.sh /app/
COPY walk-simulator.js /app/
RUN chmod +x /app/healthcheck.sh

RUN useradd -m -s /bin/bash capture
RUN chown -R capture:capture /app
USER capture

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD /app/healthcheck.sh

ENTRYPOINT ["node", "manager.js"]
