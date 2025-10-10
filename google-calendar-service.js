const { google } = require('googleapis');
const crypto = require('crypto');

// Google OAuth2 Client Configuration
const getOAuth2Client = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `${process.env.TRACKING_DOMAIN}/auth/google/callback`
  );
};

// Generate OAuth URL
const getAuthUrl = () => {
  const oauth2Client = getOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
};

// Exchange authorization code for tokens
const getTokensFromCode = async (code) => {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
};

// Get user info from Google
const getUserInfo = async (accessToken) => {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });
  
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  return data;
};

// Refresh access token
const refreshAccessToken = async (refreshToken) => {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  
  const { credentials } = await oauth2Client.refreshAccessToken();
  return credentials;
};

// Get calendar events
const getCalendarEvents = async (accessToken, refreshToken, options = {}) => {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ 
    access_token: accessToken,
    refresh_token: refreshToken 
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
  const {
    timeMin = new Date().toISOString(),
    maxResults = 50,
    orderBy = 'startTime',
    singleEvents = true
  } = options;

  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      maxResults,
      singleEvents,
      orderBy
    });

    return {
      success: true,
      events: response.data.items || [],
      accessToken: oauth2Client.credentials.access_token // Return potentially refreshed token
    };
  } catch (error) {
    if (error.code === 401) {
      // Token expired, try to refresh
      try {
        const newCredentials = await refreshAccessToken(refreshToken);
        oauth2Client.setCredentials(newCredentials);
        
        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin,
          maxResults,
          singleEvents,
          orderBy
        });

        return {
          success: true,
          events: response.data.items || [],
          accessToken: newCredentials.access_token,
          refreshToken: newCredentials.refresh_token || refreshToken
        };
      } catch (refreshError) {
        throw new Error('Failed to refresh token');
      }
    }
    throw error;
  }
};

// Create calendar event
const createCalendarEvent = async (accessToken, refreshToken, eventData) => {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ 
    access_token: accessToken,
    refresh_token: refreshToken 
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const event = {
    summary: eventData.title || eventData.summary,
    description: eventData.description || '',
    start: {
      dateTime: eventData.startTime || eventData.start?.dateTime,
      timeZone: eventData.timeZone || 'UTC',
    },
    end: {
      dateTime: eventData.endTime || eventData.end?.dateTime,
      timeZone: eventData.timeZone || 'UTC',
    },
    location: eventData.location || '',
    attendees: eventData.attendees || [],
    reminders: {
      useDefault: eventData.useDefaultReminders !== false,
      overrides: eventData.reminders || []
    }
  };

  // Add Google Meet conference if requested
  if (eventData.conferenceData) {
    event.conferenceData = eventData.conferenceData;
  }

  console.log('Creating event with data:', JSON.stringify(event, null, 2));

  try {
    const insertOptions = {
      calendarId: 'primary',
      resource: event
    };

    // Request conference creation if conferenceData is provided
    if (eventData.conferenceData) {
      insertOptions.conferenceDataVersion = 1;
    }

    // Send invitations to all attendees if there are any attendees or if conference is requested
    if (eventData.attendees?.length > 0 || eventData.conferenceData) {
      insertOptions.sendUpdates = 'all';
    }

    const response = await calendar.events.insert(insertOptions);
    
    // Log the conference details if Meet link was created
    if (response.data.conferenceData) {
      console.log('Google Meet link created:', response.data.conferenceData.entryPoints?.[0]?.uri);
    }

    console.log('Event created successfully:', response.data.id);
    
    // Extract conference link if available
    const meetLink = response.data.conferenceData?.entryPoints?.[0]?.uri;
    
    return {
      success: true,
      event: response.data,
      accessToken: oauth2Client.credentials.access_token,
      meetLink: meetLink,
      invitationsSent: eventData.attendees?.length > 0
    };
  } catch (error) {
    console.error('Error creating event:', error.message, error.code);
    if (error.response?.data) {
      console.error('Google API error details:', error.response.data);
    }
    
    if (error.code === 401) {
      // Token expired, try to refresh
      console.log('Token expired, attempting to refresh...');
      try {
        const newCredentials = await refreshAccessToken(refreshToken);
        oauth2Client.setCredentials(newCredentials);
        
        const insertOptions = {
          calendarId: 'primary',
          resource: event
        };

        if (eventData.conferenceData) {
          insertOptions.conferenceDataVersion = 1;
        }

        if (eventData.attendees?.length > 0 || eventData.conferenceData) {
          insertOptions.sendUpdates = 'all';
        }
        
        const response = await calendar.events.insert(insertOptions);
        
        if (response.data.conferenceData) {
          console.log('Google Meet link created after token refresh:', response.data.conferenceData.entryPoints?.[0]?.uri);
        }

        console.log('Event created successfully after token refresh:', response.data.id);
        
        const meetLink = response.data.conferenceData?.entryPoints?.[0]?.uri;
        
        return {
          success: true,
          event: response.data,
          accessToken: newCredentials.access_token,
          refreshToken: newCredentials.refresh_token || refreshToken,
          meetLink: meetLink,
          invitationsSent: eventData.attendees?.length > 0
        };
      } catch (refreshError) {
        console.error('Failed to refresh token:', refreshError);
        throw new Error('Failed to refresh token: ' + refreshError.message);
      }
    }
    throw new Error(`Failed to create event: ${error.message}`);
  }
};

// Update calendar event
const updateCalendarEvent = async (accessToken, refreshToken, eventId, eventData) => {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ 
    access_token: accessToken,
    refresh_token: refreshToken 
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  try {
    const response = await calendar.events.patch({
      calendarId: 'primary',
      eventId: eventId,
      resource: eventData
    });

    return {
      success: true,
      event: response.data,
      accessToken: oauth2Client.credentials.access_token
    };
  } catch (error) {
    if (error.code === 401) {
      const newCredentials = await refreshAccessToken(refreshToken);
      oauth2Client.setCredentials(newCredentials);
      
      const response = await calendar.events.patch({
        calendarId: 'primary',
        eventId: eventId,
        resource: eventData
      });

      return {
        success: true,
        event: response.data,
        accessToken: newCredentials.access_token,
        refreshToken: newCredentials.refresh_token || refreshToken
      };
    }
    throw error;
  }
};

// Delete calendar event
const deleteCalendarEvent = async (accessToken, refreshToken, eventId) => {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ 
    access_token: accessToken,
    refresh_token: refreshToken 
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: eventId
    });

    return {
      success: true,
      accessToken: oauth2Client.credentials.access_token
    };
  } catch (error) {
    if (error.code === 401) {
      const newCredentials = await refreshAccessToken(refreshToken);
      oauth2Client.setCredentials(newCredentials);
      
      await calendar.events.delete({
        calendarId: 'primary',
        eventId: eventId
      });

      return {
        success: true,
        accessToken: newCredentials.access_token,
        refreshToken: newCredentials.refresh_token || refreshToken
      };
    }
    throw error;
  }
};

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  getUserInfo,
  refreshAccessToken,
  getCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent
};

