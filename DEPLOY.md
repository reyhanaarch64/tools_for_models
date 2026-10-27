# Deploy · Kernote-Node-beta

IMPORTANT: run Vercel from this project folder, the folder that contains `package.json` and `vercel.json`.

```bash
npm install
vercel --prod
```

Vercel is configured with `installCommand: npm install --no-audit --no-fund`. The MCP function has `maxDuration: 10` for the Hobby/Free runtime budget. The backend requires Firebase Admin SDK 14.5.0, `quickjs-emscripten` 0.32.0, and Node.js 22+.

If the deployed backend says Firebase Admin SDK cannot be loaded, inspect the Vercel build log and confirm the install step completed successfully. Do not deploy from the parent folder of this project. The first build installs the pinned dependencies in `package.json`; the JavaScript execution tool does not work until the dependency installation completes successfully.
