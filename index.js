require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const session = require("express-session");
const calendarService = require("./google-calendar-service");

const app = express();
const PORT = process.env.PORT || 3001;
// Trust reverse proxy (e.g., Render) to get correct client IPs
app.set("trust proxy", true);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware for OAuth
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI environment variable is not set.");
  process.exit(1);
}

const mongoOptions = {
  maxPoolSize: 20,
  serverSelectionTimeoutMS: 5000,
};

if (process.env.MONGO_TLS_CA_FILE) {
  mongoOptions.tls = true;
  mongoOptions.tlsCAFile = path.resolve(process.env.MONGO_TLS_CA_FILE);
}

if (process.env.MONGO_TLS_ALLOW_INVALID === "true") {
  mongoOptions.tls = true;
  mongoOptions.tlsAllowInvalidCertificates = true;
}

const client = new MongoClient(MONGO_URI, mongoOptions);

let db;
let emailTrackingCollection;
let emailOpensCollection;
let emailClicksCollection;
let attachmentTrackingCollection;
let attachmentDownloadsCollection;
let googleUsersCollection;

async function connectToDatabase() {
  await client.connect();
  db = client.db(process.env.MONGO_DB_NAME || "altara_tracking");

  emailTrackingCollection = db.collection("email_tracking");
  emailOpensCollection = db.collection("email_opens");
  emailClicksCollection = db.collection("email_clicks");
  attachmentTrackingCollection = db.collection("attachment_tracking");
  attachmentDownloadsCollection = db.collection("attachment_downloads");
  googleUsersCollection = db.collection("google_users");

  await Promise.all([
    emailTrackingCollection.createIndex({ id: 1 }, { unique: true }),
    emailOpensCollection.createIndex({ emailId: 1 }),
    emailClicksCollection.createIndex({ emailId: 1 }),
    attachmentTrackingCollection.createIndex({ id: 1 }, { unique: true }),
    attachmentTrackingCollection.createIndex({ emailId: 1 }),
    attachmentDownloadsCollection.createIndex({ attachmentId: 1 }),
    googleUsersCollection.createIndex({ email: 1 }, { unique: true }),
    googleUsersCollection.createIndex({ userId: 1 }),
  ]);
}

// Persistent data directory (supports Render Disks) - still used for attachments
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure attachments directory exists within DATA_DIR
const ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");
if (!fs.existsSync(ATTACHMENTS_DIR)) {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
}

// Serve static files from persistent attachments directory
app.use("/attachments", express.static(ATTACHMENTS_DIR));

// 1x1 transparent GIF for tracking pixels
const transparentGif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

const nowIso = () => new Date().toISOString();

const ensureEmailDocument = async (emailId, defaults = {}) => {
  const baseDefaults = {
    id: emailId,
    sentAt: nowIso(),
    status: "sent",
    openCount: 0,
    clickCount: 0,
    attachmentDownloads: 0,
    attachmentOpens: 0,
    ...defaults,
  };

  await emailTrackingCollection.updateOne(
    { id: emailId },
    { $setOnInsert: baseDefaults },
    { upsert: true }
  );
};

// Open tracking endpoint
app.get("/track/open/:emailId", async (req, res) => {
  const { emailId } = req.params;
  const { r: recipientEmail } = req.query;
  const userAgent = req.get("User-Agent") || "";
  const ipAddress = req.ip || req.connection.remoteAddress || "";

  // Validation to prevent false opens
  const isAutomatedRequest = () => {
    // Check for automated user agents
    const automatedAgents = [
      'bot', 'crawler', 'spider', 'scraper', 'preview', 'validator',
      'checker', 'monitor', 'scanner', 'fetcher', 'downloader',
      'email', 'mail', 'client', 'server', 'daemon', 'service'
    ];
    
    const lowerUserAgent = userAgent.toLowerCase();
    if (automatedAgents.some(agent => lowerUserAgent.includes(agent))) {
      return true;
    }

    // Check for common email service IPs or localhost
    if (ipAddress === '127.0.0.1' || ipAddress === '::1' || ipAddress === 'localhost') {
      return true;
    }

    // Check for missing or suspicious user agents
    if (!userAgent || userAgent.length < 10) {
      return true;
    }

    return false;
  };

  // Check if this is likely an automated request
  if (isAutomatedRequest()) {
    console.log(`Skipping automated open tracking: ${emailId} - User-Agent: ${userAgent}, IP: ${ipAddress}`);
    res.set({
      "Content-Type": "image/gif",
      "Content-Length": transparentGif.length,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    return res.send(transparentGif);
  }

  // Additional validation: Check if email was sent recently (within last 30 seconds)
  try {
    const emailDoc = await emailTrackingCollection.findOne({ id: emailId });
    if (emailDoc) {
      const sentTime = new Date(emailDoc.sentAt);
      const now = new Date();
      const timeDiff = now - sentTime;
      
      // If email was sent less than 30 seconds ago, it's likely a false open
      if (timeDiff < 5000) { // 30 seconds
        console.log(`Skipping immediate open tracking: ${emailId} - Email sent ${timeDiff}ms ago`);
        res.set({
          "Content-Type": "image/gif",
          "Content-Length": transparentGif.length,
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        });
        return res.send(transparentGif);
      }
    }
  } catch (error) {
    console.error("Error checking email send time:", error);
  }

  console.log(`Email opened: ${emailId} by ${recipientEmail} - User-Agent: ${userAgent}, IP: ${ipAddress}`);

  const openData = {
    id: crypto.randomBytes(16).toString("hex"),
    emailId,
    recipientEmail,
    userAgent,
    ipAddress,
    timestamp: nowIso(),
    readingTime: null, // Will be updated when user closes email or after timeout
    readingStartTime: nowIso(),
  };

  try {
    await ensureEmailDocument(emailId, { recipientEmail });
    await emailOpensCollection.insertOne(openData);
    await emailTrackingCollection.updateOne(
      { id: emailId },
      {
        $inc: { openCount: 1 },
        $set: { lastOpenedAt: openData.timestamp, recipientEmail },
      }
    );
  } catch (error) {
    console.error("Error recording email open:", error);
  }

  res.set({
    "Content-Type": "image/gif",
    "Content-Length": transparentGif.length,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.send(transparentGif);
});

// Reading time tracking endpoint
app.post("/track/reading-time/:emailId", async (req, res) => {
  const { emailId } = req.params;
  const { readingTime, recipientEmail } = req.body;
  const userAgent = req.get("User-Agent") || "";
  const ipAddress = req.ip || req.connection.remoteAddress || "";

  console.log(`Reading time recorded: ${readingTime}ms for email ${emailId} by ${recipientEmail}`);

  try {
    // Update the most recent open record for this email and recipient
    const updateResult = await emailOpensCollection.updateOne(
      { 
        emailId, 
        recipientEmail,
        readingTime: null // Only update records that don't have reading time yet
      },
      { 
        $set: { 
          readingTime: parseInt(readingTime),
          readingEndTime: nowIso()
        } 
      },
      { sort: { timestamp: -1 } } // Update the most recent open
    );

    if (updateResult.modifiedCount > 0) {
      console.log(`✅ Reading time updated for email ${emailId}`);
      
      // Update email tracking summary with average reading time
      const opens = await emailOpensCollection.find({ 
        emailId, 
        readingTime: { $ne: null } 
      }).toArray();
      
      if (opens.length > 0) {
        const totalReadingTime = opens.reduce((sum, open) => sum + (open.readingTime || 0), 0);
        const averageReadingTime = Math.round(totalReadingTime / opens.length);
        
        await emailTrackingCollection.updateOne(
          { id: emailId },
          { $set: { averageReadingTime } }
        );
      }
    }

    res.json({ success: true, readingTime: parseInt(readingTime) });
  } catch (error) {
    console.error("Error recording reading time:", error);
    res.status(500).json({ success: false, error: "Failed to record reading time" });
  }
});

// Click tracking endpoint
app.get("/track/click/:emailId", async (req, res) => {
  const { emailId } = req.params;
  const { url, r: recipientEmail } = req.query;
  const userAgent = req.get("User-Agent") || "";
  const ipAddress = req.ip || req.connection.remoteAddress || "";

  if (!url) {
    return res.status(400).send("Invalid URL");
  }

  console.log(`Link clicked: ${url} in email ${emailId} by ${recipientEmail}`);

  const clickData = {
    id: crypto.randomBytes(16).toString("hex"),
    emailId,
    url,
    recipientEmail,
    userAgent,
    ipAddress,
    timestamp: nowIso(),
  };

  try {
    await ensureEmailDocument(emailId, { recipientEmail });
    await emailClicksCollection.insertOne(clickData);
    await emailTrackingCollection.updateOne(
      { id: emailId },
      {
        $inc: { clickCount: 1 },
        $set: { lastClickedAt: clickData.timestamp, recipientEmail },
      }
    );
  } catch (error) {
    console.error("Error recording link click:", error);
  }

  res.redirect(decodeURIComponent(url));
});

// Attachment download tracking endpoint
app.get("/track/attachment/:attachmentId", async (req, res) => {
  const { attachmentId } = req.params;
  const { token, action = "download", r: recipientEmail = "" } = req.query;
  const userAgent = req.get("User-Agent") || "";
  const ipAddress = req.ip || req.connection.remoteAddress || "";

  console.log(`Attachment download: ${attachmentId}`);

  try {
    const attachment = await attachmentTrackingCollection.findOne({
      id: attachmentId,
      secureToken: token,
    });
    if (!attachment) {
      return res.status(404).send("Attachment not found or invalid token");
    }

    const downloadData = {
      id: crypto.randomBytes(16).toString("hex"),
      attachmentId,
      recipientEmail,
      userAgent,
      ipAddress,
      timestamp: nowIso(),
      type: action,
    };

    await attachmentDownloadsCollection.insertOne(downloadData);

    await ensureEmailDocument(attachment.emailId, { recipientEmail });

    const updateFields =
      action === "open"
        ? { $inc: { attachmentOpens: 1 } }
        : { $inc: { attachmentDownloads: 1 } };

    await emailTrackingCollection.updateOne(
      { id: attachment.emailId },
      updateFields
    );

    const filePath = path.join(ATTACHMENTS_DIR, attachment.trackedFileName);
    if (fs.existsSync(filePath)) {
      res.set({
        "Content-Type": attachment.contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${attachment.originalFileName}"`,
      });
      return res.sendFile(filePath);
    }

    res.status(404).send("File not found");
  } catch (error) {
    console.error("Error recording attachment download:", error);
    res.status(500).send("Server error");
  }
});

// Unsubscribe endpoint
app.get("/track/unsubscribe/:emailId", (req, res) => {
  const { emailId } = req.params;
  const { r: recipientEmail } = req.query;

  console.log(`Unsubscribe request: ${emailId} for ${recipientEmail}`);

  // In a real implementation, you would:
  // 1. Add the email to an unsubscribe list
  // 2. Update the user's preferences
  // 3. Send a confirmation email

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Désabonnement</title>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        .success { color: #10b981; }
        .info { background: #f3f4f6; padding: 15px; border-radius: 5px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <h1 class="success">✓ Désabonnement réussi</h1>
      <p>Vous avez été désabonné avec succès de nos communications.</p>
      <div class="info">
        <p><strong>Email:</strong> ${recipientEmail}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString("fr-FR")}</p>
      </div>
      <p>Vous ne recevrez plus d'emails de notre part. Si vous souhaitez vous réabonner, vous pouvez nous contacter.</p>
    </body>
    </html>
  `);
});

// Privacy policy endpoint
app.get("/privacy", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Politique de Confidentialité</title>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
        h1, h2 { color: #333; }
        .section { margin: 30px 0; }
      </style>
    </head>
    <body>
      <h1>Politique de Confidentialité</h1>
      
      <div class="section">
        <h2>Collecte de Données</h2>
        <p>Nous collectons des données de tracking pour améliorer nos services :</p>
        <ul>
          <li>Ouvertures d'emails (pixel de tracking)</li>
          <li>Clics sur les liens</li>
          <li>Téléchargements de pièces jointes</li>
          <li>Adresse IP et User-Agent (pour la sécurité)</li>
        </ul>
      </div>

      <div class="section">
        <h2>Utilisation des Données</h2>
        <p>Ces données sont utilisées pour :</p>
        <ul>
          <li>Mesurer l'efficacité de nos campagnes</li>
          <li>Améliorer le contenu de nos emails</li>
          <li>Assurer la sécurité de nos services</li>
        </ul>
      </div>

      <div class="section">
        <h2>Vos Droits</h2>
        <p>Vous avez le droit de :</p>
        <ul>
          <li>Vous désabonner à tout moment</li>
          <li>Demander l'accès à vos données</li>
          <li>Demander la suppression de vos données</li>
        </ul>
      </div>

      <div class="section">
        <h2>Contact</h2>
        <p>Pour toute question concernant cette politique, contactez-nous.</p>
      </div>
    </body>
    </html>
  `);
});

// API endpoints for the Electron app to sync data
app.get("/api/tracking-data", async (req, res) => {
  try {
    const [
      emailTracking,
      emailOpens,
      emailClicks,
      attachmentTracking,
      attachmentDownloads,
    ] = await Promise.all([
      emailTrackingCollection.find().toArray(),
      emailOpensCollection.find().toArray(),
      emailClicksCollection.find().toArray(),
      attachmentTrackingCollection.find().toArray(),
      attachmentDownloadsCollection.find().toArray(),
    ]);

    res.json({
      emailTracking,
      emailOpens,
      emailClicks,
      attachmentTracking,
      attachmentDownloads,
    });
  } catch (error) {
    console.error("Error fetching tracking data:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch tracking data" });
  }
});

app.post("/api/sync-tracking-data", async (req, res) => {
  try {
    const {
      emailTracking: newEmailTracking,
      emailOpens: newEmailOpens,
      emailClicks: newEmailClicks,
      attachmentTracking: newAttachmentTracking,
      attachmentDownloads: newAttachmentDownloads,
    } = req.body;

    if (Array.isArray(newEmailTracking) && newEmailTracking.length) {
      await Promise.all(
        newEmailTracking.map((doc) => ensureEmailDocument(doc.id, doc))
      );
    }

    if (Array.isArray(newEmailOpens) && newEmailOpens.length) {
      await emailOpensCollection.insertMany(newEmailOpens);
    }

    if (Array.isArray(newEmailClicks) && newEmailClicks.length) {
      await emailClicksCollection.insertMany(newEmailClicks);
    }

    if (Array.isArray(newAttachmentTracking) && newAttachmentTracking.length) {
      await attachmentTrackingCollection
        .insertMany(newAttachmentTracking, { ordered: false })
        .catch(() => {});
    }

    if (
      Array.isArray(newAttachmentDownloads) &&
      newAttachmentDownloads.length
    ) {
      await attachmentDownloadsCollection.insertMany(newAttachmentDownloads);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Error syncing tracking data:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to sync tracking data" });
  }
});

// ===== Google Calendar OAuth & API Routes =====

// Google OAuth Login - Redirect to Google
app.get("/auth/google", (req, res) => {
  try {
    const { userId } = req.query; // Optional: pass userId from frontend to track which user is authenticating
    if (userId) {
      req.session.userId = userId;
    }
    const authUrl = calendarService.getAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error("Error generating auth URL:", error);
    res.status(500).json({ error: "Failed to generate auth URL" });
  }
});

// Google OAuth Callback
app.get("/auth/google/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error("OAuth error:", error);
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Error</title>
        <style>
          body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
          .message { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .error { color: #dc2626; }
        </style>
      </head>
      <body>
        <div class="message">
          <h2 class="error">Authentication Failed</h2>
          <p>${error}</p>
          <p>You can close this window and try again.</p>
        </div>
        <script>
          // Try to communicate with Electron if possible
          setTimeout(() => {
            if (window.opener) {
              window.opener.postMessage({ type: 'oauth-error', error: '${error}' }, '*');
              window.close();
            }
          }, 3000);
        </script>
      </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send("Authorization code missing");
  }

  try {
    // Exchange code for tokens
    const tokens = await calendarService.getTokensFromCode(code);
    
    // Get user info from Google
    const userInfo = await calendarService.getUserInfo(tokens.access_token);

    // Store user data in database
    const userData = {
      userId: req.session.userId || crypto.randomBytes(16).toString('hex'),
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await googleUsersCollection.updateOne(
      { email: userInfo.email },
      { $set: userData },
      { upsert: true }
    );

    // Store user session
    req.session.googleUser = {
      userId: userData.userId,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture
    };

    // Send success page that will communicate with Electron
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Successful</title>
        <style>
          body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
          .message { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .success { color: #16a34a; }
          .spinner { border: 3px solid #f3f3f3; border-top: 3px solid #16a34a; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="message">
          <h2 class="success">✓ Authentication Successful!</h2>
          <p>Connected as ${userInfo.email}</p>
          <div class="spinner"></div>
          <p>Redirecting to calendar...</p>
        </div>
        <script>
          // Store user data for the Electron app
          const userData = {
            email: '${userInfo.email}',
            name: '${userInfo.name.replace(/'/g, "\\'")}',
            picture: '${userInfo.picture}'
          };
          
          // Save to localStorage so the Electron app can access it
          localStorage.setItem('googleCalendarEmail', userData.email);
          localStorage.setItem('googleCalendarUser', JSON.stringify(userData));
          
          // Try to communicate with opener window if it exists
          if (window.opener) {
            window.opener.postMessage({ 
              type: 'oauth-success', 
              email: userData.email,
              user: userData
            }, '*');
            setTimeout(() => window.close(), 1000);
          } else {
            // If no opener, redirect after a short delay
            setTimeout(() => {
              window.location.href = 'electron://calendar?success=true&email=${encodeURIComponent(userInfo.email)}';
            }, 2000);
          }
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Error in OAuth callback:", error);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Error</title>
        <style>
          body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
          .message { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .error { color: #dc2626; }
        </style>
      </head>
      <body>
        <div class="message">
          <h2 class="error">Authentication Failed</h2>
          <p>${error.message || 'An error occurred during authentication'}</p>
          <p>You can close this window and try again.</p>
        </div>
        <script>
          setTimeout(() => {
            if (window.opener) {
              window.opener.postMessage({ type: 'oauth-error', error: '${error.message || 'Authentication failed'}' }, '*');
              window.close();
            }
          }, 3000);
        </script>
      </body>
      </html>
    `);
  }
});

// Get current user info
app.get("/api/calendar/user", async (req, res) => {
  try {
    const { email, userId } = req.query;
    
    if (!email && !userId) {
      return res.status(400).json({ error: "Email or userId required" });
    }

    const query = email ? { email } : { userId };
    const user = await googleUsersCollection.findOne(query);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Return user info without sensitive tokens
    res.json({
      userId: user.userId,
      email: user.email,
      name: user.name,
      picture: user.picture,
      isAuthenticated: true
    });
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Get Calendar Events
app.get("/api/calendar/events", async (req, res) => {
  try {
    const { email, userId, timeMin, maxResults } = req.query;

    if (!email && !userId) {
      return res.status(400).json({ error: "Email or userId required" });
    }

    const query = email ? { email } : { userId };
    const user = await googleUsersCollection.findOne(query);

    if (!user) {
      return res.status(404).json({ error: "User not authenticated" });
    }

    const result = await calendarService.getCalendarEvents(
      user.accessToken,
      user.refreshToken,
      {
        timeMin,
        maxResults: maxResults ? parseInt(maxResults) : 50
      }
    );

    // Update access token if it was refreshed
    if (result.accessToken !== user.accessToken) {
      await googleUsersCollection.updateOne(
        { email: user.email },
        { 
          $set: { 
            accessToken: result.accessToken,
            refreshToken: result.refreshToken || user.refreshToken,
            updatedAt: new Date().toISOString()
          } 
        }
      );
    }

    res.json({
      success: true,
      events: result.events
    });
  } catch (error) {
    console.error("Error fetching calendar events:", error);
    res.status(500).json({ error: error.message || "Failed to fetch calendar events" });
  }
});

// Create Calendar Event
app.post("/api/calendar/events", async (req, res) => {
  try {
    const { email, userId, eventData } = req.body;

    if (!email && !userId) {
      return res.status(400).json({ error: "Email or userId required" });
    }

    if (!eventData || !eventData.title || !eventData.startTime || !eventData.endTime) {
      return res.status(400).json({ error: "Event data incomplete (title, startTime, endTime required)" });
    }

    const query = email ? { email } : { userId };
    const user = await googleUsersCollection.findOne(query);

    if (!user) {
      return res.status(404).json({ error: "User not authenticated" });
    }

    const result = await calendarService.createCalendarEvent(
      user.accessToken,
      user.refreshToken,
      eventData
    );

    // Update access token if it was refreshed
    if (result.accessToken !== user.accessToken) {
      await googleUsersCollection.updateOne(
        { email: user.email },
        { 
          $set: { 
            accessToken: result.accessToken,
            refreshToken: result.refreshToken || user.refreshToken,
            updatedAt: new Date().toISOString()
          } 
        }
      );
    }

    res.json({
      success: true,
      event: result.event
    });
  } catch (error) {
    console.error("Error creating calendar event:", error);
    res.status(500).json({ error: error.message || "Failed to create calendar event" });
  }
});

// Update Calendar Event
app.patch("/api/calendar/events/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;
    const { email, userId, eventData } = req.body;

    if (!email && !userId) {
      return res.status(400).json({ error: "Email or userId required" });
    }

    const query = email ? { email } : { userId };
    const user = await googleUsersCollection.findOne(query);

    if (!user) {
      return res.status(404).json({ error: "User not authenticated" });
    }

    const result = await calendarService.updateCalendarEvent(
      user.accessToken,
      user.refreshToken,
      eventId,
      eventData
    );

    // Update access token if it was refreshed
    if (result.accessToken !== user.accessToken) {
      await googleUsersCollection.updateOne(
        { email: user.email },
        { 
          $set: { 
            accessToken: result.accessToken,
            refreshToken: result.refreshToken || user.refreshToken,
            updatedAt: new Date().toISOString()
          } 
        }
      );
    }

    res.json({
      success: true,
      event: result.event
    });
  } catch (error) {
    console.error("Error updating calendar event:", error);
    res.status(500).json({ error: error.message || "Failed to update calendar event" });
  }
});

// Delete Calendar Event
app.delete("/api/calendar/events/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;
    const { email, userId } = req.query;

    if (!email && !userId) {
      return res.status(400).json({ error: "Email or userId required" });
    }

    const query = email ? { email } : { userId };
    const user = await googleUsersCollection.findOne(query);

    if (!user) {
      return res.status(404).json({ error: "User not authenticated" });
    }

    const result = await calendarService.deleteCalendarEvent(
      user.accessToken,
      user.refreshToken,
      eventId
    );

    // Update access token if it was refreshed
    if (result.accessToken !== user.accessToken) {
      await googleUsersCollection.updateOne(
        { email: user.email },
        { 
          $set: { 
            accessToken: result.accessToken,
            refreshToken: result.refreshToken || user.refreshToken,
            updatedAt: new Date().toISOString()
          } 
        }
      );
    }

    res.json({
      success: true,
      message: "Event deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting calendar event:", error);
    res.status(500).json({ error: error.message || "Failed to delete calendar event" });
  }
});

// Logout/Disconnect Google Account
app.post("/api/calendar/disconnect", async (req, res) => {
  try {
    const { email, userId } = req.body;

    if (!email && !userId) {
      return res.status(400).json({ error: "Email or userId required" });
    }

    const query = email ? { email } : { userId };
    await googleUsersCollection.deleteOne(query);

    res.json({
      success: true,
      message: "Google account disconnected successfully"
    });
  } catch (error) {
    console.error("Error disconnecting account:", error);
    res.status(500).json({ error: "Failed to disconnect account" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    data: {
      emails: emailTracking.length,
      opens: emailOpens.length,
      clicks: emailClicks.length,
      attachments: attachmentTracking.length,
      downloads: attachmentDownloads.length,
    },
  });
});

// Start server (ensure DB connection first)
const startServer = async () => {
  try {
    await connectToDatabase();
    console.log("Connected to MongoDB");

    app.listen(PORT, () => {
      console.log(`Tracking server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`Privacy policy: http://localhost:${PORT}/privacy`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log("\nShutting down tracking server...");
  try {
    await client.close();
  } catch (error) {
    console.error("Error closing MongoDB client:", error);
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
