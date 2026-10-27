#!/data/data/com.termux/files/usr/bin/bash
# jalanin tools_for_models di lokal lewat vercel dev
set -e
cd "$(dirname "$0")"

if [ ! -f credential.js ]; then
  echo "credential.js belum ada. buat dari contoh lalu isi kredensial sendiri:"
  echo "  cp credential.example.js credential.js"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node belum terpasang (butuh versi 22 atau lebih baru)"
  exit 1
fi
if ! node -e 'process.exit(parseInt(process.versions.node, 10) >= 22 ? 0 : 1)'; then
  echo "versi node terlalu lama, butuh 22 atau lebih baru"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "install dependency npm..."
  npm install --no-audit --no-fund
fi

VERCEL_JS=""
if [ -f node_modules/vercel/dist/index.js ]; then
  VERCEL_JS="node_modules/vercel/dist/index.js"
elif [ -f "$(npm root -g)/vercel/dist/index.js" ]; then
  VERCEL_JS="$(npm root -g)/vercel/dist/index.js"
fi

if [ -z "$VERCEL_JS" ]; then
  printf "vercel CLI belum terpasang. install sekarang? [y/N] "
  read -r ans
  case "$ans" in
    y|Y)
      npm install -g vercel
      VERCEL_JS="$(npm root -g)/vercel/dist/index.js"
      ;;
    *)
      echo "dibatalkan. jalanin server tanpa vercel dev lewat: npm start"
      exec node local-server.js
      ;;
  esac
fi

echo "menjalankan vercel dev di http://localhost:3000"
exec node "$VERCEL_JS" dev
