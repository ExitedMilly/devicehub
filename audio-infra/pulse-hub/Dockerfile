FROM ubuntu:22.04

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        pulseaudio \
        pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/*

# PulseAudio runs as non-root user
RUN useradd -m -s /bin/bash pulse-hub

# Custom entrypoint handles dynamic sink creation
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Socket directory — will be shared via Docker volume
# mic_pipes/ holds FIFO files for virtual microphone sources
RUN mkdir -p /run/pulse /run/pulse/mic_pipes && \
    chown -R pulse-hub:pulse-hub /run/pulse

USER pulse-hub

ENTRYPOINT ["/entrypoint.sh"]
