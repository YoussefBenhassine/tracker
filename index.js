require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3001;
// Trust reverse proxy (e.g., Render) to get correct client IPs
app.set('trust proxy', true);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI environment variable is not set.');
  process.exit(1);
}

const mongoOptions = {
  maxPoolSize: 20,
  serverSelectionTimeoutMS: 5000
};

if (process.env.MONGO_TLS_CA_FILE) {
  mongoOptions.tls = true;
  mongoOptions.tlsCAFile = path.resolve(process.env.MONGO_TLS_CA_FILE);
}

if (process.env.MONGO_TLS_ALLOW_INVALID === 'true') {
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

async function connectToDatabase() {
  await client.connect();
  db = client.db(process.env.MONGO_DB_NAME || 'altara_tracking');

  emailTrackingCollection = db.collection('email_tracking');
  emailOpensCollection = db.collection('email_opens');
  emailClicksCollection = db.collection('email_clicks');
  attachmentTrackingCollection = db.collection('attachment_tracking');
  attachmentDownloadsCollection = db.collection('attachment_downloads');

  await Promise.all([
    emailTrackingCollection.createIndex({ id: 1 }, { unique: true }),
    emailOpensCollection.createIndex({ emailId: 1 }),
    emailClicksCollection.createIndex({ emailId: 1 }),
    attachmentTrackingCollection.createIndex({ id: 1 }, { unique: true }),
    attachmentTrackingCollection.createIndex({ emailId: 1 }),
    attachmentDownloadsCollection.createIndex({ attachmentId: 1 })
  ]);
}

// Persistent data directory (supports Render Disks) - still used for attachments
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure attachments directory exists within DATA_DIR
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
if (!fs.existsSync(ATTACHMENTS_DIR)) {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
}

// Serve static files from persistent attachments directory
app.use('/attachments', express.static(ATTACHMENTS_DIR));

// 1x1 transparent GIF for tracking pixels
const transparentGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const nowIso = () => new Date().toISOString();

const ensureEmailDocument = async (emailId, defaults = {}) => {
  const baseDefaults = {
    id: emailId,
    sentAt: nowIso(),
    status: 'sent',
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
app.get('/track/open/:emailId', async (req, res) => {
  const { emailId } = req.params;
  const { r: recipientEmail } = req.query;
  const userAgent = req.get('User-Agent') || '';
  const ipAddress = req.ip || req.connection.remoteAddress || '';

  // Vérifications pour éviter les faux positifs
  const suspiciousUserAgents = [
    'bot', 'crawler', 'spider', 'scanner', 'checker', 'monitor',
    'preview', 'prefetch', 'security', 'antivirus', 'firewall'
  ];
  
  const isSuspicious = suspiciousUserAgents.some(term => 
    userAgent.toLowerCase().includes(term)
  );

  // Ignorer les requêtes suspectes
  if (isSuspicious) {
    console.log(`Suspicious user agent detected, ignoring: ${userAgent}`);
    res.set({
      'Content-Type': 'image/gif',
      'Content-Length': transparentGif.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.send(transparentGif);
    return;
  }

  console.log(`Email opened: ${emailId} by ${recipientEmail} (User-Agent: ${userAgent})`);

  const openData = {
    id: crypto.randomBytes(16).toString('hex'),
    emailId,
    recipientEmail,
    userAgent,
    ipAddress,
    timestamp: nowIso()
  };

  try {
    await ensureEmailDocument(emailId, { recipientEmail });
    
    // Vérifier s'il y a déjà une ouverture récente (dans les 30 secondes)
    const recentOpen = await emailOpensCollection.findOne({
      emailId,
      recipientEmail,
      timestamp: { $gte: new Date(Date.now() - 30000).toISOString() }
    });
    
    if (recentOpen) {
      console.log(`Recent open detected for ${emailId} by ${recipientEmail}, skipping duplicate`);
    } else {
      await emailOpensCollection.insertOne(openData);
      await emailTrackingCollection.updateOne(
        { id: emailId },
        {
          $inc: { openCount: 1 },
          $set: { lastOpenedAt: openData.timestamp, recipientEmail }
        }
      );
    }
  } catch (error) {
    console.error('Error recording email open:', error);
  }

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': transparentGif.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(transparentGif);
});

// Click tracking endpoint
app.get('/track/click/:emailId', async (req, res) => {
  const { emailId } = req.params;
  const { url, r: recipientEmail } = req.query;
  const userAgent = req.get('User-Agent') || '';
  const ipAddress = req.ip || req.connection.remoteAddress || '';

  if (!url) {
    return res.status(400).send('Invalid URL');
  }

  console.log(`Link clicked: ${url} in email ${emailId} by ${recipientEmail}`);

  const clickData = {
    id: crypto.randomBytes(16).toString('hex'),
    emailId,
    url,
    recipientEmail,
    userAgent,
    ipAddress,
    timestamp: nowIso()
  };

  try {
    await ensureEmailDocument(emailId, { recipientEmail });
    await emailClicksCollection.insertOne(clickData);
    await emailTrackingCollection.updateOne(
      { id: emailId },
      {
        $inc: { clickCount: 1 },
        $set: { lastClickedAt: clickData.timestamp, recipientEmail }
      }
    );
  } catch (error) {
    console.error('Error recording link click:', error);
  }

  res.redirect(decodeURIComponent(url));
});

// Attachment download tracking endpoint
app.get('/track/attachment/:attachmentId', async (req, res) => {
  const { attachmentId } = req.params;
  const { token, action = 'download', r: recipientEmail = '' } = req.query;
  const userAgent = req.get('User-Agent') || '';
  const ipAddress = req.ip || req.connection.remoteAddress || '';

  console.log(`Attachment download: ${attachmentId}`);

  try {
    const attachment = await attachmentTrackingCollection.findOne({ id: attachmentId, secureToken: token });
    if (!attachment) {
      return res.status(404).send('Attachment not found or invalid token');
    }

    const downloadData = {
      id: crypto.randomBytes(16).toString('hex'),
      attachmentId,
      recipientEmail,
      userAgent,
      ipAddress,
      timestamp: nowIso(),
      type: action
    };

    await attachmentDownloadsCollection.insertOne(downloadData);

    await ensureEmailDocument(attachment.emailId, { recipientEmail });

    const updateFields = action === 'open'
      ? { $inc: { attachmentOpens: 1 } }
      : { $inc: { attachmentDownloads: 1 } };

    await emailTrackingCollection.updateOne(
      { id: attachment.emailId },
      updateFields
    );

    const filePath = path.join(ATTACHMENTS_DIR, attachment.trackedFileName);
    if (fs.existsSync(filePath)) {
      res.set({
        'Content-Type': attachment.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${attachment.originalFileName}"`
      });
      return res.sendFile(filePath);
    }

    res.status(404).send('File not found');
  } catch (error) {
    console.error('Error recording attachment download:', error);
    res.status(500).send('Server error');
  }
});

// Unsubscribe endpoint
app.get('/track/unsubscribe/:emailId', (req, res) => {
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
        <p><strong>Date:</strong> ${new Date().toLocaleString('fr-FR')}</p>
      </div>
      <p>Vous ne recevrez plus d'emails de notre part. Si vous souhaitez vous réabonner, vous pouvez nous contacter.</p>
    </body>
    </html>
  `);
});

// Privacy policy endpoint
app.get('/privacy', (req, res) => {
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
app.get('/api/tracking-data', async (req, res) => {
  try {
    const { since } = req.query; // Optional: get only data since a certain timestamp
    
    const query = since ? { timestamp: { $gt: since } } : {};
    
    const [emailTracking, emailOpens, emailClicks, attachmentTracking, attachmentDownloads] = await Promise.all([
      emailTrackingCollection.find().toArray(),
      emailOpensCollection.find(query).toArray(),
      emailClicksCollection.find(query).toArray(),
      attachmentTrackingCollection.find().toArray(),
      attachmentDownloadsCollection.find(query).toArray()
    ]);

    res.json({
      emailTracking,
      emailOpens,
      emailClicks,
      attachmentTracking,
      attachmentDownloads,
      serverTimestamp: nowIso()
    });
  } catch (error) {
    console.error('Error fetching tracking data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tracking data' });
  }
});

// Quick check endpoint for changes (lightweight)
app.get('/api/tracking-status', async (req, res) => {
  try {
    const [emailCount, openCount, clickCount, attachmentCount, downloadCount] = await Promise.all([
      emailTrackingCollection.countDocuments(),
      emailOpensCollection.countDocuments(),
      emailClicksCollection.countDocuments(),
      attachmentTrackingCollection.countDocuments(),
      attachmentDownloadsCollection.countDocuments()
    ]);

    // Get latest timestamps
    const [latestOpen, latestClick] = await Promise.all([
      emailOpensCollection.findOne({}, { sort: { timestamp: -1 }, projection: { timestamp: 1 } }),
      emailClicksCollection.findOne({}, { sort: { timestamp: -1 }, projection: { timestamp: 1 } })
    ]);

    res.json({
      counts: {
        emails: emailCount,
        opens: openCount,
        clicks: clickCount,
        attachments: attachmentCount,
        downloads: downloadCount
      },
      latestActivity: {
        lastOpen: latestOpen?.timestamp || null,
        lastClick: latestClick?.timestamp || null
      },
      serverTimestamp: nowIso()
    });
  } catch (error) {
    console.error('Error fetching tracking status:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tracking status' });
  }
});

app.post('/api/sync-tracking-data', async (req, res) => {
  try {
    const {
      emailTracking: newEmailTracking,
      emailOpens: newEmailOpens,
      emailClicks: newEmailClicks,
      attachmentTracking: newAttachmentTracking,
      attachmentDownloads: newAttachmentDownloads
    } = req.body;

    if (Array.isArray(newEmailTracking) && newEmailTracking.length) {
      await Promise.all(newEmailTracking.map(doc => ensureEmailDocument(doc.id, doc)));
    }

    if (Array.isArray(newEmailOpens) && newEmailOpens.length) {
      await emailOpensCollection.insertMany(newEmailOpens);
    }

    if (Array.isArray(newEmailClicks) && newEmailClicks.length) {
      await emailClicksCollection.insertMany(newEmailClicks);
    }

    if (Array.isArray(newAttachmentTracking) && newAttachmentTracking.length) {
      await attachmentTrackingCollection.insertMany(newAttachmentTracking, { ordered: false }).catch(() => {});
    }

    if (Array.isArray(newAttachmentDownloads) && newAttachmentDownloads.length) {
      await attachmentDownloadsCollection.insertMany(newAttachmentDownloads);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error syncing tracking data:', error);
    res.status(500).json({ success: false, error: 'Failed to sync tracking data' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    data: {
      emails: emailTracking.length,
      opens: emailOpens.length,
      clicks: emailClicks.length,
      attachments: attachmentTracking.length,
      downloads: attachmentDownloads.length
    }
  });
});

// Start server (ensure DB connection first)
const startServer = async () => {
  try {
    await connectToDatabase();
    console.log('Connected to MongoDB');

    app.listen(PORT, () => {
      console.log(`Tracking server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`Privacy policy: http://localhost:${PORT}/privacy`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('\nShutting down tracking server...');
  try {
    await client.close();
  } catch (error) {
    console.error('Error closing MongoDB client:', error);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);


