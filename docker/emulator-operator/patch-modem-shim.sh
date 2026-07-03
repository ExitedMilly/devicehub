#!/bin/bash
set -u
REAL="/opt/android/emulator/emulator.real"
EMULATOR_API_LEVEL="${EMULATOR_API_LEVEL:-33}"
EMULATOR_IMG_TYPE="${EMULATOR_IMG_TYPE:-google_apis}"
EMULATOR_SYS_IMG="${EMULATOR_SYS_IMG:-x86_64}"
OP_MCC="${OP_MCC:-}"; OP_MNC="${OP_MNC:-}"; OP_NAME="${OP_NAME:-}"
OP_NAME_SHORT="${OP_NAME_SHORT:-${OP_NAME}}"
PHONE_NUMBER="${PHONE_NUMBER:-}"

HAS_OP=0
if [ -n "${OP_MCC}" ] && [ -n "${OP_MNC}" ]; then HAS_OP=1; fi

# Nothing to patch (no operator, no phone number) -> run the real emulator as-is.
if [ "${HAS_OP}" = "0" ] && [ -z "${PHONE_NUMBER}" ]; then exec "${REAL}" "$@"; fi

ICC_REL="iccprofile_for_sim0.xml"
NUM_REL="etc/modem_simulator/files/numeric_operator.xml"

# ----- operator-derived values (IMSI / EF_AD / numeric_operator) -----
PLMN=""; IMSI=""; AD_HEX=""; MNC_LEN=""
if [ "${HAS_OP}" = "1" ]; then
  PLMN="${OP_MCC}${OP_MNC}"; MNC_LEN="${#OP_MNC}"
  IMSI="${PLMN}"; while [ "${#IMSI}" -lt 15 ]; do IMSI="${IMSI}0"; done; IMSI="${IMSI:0:15}"
  AD_HEX="000000$(printf '%02X' "${MNC_LEN}")"
fi

# ----- MSISDN (phone number) encoding -----
# Encode plain digits into the EF_MSISDN (6F40) number segment per 3GPP TS 51.011:
#   LEN(1) + TON/NPI(0x91 international) + dialing number BCD (nibble-swapped,
#   F-padded to 10 bytes) + CCP(0xFF) + Ext(0xFF). Always 28 hex chars (14 bytes),
#   so the record length is preserved. E.g. 79001234567 -> 07919700214365F7FF...FF
encode_msisdn() {
  local digits="$1" ndig nbytes len_hex bcd i c1 c2
  ndig="${#digits}"; nbytes=$(( (ndig + 1) / 2 ))
  len_hex="$(printf '%02X' $(( 1 + nbytes )))"
  bcd=""; i=0
  while [ "${i}" -lt "${ndig}" ]; do
    c1="${digits:${i}:1}"; c2="${digits:$((i+1)):1}"
    [ -z "${c2}" ] && c2="F"          # odd trailing digit -> pad nibble with F
    bcd="${bcd}${c2}${c1}"             # nibble swap within the byte
    i=$(( i + 2 ))
  done
  while [ "${#bcd}" -lt 20 ]; do bcd="${bcd}F"; done   # pad to 10 bytes
  printf '%s91%sFFFF' "${len_hex}" "${bcd:0:20}"
}

MSISDN_SEG=""
if [ -n "${PHONE_NUMBER}" ]; then
  PN_DIGITS="$(printf '%s' "${PHONE_NUMBER}" | tr -cd '0-9')"
  [ -n "${PN_DIGITS}" ] && MSISDN_SEG="$(encode_msisdn "${PN_DIGITS}")"
fi

patch_dir() {
  local base="$1"; [ -d "${base}" ] || return 0
  if [ -f "${base}/${ICC_REL}" ]; then
    if [ "${HAS_OP}" = "1" ]; then
      sed -i -e "s|<CIMI>[0-9]*</CIMI>|<CIMI>${IMSI}</CIMI>|g" \
             -e "s|144,0,00000003</SIMIO>|144,0,${AD_HEX}</SIMIO>|g" "${base}/${ICC_REL}" 2>/dev/null || true
    fi
    if [ -n "${MSISDN_SEG}" ]; then
      # EF_MSISDN primary record (zeros-alpha B2 read): replace ONLY the 28-hex
      # number segment (LEN..Ext), keeping the alpha prefix + record length intact.
      sed -i -E "s#(144,0,0{28})[0-9A-Fa-f]{2}91[0-9A-Fa-f]{24}(</SIMIO>)#\1${MSISDN_SEG}\2#g" "${base}/${ICC_REL}" 2>/dev/null || true
    fi
  fi
  if [ "${HAS_OP}" = "1" ] && [ -f "${base}/${NUM_REL}" ]; then
    sed -i -e "s|<item numeric=\"[0-9]*\">[^<]*</item>|<item numeric=\"${PLMN}\">${OP_NAME}=${OP_NAME_SHORT}</item>|g" "${base}/${NUM_REL}" 2>/dev/null || true
  fi
}
patch_all() {
  patch_dir "/opt/android/system-images/android-${EMULATOR_API_LEVEL}/${EMULATOR_IMG_TYPE}/${EMULATOR_SYS_IMG}/data/misc/modem_simulator"
  patch_dir "/home/androidusr/emulator/modem_simulator"
}
echo "[op-shim] PLMN=${PLMN} name=${OP_NAME} imsi=${IMSI} mnc_len=${MNC_LEN} phone=${PHONE_NUMBER} msisdn_seg=${MSISDN_SEG}" >&2
patch_all
# AVD working copy is regenerated from an embedded default at radio init
# (~3 min, past boot) — keep re-patching (operator IMSI/EF_AD/name AND MSISDN)
# until the radio reports our PLMN (then it's authoritative), with a hard ceiling
# as a safety net. Phone-only (no operator) re-patches until the ceiling.
(
  deadline=$(( $(date +%s) + 900 ))
  n=0
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    patch_all
    n=$(( n + 1 ))
    if [ "${HAS_OP}" = "1" ] && [ $(( n % 20 )) -eq 0 ]; then
      cur="$(adb shell getprop gsm.sim.operator.numeric 2>/dev/null | tr -d '\r\n ')"
      [ "${cur}" = "${PLMN}" ] && break
    fi
    sleep 0.1
  done
) >/dev/null 2>&1 &
exec "${REAL}" "$@"
