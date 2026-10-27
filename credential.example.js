module.exports = {
  multiUser: {
    enabled: true
  },
  server: {
    // legacy static token; leave empty when using Firebase OAuth.
    accessToken: ""
  },
  firebase: {
    webApiKey: "REPLACE_WITH_FIREBASE_WEB_API_KEY",
    databaseURL: "https://REPLACE_PROJECT_ID-default-rtdb.REGION.firebasedatabase.app",
    serviceAccount: {
      // Bisa diisi dari JSON service account Firebase:
      // project_id     -> projectId
      // client_email   -> clientEmail
      // private_key    -> privateKey
      projectId: "REPLACE_PROJECT_ID",
      clientEmail: "firebase-adminsdk-REPLACE@REPLACE_PROJECT_ID.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\\nREPLACE_ME\\n-----END PRIVATE KEY-----\\n"
    }
  },
  security: {
    // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    credentialEncryptionKey: "REPLACE_WITH_32_BYTE_BASE64_KEY",
    allowPrivateTargets: false
  },
  // Legacy global credential fallback. In multiUser mode, GitHub/Gmail values are taken
  // from users/{uid}/credentials and managed from the dashboard. These stay empty.
  github: { token: "" },
  gmail: { user: "", appPassword: "" },
  services: {
    newsApi: "",
    coinGecko: "",
    ipInfo: ""
  }
};
