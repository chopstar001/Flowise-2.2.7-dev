// youtube-proxy.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Endpoint to fetch YouTube video page
// Add this to youtube-proxy.js
app.get('/youtube/page', async (req, res) => {
    try {
      const videoId = req.query.videoId;
      if (!videoId) {
        return res.status(400).json({ error: 'Missing videoId parameter' });
      }
      
      console.log(`Proxying request for YouTube video: ${videoId}`);
      const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      // Log more details about the response
      const titleMatch = response.data.match(/<title>(.*?)<\/title>/);
      const videoTitle = titleMatch ? titleMatch[1] : 'Unknown';
      console.log(`Video title: "${videoTitle}"`);
      
      // Check for common unavailability indicators
      const unavailableChecks = [
        { pattern: 'Video unavailable', found: response.data.includes('Video unavailable') },
        { pattern: 'This video isn\'t available anymore', found: response.data.includes('This video isn\'t available anymore') },
        { pattern: 'PLAYER_UNAVAILABLE', found: response.data.includes('PLAYER_UNAVAILABLE') },
        { pattern: 'private video', found: response.data.includes('This is a private video') }
      ];
      
      console.log('Availability checks:', unavailableChecks);
      
      res.json({ 
        html: response.data,
        status: response.status,
        title: videoTitle,
        checks: unavailableChecks
      });
    } catch (error) {
      console.error('Proxy error:', error.message);
      res.status(500).json({ 
        error: error.message,
        status: error.response?.status || 500
      });
    }
  });

// Endpoint to fetch transcript XML
app.get('/youtube/transcript', async (req, res) => {
    const videoId = req.query.videoId;
    console.warn(`[PROXY] Handling request for video: ${videoId}`);
  try {
    const url = req.query.url;
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }
    
    console.log(`Proxying request for transcript: ${url}`);
    const response = await axios.get(url);
    
    res.json({ 
      data: response.data,
      status: response.status
    });
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ 
      error: error.message,
      status: error.response?.status || 500
    });
  }
});

const PORT = 3099;
app.listen(PORT, () => {
  console.log(`YouTube proxy server running on port ${PORT}`);
});