# Altara Tracking Server

Minimal Express server for email open/click/attachment tracking.

## Local development

```bash
cd server
npm install
npm start
```

- Health: http://localhost:3001/health
- Data stored in ./data by default; override with DATA_DIR.

## Deploy to Render

- Commit only the server/ folder in a separate repository.
- In Render, create a Web Service from that repo. Render detects server/render.yaml.
- Persistent disk is mounted at /data.

Environment variables:
- DATA_DIR=/data (set via render.yaml)

Start command:
- npm run start:render

After deploy, use the service URL in your app as TRACKING_DOMAIN.
