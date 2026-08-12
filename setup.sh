sudo apt-get update -qq

# libasound2 package name differs between Ubuntu versions.
# `apt-cache show` returns 0 for virtual/transitional packages even when no
# installable candidate exists, so use `apt-cache policy` and check that a
# candidate version is actually available.
ALSA_PKG="libasound2"
if ! apt-cache policy "$ALSA_PKG" 2>/dev/null | grep -q "Candidate:.*[0-9]"; then
  ALSA_PKG="libasound2t64"
fi

# On Ubuntu 24.04 several GNOME/atk libraries gained a t64 suffix.
resolve_pkg () {
  for p in "$@"; do
    if apt-cache policy "$p" 2>/dev/null | grep -q "Candidate:.*[0-9]"; then
      printf '%s' "$p"; return 0
    fi
  done
  printf '%s' "$1"; return 1
}
ATK_PKG=$(resolve_pkg libatk1.0-0 libatk1.0-0t64)
ATK_BRIDGE_PKG=$(resolve_pkg libatk-bridge2.0-0 libatk-bridge2.0-0t64)

sudo apt-get install -y -qq \
  "$ATK_PKG" \
  "$ATK_BRIDGE_PKG" \
  libcups2 \
  libdrm2 \
  libdbus-1-3 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libpango-1.0-0 \
  libcairo2 \
  libnspr4 \
  libnss3 \
  libxfixes3 \
  "$ALSA_PKG" \
  libx11-xcb1 \
  libxcb1 \
  libxext6 \
  libxrender1 \
  libxtst6 \
  libxi6 \
  libxss1 \
  fonts-noto-color-emoji \
  fonts-freefont-ttf \
  fonts-unifont \
  fonts-ipafont-gothic \
  fonts-wqy-zenhei \
  fonts-tlwg-loma-otf
