#!/usr/bin/env bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치하세요."
  exit 1
fi
node scripts/check-deps.cjs >/dev/null 2>&1 || npm install --omit=dev || exit 1
OPEN_BROWSER=1 exec node server/index.js
