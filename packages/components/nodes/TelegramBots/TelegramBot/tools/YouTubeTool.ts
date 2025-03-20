// tools/YouTubeTool.ts (With improved logging and API handling)
import axios from 'axios';
import { Tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSubtitles } from 'youtube-caption-extractor';
import { parse } from 'node-html-parser';

export class YouTubeTool extends Tool {
    name = "youtube_tool";
    description = "Retrieve transcripts, comments, and metadata from YouTube videos";
    apiKey: string;
    
    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    static lc_name() {
        return "YouTubeTool";
    }

    schema = z.object({
        input: z.string().optional().describe("A JSON string containing the YouTube URL, action, and optional language"),
    }).transform(data => data.input ?? undefined);

    async _call(args: z.infer<typeof this.schema>): Promise<string> {
        try {
            if (!args) {
                return "Error: Missing input";
            }

            let { url, action, language = 'en' } = JSON.parse(args);
            
            console.log(`Raw URL from input: "${url}"`);
            
            // Extract and validate the video ID
            const videoId = this.extractVideoId(url);
            console.log(`Extracted video ID: "${videoId}" from URL: "${url}"`);
            
            if (!videoId) {
                return "Error: Invalid YouTube URL. Please provide a valid YouTube video URL.";
            }

            // Normalize video ID (ensure lowercase for case-insensitive comparison)
            const normalizedVideoId = videoId;
            console.log(`Normalized video ID: "${normalizedVideoId}"`);
            
            // First, check if the video exists before doing anything else
            const videoExists = await this.checkVideoExists(normalizedVideoId);
            if (!videoExists) {
                return `Error: The video with ID ${normalizedVideoId} does not exist or is not publicly available. Please check the video URL and try again.`;
            }

            switch (action) {
                case 'transcript': {
                    const transcript = await this.getImprovedTranscript(normalizedVideoId, language, false);
                    return this.cleanHTMLForTelegram(transcript);
                }
                case 'transcript_with_timestamps': {
                    const transcript = await this.getImprovedTranscript(normalizedVideoId, language, true);
                    return this.cleanHTMLForTelegram(transcript);
                }
                case 'metadata': {
                    // Remove the pageData parameter
                    const metadata = await this.getMetadata(normalizedVideoId);
                    // No need to clean JSON metadata
                    return metadata;
                }
                case 'comments': {
                    const comments = await this.getComments(normalizedVideoId);
                    // No need to clean JSON comments
                    return comments;
                }
                case 'all': {
                    // Remove the pageData parameter
                    const metadata = await this.getMetadata(normalizedVideoId);
                    const metadataObj = JSON.parse(metadata);
                    
                    const transcript = await this.getImprovedTranscript(normalizedVideoId, language, false);
                    // Clean the transcript
                    const cleanedTranscript = transcript.startsWith("No transcript found") 
                        ? transcript
                        : this.cleanHTMLForTelegram(transcript);
                    
                    const comments = await this.getComments(normalizedVideoId);
                    
                    return JSON.stringify({
                        transcript: cleanedTranscript,
                        metadata: metadataObj,
                        comments: JSON.parse(comments)
                    }, null, 2);
                }
                default:
                    return "Error: Unknown action. Available actions are: transcript, transcript_with_timestamps, metadata, comments, all";
            }
        } catch (error) {
            console.error("YouTube tool error:", error);
            
            // More descriptive error message
            if (error instanceof SyntaxError) {
                return "Error: Invalid JSON input. Please check the format of your request.";
            }
            
            if (error.message?.includes('Network Error') || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                return "Error: Network connection issue. Unable to connect to YouTube servers.";
            }
            
            return `Error: ${error instanceof Error ? error.message : 'Unknown error occurred while processing the YouTube request'}`;
        }
    }

    // New method to check if a video exists before attempting other operations
    private async checkVideoExists(videoId: string): Promise<boolean> {
        try {
            console.log(`Checking if video exists via proxy: ${videoId}`);
            
            // Use local proxy instead of direct request
            const proxyUrl = `http://localhost:3099/youtube/page?videoId=${videoId}`;
            console.log(`Making proxy request to: ${proxyUrl}`);
            
            const response = await axios.get(proxyUrl);
            
            if (response.data.error) {
                console.log(`Proxy error: ${response.data.error}`);
                return false;
            }
            
            const html = response.data.html;
            console.log(`Proxy returned HTML of length: ${html.length}`);
            
            // Check for video unavailable markers
            const unavailableMarkers = [
                "Video unavailable",
                ">This video isn't available anymore</span>",
                "PLAYER_UNAVAILABLE"
            ];
            
            if (unavailableMarkers.some(marker => html.includes(marker))) {
                console.log(`Video ${videoId} not available (confirmed via proxy check)`);
                return false;
            }
            
            console.log(`Video ${videoId} exists (confirmed via proxy check)`);
            return true;
        } catch (error) {
            console.error(`Proxy check failed: ${error.message}`);
            return false;
        }
    }
    
    private extractVideoId(url: string): string | null {
        if (!url) {
            console.log('URL is empty or undefined');
            return null;
        }
        
        console.log(`Extracting video ID from: "${url}"`);
        
        // Handle YouTube live URLs specifically
        const liveMatch = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/live\/)([a-zA-Z0-9_-]+)/i);
        if (liveMatch && liveMatch[1]) {
            console.log(`Extracted ID from live URL: "${liveMatch[1]}"`);
            // Verify it's a valid 11-character ID
            if (liveMatch[1].length === 11) {
                return liveMatch[1];
            }
        }
        
        // Standard video URL pattern
        const videoPattern = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|(?:s(?:horts)\/)|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
        const match = url.match(videoPattern);
        
        if (match && match[1] && match[1].length === 11) {
            console.log(`Extracted ID via standard pattern: "${match[1]}"`);
            return match[1];
        }
        
        // If it's already just an 11-char ID, return it
        if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
            console.log(`URL is already a valid video ID: "${url}"`);
            return url;
        }
        
        // Try to extract from any URL containing the ID
        const idMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/i) || 
                        url.match(/([a-zA-Z0-9_-]{11})/);
        
        if (idMatch && idMatch[1] && idMatch[1].length === 11) {
            console.log(`Extracted ID via fallback pattern: "${idMatch[1]}"`);
            return idMatch[1];
        }
        
        console.log('Failed to extract video ID');
        return null;
    }

    private async getImprovedTranscript(videoId: string, lang: string, withTimestamps: boolean): Promise<string> {
        console.log(`Trying to get transcript for video: ${videoId} with language: ${lang}`);
        
        // Try multiple methods in sequence
        try {
            // Method 1: Try direct transcript extraction
            try {
                console.log(`Trying direct transcript extraction`);
                const transcript = await this.getDirectTranscript(videoId, lang);
                if (transcript && !transcript.startsWith("No transcript found")) {
                    console.log(`Successfully retrieved transcript using direct extraction`);
                    return withTimestamps ? transcript : transcript.replace(/\[\d+:\d+:\d+ - \d+:\d+:\d+\] /g, '');
                }
            } catch (error) {
                console.log(`Direct transcript extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
            
            // Method 2: Try using youtube-caption-extractor - This seems to work the most
            try {
                console.log(`Trying youtube-caption-extractor for language: ${lang}`);
                const subtitles = await getSubtitles({
                    videoID: videoId,
                    lang: lang
                });
                
                if (subtitles && subtitles.length > 0) {
                    console.log(`Successfully retrieved captions using youtube-caption-extractor for lang "${lang}"`);
                    return this.formatSubtitles(subtitles, withTimestamps);
                }
                
                // Try auto-generated captions
                console.log(`Trying auto-generated captions with prefix a.${lang}`);
                const autoSubtitles = await getSubtitles({
                    videoID: videoId,
                    lang: `a.${lang}`
                });
                
                if (autoSubtitles && autoSubtitles.length > 0) {
                    console.log(`Successfully retrieved auto-generated captions`);
                    return this.formatSubtitles(autoSubtitles, withTimestamps);
                }
                
                // Try with "auto" language
                console.log(`Trying with "auto" language`);
                const fallbackSubtitles = await getSubtitles({
                    videoID: videoId,
                    lang: "auto"
                });
                
                if (fallbackSubtitles && fallbackSubtitles.length > 0) {
                    console.log(`Successfully retrieved captions with "auto" language`);
                    return this.formatSubtitles(fallbackSubtitles, withTimestamps);
                }
            } catch (error) {
                console.log(`youtube-caption-extractor method failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }

            // Method 3: Try page scraping approach as a last resort
            try {
                console.log(`Trying page scraping approach`);
                const transcript = await this.getTranscriptFromPage(videoId, lang, withTimestamps);
                if (!transcript.startsWith("No transcript found")) {
                    console.log(`Successfully retrieved transcript using page scraping`);
                    return transcript;
                }
            } catch (error) {
                console.log(`Page scraping method failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }

            // If we got here, all methods failed - try to fetch video metadata for better error message
            let videoTitle = "Unknown Video";
            let channelTitle = "Unknown Channel";
            
            try {
                console.log("Trying to get metadata for better error message");
                const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
                const response = await axios.get(watchUrl);
                const html = response.data;
                
                // Try to extract title from HTML
                const titleMatch = html.match(/<title>(.*?)<\/title>/);
                if (titleMatch && titleMatch[1]) {
                    videoTitle = titleMatch[1].replace(' - YouTube', '');
                    console.log(`Extracted title from HTML: ${videoTitle}`);
                }
                
                // Try to extract channel name from HTML
                const channelMatch = html.match(/"ownerChannelName":"(.*?)"/);
                if (channelMatch && channelMatch[1]) {
                    channelTitle = channelMatch[1];
                    console.log(`Extracted channel from HTML: ${channelTitle}`);
                }
            } catch (error) {
                console.log(`Failed to get metadata for better error message: ${error.message}`);
            }

            // Return a detailed error message
            let errorMessage = `No transcript found for this video (ID: ${videoId}).`;
            errorMessage += "\n\nPossible reasons:";
            errorMessage += "\n• The video doesn't have captions/subtitles";
            errorMessage += "\n• The creator hasn't made subtitles available";
            errorMessage += "\n• Subtitles might be available in a different language";
            
            // Add video information
            errorMessage += "\n\nVideo Information:";
            errorMessage += `\nTitle: ${videoTitle}`;
            errorMessage += `\nChannel: ${channelTitle}`;
            errorMessage += `\nURL: https://www.youtube.com/watch?v=${videoId}`;
            
            return errorMessage;
                   
        } catch (error) {
            throw new Error(`Failed to get transcript: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    // New additional method using a different approach
    private async getDirectTranscript(videoId: string, lang: string): Promise<string> {
        try {
            console.log(`Getting direct transcript for video: ${videoId}, language: ${lang}`);
            
            // Try to get the available caption tracks
            const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            console.log(`Fetching video page from: ${watchUrl}`);
            
            const response = await axios.get(watchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            const html = response.data;
            
            // First, check if the page indicates that the video is unavailable
            if (html.includes("Video unavailable") || html.includes(">This video isn't available anymore</span>")) {
                console.log("Video page indicates that the video is unavailable");
                return "No transcript found for this video.";
            }
            
            // First try the JSON approach
            console.log("Trying to extract caption tracks from page data");
            const captionRegex = /"captionTracks":(\[.*?\])\s*,\s*"translationLanguages"/;
            const match = html.match(captionRegex);
            
            if (!match || !match[1]) {
                console.log(`No caption tracks found in HTML using JSON pattern`);
                
                // Try alternative capture patterns
                const altCaptionRegex = /"captions":\s*{[\s\S]*?"playerCaptionsTracklistRenderer":\s*{[\s\S]*?"captionTracks":\s*(\[[\s\S]*?\])/;
                const altMatch = html.match(altCaptionRegex);
                
                if (!altMatch || !altMatch[1]) {
                    console.log(`No caption tracks found using alternative pattern`);
                    return "No transcript found for this video.";
                }
                
                try {
                    const captionTracks = JSON.parse(altMatch[1]);
                    console.log(`Found caption tracks using alternative pattern: ${captionTracks.length} tracks`);
                    return this.processCaptionTracks(captionTracks, lang, watchUrl);
                } catch (error) {
                    console.log(`Error parsing alternative caption tracks: ${error.message}`);
                    return "No transcript found for this video.";
                }
            }
            
            try {
                const captionTracks = JSON.parse(match[1]);
                console.log(`Found caption tracks: ${captionTracks.length} tracks`);
                return this.processCaptionTracks(captionTracks, lang, watchUrl);
            } catch (error) {
                console.log(`Error parsing caption tracks: ${error.message}`);
                return "No transcript found for this video.";
            }
        } catch (error) {
            console.error(`Error in getDirectTranscript:`, error);
            return "No transcript found for this video.";
        }
    }
    
    // Helper to process caption tracks once extracted
    private async processCaptionTracks(captionTracks: any[], lang: string, videoUrl: string): Promise<string> {
        // Log available caption languages
        const availableLangs = captionTracks.map(track => track.languageCode || track.language);
        console.log(`Available caption languages: ${availableLangs.join(', ')}`);
        
        // Try to find the requested language, otherwise use first available
        let captionTrack = captionTracks.find(track => (track.languageCode || track.language) === lang);
        
        // If requested language not found, use the first available track
        if (!captionTrack && captionTracks.length > 0) {
            captionTrack = captionTracks[0];
            console.log(`Language ${lang} not found, using ${captionTrack.languageCode || captionTrack.language} instead`);
        }
        
        const baseUrl = captionTrack?.baseUrl || captionTrack?.url;
        if (!baseUrl) {
            console.log(`No caption URL found in track`);
            return "No transcript found for this video.";
        }
        
        console.log(`Caption URL: ${baseUrl}`);
        
        try {

            const proxyUrl = `http://localhost:3099/youtube/transcript?url=${encodeURIComponent(baseUrl)}`;
            const transcriptResponse = await axios.get(proxyUrl);
    
            // Fetch the XML transcript
            const transcriptXml = transcriptResponse.data;
            
            // Log a preview of the XML
            console.log(`Transcript XML preview: ${transcriptXml.substring(0, 200)}...`);
            
            // Parse out the text and timing
            const lines = [];
            const regex = /<text start="([\d\.]+)" dur="([\d\.]+)".*?>(.*?)<\/text>/g;
            let result;
            
            while ((result = regex.exec(transcriptXml)) !== null) {
                const startTime = parseFloat(result[1]);
                const duration = parseFloat(result[2]);
                const endTime = startTime + duration;
                const rawText = result[3]
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'");
                const text = rawText.replace(/<\/?[^>]+(>|$)/g, "");
                
                lines.push({
                    startTime,
                    endTime,
                    text
                });
            }
            
            console.log(`Extracted ${lines.length} transcript lines`);
            
            if (lines.length === 0) {
                return "No transcript found for this video.";
            }
            
            // Format the transcript
            return lines.map(line => 
                `[${this.formatTimestamp(line.startTime)} - ${this.formatTimestamp(line.endTime)}] ${line.text}`
            ).join('\n');
        } catch (error) {
            console.error(`Error processing transcript XML: ${error.message}`);
            return "No transcript found for this video.";
        }
    }

    private formatSubtitles(subtitles: any[], withTimestamps: boolean): string {
        if (withTimestamps) {
            return subtitles.map(item =>
                `[${this.formatTimestamp(Number(item.start))} - ${this.formatTimestamp(Number(item.start) + Number(item.dur))}] ${item.text}`
            ).join('\n');
        } else {
            return subtitles.map(item => item.text).join(' ');
        }
    }

    private formatTimestamp(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    // Get metadata using the YouTube API
    private async getMetadata(videoId: string): Promise<string> {
        try {
            if (!this.apiKey) {
                throw new Error('YouTube API key is required for metadata retrieval');
            }
            
            console.log(`Getting metadata for video: ${videoId}`);
            console.log(`Making API request: https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}`);
            
            const response = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, {
                params: {
                    part: 'snippet,statistics,contentDetails',
                    id: videoId,
                    key: this.apiKey
                }
            });

            console.log(`API response status: ${response.status}`);
            console.log(`API response items count: ${response.data.items ? response.data.items.length : 0}`);
            
            if (!response.data.items || response.data.items.length === 0) {
                throw new Error(`No video found with ID: ${videoId}`);
            }

            const item = response.data.items[0];
            const snippet = item.snippet;
            const statistics = item.statistics;
            const contentDetails = item.contentDetails;

            const metadata = {
                id: videoId,
                title: snippet.title,
                description: snippet.description,
                publishedAt: snippet.publishedAt,
                channelId: snippet.channelId,
                channelTitle: snippet.channelTitle,
                categoryId: snippet.categoryId,
                tags: snippet.tags || [],
                viewCount: statistics.viewCount,
                likeCount: statistics.likeCount,
                duration: contentDetails.duration,
                definition: contentDetails.definition // hd or sd
            };

            console.log(`Successfully retrieved metadata for video: ${videoId}`);
            return JSON.stringify(metadata, null, 2);
            
        } catch (error) {
            // Try fallback method to get basic metadata from page
            try {
                console.log(`API metadata failed, trying page extraction for video: ${videoId}`);
                const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
                const response = await axios.get(watchUrl);
                const html = response.data;
                
                // Try to extract metadata from HTML using regex
                const titleMatch = html.match(/<title>(.*?)<\/title>/);
                const viewsMatch = html.match(/"viewCount":"(\d+)"/);
                const dateMatch = html.match(/"publishDate":"([^"]+)"/);
                const channelMatch = html.match(/"ownerChannelName":"([^"]+)"/);
                const descriptionMatch = html.match(/"shortDescription":"([^"]*)"/);
                
                const basicMetadata = {
                    id: videoId,
                    title: titleMatch ? titleMatch[1].replace(' - YouTube', '') : 'Unknown Title',
                    description: descriptionMatch ? descriptionMatch[1] : '',
                    publishedAt: dateMatch ? dateMatch[1] : 'Unknown Date',
                    channelTitle: channelMatch ? channelMatch[1] : 'Unknown Channel',
                    viewCount: viewsMatch ? viewsMatch[1] : '0',
                    // Add any other metadata you can extract from the page
                };
                
                console.log(`Successfully retrieved basic metadata from page for video: ${videoId}`);
                return JSON.stringify(basicMetadata, null, 2);
                
            } catch (fallbackError) {
                console.error(`Fallback metadata extraction failed: ${fallbackError.message}`);
                throw error; // Throw the original error
            }
        }
    }

    private async getComments(videoId: string): Promise<string> {
        try {
            if (!this.apiKey) {
                return JSON.stringify([], null, 2);
            }
            
            console.log(`Getting comments for video: ${videoId}`);
            console.log(`Making API request: https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&videoId=${videoId}`);
            
            const response = await axios.get(`https://www.googleapis.com/youtube/v3/commentThreads`, {
                params: {
                    part: 'snippet,replies',
                    videoId: videoId,
                    maxResults: 100,
                    textFormat: 'plainText',
                    key: this.apiKey
                }
            });

            console.log(`API response status: ${response.status}`);
            console.log(`API response items count: ${response.data.items ? response.data.items.length : 0}`);
            
            if (!response.data.items || response.data.items.length === 0) {
                console.log(`No comments found for video: ${videoId}`);
                return JSON.stringify([], null, 2);
            }

            const comments = response.data.items.map((item: any) => {
                const topLevelComment = item.snippet.topLevelComment.snippet;
                
                const commentData = {
                    text: topLevelComment.textDisplay,
                    author: topLevelComment.authorDisplayName,
                    publishedAt: topLevelComment.publishedAt,
                    likeCount: topLevelComment.likeCount,
                    replies: []
                };
                
                if (item.replies) {
                    commentData.replies = item.replies.comments.map((reply: any) => ({
                        text: reply.snippet.textDisplay,
                        author: reply.snippet.authorDisplayName,
                        publishedAt: reply.snippet.publishedAt,
                        likeCount: reply.snippet.likeCount
                    }));
                }
                
                return commentData;
            });

            console.log(`Retrieved ${comments.length} comments for video: ${videoId}`);
            return JSON.stringify(comments, null, 2);
            
        } catch (error) {
            console.error(`Error getting comments: ${error.message}`);
            return JSON.stringify([], null, 2); // Return empty array on error
        }
    }

    // Keep as a fallback method
    private async getTranscriptFromPage(videoId: string, lang: string, withTimestamps: boolean): Promise<string> {
        try {
            console.log(`Scraping transcript from page for video: ${videoId}, language: ${lang}`);
            
            const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            console.log(`Fetching video page: ${watchUrl}`);
            
            const response = await axios.get(watchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            const html = response.data as string;
            
            console.log(`Received HTML page of length: ${html.length}`);

            // Check for any indication that captions might be available
            const hasCaptionsIndicator = html.includes('"captionTracks"') || 
                                         html.includes('"playerCaptionsTracklistRenderer"') ||
                                         html.includes('"timedtext"');
                                         
            if (!hasCaptionsIndicator) {
                console.log(`No caption indicators found in HTML`);
                return `No transcript found for this video.`;
            }

            const captionDataMatch = html.match(/"captionTracks":(\[.*?\])/);
            if (!captionDataMatch) {
                console.log(`No caption tracks data found in HTML`);
                return `No transcript found for this video.`;
            }

            let captionTracks;
            try {
                captionTracks = JSON.parse(captionDataMatch[1]);
                console.log(`Parsed ${captionTracks.length} caption tracks`);
            } catch (error) {
                console.error(`Failed to parse caption tracks: ${error.message}`);
                return `Failed to parse caption tracks.`;
            }

            let selectedTrack = captionTracks.find((track: any) => track.languageCode === lang);
            if (!selectedTrack && captionTracks.length > 0) {
                selectedTrack = captionTracks[0];
                console.log(`Language ${lang} not found, using ${selectedTrack.languageCode} instead`);
            }
            
            if (!selectedTrack || !selectedTrack.baseUrl) {
                console.log(`No suitable caption track found`);
                return `No transcript available.`;
            }

            console.log(`Fetching transcript from URL: ${selectedTrack.baseUrl}`);
            const transcriptResponse = await axios.get(selectedTrack.baseUrl);
            const transcriptXml = transcriptResponse.data as string;
            
            console.log(`Received transcript XML of length: ${transcriptXml.length}`);

            const textRegex = /<text start="([\d.]+)" dur="([\d.]+)">(.*?)<\/text>/g;
            let result = '';
            let match;
            let matchCount = 0;
            
            while ((match = textRegex.exec(transcriptXml)) !== null) {
                matchCount++;
                const start = Number(match[1]);
                const dur = Number(match[2]);
                const text = match[3]
                    .replace(/&#39;/g, "'")
                    .replace(/&amp;/g, "&")
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"');
                    
                if (withTimestamps) {
                    result += `[${this.formatTimestamp(start)} - ${this.formatTimestamp(start + dur)}] ${text}\n`;
                } else {
                    result += text + ' ';
                }
            }
            
            console.log(`Extracted ${matchCount} transcript segments`);
            
            if (matchCount === 0) {
                return `No transcript content found.`;
            }
            
            return result.trim();
        } catch (error) {
            console.error('Error in getTranscriptFromPage:', error);
            return `No transcript found for this video.`;
        }
    }
    private async fetchVideoPageData(videoId: string): Promise<{ html: string, document: any }> {
        try {
            console.log(`Fetching video page data for ID: ${videoId} via proxy`);
            
            // Use local proxy instead of direct YouTube access
            const proxyUrl = `http://localhost:3099/youtube/page?videoId=${videoId}`;
            const response = await axios.get(proxyUrl);
            
            if (response.data.error) {
                throw new Error(`Proxy error: ${response.data.error}`);
            }
            
            const html = response.data.html;
            console.log(`Received video page HTML via proxy, length: ${html.length}`);
            
            const document = parse(html);
            
            return { html, document };
        } catch (error) {
            console.error(`Error fetching video page: ${error.message}`);
            throw error;
        }
    }
/**
 * Converts HTML to a format Telegram can understand (for safe display)
 */
private cleanHTMLForTelegram(html: string): string {
    // Replace paragraph tags with newlines
    let result = html.replace(/<\/?p>/g, '\n');
    
    // Replace lists with simple formatting
    result = result.replace(/<ul>([\s\S]*?)<\/ul>/g, (match, content) => {
        return content.replace(/<li>([\s\S]*?)<\/li>/g, '• $1\n');
    });
    
    result = result.replace(/<ol>([\s\S]*?)<\/ol>/g, (match, content) => {
        let index = 1;
        return content.replace(/<li>([\s\S]*?)<\/li>/g, () => {
            return `${index++}. $1\n`;
        });
    });
    
    // Preserve basic formatting that Telegram supports
    // Telegram supports <b>, <i>, <u>, <s>, <a>, <code>, <pre>
    
    // Remove any other HTML tags
    result = result.replace(/<(?!\/?(b|i|u|s|a|code|pre))[^>]*>/g, '');
    
    // Clean up excessive newlines
    result = result.replace(/\n{3,}/g, '\n\n');
    
    return result.trim();
}

}