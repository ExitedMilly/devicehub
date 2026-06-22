FROM budtmo/docker-android:emulator_13.0
USER root
RUN mv /opt/android/emulator/emulator /opt/android/emulator/emulator.real
COPY patch-modem-shim.sh /opt/android/emulator/emulator
RUN chmod 0755 /opt/android/emulator/emulator
# Source modem_simulator dir is root-owned 644; make it writable so the shim
# (runs as androidusr) can patch the source too — cheap insurance for the
# cold-start source->AVD copy. (Path is image-specific: android-33/google_apis/x86_64.)
RUN chmod -R a+rwX /opt/android/system-images/android-33/google_apis/x86_64/data/misc/modem_simulator
USER androidusr
