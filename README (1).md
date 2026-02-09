# WhatsApp Bot for Heroku

A WhatsApp bot using Baileys that connects to your Lovable Cloud backend.

## Quick Deploy

```bash
# Clone your repo
git clone https://github.com/YOUR_USERNAME/whatsapp-bot-heroku.git
cd whatsapp-bot-heroku

# Login to Heroku
heroku login

# Create app
heroku create your-app-name

# Set environment variables
heroku config:set SUPABASE_URL=https://njkmilblorgeaqoyicst.supabase.co
heroku config:set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
heroku config:set LOVABLE_API_KEY=your_lovable_api_key
heroku config:set BUSINESS_PHONE=your_whatsapp_number

# Deploy
git add .
git commit -m "Deploy WhatsApp bot"
git push heroku main
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (from Lovable Cloud settings) |
| `LOVABLE_API_KEY` | Lovable AI Gateway API key |
| `BUSINESS_PHONE` | Your WhatsApp business phone number |

## View QR Code

After deployment, visit:
```
https://your-app-name.herokuapp.com/qr
```

Scan the QR code with WhatsApp to link your device.

## Troubleshooting

### Common Heroku Errors

1. **H10 - App crashed**: Check logs with `heroku logs --tail`
2. **Missing dependencies**: Run `npm install` locally first
3. **Port binding**: App uses `process.env.PORT` automatically

### View Logs
```bash
heroku logs --tail
```

### Restart App
```bash
heroku restart
```

## Important Notes

- Heroku free dynos sleep after 30 minutes of inactivity
- Consider upgrading to a paid dyno for 24/7 operation
- Session persists in `auth_info/` folder (may need Redis for production)
