# WhatBot AI - Baileys WhatsApp Bot for Heroku

This is a persistent WhatsApp bot using the Baileys library, designed to run on Heroku as a worker dyno.

## Setup Instructions

### 1. Create Heroku App

```bash
cd heroku-whatsapp-bot
heroku create your-whatsapp-bot-name
```

### 2. Set Config Variables

Set these environment variables in Heroku Dashboard → Settings → Config Vars:

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | `https://njkmilblorgeaqoyicst.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service role key (from Lovable Cloud) |
| `LOVABLE_API_KEY` | Your Lovable API key |
| `BUSINESS_PHONE` | Your WhatsApp phone number (e.g., `+1234567890`) |

### 3. Deploy to Heroku

```bash
git init
heroku git:remote -a your-whatsapp-bot-name
git add .
git commit -m "Initial deploy"
git push heroku main
```

### 4. Scale the Worker Dyno

```bash
heroku ps:scale worker=1
```

### 5. View Logs to Get QR Code

```bash
heroku logs --tail
```

Scan the QR code shown in the logs with your WhatsApp to connect.

## Important Notes

### Session Persistence

The auth session is stored in `auth_info_baileys/`. On Heroku's ephemeral filesystem, this will be lost on dyno restart. For production, consider:

1. **Heroku Add-on**: Use Redis to store session (requires code modification)
2. **External Storage**: Store session in S3 or similar
3. **Manual Re-auth**: Be prepared to re-scan QR code after dyno restarts

### First-Time Setup

1. After deploying, watch the logs (`heroku logs --tail`)
2. A QR code will appear - scan it with WhatsApp
3. Once connected, the bot will start responding to messages

### Linking to Your Business

Before using the bot, make sure to:

1. Go to your WhatBot AI dashboard
2. Navigate to "Link WhatsApp"
3. Enter the phone number you're using with Baileys
4. Click "Connect" to register it in the database

## Troubleshooting

### Bot Not Responding

- Check logs: `heroku logs --tail`
- Verify all config vars are set correctly
- Ensure the phone number is linked to a business in the dashboard

### QR Code Not Showing

- Make sure the worker dyno is running: `heroku ps`
- Check for errors in logs

### Connection Drops

- Heroku dynos restart every 24 hours
- Consider upgrading to a paid dyno for more stability
- Session will need to be re-authenticated after restart

## Tech Stack

- **Baileys**: WhatsApp Web API library
- **Supabase**: Database for conversations and messages
- **Lovable AI Gateway**: AI responses using Gemini Flash

## Warning

⚠️ Using unofficial WhatsApp libraries like Baileys may violate WhatsApp Terms of Service. Use at your own risk. Your account may be banned.
