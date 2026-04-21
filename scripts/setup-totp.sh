#!/bin/bash

# Copyright 2025 Emmanuel Madehin
# SPDX-License-Identifier: Apache-2.0

# Dployr Admin TOTP Setup
# Generates a TOTP secret, prints config snippets, and renders a
# QR code you can scan directly with Google / Microsoft Authenticator.
#
# Usage:
#   chmod +x setup-totp.sh
#   ./setup-totp.sh
#
# Requirements: openssl, qrencode
#   macOS:  brew install qrencode
#   Debian, Ubuntu: apt-get install qrencode
#   Arch:   pacman -S qrencode

set -euo pipefail

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# Check dependencies
for cmd in openssl qrencode; do
  if ! command -v "$cmd" &>/dev/null; then
    echo -e "${RED}✕ Missing dependency: ${BOLD}${cmd}${RESET}"
    echo -e "  macOS:  ${DIM}brew install ${cmd}${RESET}"
    echo -e "  Debian: ${DIM}apt-get install ${cmd}${RESET}"
    exit 1
  fi
done

# Config
ISSUER="${1:-dployr}"
LABEL="${2:-admin}"

# Generate secret (20 bytes = 160-bit, RFC 4226 compliant) 
SECRET=$(openssl rand 20 | base32 | tr -d '=\n')

# Build otpauth URI
URI="otpauth://totp/${ISSUER}:${LABEL}?secret=${SECRET}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30"

# Print header 
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  Dployr Admin TOTP Setup${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# QR code 
echo -e "${CYAN}  Scan this with Google Authenticator or Microsoft Authenticator:${RESET}"
echo ""
echo "$URI" | qrencode -t UTF8 -m 2
echo ""

# Secret 
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${YELLOW}  ⚠  Save the secret below. This is the only time it is shown.${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${DIM}Secret (Base32):${RESET}"
echo -e "  ${GREEN}${BOLD}${SECRET}${RESET}"
echo ""

# config.toml snippet 
echo -e "  ${DIM}Add to your config.toml:${RESET}"
echo ""
echo -e "  ${DIM}[admin]${RESET}"
echo -e "  ${CYAN}totp_secret = \"${SECRET}\"${RESET}"
echo ""

# .env / environment variable 
echo -e "  ${DIM}Or as an environment variable:${RESET}"
echo ""
echo -e "  ${CYAN}ADMIN_TOTP_SECRET=\"${SECRET}\"${RESET}"
echo ""

# Details 
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${DIM}Issuer   ${RESET}${ISSUER}"
echo -e "  ${DIM}Label    ${RESET}${LABEL}"
echo -e "  ${DIM}Algorithm${RESET}  SHA1"
echo -e "  ${DIM}Digits   ${RESET}  6"
echo -e "  ${DIM}Period   ${RESET}  30s"
echo ""
echo -e "  ${DIM}Override: ${RESET}${DIM}./setup-totp.sh <issuer> <label>${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""