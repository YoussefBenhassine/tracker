const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;
// Trust reverse proxy (e.g., Render) to get correct client IPs
app.set('trust proxy', true);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Persistent data directory (supports Render Disks)
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

// Email tracking data storage (in production, use a proper database)
let emailTracking = [];
let emailOpens = [];
let emailClicks = [];
let attachmentTracking = [];
let attachmentDownloads = [];

// Load existing data from files if they exist
const loadData = () => {
  try {
    const emailTrackingPath = path.join(DATA_DIR, 'email_tracking.json');
    const emailOpensPath = path.join(DATA_DIR, 'email_opens.json');
    const emailClicksPath = path.join(DATA_DIR, 'email_clicks.json');
    const attachmentTrackingPath = path.join(DATA_DIR, 'attachment_tracking.json');
    const attachmentDownloadsPath = path.join(DATA_DIR, 'attachment_downloads.json');

    if (fs.existsSync(emailTrackingPath)) {
      emailTracking = JSON.parse(fs.readFileSync(emailTrackingPath, 'utf8'));
    }
    if (fs.existsSync(emailOpensPath)) {
      emailOpens = JSON.parse(fs.readFileSync(emailOpensPath, 'utf8'));
    }
    if (fs.existsSync(emailClicksPath)) {
      emailClicks = JSON.parse(fs.readFileSync(emailClicksPath, 'utf8'));
    }
    if (fs.existsSync(attachmentTrackingPath)) {
      attachmentTracking = JSON.parse(fs.readFileSync(attachmentTrackingPath, 'utf8'));
    }
    if (fs.existsSync(attachmentDownloadsPath)) {
      attachmentDownloads = JSON.parse(fs.readFileSync(attachmentDownloadsPath, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading tracking data:', error);
  }
};

// Save data to files
const saveData = () => {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'email_tracking.json'), JSON.stringify(emailTracking, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, 'email_opens.json'), JSON.stringify(emailOpens, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, 'email_clicks.json'), JSON.stringify(emailClicks, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, 'attachment_tracking.json'), JSON.stringify(attachmentTracking, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, 'attachment_downloads.json'), JSON.stringify(attachmentDownloads, null, 2));
  } catch (error) {
    console.error('Error saving tracking data:', error);
  }
};

// Load data on startup
loadData();

// Open tracking endpoint
app.get('/track/open/:emailId', (req, res) => {
  const { emailId } = req.params;
  const { r: recipientEmail } = req.query;
  const userAgent = req.get('User-Agent') || '';
  const ipAddress = req.ip || req.connection.remoteAddress || '';

  // Find the email tracking record to check when it was sent
  const emailRecord = emailTracking.find(email => email.id === emailId);
  if (emailRecord) {
    const sentTime = new Date(emailRecord.sentAt);
    const now = new Date();
    const secondsSinceSent = (now - sentTime) / 1000;
    
    // Ignore opens that happen within 5 seconds of sending (likely preview/scanner)
    if (secondsSinceSent < 5) {
      console.log(`⚠️ Instant open ignored (${secondsSinceSent.toFixed(1)}s after sending) - likely preview/scanner`);
      res.set({
        'Content-Type': 'image/gif',
        'Content-Length': transparentGif.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      return res.send(transparentGif);
    }
  }

  console.log(`Email opened: ${emailId} by ${recipientEmail}`);

  // Record the open event
  const openData = {
    id: crypto.randomBytes(16).toString('hex'),
    emailId,
    recipientEmail,
    userAgent,
    ipAddress,
    timestamp: new Date().toISOString()
  };

  emailOpens.push(openData);

  // Update email tracking record
  const emailIndex = emailTracking.findIndex(email => email.id === emailId);
  if (emailIndex !== -1) {
    emailTracking[emailIndex].openCount = (emailTracking[emailIndex].openCount || 0) + 1;
    emailTracking[emailIndex].lastOpenedAt = new Date().toISOString();
  }

  saveData();

  // Return transparent GIF
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
app.get('/track/click/:emailId', (req, res) => {
  const { emailId } = req.params;
  const { url, r: recipientEmail } = req.query;
  const userAgent = req.get('User-Agent') || '';
  const ipAddress = req.ip || req.connection.remoteAddress || '';

  // Find the email tracking record to check when it was sent
  const emailRecord = emailTracking.find(email => email.id === emailId);
  if (emailRecord) {
    const sentTime = new Date(emailRecord.sentAt);
    const now = new Date();
    const secondsSinceSent = (now - sentTime) / 1000;
    
    // Ignore clicks that happen within 5 seconds of sending (likely scanner)
    if (secondsSinceSent < 5) {
      console.log(`⚠️ Instant click ignored (${secondsSinceSent.toFixed(1)}s after sending) - likely scanner`);
      if (url) {
        return res.redirect(decodeURIComponent(url));
      } else {
        return res.status(400).send('Invalid URL');
      }
    }
  }

  console.log(`Link clicked: ${url} in email ${emailId} by ${recipientEmail}`);

  // Record the click event
  const clickData = {
    id: crypto.randomBytes(16).toString('hex'),
    emailId,
    url,
    recipientEmail,
    userAgent,
    ipAddress,
    timestamp: new Date().toISOString()
  };

  emailClicks.push(clickData);

  // Update email tracking record
  const emailIndex = emailTracking.findIndex(email => email.id === emailId);
  if (emailIndex !== -1) {
    emailTracking[emailIndex].clickCount = (emailTracking[emailIndex].clickCount || 0) + 1;
    emailTracking[emailIndex].lastClickedAt = new Date().toISOString();
  }

  saveData();

  // Redirect to the original URL
  if (url) {
    res.redirect(decodeURIComponent(url));
  } else {
    res.status(400).send('Invalid URL');
  }
});

// Attachment download tracking endpoint
app.get('/track/attachment/:attachmentId', (req, res) => {
  const { attachmentId } = req.params;
  const { token } = req.query;
  const userAgent = req.get('User-Agent') || '';
  const ipAddress = req.ip || req.connection.remoteAddress || '';

  // Find attachment record
  const attachment = attachmentTracking.find(att => att.id === attachmentId && att.secureToken === token);
  if (!attachment) {
    return res.status(404).send('Attachment not found or invalid token');
  }

  // Find the email tracking record to check when it was sent
  const emailRecord = emailTracking.find(email => email.id === attachment.emailId);
  if (emailRecord) {
    const sentTime = new Date(emailRecord.sentAt);
    const now = new Date();
    const secondsSinceSent = (now - sentTime) / 1000;
    
    // Ignore downloads that happen within 5 seconds of sending (likely scanner)
    if (secondsSinceSent < 5) {
      console.log(`⚠️ Instant download ignored (${secondsSinceSent.toFixed(1)}s after sending) - likely scanner`);
      // Serve the file but don't record the download
      const filePath = path.join(ATTACHMENTS_DIR, attachment.trackedFileName);
      if (fs.existsSync(filePath)) {
        res.set({
          'Content-Type': attachment.contentType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${attachment.originalFileName}"`
        });
        return res.sendFile(filePath);
      } else {
        return res.status(404).send('File not found');
      }
    }
  }

  console.log(`Attachment download: ${attachmentId}`);

  // Record the download event
  const downloadData = {
    id: crypto.randomBytes(16).toString('hex'),
    attachmentId,
    recipientEmail: '', // Could be passed as query param if needed
    userAgent,
    ipAddress,
    timestamp: new Date().toISOString()
  };

  attachmentDownloads.push(downloadData);

  // Update email tracking record
  const emailIndex = emailTracking.findIndex(email => email.id === attachment.emailId);
  if (emailIndex !== -1) {
    emailTracking[emailIndex].attachmentDownloads = (emailTracking[emailIndex].attachmentDownloads || 0) + 1;
  }

  saveData();

  // Serve the file from persistent attachments directory
  const filePath = path.join(ATTACHMENTS_DIR, attachment.trackedFileName);
  if (fs.existsSync(filePath)) {
    res.set({
      'Content-Type': attachment.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${attachment.originalFileName}"`
    });
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
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
app.get('/api/tracking-data', (req, res) => {
  res.json({
    emailTracking,
    emailOpens,
    emailClicks,
    attachmentTracking,
    attachmentDownloads
  });
});

app.post('/api/sync-tracking-data', (req, res) => {
  const { emailTracking: newEmailTracking, emailOpens: newEmailOpens, emailClicks: newEmailClicks, attachmentTracking: newAttachmentTracking, attachmentDownloads: newAttachmentDownloads } = req.body;
  
  if (newEmailTracking) emailTracking = newEmailTracking;
  if (newEmailOpens) emailOpens = newEmailOpens;
  if (newEmailClicks) emailClicks = newEmailClicks;
  if (newAttachmentTracking) attachmentTracking = newAttachmentTracking;
  if (newAttachmentDownloads) attachmentDownloads = newAttachmentDownloads;
  
  saveData();
  res.json({ success: true });
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

// Start server
app.listen(PORT, () => {
  console.log(`Tracking server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Privacy policy: http://localhost:${PORT}/privacy`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down tracking server...');
  saveData();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down tracking server...');
  saveData();
  process.exit(0);
});


