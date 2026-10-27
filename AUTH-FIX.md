# Authentication setup

Kernote sekarang memakai Firebase Authentication **Email/Password saja**. Google Sign-In dihapus dari dashboard dan halaman authorization MCP.

Routes:
- `/` — login dengan email + password
- `/register` — registrasi akun baru dengan email + password
- `/oauth-login` — login email + password untuk proses otorisasi MCP

Di Firebase Console → Authentication → Sign-in method, aktifkan **Email/Password**.

Password yang dibuat user pada halaman `/register` adalah password akun Firebase untuk login berikutnya. Tidak ada password Firebase terpisah.


## Firebase Admin backend

Backend Kernote memakai Firebase Admin SDK modular API. Untuk konfigurasi backend lokal, isi `firebase.serviceAccount` dengan nilai dari file JSON service account: `project_id` ke `projectId`, `client_email` ke `clientEmail`, dan `private_key` ke `privateKey`. Backend juga menerima `FIREBASE_SERVICE_ACCOUNT_JSON` yang berisi seluruh JSON service account, atau tiga environment variable `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, dan `FIREBASE_PRIVATE_KEY`.

Jangan mengubah isi private key selain membiarkan `\n` sebagai pemisah baris saat disimpan dalam string JavaScript.
