# Deployment Guide — Kitchenware Lead Generator

## What this is
A Node.js backend that:
1. Scrapes Google Maps daily for F&B businesses and interior designers in Singapore
2. Scores and qualifies leads (must have phone or email)
3. Generates personalised WhatsApp/email outreach using Claude AI
4. Notifies you via Telegram when new leads arrive
5. Sends outreach drafts to your WhatsApp for approval before they go out

---

## Step 1 — Get your API keys (30 minutes total)

### Google Maps Places API (10 min)
1. Go to https://console.cloud.google.com
2. Create a new project (e.g. "LeadGen")
3. Go to APIs & Services → Library
4. Search "Places API" → Enable it
5. Go to APIs & Services → Credentials → Create Credentials → API Key
6. Copy the key — paste into `.env` as `GOOGLE_MAPS_API_KEY`
7. Note: Google gives $200 free credit/month. At ~$0.032/request, that's ~6,000 searches free.

### Twilio WhatsApp (10 min)
1. Go to https://www.twilio.com → sign up free
2. Go to Console → Messaging → Try it Out → Send a WhatsApp message
3. Follow the sandbox setup (scan QR code with your phone)
4. Copy Account SID and Auth Token from the main console page
5. Paste into `.env` as `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`
6. Your WhatsApp number goes into `YOUR_WHATSAPP` (e.g. `whatsapp:+6591234567`)

### Telegram Bot (2 min)
1. Open Telegram → search @BotFather → start a chat
2. Send: `/newbot`
3. Follow prompts → give it a name → you'll get a token like `1234567890:ABCdef...`
4. Paste into `.env` as `TELEGRAM_BOT_TOKEN`
5. To get your chat ID: message @userinfobot → it replies with your ID
6. Paste into `.env` as `TELEGRAM_CHAT_ID`

### Anthropic API key (2 min)
1. Go to https://console.anthropic.com → API Keys → Create Key
2. Paste into `.env` as `ANTHROPIC_API_KEY`

---

## Step 2 — Deploy to Railway (5 min)

Railway gives you a free server that runs 24/7.

1. Go to https://railway.app → sign up with GitHub
2. New Project → Deploy from GitHub repo
   (push this folder to a GitHub repo first — make sure `.env` is in `.gitignore`)
3. Once deployed, go to Variables tab
4. Add each key from your `.env.example` file with real values
5. Railway auto-deploys on every push

**Important:** Never commit your `.env` file with real keys to GitHub.

---

## Step 3 — Test it

SSH into Railway or use the Railway shell:

```bash
# Test the scraper (runs 2-3 minutes)
node src/scraper.js

# Check the API is up
curl https://your-app.railway.app/health

# Get leads
curl https://your-app.railway.app/api/leads

# Trigger a manual scrape
curl -X POST https://your-app.railway.app/api/scrape
```

---

## Step 4 — Connect the dashboard

In the lead pipeline dashboard (the Claude artifact), update the API base URL:

Change `API_BASE` from the mock URL to:
```
https://your-app.railway.app
```

The dashboard will then show real leads and generate real outreach.

---

## How outreach approval works

1. Dashboard generates an AI outreach message for a lead
2. You click "Send for approval"
3. You receive a WhatsApp message from the system with the draft
4. Reply YES → message gets sent to the lead
5. Reply NO → skipped, you can edit and retry

This keeps you in control — nothing goes out without your approval.

---

## Costs (approximate)

| Service | Free tier | After free tier |
|---|---|---|
| Google Maps Places | $200/month credit | ~$0.032/request |
| Twilio WhatsApp | 1,000 msgs free | ~$0.005/msg |
| Telegram | Free forever | — |
| Railway | $5/month | — |
| Anthropic | Pay per token | ~$0.003/message |

For your usage (daily scrape + ~20 outreach msgs/day), expect **under $20/month total**.

---

## Troubleshooting

**Scraper returns no results:** Check `GOOGLE_MAPS_API_KEY` is set and Places API is enabled in Google Cloud.

**WhatsApp messages not sending:** Make sure you've joined the Twilio sandbox (scan QR code from the Twilio console).

**Telegram not notifying:** Message your bot first (say hi) — bots can't initiate conversations until you've messaged them once.

**Railway crashing:** Check the logs in Railway dashboard. Most common cause is a missing env variable.
