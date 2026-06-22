#!/bin/bash
set -u
REAL="/opt/android/emulator/emulator.real"
EMULATOR_API_LEVEL="${EMULATOR_API_LEVEL:-33}"
EMULATOR_IMG_TYPE="${EMULATOR_IMG_TYPE:-google_apis}"
EMULATOR_SYS_IMG="${EMULATOR_SYS_IMG:-x86_64}"
OP_MCC="${OP_MCC:-}"; OP_MNC="${OP_MNC:-}"; OP_NAME="${OP_NAME:-}"
OP_NAME_SHORT="${OP_NAME_SHORT:-${OP_NAME}}"
if [ -z "${OP_MCC}" ] || [ -z "${OP_MNC}" ]; then exec "${REAL}" "$@"; fi
PLMN="${OP_MCC}${OP_MNC}"; MNC_LEN="${#OP_MNC}"
IMSI="${PLMN}"; while [ "${#IMSI}" -lt 15 ]; do IMSI="${IMSI}0"; done; IMSI="${IMSI:0:15}"
AD_HEX="000000$(printf '%02X' "${MNC_LEN}")"
ICC_REL="iccprofile_for_sim0.xml"
NUM_REL="etc/modem_simulator/files/numeric_operator.xml"
patch_dir() {
  local base="$1"; [ -d "${base}" ] || return 0
  if [ -f "${base}/${ICC_REL}" ]; then
    sed -i -e "s|<CIMI>[0-9]*</CIMI>|<CIMI>${IMSI}</CIMI>|g" \
           -e "s|144,0,00000003</SIMIO>|144,0,${AD_HEX}</SIMIO>|g" "${base}/${ICC_REL}" 2>/dev/null || true
  fi
  if [ -f "${base}/${NUM_REL}" ]; then
    sed -i -e "s|<item numeric=\"[0-9]*\">[^<]*</item>|<item numeric=\"${PLMN}\">${OP_NAME}=${OP_NAME_SHORT}</item>|g" "${base}/${NUM_REL}" 2>/dev/null || true
  fi
}
patch_all() {
  patch_dir "/opt/android/system-images/android-${EMULATOR_API_LEVEL}/${EMULATOR_IMG_TYPE}/${EMULATOR_SYS_IMG}/data/misc/modem_simulator"
  patch_dir "/home/androidusr/emulator/modem_simulator"
}
echo "[op-shim] PLMN=${PLMN} name=${OP_NAME} imsi=${IMSI} mnc_len=${MNC_LEN}" >&2
patch_all
# AVD working copy is regenerated from an embedded default at radio init
# (~3 min, past boot) — keep re-patching until the radio reports our PLMN
# (then it's authoritative), with a hard ceiling as a safety net.
(
  deadline=$(( $(date +%s) + 900 ))
  n=0
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    patch_all
    n=$(( n + 1 ))
    if [ $(( n % 20 )) -eq 0 ]; then
      cur="$(adb shell getprop gsm.sim.operator.numeric 2>/dev/null | tr -d '\r\n ')"
      [ "${cur}" = "${PLMN}" ] && break
    fi
    sleep 0.1
  done
) >/dev/null 2>&1 &
exec "${REAL}" "$@"
