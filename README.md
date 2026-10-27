# Kernote-Node-beta

serverless MCP utility platform untuk Vercel dengan Firebase Authentication, Firebase Realtime Database, OAuth 2.1 + PKCE, statistik penggunaan tool, credential per-user terenkripsi, dan cloud Markdown notes yang bisa dikontrol akses AI-nya per note.

## arsitektur

```text
Claude / MCP client
        |
        | OAuth 2.1 + PKCE
        v
Kernote-Node-beta /mcp
        |
        +--> Firebase Auth / UID
        |
        +--> RTDB
        |     +-- users/{uid}/profile
        |     +-- users/{uid}/stats (tool analytics + quotaTools/{tool}/count)
        |     +-- users/{uid}/credentials/* (ciphertext AES-256-GCM)
        |     +-- users/{uid}/notes/* (Markdown; optional AES-256-GCM at rest)
        |     +-- oauth/* (hashed auth codes/tokens)
        |
        +--> external APIs
              +-- BMKG
              +-- Google News RSS
              +-- Open-Meteo
              +-- GitHub
              +-- npm
              +-- Wikipedia
              +-- REST Countries
              +-- USGS
              +-- dan lain-lain
```

kuota per tool disimpan di `users/{uid}/stats/quotaTools/{tool}/count`: akun biasa mendapat 400 pemanggilan per tool, sedangkan akun yang diizinkan tidak dibatasi.

Credential asli tidak disimpan plaintext di RTDB. Backend mengenkripsi value menggunakan AES-256-GCM sebelum write. Note juga bisa dienkripsi per note; key notes diturunkan dari master encryption key dengan purpose terpisah. Encryption key tidak boleh disimpan di RTDB. Backup master key wajib disimpan terpisah karena dibutuhkan untuk memulihkan credential dan encrypted notes.

## setup Firebase

1. Firebase Authentication: aktifkan Email/Password. Google Sign-In tidak digunakan.
2. Realtime Database: buat database pada project Firebase kamu (ganti REPLACE_PROJECT_ID dengan project ID sendiri).
3. Deploy `database.rules.json` dengan Firebase CLI atau copy rules-nya ke RTDB Rules.
4. Buat service account Firebase Admin dari Firebase/Google Cloud Console.
5. Siapkan konfigurasi backend private sesuai `credential.example.js` (service account, database URL, dan security key).
6. Isi `firebase.serviceAccount.projectId`, `clientEmail`, dan `privateKey`.
7. Generate encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Masukkan hasilnya ke `security.credentialEncryptionKey`.

Konfigurasi backend private tidak boleh di-commit. Jangan commit private key service account, Gmail app password, GitHub PAT, atau master encryption key.

Firebase web configuration yang dipakai browser boleh berada di frontend; credential backend yang memiliki hak istimewa tetap private.

## install, jalankan lokal, dan deploy

### persiapan

- Node.js 22 atau lebih baru (`node -v`)
- npm (ikut dengan Node.js)
- `credential.js` dibuat sendiri dari contoh, lalu diisi kredensial kamu:

```bash
cp credential.example.js credential.js
```

`credential.js` sengaja di-ignore git. Jangan pernah di-commit atau dibagikan.

### jalankan lokal dengan start.bash

```bash
chmod +x start.bash   # cukup sekali
./start.bash
```

Script `start.bash` akan:

1. mengecek `credential.js` dan versi Node.js
2. menjalankan `npm install` kalau folder `node_modules` belum ada
3. mengecek Vercel CLI. kalau belum ada, script **bertanya dulu** (`[y/N]`) sebelum install `vercel` secara global
4. menjalankan `vercel dev`, lalu server bisa diakses di `http://localhost:3000`

Kalau kamu menolak install Vercel CLI, script akan menjalankan `node local-server.js` (sama dengan `npm start`). Mode ini tanpa simulasi routing Vercel, jadi rewrite di `vercel.json` (misalnya `/mcp`) tidak aktif. Endpoint MCP tetap tersedia di `http://localhost:3000/mcp`.

Saat pertama kali menjalankan `vercel dev`, Vercel CLI bisa meminta kamu menautkan folder ke project. Ikuti promptnya.

### npm module

Semua dependency ada di `package.json`, dan `npm install` akan memasangnya. Yang paling penting:

- `firebase-admin`: akses Firebase Admin untuk RTDB dan verifikasi token
- `axios`, `bottleneck`, `p-limit`, `p-retry`: HTTP client dan pembatasan request ke API eksternal
- `cheerio`, `linkedom`, `htmlparser2`, `parse5`, `@mozilla/readability`, `turndown`: parsing dan ekstraksi HTML
- `quickjs-emscripten`: eksekusi JavaScript yang terisolasi untuk tool `javascript`
- `nodemailer`, `mailparser`: fitur Gmail
- `zod`: validasi input tool
- `luxon`, `date-fns`, `dayjs`, `rrule`: tanggal dan waktu

Untuk memasang manual:

```bash
npm install
```

Script tambahan:

```bash
npm run check        # cek syntax file utama
npm run smoke        # smoke test
npm run check-deps   # cek dependency
```

### deploy ke Vercel

```bash
npm install
vercel --prod
```

Setelah deploy, halaman dashboard ada di:

```text
https://DOMAIN-KAMU.vercel.app/
```

Endpoint MCP:

```text
https://DOMAIN-KAMU.vercel.app/mcp
```

Saat client MCP melakukan koneksi pertama, endpoint MCP mengembalikan challenge OAuth. Client menemukan metadata OAuth, membuka portal login, lalu melakukan authorization code + PKCE. Setelah token diterima, request MCP dipetakan ke Firebase UID. Perubahan credential di dashboard otomatis berlaku pada tool call berikutnya karena credential selalu dibaca dari RTDB berdasarkan UID. Deskripsi tool GitHub/Gmail memakai credential akun yang sedang terautentikasi, bukan credential global aplikasi.

Catatan: `credential.js` tidak ikut ke repo. Sebelum deploy, pastikan konfigurasi backend (service account, encryption key) tersedia di environment deploy dengan cara yang kamu pilih sendiri.

## credential per-user

Dashboard saat ini menyediakan:

- GitHub PAT
- Gmail email + app password

Value disimpan dalam bentuk encrypted record di:

```text
users/{uid}/credentials/github
users/{uid}/credentials/gmail
```

Dashboard tidak pernah menampilkan kembali token atau app password penuh.

Untuk mode personal lama, `server.accessToken` masih tersedia sebagai legacy bearer token. Untuk deployment multi-user, gunakan Firebase OAuth.

## cloud notes

Dashboard memiliki editor Markdown untuk catatan cloud per-user. Setiap note memiliki:

```text
noteId
judul
description (maksimal 300 karakter)
content (Markdown)
status: draft | published
visibility: public | private
encrypted: true | false
createdAt
updatedAt
```

`noteId` unik per akun dan hanya boleh berisi huruf, angka, `-`, atau `_` tanpa spasi.

Aturan MCP:

- `notes_list` hanya mengembalikan `noteId`, `title`, `description`, `status`, dan `updatedAt` untuk note `public`.
- `notes_get` menerima `noteId` secara eksplisit dan hanya dapat membaca note `public`.
- `notes_create`, `notes_update`, `notes_append`, dan `notes_delete` bekerja pada note milik UID yang sedang terautentikasi.
- `private` berarti note tidak muncul di `notes_list` dan tidak dapat dibuka melalui MCP.
- `encrypted` hanya mengatur penyimpanan content di RTDB. Note `public` yang terenkripsi tetap didekripsi server saat `notes_get`, lalu Markdown asli dikembalikan ke model.
- Dashboard dapat mengubah visibility dan encryption kapan saja.

`notes_list` sengaja tidak mengembalikan content. Model harus memanggil `notes_get` secara eksplisit memakai `noteId`.

## statistik

Setiap `tools/call` yang datang dari user OAuth mencatat:

```text
users/{uid}/stats/totalCalls
users/{uid}/stats/successCalls
users/{uid}/stats/errorCalls
users/{uid}/stats/tools/{toolName}/count
users/{uid}/stats/tools/{toolName}/success
users/{uid}/stats/tools/{toolName}/lastUsedAt
users/{uid}/stats/tools/{toolName}/lastDurationMs
users/{uid}/stats/days/{YYYY-MM-DD}
```

Dashboard membaca statistik akun sendiri melalui Firebase RTDB listener.

## javascript execution

`javascript_execute` menjalankan tugas JavaScript singkat di runtime QuickJS/WebAssembly yang terpisah dari runtime Node.js aplikasi. Tool ini mendukung top-level `await`, `return`, penangkapan `console.log` ke `stdout`, penangkapan `console.warn`/`console.error` ke `stderr`, nilai hasil, error terstruktur, serta metadata request jaringan. Ini bukan Node.js `eval()` di proses utama.

Batas default: kode maksimal 32 KiB, timeout default 20 detik (maksimum 30 detik, tidak termasuk inisialisasi QuickJS/WASM), memori QuickJS 24 MiB, stack 512 KiB, output log 24 KiB, hasil 96 KiB, hingga 8 request jaringan, total respons jaringan 768 KiB, maksimal 256 KiB per respons, dan satu email per eksekusi. Vercel function `/api/mcp` dikonfigurasi dengan `maxDuration: 60` agar proses bisa menyelesaikan eksekusi dan merakit respons MCP tanpa batas lama 10 detik.

`axios` dan `fetch` merupakan facade sandbox yang meneruskan request ke HTTP helper Kernote; redirect diperiksa per langkah, URL dibatasi ke HTTP/HTTPS, target privat/internal ditolak, response hanya teks, dan limit request tetap berlaku. `nodemailer` juga berupa facade; jika Gmail terhubung, satu email bisa dikirim menggunakan credential akun terautentikasi tanpa memaparkan app password ke kode. Hanya OAuth access token yang dipetakan ke UID pengguna yang dapat memakai tool ini; mode static bearer tanpa UID ditolak.

Modul terpilih yang tersedia melalui `require()` meliputi `axios`, `cheerio`, `tough-cookie`, `form-data`, `qs`, `ipaddr.js`, `zod`, `lodash`, `json5`, `fast-xml-parser`, `xmlbuilder2`, `csv-parse`, `csv-stringify`, `yaml`, `toml`, `smol-toml`, `jsonpath-plus`, `jmespath`, `dayjs`, `luxon`, `date-fns`, `rrule`, `uuid`, `nanoid`, `base64-js`, `he`, `iconv-lite`, `linkedom`, `parse5`, `marked`, `turndown`, `sanitize-html`, `htmlparser2`, `rss-parser`, `robots-parser`, `@mozilla/readability`, `mailparser`, `email-addresses`, `validator`, `semver`, `minimatch`, `micromatch`, `diff`, `slugify`, `pluralize`, `fast-deep-equal`, `deepmerge`, `p-limit`, `bottleneck`, `p-retry`, serta builtin terbatas `assert`, `buffer`, `crypto`, `events`, `path`, `querystring`, `stream`, `string_decoder`, `url`, dan `util`. HTTP/socket mentah, `fs`, `child_process`, `worker_threads`, `cluster`, `vm`, `process`, `net`, `tls`, `dns`, dan `os` tidak tersedia kepada kode sandbox.

Batas keamanan perlu dipahami: QuickJS memisahkan kode pengguna dari Node.js dan membatasi memori/eksekusi sinkron; semua jaringan yang disediakan lewat facade Kernote dibatasi, tetapi tidak semua API callback dari modul Node-style cocok dengan semua modul yang dijembatani. Untuk operasi callback-heavy, gunakan pola sinkron/async yang didukung oleh wrapper atau proses data langsung di JavaScript guest. Hanya jalankan tugas pada endpoint dan data yang memang boleh diakses. Tool tidak ditujukan untuk task persisten, worker jangka panjang, atau job di background.

## tool catalog

Saat ini ada 64 tool.

### web / HTTP

- `http_request`
- `http_headers`
- `url_inspector`
- `webpage_extract`
- `website_metadata`
- `robots_txt`
- `sitemap`
- `favicon`
- `url_download`
- `port_check`

### weather / geospatial / public data

- `weather`
- `geocoding`
- `timezone`
- `air_quality`
- `sunrise_sunset`
- `public_holidays`
- `earthquake`
- `earthquake_bmkg`
- `bmkg_weather`
- `bmkg_marine_meta`
- `bmkg_marine_forecast`

### news / knowledge

- `news_search`
- `news_headlines`
- `rss_feed`
- `wikipedia_search`
- `wikipedia_summary`
- `country_info`

### finance / market

- `currency`
- `crypto_price`
- `gold_price`
- `stock_price`

### DNS / network / TLS

- `dns_lookup`
- `dns_propagation`
- `whois`
- `ip_info`
- `public_ip`
- `ssl_check`

### developer ecosystem

- `github`
- `github_raw`
- `github_releases`
- `npm`
- `npm_downloads`

### communication / social

- `send_email`
- `stalk_tiktok`

### cloud notes

- `notes_list`
- `notes_get`
- `notes_create`
- `notes_update`
- `notes_append`
- `notes_delete`

### web security assessment

- `websec_scan`
- `websec_recon`
- `websec_fingerprint`
- `websec_headers`
- `websec_csp`
- `websec_methods`
- `websec_exposure`
- `websec_sensitive_paths`
- `websec_frontend`
- `websec_mixed_content`
- `websec_xss`
- `websec_tls`
- `websec_dns`

Web security tools dibuat untuk assessment ringan/non-destructive pada target yang memang diizinkan untuk diuji. Modul XSS hanya melakukan benign reflected-input check dan tidak membuktikan exploitability.

## BMKG

`earthquake_bmkg` mengambil data dari portal Data Gempabumi terbuka BMKG. `bmkg_weather` memakai endpoint prakiraan cuaca publik BMKG berbasis kode ADM4. `bmkg_marine_*` memakai public maritime API BMKG.

BMKG meminta aplikasi yang menggunakan datanya mencantumkan BMKG sebagai sumber.

## local checks

Tanpa dependency install, syntax seluruh JavaScript dapat diperiksa:

```bash
find . -name '*.js' -not -path './node_modules/*' -print0 | xargs -0 -n1 node --check
```

`npm install` dibutuhkan sebelum menjalankan deployment/production karena project memakai `firebase-admin` dan `nodemailer`.

## catatan deployment

Project ini stateless pada level HTTP function. Credential dan statistik persisten berada di RTDB. OAuth code/token disimpan sebagai record hashed agar access token plaintext tidak menjadi key database.

Tool yang mengambil data eksternal tetap dibatasi ke response JSON/text dan tidak sengaja membawa media besar ke response MCP.


## Troubleshooting

### Email login: `auth/invalid-credential`
Firebase uses this when the supplied email/password credential is rejected. A common case is an account that was created with Google and therefore does not have an email/password provider. The dashboard uses a dedicated email/password login page; new accounts are created from `/register`, and the login page includes password reset.

## tool usage dan javascript executor

Setiap akun MCP terautentikasi mendapat batas 400 pemanggilan untuk masing-masing tool. Penggunaan dihitung secara atomik sebelum tool dijalankan, sehingga pemanggilan paralel tidak bisa melewati kuota. Akun dengan email `rehanalok99.0@gmail.com`, `nurkhalifah0099@gmail.com`, dan `ryhnardianshh@gmail.com` tidak memiliki batas pemanggilan. Daftar akun pengecualian harus tetap dikontrol dari backend.

Tab statistics menampilkan jumlah pemanggilan dan sisa kuota setiap tool. Tool MCP `usage_read` mengembalikan statistik serupa dalam JSON untuk dipakai AI; argumen opsional `tool` dapat digunakan untuk membaca satu tool tertentu.

`javascript_execute` menggunakan QuickJS/WASM terisolasi. Budget eksekusi kode pengguna dimulai setelah runtime dan bridge tepercaya selesai diinisialisasi; cold-start tidak lagi menghabiskan budget kode yang sebelumnya dibatasi 6,5-7 detik. Budget default saat ini 20 detik dengan batas maksimum 30 detik. `api/mcp.js` dikonfigurasi dengan `maxDuration: 60` agar QuickJS, request jaringan, autentikasi, pencatatan usage, dan respons MCP tidak dipaksa selesai dalam 10 detik. Penggunaan jaringan tetap dibatasi jumlah request, ukuran respons, timeout per request, dan sisa waktu eksekusi.
