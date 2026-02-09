import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
const BUSINESS_PHONE = process.env.BUSINESS_PHONE;
const PORT = process.env.PORT || 3000;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Express app for Heroku health check (prevents dyno from sleeping due to no web traffic)
const app = express();

app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    service: 'WhatsApp Bot',
    connected: !!globalSocket
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.get('/qr', (req, res) => {
  if (lastQR) {
    res.send(`<html><body><h1>Scan QR Code</h1><pre style="font-size:8px;line-height:8px;">${lastQR}</pre></body></html>`);
  } else {
    res.send('<html><body><h1>No QR Code</h1><p>Bot may already be connected or QR not yet generated.</p></body></html>');
  }
});

app.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

// Global state
let globalSocket = null;
let lastQR = null;

// Logger
const logger = pino({ level: 'info' });

// Auth state directory
const AUTH_DIR = './auth_info';

// Ensure auth directory exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Get or create conversation
async function getOrCreateConversation(businessId, customerPhone) {
  // Check for existing conversation
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('business_id', businessId)
    .eq('customer_phone', customerPhone)
    .single();

  if (existing) {
    return existing;
  }

  // Create new conversation
  const { data: newConv, error } = await supabase
    .from('conversations')
    .insert({
      business_id: businessId,
      customer_phone: customerPhone,
      status: 'active'
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating conversation:', error);
    throw error;
  }

  return newConv;
}

// Save message to database
async function saveMessage(conversationId, content, senderType, whatsappMessageId = null) {
  const { error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      content,
      sender_type: senderType,
      whatsapp_message_id: whatsappMessageId
    });

  if (error) {
    console.error('Error saving message:', error);
  }

  // Update conversation last_message_at
  await supabase
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);
}

// Get business context for AI
async function getBusinessContext(businessId) {
  const { data: business } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', businessId)
    .single();

  if (!business) return null;

  let systemPrompt = `You are a helpful customer service assistant for ${business.name}.`;
  
  if (business.description) {
    systemPrompt += ` About the business: ${business.description}`;
  }
  
  if (business.tone) {
    systemPrompt += ` Communication style: ${business.tone}`;
  }
  
  if (business.products) {
    systemPrompt += ` Products/Services: ${JSON.stringify(business.products)}`;
  }
  
  if (business.faqs) {
    systemPrompt += ` FAQs: ${JSON.stringify(business.faqs)}`;
  }
  
  if (business.custom_instructions) {
    systemPrompt += ` Additional instructions: ${business.custom_instructions}`;
  }

  return systemPrompt;
}

// Get conversation history
async function getConversationHistory(conversationId, limit = 10) {
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!messages) return [];

  return messages.reverse().map(msg => ({
    role: msg.sender_type === 'customer' ? 'user' : 'assistant',
    content: msg.content
  }));
}

// Generate AI response using Lovable AI Gateway
async function generateAIResponse(systemPrompt, conversationHistory, userMessage) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await fetch('https://ai-gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LOVABLE_API_KEY}`
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages,
        max_tokens: 500,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI Gateway error:', errorText);
      throw new Error(`AI Gateway error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error('Error generating AI response:', error);
    return "I'm sorry, I'm having trouble processing your request right now. Please try again later.";
  }
}

// Find business by phone number
async function findBusinessByPhone(phoneNumber) {
  // Clean the phone number
  const cleanPhone = phoneNumber.replace(/\D/g, '');
  
  const { data: connection } = await supabase
    .from('whatsapp_connections')
    .select('*, businesses!businesses_whatsapp_connection_id_fkey(*)')
    .or(`phone_number.eq.${cleanPhone},phone_number.eq.+${cleanPhone}`)
    .eq('status', 'connected')
    .single();

  if (connection && connection.businesses && connection.businesses.length > 0) {
    return connection.businesses[0];
  }

  // Fallback: find by BUSINESS_PHONE env var
  if (BUSINESS_PHONE) {
    const { data: businesses } = await supabase
      .from('businesses')
      .select('*')
      .eq('is_active', true)
      .limit(1);
    
    if (businesses && businesses.length > 0) {
      return businesses[0];
    }
  }

  return null;
}

// Handle incoming message
async function handleIncomingMessage(message, sock) {
  try {
    const remoteJid = message.key.remoteJid;
    const customerPhone = remoteJid.replace('@s.whatsapp.net', '');
    const messageContent = message.message?.conversation || 
                          message.message?.extendedTextMessage?.text || 
                          '';

    if (!messageContent) {
      console.log('No text content in message, skipping');
      return;
    }

    console.log(`Received message from ${customerPhone}: ${messageContent}`);

    // Find the business
    const business = await findBusinessByPhone(BUSINESS_PHONE);
    
    if (!business) {
      console.log('No active business found');
      await sock.sendMessage(remoteJid, { 
        text: "Sorry, this service is not currently available." 
      });
      return;
    }

    // Get or create conversation
    const conversation = await getOrCreateConversation(business.id, customerPhone);

    // Save incoming message
    await saveMessage(conversation.id, messageContent, 'customer', message.key.id);

    // Get business context and conversation history
    const systemPrompt = await getBusinessContext(business.id);
    const history = await getConversationHistory(conversation.id);

    // Generate AI response
    const aiResponse = await generateAIResponse(systemPrompt, history, messageContent);

    // Send response
    const sentMessage = await sock.sendMessage(remoteJid, { text: aiResponse });

    // Save bot response
    await saveMessage(conversation.id, aiResponse, 'bot', sentMessage?.key?.id);

    console.log(`Sent response to ${customerPhone}: ${aiResponse.substring(0, 50)}...`);
  } catch (error) {
    console.error('Error handling message:', error);
  }
}

// Start WhatsApp connection
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger,
    browser: ['WhatsApp Bot', 'Chrome', '120.0.0']
  });

  globalSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR Code generated. Scan with WhatsApp:');
      qrcode.generate(qr, { small: true }, (qrString) => {
        lastQR = qrString;
        console.log(qrString);
      });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;

      console.log('Connection closed. Reconnecting:', shouldReconnect);
      
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 5000);
      } else {
        console.log('Logged out. Please delete auth_info folder and restart.');
        // Clean auth folder on logout
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true });
        }
        setTimeout(() => startWhatsApp(), 5000);
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connection established!');
      lastQR = null;
      
      // Update connection status in database
      if (BUSINESS_PHONE) {
        await supabase
          .from('whatsapp_connections')
          .update({ 
            status: 'connected',
            connected_at: new Date().toISOString()
          })
          .or(`phone_number.eq.${BUSINESS_PHONE},phone_number.eq.+${BUSINESS_PHONE}`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    for (const message of messages) {
      // Skip messages from self
      if (message.key.fromMe) continue;
      // Skip group messages
      if (message.key.remoteJid.includes('@g.us')) continue;
      
      await handleIncomingMessage(message, sock);
    }
  });
}

// Validate environment variables
function validateEnv() {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'LOVABLE_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
}

// Main entry point
console.log('Starting WhatsApp Bot...');
validateEnv();
startWhatsApp().catch(console.error);
