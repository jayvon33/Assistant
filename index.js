const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { createClient } = require("@supabase/supabase-js");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// Environment variables (set these in Heroku Config Vars)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
const BUSINESS_PHONE = process.env.BUSINESS_PHONE; // Your WhatsApp business phone number

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Logger
const logger = pino({ level: "info" });

// Auth state directory
const AUTH_DIR = "./auth_info_baileys";

async function getBusinessByPhone(phoneNumber) {
  // Find WhatsApp connection by phone number
  const { data: connection } = await supabase
    .from("whatsapp_connections")
    .select("*, businesses!businesses_whatsapp_connection_id_fkey(*)")
    .eq("phone_number", phoneNumber)
    .eq("status", "connected")
    .single();

  if (!connection || !connection.businesses?.[0]) {
    return null;
  }

  return connection.businesses[0];
}

async function processMessage(businessId, customerPhone, customerMessage) {
  try {
    // Fetch business details
    const { data: business, error: businessError } = await supabase
      .from("businesses")
      .select("*")
      .eq("id", businessId)
      .single();

    if (businessError || !business) {
      throw new Error("Business not found");
    }

    // Get or create conversation
    let conversation;
    const { data: existing } = await supabase
      .from("conversations")
      .select("*")
      .eq("business_id", businessId)
      .eq("customer_phone", customerPhone)
      .eq("status", "active")
      .single();

    if (existing) {
      conversation = existing;
    } else {
      const { data: newConvo, error: convoError } = await supabase
        .from("conversations")
        .insert({
          business_id: businessId,
          customer_phone: customerPhone,
          status: "active",
        })
        .select()
        .single();

      if (convoError) throw convoError;
      conversation = newConvo;
    }

    // Save customer message
    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      content: customerMessage,
      sender_type: "customer",
      message_type: "text",
    });

    // Get conversation history
    const { data: history } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true })
      .limit(20);

    // Build messages for AI
    const conversationHistory = (history || []).map((msg) => ({
      role: msg.sender_type === "customer" ? "user" : "assistant",
      content: msg.content,
    }));

    // Build system prompt
    const systemPrompt = buildSystemPrompt(business);

    // Call Lovable AI Gateway
    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            { role: "system", content: systemPrompt },
            ...conversationHistory,
          ],
          stream: false,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error("AI gateway error");
    }

    const aiResponse = await response.json();
    const aiMessage =
      aiResponse.choices?.[0]?.message?.content ||
      "I apologize, I couldn't process that request.";

    // Save AI response
    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      content: aiMessage,
      sender_type: "bot",
      message_type: "text",
    });

    // Update conversation last_message_at
    await supabase
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversation.id);

    return aiMessage;
  } catch (error) {
    console.error("Error processing message:", error);
    return "Sorry, I'm having trouble processing your message right now. Please try again later.";
  }
}

function buildSystemPrompt(business) {
  const toneDescriptions = {
    friendly:
      "Be warm, approachable, and use casual language with emojis occasionally.",
    professional: "Be polite, formal, and business-like in your responses.",
    playful:
      "Be fun, energetic, and use emojis and exclamation marks liberally!",
    formal: "Be very formal, proper, and courteous in all communications.",
  };

  const toneInstruction =
    toneDescriptions[business.tone] || toneDescriptions.friendly;

  let prompt = `You are an AI customer service assistant for ${business.name}.

Business Description: ${business.description || "A customer-focused business."}

Communication Style: ${toneInstruction}

${business.welcome_message ? `Welcome Message: ${business.welcome_message}` : ""}
`;

  if (
    business.products &&
    Array.isArray(business.products) &&
    business.products.length > 0
  ) {
    prompt += `\nProducts/Services:\n`;
    business.products.forEach((product) => {
      prompt += `- ${product.name}: ${product.description || ""} ${product.price ? `(Price: ${product.price})` : ""}\n`;
    });
  }

  if (business.faqs && Array.isArray(business.faqs) && business.faqs.length > 0) {
    prompt += `\nFrequently Asked Questions:\n`;
    business.faqs.forEach((faq) => {
      prompt += `Q: ${faq.question}\nA: ${faq.answer}\n\n`;
    });
  }

  if (business.custom_instructions) {
    prompt += `\nAdditional Instructions: ${business.custom_instructions}\n`;
  }

  prompt += `
Guidelines:
- Keep responses concise and helpful
- If you don't know something, politely say so
- Always be ready to help with orders, questions, or concerns
- If the customer needs human assistance, let them know someone will contact them
- Never make up information about products or policies you don't have
`;

  return prompt;
}

async function startBot() {
  console.log("🚀 Starting WhatsApp Bot...");

  // Ensure auth directory exists
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["WhatBot AI", "Chrome", "1.0.0"],
  });

  // Handle connection updates
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Scan the QR code above with WhatsApp to connect!\n");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log(
        "Connection closed due to:",
        lastDisconnect?.error?.message,
        "Reconnecting:",
        shouldReconnect
      );

      if (shouldReconnect) {
        setTimeout(() => startBot(), 5000);
      } else {
        console.log("Logged out. Please delete auth_info_baileys folder and restart.");
      }
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
      
      // Update connection status in database if phone is configured
      if (BUSINESS_PHONE) {
        await supabase
          .from("whatsapp_connections")
          .update({ 
            status: "connected", 
            connected_at: new Date().toISOString() 
          })
          .eq("phone_number", BUSINESS_PHONE);
      }
    }
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip if not a regular message or from self
      if (!msg.message || msg.key.fromMe) continue;

      // Get message content
      const messageContent =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!messageContent) continue;

      // Extract sender phone number (remove @s.whatsapp.net)
      const senderJid = msg.key.remoteJid;
      const customerPhone = senderJid.replace("@s.whatsapp.net", "");

      console.log(`📩 Message from ${customerPhone}: ${messageContent}`);

      // Get business for this phone
      const business = await getBusinessByPhone(BUSINESS_PHONE);

      if (!business) {
        console.log("No business configured for this phone number");
        await sock.sendMessage(senderJid, {
          text: "Sorry, this bot is not configured yet. Please try again later.",
        });
        continue;
      }

      // Process message and get AI response
      const aiResponse = await processMessage(
        business.id,
        customerPhone,
        messageContent
      );

      // Send response
      await sock.sendMessage(senderJid, { text: aiResponse });
      console.log(`📤 Sent response to ${customerPhone}`);
    }
  });
}

// Start the bot
startBot().catch(console.error);

// Keep process alive
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  process.exit(0);
});
